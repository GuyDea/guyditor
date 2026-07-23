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
  AnnotationTranscriptSource,
  AutomationPolicy,
  OperationInput,
  ProjectStore,
  SubjectiveAssessment,
  TemplateProvider,
} from "../../core/src/index.js";
import type { AssessmentStore } from "./assessment-store.js";
import type { CriticExecutionService } from "./critic-execution.js";
import type { DataClass } from "./audit-types.js";
import type { AuditLog } from "./audit-log.js";
import {
  SessionManager,
} from "./session.js";
import type {
  GatewaySession,
} from "./session.js";
import { SkillRegistry } from "./skills/index.js";
import type { ResolvedSkill } from "./skills/index.js";

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

export const M3_CANDIDATE_GATEWAY_TOOL = "deliverable_candidates_discover" as const;
export const M3_METADATA_GATEWAY_TOOL = "deliverable_metadata_draft" as const;
export const M4_ACTIVE_SKILLS_GATEWAY_TOOL = "active_skills_get" as const;
export const M4_ASSESSMENT_SUBMIT_TOOL = "assessment_submit" as const;
export const M4_CRITIC_REQUEST_TOOL = "critic_request" as const;
export const M4_CRITIC_RESULT_GET_TOOL = "critic_result_get" as const;
export const M4_TAKES_COMPARE_TOOL = "assist_takes_compare" as const;

export interface CandidateDiscoveryToolInput {
  profile: string;
  maxCandidates?: number;
  constraints?: {
    mustIncludeBeats?: string[];
    durationSeconds?: { min: number; max: number };
  };
}

export interface GatewayDirector {
  profileId: string;
  modelLabel: string;
  locality: "local" | "remote";
}

export interface GatewaySkillRegistry {
  pinned(project: ProjectStore): Promise<ResolvedSkill[]>;
  resolveAutomationPolicy(
    policy: AutomationPolicy,
    skills: readonly ResolvedSkill[],
  ): AutomationPolicy;
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
  candidateDiscovery?: (input: CandidateDiscoveryToolInput) => Promise<unknown>;
  metadataDraft?: (deliverableId: string) => Promise<unknown>;
  skillRegistry?: GatewaySkillRegistry;
  assessmentStore?: Pick<AssessmentStore, "submit" | "get">;
  criticExecution?: Pick<CriticExecutionService, "request" | "get">;
  takeComparison?: (takeIds: string[]) => Promise<unknown>;
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

function automationPolicy(value: unknown): AutomationPolicy | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value["automation"]) ? value["automation"] : value;
  if (
    typeof candidate["enabled"] !== "boolean" || candidate["maxRisk"] !== "low" ||
    !Array.isArray(candidate["allowedOperations"]) ||
    !candidate["allowedOperations"].every((entry) => typeof entry === "string") ||
    typeof candidate["maxOpsPerProposal"] !== "number" ||
    typeof candidate["maxAutoAcceptsPerSession"] !== "number" ||
    typeof candidate["notify"] !== "string"
  ) return undefined;
  return {
    enabled: candidate["enabled"],
    maxRisk: "low",
    allowedOperations: [...candidate["allowedOperations"]],
    maxOpsPerProposal: candidate["maxOpsPerProposal"],
    maxAutoAcceptsPerSession: candidate["maxAutoAcceptsPerSession"],
    notify: candidate["notify"],
  };
}

