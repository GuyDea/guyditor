import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyDeterministicRestyleFilter } from "../../../media/src/index.js";
import type { RestyleAdapterConstraints } from "../../../core/src/index.js";

import type { CredentialStore } from "./credentials.js";
import { HttpKlingApi } from "./kling-api.js";
import type { KlingApi, KlingApiTask } from "./kling-api.js";
import type {
  AdapterDescriptor,
  AdapterJobHandle,
  AdapterJobStatus,
  RestyleAdapter,
  RestyleRequest,
  RestyleResult,
} from "./types.js";

export const KLING_ADAPTER_ID = "adp_klingaaaaa";
export const KLING_ADAPTER_CANONICAL_NAME = ["adp", "kling"].join("_");

export interface KlingAdapterConfig {
  apiKeyRef: string;
  baseUrl?: string;
  model: string;
  costPerSecond?: number;
  concurrency?: number;
}

export interface KlingApiFactoryInput {
  apiKey: string;
  baseUrl?: string;
}

export interface KlingRestyleAdapterOptions {
  credentials: CredentialStore;
  config: KlingAdapterConfig;
  stubMode?: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  apiFactory?: (input: KlingApiFactoryInput) => KlingApi;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function mapTask(task: KlingApiTask): AdapterJobStatus {
  if (task.state === "failed") {
    return { state: "failed", error: task.error ?? "Kling task failed.", retry: "safe" };
  }
  if (task.state === "queued" || task.state === "running") {
    return { state: task.state, progress: task.progress };
  }
  return {
    state: "succeeded",
    providerMetadata: structuredClone(task.providerMetadata),
    ...(task.actualCostUsd === undefined ? {} : { actualCostUsd: task.actualCostUsd }),
  };
}

export class KlingRestyleAdapter implements RestyleAdapter {
  public readonly descriptor: AdapterDescriptor;
  public readonly constraints: RestyleAdapterConstraints;
  readonly #credentials: CredentialStore;
  readonly #config: KlingAdapterConfig;
  readonly #forcedStub: boolean;
  readonly #apiFactory: (input: KlingApiFactoryInput) => KlingApi;
  readonly #stubRequests = new Map<string, RestyleRequest>();
  readonly #liveApis = new Map<string, KlingApi>();

  public constructor(options: KlingRestyleAdapterOptions) {
    this.#credentials = options.credentials;
    this.#config = structuredClone(options.config);
    const environment = options.environment ?? process.env;
    this.#forcedStub = options.stubMode === true || environment["GUYDITOR_RESTYLE_STUB"] === "1";
    this.#apiFactory = options.apiFactory ?? ((input) => new HttpKlingApi(input));
    const costPerSecond = options.config.costPerSecond ?? 0.14;
    const concurrency = options.config.concurrency ?? 2;
    this.constraints = {
      maxSegmentSeconds: 10,
      maxResolution: { width: 2048, height: 2048 },
      fpsSupport: ["24/1", "25/1", "30/1", "30000/1001"],
      costPerSecond,
      concurrency,
    };
    this.descriptor = {
      adapterId: KLING_ADAPTER_ID,
      canonicalName: KLING_ADAPTER_CANONICAL_NAME,
      adapterVersion: "1.0.0",
      displayName: "Kling AI video restyle",
      provider: "Kling AI",
      local: false,
      capabilities: ["restyle"],
      modes: ["video"],
      models: [{
        id: options.config.model,
        mode: "video",
        maxWidth: this.constraints.maxResolution.width,
        maxHeight: this.constraints.maxResolution.height,
        maxDurationSec: this.constraints.maxSegmentSeconds,
        supportsSeed: true,
      }],
      requestSchema: {
        type: "object",
        additionalProperties: true,
        properties: { creativity: { type: "number", minimum: 0, maximum: 1 } },
      },
      dataClassesSent: ["video", "prompt", "metadata"],
      maxConcurrent: concurrency,
    };
  }

  public estimateCost(request: RestyleRequest) {
    return Promise.resolve({
      adapterId: this.descriptor.adapterId,
      currency: "USD",
      amount: rounded(request.durationSeconds * this.constraints.costPerSecond),
      units: { seconds: request.durationSeconds },
      confidence: "pricebook" as const,
    });
  }

