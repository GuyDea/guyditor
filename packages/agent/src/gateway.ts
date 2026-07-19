import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  buildAnnotationContext,
  JobQueue,
  OperationEngine,
} from "../../core/src/index.js";
import type {
  AnnotationContextPackage,
  AnnotationTranscriptSource,
  JobOverview,
  OperationInput,
  ProjectStore,
  Proposal,
  TemplateProvider,
} from "../../core/src/index.js";
import type { DataClass } from "./audit-types.js";
import type { AuditLog } from "./audit-log.js";
import {
  SessionManager,
} from "./session.js";
import type {
  GatewaySession,
} from "./session.js";

const MCP_PATH = "/mcp";
const MAX_REQUEST_BYTES = 1024 * 1024;
const ANNOTATION_ID = /^ann_[a-z2-7]{10}$/u;
const PROPOSAL_ID = /^prp_[a-z2-7]{10}$/u;

export const AC004_GATEWAY_TOOLS = Object.freeze([
  "context_package",
  "progress_overview",
  "proposal_create",
  "proposal_get",
] as const);

export interface GatewayDirector {
  profileId: string;
  modelLabel: string;
  locality: "local" | "remote";
}

export interface AgentGatewayOptions {
  auditLog: AuditLog;
  jobQueue: Pick<JobQueue, "overview">;
  project: ProjectStore;
  stateDirectory?: string;
  director?: GatewayDirector;
  policySnapshot?: object;
  transcript?: AnnotationTranscriptSource;
  sessionIdFactory?: () => string;
  templateProvider?: TemplateProvider;
}

export interface StartedAgentGateway {
  endpoint: string;
  token: string;
  stateFile: string;
}

interface ActiveTransport {
  logicalSessionId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface GatewayStateFile {
  endpoint: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error["code"] === "string"
    ? error["code"]
    : "E_AGENT_GATEWAY";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function requestDigest(params: unknown): object {
  return {
    sha256: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
  };
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new RangeError("MCP request body is too large.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? undefined : JSON.parse(text) as unknown;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sessionHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export class AgentGateway {
  readonly #audit: AuditLog;
  readonly #jobs: Pick<JobQueue, "overview">;
  readonly #project: ProjectStore;
  readonly #stateDirectory: string;
  readonly #director: GatewayDirector;
  readonly #policySnapshot: object;
  readonly #transcript: AnnotationTranscriptSource | undefined;
  readonly #templateProvider: TemplateProvider | undefined;
  readonly #sessions: SessionManager;
  readonly #transports = new Map<string, ActiveTransport>();
  #http: Server | undefined;
  #started: StartedAgentGateway | undefined;

  public constructor(options: AgentGatewayOptions) {
    this.#audit = options.auditLog;
    this.#jobs = options.jobQueue;
    this.#project = options.project;
    this.#stateDirectory = options.stateDirectory ?? join(homedir(), ".guyditor", "state");
    this.#director = options.director ?? {
      profileId: "adp_bbbbbbbbbb",
      modelLabel: "attached-mcp-director",
      locality: "local",
    };
    this.#policySnapshot = structuredClone(options.policySnapshot ?? {});
    this.#transcript = options.transcript;
    this.#templateProvider = options.templateProvider;
    this.#sessions = new SessionManager(this.#audit, {
      ...(options.sessionIdFactory === undefined
        ? {}
        : { idFactory: options.sessionIdFactory }),
    });
  }