function withResolvedAutomation(
  snapshot: object,
  resolved: AutomationPolicy | undefined,
): object {
  if (resolved === undefined) return structuredClone(snapshot);
  return { ...structuredClone(snapshot), automation: resolved };
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
  readonly #candidateDiscovery: AgentGatewayOptions["candidateDiscovery"];
  readonly #metadataDraft: AgentGatewayOptions["metadataDraft"];
  readonly #skillRegistry: GatewaySkillRegistry;
  readonly #assessmentStore: AgentGatewayOptions["assessmentStore"];
  readonly #criticExecution: AgentGatewayOptions["criticExecution"];
  readonly #takeComparison: AgentGatewayOptions["takeComparison"];
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
    this.#candidateDiscovery = options.candidateDiscovery;
    this.#metadataDraft = options.metadataDraft;
    this.#skillRegistry = options.skillRegistry ?? new SkillRegistry();
    this.#assessmentStore = options.assessmentStore;
    this.#criticExecution = options.criticExecution;
    this.#takeComparison = options.takeComparison;
    this.#sessions = new SessionManager(this.#audit, {
      ...(options.sessionIdFactory === undefined
        ? {}
        : { idFactory: options.sessionIdFactory }),
    });
  }

  public async start(): Promise<StartedAgentGateway> {
    if (this.#started !== undefined) return structuredClone(this.#started);
    await this.#skillRegistry.pinned(this.#project);
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
    const skills = await this.#skillRegistry.pinned(this.#project);
    const baseAutomation = automationPolicy(this.#policySnapshot) ??
      automationPolicy(this.#project.currentProject.settings.automation);
    const resolvedAutomation = baseAutomation === undefined
      ? baseAutomation
      : this.#skillRegistry.resolveAutomationPolicy(baseAutomation, skills);
    const session = this.#sessions.open({
      projectId: this.#project.currentProject.project.id,
      director: this.#director,
      policySnapshot: withResolvedAutomation(this.#policySnapshot, resolvedAutomation),
    });
    const server = this.#mcpServer(session, skills, resolvedAutomation);
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

  #mcpServer(
    session: GatewaySession,
    skills: readonly ResolvedSkill[],
    resolvedAutomation: AutomationPolicy | undefined,
  ): McpServer {
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
        addresses: z.array(z.string().regex(ANNOTATION_ID)).default([]),
        assessmentId: z.string().regex(/^asm_[a-z2-7]{10}$/u).optional(),
        evidenceRefs: z.array(z.string().min(1)).optional(),
        divergence: z.enum(["hook", "order", "pacing", "cuts", "graphics", "captions", "cta", "ending", "framing"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async ({ title, ops, addresses, divergence, assessmentId, evidenceRefs }, extra) => this.#toolCall(
      session,
      "proposal_create",
      String(extra.requestId),
      { title, ops, addresses, divergence, assessmentId, evidenceRefs },
      async () => {
        const assessment = assessmentId === undefined
          ? undefined
          : await this.#assessmentStore?.get(assessmentId);
        if (assessmentId !== undefined && assessment === undefined) {
          throw new Error(`E_ASSESSMENT_NOT_FOUND: Assessment ${assessmentId} was not found.`);
        }
        const engine = new OperationEngine(this.#project.currentProject, {
          appVersion: "0.0.0",
          proposalStore: this.#project,
          auditSink: this.#audit,
          ...(resolvedAutomation === undefined
            ? {}
            : { automationPolicy: resolvedAutomation }),
          ...(this.#templateProvider === undefined
            ? {}
            : { templateProvider: this.#templateProvider }),
        });
        const result = await engine.createProposal({
          operations: ops as OperationInput[],
          instruction: addresses[0] === undefined
            ? { kind: "skill-policy" }
            : { kind: "annotation", annotation: addresses[0] },
          actor: {
            kind: "agent",
            id: session.sessionId,
            model: session.director.modelLabel,
          },
          sessionId: session.sessionId,
          ...(divergence === undefined ? {} : { divergence }),
          reason: {
            text: title,
            sources: [
              ...addresses.map((annotationId) => ({
                kind: "annotation" as const,
                ref: annotationId,
              })),
              ...(assessmentId === undefined ? [] : [{
                kind: "media-evidence" as const,
                ref: assessmentId,
              }]),
              ...(evidenceRefs ?? []).map((ref) => ({
                kind: "media-evidence" as const,
                ref,
              })),
            ],
          },
          ...(assessment === undefined ? {} : { assessment }),
          addresses,
        });
        if (!result.ok) throw result.error;
        return { value: result.value, dataClasses: ["metadata" as const] };
      },
    ));

    if (this.#assessmentStore !== undefined) {
      server.registerTool(M4_ASSESSMENT_SUBMIT_TOOL, {
        description: "Validate and cache a recommendation-framed subjective assessment with inspectable evidence.",
        inputSchema: { assessment: z.record(z.string(), z.unknown()) },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      }, async ({ assessment }, extra) => this.#toolCall(
        session,
        M4_ASSESSMENT_SUBMIT_TOOL,
        String(extra.requestId),
        { assessment },
        async () => ({
          value: await this.#assessmentStore!.submit(assessment) as SubjectiveAssessment,
          dataClasses: ["metadata" as const],
        }),
      ));
    }
    if (this.#criticExecution !== undefined) {
      server.registerTool(M4_CRITIC_REQUEST_TOOL, {
        description: "Send a consent-gated proxy range to a registered advisory critic and cache its findings.",
        inputSchema: {
          adapterId: z.string().min(1),
          confirmToken: z.string().min(1).optional(),
          request: z.object({
            critiqueId: z.string().regex(/^crt_[a-z2-7]{10}$/u),
            subject: z.object({
              deliverableId: z.string().regex(/^dlv_[a-z2-7]{10}$/u).optional(),
              proxyFile: z.object({ path: z.string().min(1), sha256: z.string().optional() }),
              range: z.record(z.string(), z.unknown()),
            }),
            rubric: z.array(z.object({
              id: z.string().min(1),
              source: z.enum(["skill_rule", "inline"]),
              skillId: z.string().optional(),
              ruleId: z.string().optional(),
              text: z.string().min(1),
            })),
            questions: z.array(z.string().min(1)),
          }),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      }, async ({ adapterId, request: critiqueRequest, confirmToken }, extra) => this.#toolCall(
        session,
        M4_CRITIC_REQUEST_TOOL,
        String(extra.requestId),
        { adapterId, request: critiqueRequest, confirmToken },
        async () => {
          const result = await this.#criticExecution!.request({
            adapterId,
            request: {
              critiqueId: critiqueRequest.critiqueId,
              questions: [...critiqueRequest.questions],
              rubric: critiqueRequest.rubric.map((criterion) => ({
                id: criterion.id,
                source: criterion.source,
                text: criterion.text,
                ...(criterion.skillId === undefined ? {} : { skillId: criterion.skillId }),
                ...(criterion.ruleId === undefined ? {} : { ruleId: criterion.ruleId }),
              })),
              subject: {
                ...(critiqueRequest.subject.deliverableId === undefined
                  ? {}
                  : { deliverableId: critiqueRequest.subject.deliverableId }),
                range: critiqueRequest.subject.range,
                proxyFile: {
                  path: critiqueRequest.subject.proxyFile.path,
                  ...(critiqueRequest.subject.proxyFile.sha256 === undefined
                    ? {}
                    : { sha256: critiqueRequest.subject.proxyFile.sha256 }),
                },
              },
            },
            context: {
              sessionId: session.sessionId,
              projectId: session.projectId,
              taskId: critiqueRequest.critiqueId,
              initiator: "agent",
            },
            ...(confirmToken === undefined ? {} : { confirmToken }),
          });
          if (!result.ok) throw result.error;
          return { value: result.value, dataClasses: ["metadata" as const] };
        },
      ));
      server.registerTool(M4_CRITIC_RESULT_GET_TOOL, {
        description: "Fetch cached advisory critic findings for proposal translation.",
        inputSchema: { critiqueId: z.string().regex(/^crt_[a-z2-7]{10}$/u) },
        annotations: { readOnlyHint: true, openWorldHint: false },
      }, async ({ critiqueId }, extra) => this.#toolCall(
        session,
        M4_CRITIC_RESULT_GET_TOOL,
        String(extra.requestId),
        { critiqueId },
        async () => ({
          value: await this.#criticExecution!.get(critiqueId) ?? null,
          dataClasses: ["metadata" as const],
        }),
      ));
    }
    if (this.#takeComparison !== undefined) {
      server.registerTool(M4_TAKES_COMPARE_TOOL, {
        description: "Compare transcript-similar takes using delivery, technical, and pinned preference evidence.",
        inputSchema: { takeIds: z.array(z.string().regex(/^tak_[a-z2-7]{10}$/u)).min(2) },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      }, async ({ takeIds }, extra) => this.#toolCall(
        session,
        M4_TAKES_COMPARE_TOOL,
        String(extra.requestId),
        { takeIds },
        async () => ({
          value: await this.#takeComparison!([...takeIds]),
          dataClasses: ["metadata" as const, "transcript" as const, "audio" as const],
        }),
      ));
    }

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
    if (skills.length > 0) {
      server.registerTool(M4_ACTIVE_SKILLS_GATEWAY_TOOL, {
        description: "Read the verified, project-pinned editorial skills and their full prose context.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      }, async (_params, extra) => this.#toolCall(
        session,
        M4_ACTIVE_SKILLS_GATEWAY_TOOL,
        String(extra.requestId),
        {},
        () => Promise.resolve({
          value: structuredClone(skills),
          dataClasses: ["metadata" as const, "prompt" as const],
        }),
      ));
    }
    if (this.#candidateDiscovery !== undefined) {
      server.registerTool(M3_CANDIDATE_GATEWAY_TOOL, {
        description: "Enqueue deterministic short-candidate discovery and return the cache-backed candidate records with disclosed hook/coherence/payoff criteria.",
        inputSchema: {
          profile: z.string().regex(/^[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+$/u),
          maxCandidates: z.number().int().min(1).max(100).optional(),
          constraints: z.object({
            mustIncludeBeats: z.array(z.string().regex(/^beat_[a-z2-7]{10}$/u)).optional(),
            durationSeconds: z.object({
              min: z.number().nonnegative(),
              max: z.number().positive(),
            }).optional(),
          }).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      }, async (params, extra) => this.#toolCall(
        session,
        M3_CANDIDATE_GATEWAY_TOOL,
        String(extra.requestId),
        params,
        async () => ({
          value: await this.#candidateDiscovery!({
            profile: params.profile,
            ...(params.maxCandidates === undefined ? {} : { maxCandidates: params.maxCandidates }),
            ...(params.constraints === undefined ? {} : {
              constraints: {
                ...(params.constraints.mustIncludeBeats === undefined
                  ? {}
                  : { mustIncludeBeats: params.constraints.mustIncludeBeats }),
                ...(params.constraints.durationSeconds === undefined
                  ? {}
                  : { durationSeconds: params.constraints.durationSeconds }),
              },
            }),
          }),
          dataClasses: ["metadata" as const],
        }),
      ));
    }
    if (this.#metadataDraft !== undefined) {
      server.registerTool(M3_METADATA_GATEWAY_TOOL, {
        description: "Draft creator-editable publish title, description, tags, hashtags, and CTA from accepted transcript and beat evidence.",
        inputSchema: {
          deliverableId: z.string().regex(/^dlv_[a-z2-7]{10}$/u),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      }, async ({ deliverableId }, extra) => this.#toolCall(
        session,
        M3_METADATA_GATEWAY_TOOL,
        String(extra.requestId),
        { deliverableId },
        async () => ({
          value: await this.#metadataDraft!(deliverableId),
          dataClasses: ["metadata" as const, "transcript" as const],
        }),
      ));
    }
    return server;
  }

  async #toolCall<Value>(
    session: GatewaySession,
    tool: typeof AC004_GATEWAY_TOOLS[number] |
      typeof M3_CANDIDATE_GATEWAY_TOOL |
      typeof M3_METADATA_GATEWAY_TOOL |
      typeof M4_ACTIVE_SKILLS_GATEWAY_TOOL |
      typeof M4_ASSESSMENT_SUBMIT_TOOL |
      typeof M4_CRITIC_REQUEST_TOOL |
      typeof M4_CRITIC_RESULT_GET_TOOL |
      typeof M4_TAKES_COMPARE_TOOL,
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
