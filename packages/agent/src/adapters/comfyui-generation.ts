import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import type {
  AdapterDescriptor,
  AdapterJobHandle,
  AdapterJobStatus,
  BrollProviderAdapter,
  GenerationRequest,
  GenerationResult,
} from "./types.js";

export const COMFYUI_GENERATION_ADAPTER_ID = "adp_comfyuiaaa";
export const COMFYUI_GENERATION_ADAPTER_CANONICAL_NAME = ["adp", "comfyui"].join("_");

export type ComfyUiHistory =
  | { state: "queued" | "running"; progress?: number; providerMetadata: Record<string, unknown> }
  | { state: "failed"; error: string; providerMetadata: Record<string, unknown> }
  | {
      state: "succeeded";
      outputs: Array<{
        filename: string;
        subfolder?: string;
        type?: string;
        width: number;
        height: number;
        durationSeconds?: number;
        mime?: string;
      }>;
      providerMetadata: Record<string, unknown>;
    };

export interface ComfyUiApi {
  probe(): Promise<boolean>;
  submit(workflow: Record<string, unknown>, signal: AbortSignal): Promise<{ promptId: string }>;
  history(promptId: string): Promise<ComfyUiHistory>;
  download(output: { filename: string; subfolder?: string; type?: string }): Promise<Buffer>;
  cancel?(promptId: string): Promise<void>;
}

export interface ComfyUiWorkflowTemplate {
  graph: Record<string, unknown>;
  mode?: "image" | "video";
  maxWidth?: number;
  maxHeight?: number;
  maxDurationSec?: number;
}

export interface ComfyUiGenerationConfig {
  enabled?: boolean;
  baseUrl?: string;
  workflows: Record<string, ComfyUiWorkflowTemplate>;
  modelLicense?: string;
}

export interface ComfyUiGenerationAdapterOptions {
  config: ComfyUiGenerationConfig;
  api?: ComfyUiApi;
  fetchImplementation?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

class HttpComfyUiApi implements ComfyUiApi {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  public constructor(baseUrl: string, fetchImplementation?: typeof fetch) {
    this.#baseUrl = baseUrl.replace(/\/$/u, "");
    this.#fetch = fetchImplementation ?? fetch;
  }

  public async probe(): Promise<boolean> {
    // PROVIDER-VERIFY: ComfyUI capability probing is isolated to /system_stats.
    const response = await this.#fetch(`${this.#baseUrl}/system_stats`);
    return response.ok;
  }

  public async submit(
    workflow: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ promptId: string }> {
    // PROVIDER-VERIFY: API-format workflow submission shape.
    const response = await this.#fetch(`${this.#baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    });
    if (!response.ok) throw new Error(`ComfyUI submit returned ${String(response.status)}.`);
    const body = record(await response.json());
    const promptId = body["prompt_id"];
    if (typeof promptId !== "string") throw new Error("ComfyUI submit response has no prompt_id.");
    return { promptId };
  }

  public async history(promptId: string): Promise<ComfyUiHistory> {
    // PROVIDER-VERIFY: output-node traversal is normalized at this boundary.
    const response = await this.#fetch(`${this.#baseUrl}/history/${encodeURIComponent(promptId)}`);
    if (!response.ok) throw new Error(`ComfyUI history returned ${String(response.status)}.`);
    const raw = record(await response.json());
    const entry = record(raw[promptId]);
    if (Object.keys(entry).length === 0) {
      return { state: "running", providerMetadata: raw };
    }
    const status = record(entry["status"]);
    if (status["completed"] === false && status["status_str"] === "error") {
      return { state: "failed", error: "ComfyUI workflow failed.", providerMetadata: raw };
    }
    const outputs: Extract<ComfyUiHistory, { state: "succeeded" }>["outputs"] = [];
    for (const node of Object.values(record(entry["outputs"]))) {
      const nodeRecord = record(node);
      for (const collection of [nodeRecord["images"], nodeRecord["gifs"]]) {
        if (!Array.isArray(collection)) continue;
        for (const candidate of collection) {
          const output = record(candidate);
          if (typeof output["filename"] !== "string") continue;
          outputs.push({
            filename: output["filename"],
            ...(typeof output["subfolder"] === "string" ? { subfolder: output["subfolder"] } : {}),
            ...(typeof output["type"] === "string" ? { type: output["type"] } : {}),
            width: typeof output["width"] === "number" ? output["width"] : 1,
            height: typeof output["height"] === "number" ? output["height"] : 1,
          });
        }
      }
    }
    return outputs.length === 0
      ? { state: "running", providerMetadata: raw }
      : { state: "succeeded", outputs, providerMetadata: raw };
  }

  public async download(
    output: { filename: string; subfolder?: string; type?: string },
  ): Promise<Buffer> {
    const query = new URLSearchParams({ filename: output.filename });
    if (output.subfolder !== undefined) query.set("subfolder", output.subfolder);
    if (output.type !== undefined) query.set("type", output.type);
    const response = await this.#fetch(`${this.#baseUrl}/view?${query.toString()}`);
    if (!response.ok) throw new Error(`ComfyUI output download returned ${String(response.status)}.`);
    return Buffer.from(await response.arrayBuffer());
  }
}

function inject(value: unknown, replacements: Record<string, unknown>): unknown {
  if (typeof value === "string" && Object.hasOwn(replacements, value)) {
    return replacements[value];
  }
  if (Array.isArray(value)) return value.map((child) => inject(child, replacements));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    inject(child, replacements),
  ]));
}