  public async start(): Promise<StartedAgentGateway> {
    if (this.#started !== undefined) return structuredClone(this.#started);
    const token = randomBytes(32).toString("hex");
    const http = createServer((request, response) => {
      void this.#handle(request, response, token).catch((error: unknown) => {
        if (!response.headersSent) {
          sendJson(response, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: errorMessage(error) },
            id: null,
          });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", reject);
        resolveListen();
      });
    });
    const address = http.address();
    if (address === null || typeof address === "string") {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      throw new Error("AgentGateway did not receive a loopback TCP port.");
    }
    const stateFile = join(this.#stateDirectory, "gateway.json");
    const started: StartedAgentGateway = {
      endpoint: `http://127.0.0.1:${String(address.port)}${MCP_PATH}`,
      token,
      stateFile,
    };
    const state: GatewayStateFile = { endpoint: started.endpoint, token };
    try {
      await mkdir(this.#stateDirectory, { recursive: true });
      await writeFile(stateFile, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(stateFile, 0o600);
    } catch (error: unknown) {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      throw error;
    }
    this.#http = http;
    this.#started = started;
    return structuredClone(started);
  }

  public async close(): Promise<void> {
    const active = [...this.#transports.entries()];
    for (const [transportSessionId, entry] of active) {
      this.#transports.delete(transportSessionId);
      await entry.transport.close().catch(() => undefined);
      if (this.#sessions.get(entry.logicalSessionId) !== undefined) {
        this.#sessions.close(entry.logicalSessionId);
      }
    }
    const http = this.#http;
    this.#http = undefined;
    if (http !== undefined) {
      await new Promise<void>((resolveClose, reject) => {
        http.close((error) => error === undefined ? resolveClose() : reject(error));
      });
    }
    const stateFile = this.#started?.stateFile;
    this.#started = undefined;
    if (stateFile !== undefined) await rm(stateFile, { force: true });
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== MCP_PATH) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    if (!bearerMatches(request.headers.authorization, token)) {
      response.writeHead(401, { "www-authenticate": "Bearer" });
      response.end("Unauthorized");
      return;
    }

    if (request.method === "POST") {
      const body = await requestBody(request);
      const existingId = sessionHeader(request);
      const existing = existingId === undefined ? undefined : this.#transports.get(existingId);
      if (existing !== undefined) {
        await existing.transport.handleRequest(request, response, body);
        return;
      }
      if (existingId !== undefined || !isInitializeRequest(body)) {
        sendJson(response, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Invalid or missing MCP session ID." },
          id: null,
        });
        return;
      }
      await this.#initialize(request, response, body);
      return;
    }

    if (request.method === "GET" || request.method === "DELETE") {
      const id = sessionHeader(request);
      const active = id === undefined ? undefined : this.#transports.get(id);
      if (id === undefined || active === undefined) {
        response.writeHead(400);
        response.end("Invalid or missing MCP session ID");
        return;
      }
      await active.transport.handleRequest(request, response);
      if (request.method === "DELETE") this.#endTransport(id);
      return;
    }

    response.writeHead(405, { allow: "GET, POST, DELETE" });
    response.end("Method not allowed");
  }

  async #initialize(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const session = this.#sessions.open({
      projectId: this.#project.currentProject.project.id,
      director: this.#director,
      policySnapshot: this.#policySnapshot,
    });
    const server = this.#mcpServer(session);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (transportSessionId) => {
        this.#transports.set(transportSessionId, {
          logicalSessionId: session.sessionId,
          server,
          transport,
        });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) this.#endTransport(id);
    };
    try {
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, body);
    } catch (error: unknown) {
      if (this.#sessions.get(session.sessionId) !== undefined) {
        this.#sessions.close(session.sessionId);
      }
      throw error;
    }
  }

  #endTransport(transportSessionId: string): void {
    const active = this.#transports.get(transportSessionId);
    if (active === undefined) return;
    this.#transports.delete(transportSessionId);
    if (this.#sessions.get(active.logicalSessionId) !== undefined) {
      this.#sessions.close(active.logicalSessionId);
    }
  }

  #mcpServer(session: GatewaySession): McpServer {
    const server = new McpServer({ name: "guyditor-agent-gateway", version: "0.0.0" });
    server.registerTool("progress_overview", {
      description: "Read all running, queued, creator-blocked, and external project work.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (_params, extra) => this.#toolCall(
      session,
      "progress_overview",
      String(extra.requestId),
      {},
      async () => ({
        value: await this.#jobs.overview(),
        dataClasses: ["metadata" as const],
      }),
    ));

    server.registerTool("context_package", {
      description: "Read the context package for one review annotation.",
      inputSchema: { annotationId: z.string().regex(ANNOTATION_ID) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ annotationId }, extra) => this.#toolCall(
      session,
      "context_package",
      String(extra.requestId),
      { annotationId },
      async () => {
        const result = await buildAnnotationContext({
          store: this.#project,
          ...(this.#transcript === undefined ? {} : { transcript: this.#transcript }),
        }, annotationId);
        if (!result.ok) throw result.error;
        return { value: result.value, dataClasses: result.value.dataClasses };
      },
    ));

    server.registerTool("proposal_create", {
      description: "Submit a review-gated proposal containing semantic operations.",
      inputSchema: {
        title: z.string().min(1),
        ops: z.array(z.object({
          op: z.string().min(1),
          params: z.record(z.string(), z.unknown()),
        })).min(1),
        addresses: z.array(z.string().regex(ANNOTATION_ID)).min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async ({ title, ops, addresses }, extra) => this.#toolCall(
      session,
      "proposal_create",
      String(extra.requestId),
      { title, ops, addresses },
      async () => {
        const engine = new OperationEngine(this.#project.currentProject, {
          appVersion: "0.0.0",
          proposalStore: this.#project,
          auditSink: this.#audit,
          ...(this.#templateProvider === undefined
            ? {}
            : { templateProvider: this.#templateProvider }),
        });
        const result = await engine.createProposal({
          operations: ops as OperationInput[],
          instruction: { kind: "annotation", annotation: addresses[0] },
          actor: {
            kind: "agent",
            id: session.sessionId,
            model: session.director.modelLabel,
          },
          sessionId: session.sessionId,
          reason: {
            text: title,
            sources: addresses.map((annotationId) => ({
              kind: "annotation" as const,
              ref: annotationId,
            })),
          },
          addresses,
        });
        if (!result.ok) throw result.error;
        return { value: result.value, dataClasses: ["metadata" as const] };
      },
    ));

    server.registerTool("proposal_get", {
      description: "Read current proposal status and creator outcome.",
      inputSchema: { proposalId: z.string().regex(PROPOSAL_ID) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ proposalId }, extra) => this.#toolCall(
      session,
      "proposal_get",
      String(extra.requestId),
      { proposalId },
      async () => {
        const result = await this.#project.readProposal(proposalId);
        if (!result.ok) throw result.error;
        return { value: result.value, dataClasses: ["metadata" as const] };
      },
    ));
    return server;
  }

  async #toolCall<Value extends AnnotationContextPackage | JobOverview | Proposal>(
    session: GatewaySession,
    tool: typeof AC004_GATEWAY_TOOLS[number],
    callId: string,
    params: unknown,
    execute: () => Promise<{ value: Value; dataClasses: DataClass[] }>,
  ) {
    const startedAt = performance.now();
    this.#audit.append({
      type: "tool.call",
      sessionId: session.sessionId,
      projectId: session.projectId,
      tool,
      callId,
      paramsDigest: requestDigest(params),
    });
    try {
      const result = await execute();
      this.#audit.append({
        type: "tool.result",
        sessionId: session.sessionId,
        projectId: session.projectId,
        tool,
        callId,
        paramsDigest: requestDigest(params),
        ok: true,
        dataClassesReturned: result.dataClasses,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      return jsonToolResult(result.value);
    } catch (error: unknown) {
      this.#audit.append({
        type: "tool.result",
        sessionId: session.sessionId,
        projectId: session.projectId,
        tool,
        callId,
        paramsDigest: requestDigest(params),
        ok: false,
        errorCode: errorCode(error),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      return {
        isError: true,
        content: [{ type: "text" as const, text: `${errorCode(error)}: ${errorMessage(error)}` }],
      };
    }
  }
}
