import { readFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type {
  AnnotationContextPackage,
  JobOverview,
  OperationInput,
  Proposal,
} from "../../../core/src/index.js";
import type { CritiqueRequest, CritiqueResult } from "../../src/adapters/types.js";

interface GatewayStateFile {
  endpoint: string;
  token: string;
}

export interface StubDirectorOptions {
  annotationId: string;
  clipId: string;
  gatewayStateFile: string;
  trimFrames?: number;
  operations?: OperationInput[];
  title?: string;
  candidateDiscovery?: {
    profile: string;
    maxCandidates?: number;
  };
  metadataDraft?: { deliverableId: string };
  activeSkills?: boolean;
  critic?: { adapterId: string; request: CritiqueRequest };
}

export interface StubDirectorResult {
  tools: string[];
  progress: JobOverview;
  context: AnnotationContextPackage;
  proposal: Proposal;
  status: Proposal;
  candidateResult?: unknown;
  metadataResult?: unknown;
  activeSkillsResult?: unknown;
  critiqueRequestResult?: CritiqueResult;
  critiqueFetchedResult?: CritiqueResult | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gatewayState(value: unknown): GatewayStateFile {
  if (
    !isRecord(value) || typeof value["endpoint"] !== "string" ||
    typeof value["token"] !== "string"
  ) {
    throw new TypeError("gateway.json must contain endpoint and token strings.");
  }
  return { endpoint: value["endpoint"], token: value["token"] };
}

function toolValue<Value>(result: Awaited<ReturnType<Client["callTool"]>>): Value {
  const raw: unknown = result;
  const content = isRecord(raw) && Array.isArray(raw["content"])
    ? raw["content"]
    : [];
  const text = content.find((entry): entry is Record<string, unknown> =>
    isRecord(entry) && entry["type"] === "text" && typeof entry["text"] === "string");
  if (isRecord(raw) && raw["isError"] === true || text === undefined) {
    throw new Error(
      text === undefined ? "MCP tool returned no JSON text." : String(text["text"]),
    );
  }
  return JSON.parse(String(text["text"])) as Value;
}

/**
 * AC-004's deterministic director: three fixed MCP calls and no model/provider code.
 */
export async function runStubDirector(
  options: StubDirectorOptions,
): Promise<StubDirectorResult> {
  const state = gatewayState(JSON.parse(
    await readFile(options.gatewayStateFile, "utf8"),
  ) as unknown);
  const client = new Client({
    name: "guyditor-ac004-stub-director",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(state.endpoint), {
    requestInit: { headers: { authorization: `Bearer ${state.token}` } },
  });
  await client.connect(transport as unknown as Transport);
  try {
    const tools = (await client.listTools()).tools.map(({ name }) => name).sort();
    const progress = toolValue<JobOverview>(await client.callTool({
      name: "progress_overview",
      arguments: {},
    }));
    const candidateResult = options.candidateDiscovery === undefined
      ? undefined
      : toolValue<unknown>(await client.callTool({
          name: "deliverable_candidates_discover",
          arguments: options.candidateDiscovery,
        }));
    const metadataResult = options.metadataDraft === undefined
      ? undefined
      : toolValue<unknown>(await client.callTool({
          name: "deliverable_metadata_draft",
          arguments: options.metadataDraft,
        }));
    const activeSkillsResult = options.activeSkills !== true
      ? undefined
      : toolValue<unknown>(await client.callTool({
          name: "active_skills_get",
          arguments: {},
        }));
    const critiqueRequestResult = options.critic === undefined
      ? undefined
      : toolValue<CritiqueResult>(await client.callTool({
          name: "critic_request",
          arguments: options.critic,
        }));
    const critiqueFetchedResult = options.critic === undefined
      ? undefined
      : toolValue<CritiqueResult | null>(await client.callTool({
          name: "critic_result_get",
          arguments: { critiqueId: options.critic.request.critiqueId },
        }));
    const context = toolValue<AnnotationContextPackage>(await client.callTool({
      name: "context_package",
      arguments: { annotationId: options.annotationId },
    }));
    const proposal = toolValue<Proposal>(await client.callTool({
      name: "proposal_create",
      arguments: {
        title: options.title ?? `Trim the clip to address ${options.annotationId}: ${context.annotation?.body ?? "review note"}`,
        addresses: [options.annotationId],
        ops: options.operations ?? [{
          op: "clip.trim",
          params: {
            clipId: options.clipId,
            edge: "tail",
            delta: {
              frames: options.trimFrames ?? 2,
              fps: context.position.timelineFrame.fps,
            },
            evidence: `ann:${options.annotationId}`,
          },
        }],
      },
    }));
    const status = toolValue<Proposal>(await client.callTool({
      name: "proposal_get",
      arguments: { proposalId: proposal.id },
    }));
    return {
      tools,
      progress,
      context,
      proposal,
      status,
      ...(candidateResult === undefined ? {} : { candidateResult }),
      ...(metadataResult === undefined ? {} : { metadataResult }),
      ...(activeSkillsResult === undefined ? {} : { activeSkillsResult }),
      ...(critiqueRequestResult === undefined ? {} : { critiqueRequestResult }),
      ...(critiqueFetchedResult === undefined ? {} : { critiqueFetchedResult }),
    };
  } finally {
    await client.close();
  }
}