  async #api(): Promise<KlingApi | undefined> {
    const apiKey = await this.#credentials.get(
      this.descriptor.adapterId,
      this.#config.apiKeyRef,
    );
    if (this.#forcedStub || apiKey === undefined) return undefined;
    return this.#apiFactory({
      apiKey,
      ...(this.#config.baseUrl === undefined ? {} : { baseUrl: this.#config.baseUrl }),
    });
  }

  #validate(request: RestyleRequest): void {
    if (request.durationSeconds <= 0 || request.durationSeconds > this.constraints.maxSegmentSeconds) {
      throw new RangeError(
        `Kling restyle duration must be within 0–${String(this.constraints.maxSegmentSeconds)} seconds.`,
      );
    }
    if (
      request.width > this.constraints.maxResolution.width ||
      request.height > this.constraints.maxResolution.height ||
      this.constraints.fpsSupport !== "any" && !this.constraints.fpsSupport.includes(request.fps)
    ) {
      throw new RangeError("Kling restyle request exceeds resolution or fps constraints.");
    }
  }

  public async restyle(
    request: RestyleRequest,
    signal: AbortSignal,
  ): Promise<AdapterJobHandle> {
    this.#validate(request);
    const api = await this.#api();
    if (api === undefined) {
      const inputHash = createHash("sha256").update(await readFile(request.inputFilePath)).digest("hex");
      const providerJobId = `stub-${createHash("sha256").update(JSON.stringify({
        inputHash,
        model: request.model,
        prompt: request.prompt,
        providerSettings: request.providerSettings,
        requestId: request.requestId,
        seed: request.seed,
        sourceRange: request.sourceRange,
      })).digest("hex").slice(0, 24)}`;
      this.#stubRequests.set(providerJobId, structuredClone(request));
      return { adapterId: this.descriptor.adapterId, providerJobId };
    }
    const task = await api.submitVideoToVideo(request, signal);
    this.#liveApis.set(task.taskId, api);
    return { adapterId: this.descriptor.adapterId, providerJobId: task.taskId };
  }

  public async poll(handle: AdapterJobHandle): Promise<AdapterJobStatus> {
    if (this.#stubRequests.has(handle.providerJobId)) {
      return {
        state: "succeeded",
        providerMetadata: {
          mode: "deterministic-ffmpeg-stub",
          filter: "curves+hue-v1",
          taskId: handle.providerJobId,
        },
        actualCostUsd: 0,
      };
    }
    const api = this.#liveApis.get(handle.providerJobId) ?? await this.#api();
    if (api === undefined) {
      return {
        state: "failed",
        error: `Kling credential is unavailable for task ${handle.providerJobId}.`,
        retry: "safe",
      };
    }
    this.#liveApis.set(handle.providerJobId, api);
    return mapTask(await api.getTask(handle.providerJobId));
  }

  public async fetchResult(
    handle: AdapterJobHandle,
    destinationDirectory: string,
  ): Promise<RestyleResult> {
    await mkdir(destinationDirectory, { recursive: true });
    const filePath = join(destinationDirectory, "restyled.mp4");
    const rawResponseRef = join(destinationDirectory, "raw-response.json");
    const stub = this.#stubRequests.get(handle.providerJobId);
    if (stub !== undefined) {
      await applyDeterministicRestyleFilter({
        inputPath: stub.inputFilePath,
        outputPath: filePath,
        width: stub.width,
        height: stub.height,
        fps: stub.fps,
        durationSeconds: stub.durationSeconds,
      });
      const providerMetadata = {
        mode: "deterministic-ffmpeg-stub",
        filter: "curves+hue-v1",
        taskId: handle.providerJobId,
      };
      await writeFile(rawResponseRef, `${JSON.stringify(providerMetadata)}\n`, "utf8");
      return {
        output: {
          filePath,
          mime: "video/mp4",
          width: stub.width,
          height: stub.height,
          durationSeconds: stub.durationSeconds,
          ...(stub.seed === undefined ? {} : { seed: stub.seed }),
          providerMetadata,
          rights: {
            origin: "generated",
            licensor: "Guyditor deterministic stub",
            restrictions: [],
            confirmedBy: "provider",
          },
        },
        rawResponseRef,
        actualCostUsd: 0,
      };
    }
    const api = this.#liveApis.get(handle.providerJobId) ?? await this.#api();
    if (api === undefined) throw new Error("Kling credentials are unavailable for result fetch.");
    const task = await api.getTask(handle.providerJobId);
    if (task.state !== "succeeded" || task.output === undefined) {
      throw new Error(`Kling task ${handle.providerJobId} is not complete.`);
    }
    await api.downloadResult(handle.providerJobId, filePath);
    await writeFile(rawResponseRef, `${JSON.stringify(task.providerMetadata)}\n`, "utf8");
    return {
      output: {
        filePath,
        mime: task.output.mime,
        width: task.output.width,
        height: task.output.height,
        durationSeconds: task.output.durationSeconds,
        providerMetadata: structuredClone(task.providerMetadata),
        rights: {
          origin: "generated",
          licensor: "Kling AI",
          providerTermsUrl: "https://klingai.com/terms-of-service",
          restrictions: [],
          confirmedBy: "provider",
        },
      },
      rawResponseRef,
      ...(task.actualCostUsd === undefined ? {} : { actualCostUsd: task.actualCostUsd }),
    };
  }

  public async cancel(handle: AdapterJobHandle): Promise<void> {
    if (this.#stubRequests.delete(handle.providerJobId)) return;
    const api = this.#liveApis.get(handle.providerJobId) ?? await this.#api();
    await api?.cancel(handle.providerJobId);
  }
}