export class ComfyUiGenerationAdapter implements BrollProviderAdapter {
  public readonly descriptor: AdapterDescriptor;
  readonly #config: ComfyUiGenerationConfig;
  readonly #api: ComfyUiApi;
  readonly #requests = new Map<string, GenerationRequest>();

  public constructor(options: ComfyUiGenerationAdapterOptions) {
    this.#config = structuredClone(options.config);
    this.#api = options.api ?? new HttpComfyUiApi(
      options.config.baseUrl ?? "http://127.0.0.1:8188",
      options.fetchImplementation,
    );
    const workflows = Object.entries(options.config.workflows);
    const available = options.config.enabled === true && workflows.length > 0;
    this.descriptor = {
      adapterId: COMFYUI_GENERATION_ADAPTER_ID,
      canonicalName: COMFYUI_GENERATION_ADAPTER_CANONICAL_NAME,
      adapterVersion: "0.1.0",
      displayName: "ComfyUI local generator",
      provider: "comfyui",
      local: true,
      availability: available ? "available" : "declared-unavailable",
      ...(available ? {} : { unavailableReason: "No enabled ComfyUI workflow is configured." }),
      capabilities: ["generate"],
      modes: [...new Set(workflows.map(([, template]) => template.mode ?? "video"))],
      models: workflows.map(([id, template]) => ({
        id,
        mode: template.mode ?? "video",
        maxWidth: template.maxWidth ?? 4096,
        maxHeight: template.maxHeight ?? 4096,
        ...(template.mode === "image" ? {} : { maxDurationSec: template.maxDurationSec ?? 60 }),
        supportsSeed: true,
      })),
      requestSchema: { type: "object", additionalProperties: true },
      dataClassesSent: [],
      maxConcurrent: 1,
    };
  }

  public estimateCost() {
    return Promise.resolve({
      adapterId: this.descriptor.adapterId,
      currency: "USD",
      amount: 0,
      units: { localCompute: 1 },
      confidence: "quote" as const,
    });
  }

  public async submit(
    request: GenerationRequest,
    signal: AbortSignal,
  ): Promise<AdapterJobHandle> {
    const template = this.#config.workflows[request.model];
    if (this.descriptor.availability !== "available" || template === undefined) {
      throw new Error(this.descriptor.unavailableReason ?? `ComfyUI workflow ${request.model} is unavailable.`);
    }
    if (!await this.#api.probe()) throw new Error("ComfyUI is not reachable.");
    const graph = inject(template.graph, {
      "$prompt": request.prompt,
      "$negative": request.negativePrompt ?? "",
      "$seed": request.seed ?? 0,
      "$width": request.width,
      "$height": request.height,
      "$frames": request.durationFrames ?? 1,
    });
    const { promptId } = await this.#api.submit(record(graph), signal);
    this.#requests.set(promptId, structuredClone(request));
    return { adapterId: this.descriptor.adapterId, providerJobId: promptId };
  }

  public async poll(handle: AdapterJobHandle): Promise<AdapterJobStatus> {
    const history = await this.#api.history(handle.providerJobId);
    if (history.state === "failed") {
      return { state: "failed", error: history.error, retry: "safe" };
    }
    if (history.state === "queued" || history.state === "running") {
      return {
        state: history.state,
        ...(history.progress === undefined ? {} : { progress: history.progress }),
      };
    }
    return { state: "succeeded", providerMetadata: history.providerMetadata, actualCostUsd: 0 };
  }

  public async fetchResult(
    handle: AdapterJobHandle,
    destinationDirectory: string,
  ): Promise<GenerationResult> {
    const request = this.#requests.get(handle.providerJobId);
    if (request === undefined) throw new Error(`Unknown ComfyUI job ${handle.providerJobId}.`);
    const history = await this.#api.history(handle.providerJobId);
    if (history.state !== "succeeded") throw new Error(`ComfyUI job ${handle.providerJobId} is incomplete.`);
    await mkdir(destinationDirectory, { recursive: true });
    const outputs: GenerationResult["outputs"] = [];
    for (const [index, output] of history.outputs.entries()) {
      const extension = extname(output.filename) || (request.mode === "video" ? ".mp4" : ".png");
      const filePath = join(destinationDirectory, `candidate-${String(index)}${extension}`);
      await writeFile(filePath, await this.#api.download(output));
      outputs.push({
        filePath,
        mime: output.mime ?? (request.mode === "video" ? "video/mp4" : "image/png"),
        width: output.width,
        height: output.height,
        ...(output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds }),
        ...(request.seed === undefined ? {} : { seed: request.seed + index }),
        providerMetadata: history.providerMetadata,
        rights: {
          origin: "generated",
          licenseName: this.#config.modelLicense ?? "local-model-license-unrecorded",
          licensor: "creator-local-model",
          restrictions: [],
          confirmedBy: "creator",
        },
      });
    }
    const rawResponseRef = join(destinationDirectory, "raw-response.json");
    await writeFile(rawResponseRef, `${JSON.stringify(history.providerMetadata, null, 2)}\n`, "utf8");
    return { outputs, rawResponseRef };
  }

  public cancel(handle: AdapterJobHandle): Promise<void> {
    return this.#api.cancel?.(handle.providerJobId) ?? Promise.resolve();
  }
}
