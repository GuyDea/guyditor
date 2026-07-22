import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CredentialStore } from "./credentials.js";
import { HttpHttpGenerationApi } from "./http-generation-api.js";
import type {
  HttpGenerationApi,
  HttpGenerationPaths,
} from "./http-generation-api.js";
import type {
  AdapterDescriptor,
  AdapterJobHandle,
  AdapterJobStatus,
  BrollProviderAdapter,
  GenerationRequest,
  GenerationResult,
} from "./types.js";

export const HTTP_GENERATION_ADAPTER_ID = "adp_httpgenaaa";
export const HTTP_GENERATION_ADAPTER_CANONICAL_NAME = ["adp", "httpgen"].join("_");

export interface HttpGenerationAdapterConfig {
  enabled?: boolean;
  apiKeyRef: string;
  baseUrl: string;
  paths?: Partial<HttpGenerationPaths>;
  models: Array<{ id: string; mode: "image" | "video" }>;
  pricing: {
    currency: "USD";
    imagePerOutput?: Record<string, number>;
    videoPerSecond?: Record<string, number>;
  };
  providerTermsUrl?: string;
}

export interface HttpGenerationAdapterOptions {
  credentials: CredentialStore;
  config: HttpGenerationAdapterConfig;
  apiFactory?: (input: { apiKey: string; baseUrl: string }) => HttpGenerationApi;
}

interface SubmittedRequest {
  request: GenerationRequest;
  api: HttpGenerationApi;
  imageResponse?: Awaited<ReturnType<HttpGenerationApi["createImages"]>>;
}

function fpsNumber(value: string): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(value);
  if (match === null) throw new TypeError(`Invalid frame rate ${value}.`);
  return Number(match[1]) / Number(match[2]);
}

export class HttpGenerationAdapter implements BrollProviderAdapter {
  public readonly descriptor: AdapterDescriptor;
  readonly #credentials: CredentialStore;
  readonly #config: HttpGenerationAdapterConfig;
  readonly #apiFactory: NonNullable<HttpGenerationAdapterOptions["apiFactory"]>;
  readonly #submitted = new Map<string, SubmittedRequest>();

  public constructor(options: HttpGenerationAdapterOptions) {
    this.#credentials = options.credentials;
    this.#config = structuredClone(options.config);
    this.#apiFactory = options.apiFactory ?? ((input) => new HttpHttpGenerationApi({
      ...input,
      ...(options.config.paths === undefined ? {} : { paths: options.config.paths }),
    }));
    const available = options.config.enabled !== false;
    this.descriptor = {
      adapterId: HTTP_GENERATION_ADAPTER_ID,
      canonicalName: HTTP_GENERATION_ADAPTER_CANONICAL_NAME,
      adapterVersion: "1.0.0",
      displayName: "Generic HTTP generator",
      provider: "openai-compatible",
      local: false,
      availability: available ? "available" : "declared-unavailable",
      ...(available ? {} : {
        unavailableReason: "No enabled HTTP generation provider is configured.",
      }),
      capabilities: ["generate"],
      modes: [...new Set(options.config.models.map(({ mode }) => mode))],
      models: options.config.models.map((model) => ({
        ...model,
        maxWidth: 4096,
        maxHeight: 4096,
        ...(model.mode === "video" ? { maxDurationSec: 60 } : {}),
        supportsSeed: true,
      })),
      requestSchema: { type: "object", additionalProperties: true },
      dataClassesSent: ["prompt", "metadata"],
      maxConcurrent: 2,
    };
  }

  async #api(): Promise<HttpGenerationApi> {
    const apiKey = await this.#credentials.get(
      this.descriptor.adapterId,
      this.#config.apiKeyRef,
    );
    if (apiKey === undefined) throw new Error("HTTP generation credential is unavailable.");
    return this.#apiFactory({ apiKey, baseUrl: this.#config.baseUrl });
  }

  public estimateCost(request: GenerationRequest) {
    let amount = 0;
    const units: Record<string, number> = { outputs: request.count };
    if (request.mode === "image") {
      const size = `${String(request.width)}x${String(request.height)}`;
      const price = this.#config.pricing.imagePerOutput?.[size] ??
        this.#config.pricing.imagePerOutput?.["default"] ?? 0;
      amount = price * request.count;
      units["images"] = request.count;
    } else {
      if (request.durationFrames === undefined || request.fps === undefined) {
        throw new TypeError("Video cost estimation requires durationFrames and fps.");
      }
      const seconds = request.durationFrames / fpsNumber(request.fps);
      const price = this.#config.pricing.videoPerSecond?.[request.model] ??
        this.#config.pricing.videoPerSecond?.["default"] ?? 0;
      amount = price * seconds * request.count;
      units["seconds"] = seconds * request.count;
    }
    return Promise.resolve({
      adapterId: this.descriptor.adapterId,
      currency: this.#config.pricing.currency,
      amount: Math.round((amount + Number.EPSILON) * 1_000_000) / 1_000_000,
      units,
      confidence: "pricebook" as const,
    });
  }

  public async submit(
    request: GenerationRequest,
    signal: AbortSignal,
  ): Promise<AdapterJobHandle> {
    const api = await this.#api();
    if (request.mode === "image") {
      const imageResponse = await api.createImages(request, signal);
      this.#submitted.set(imageResponse.providerJobId, {
        request: structuredClone(request),
        api,
        imageResponse,
      });
      return { adapterId: this.descriptor.adapterId, providerJobId: imageResponse.providerJobId };
    }
    const { providerJobId } = await api.createVideo(request, signal);
    this.#submitted.set(providerJobId, { request: structuredClone(request), api });
    return { adapterId: this.descriptor.adapterId, providerJobId };
  }

  public async poll(handle: AdapterJobHandle): Promise<AdapterJobStatus> {
    const submitted = this.#submitted.get(handle.providerJobId);
    if (submitted === undefined) {
      return { state: "failed", error: "Unknown HTTP generation job.", retry: "safe" };
    }
    if (submitted.imageResponse !== undefined) {
      return { state: "succeeded", providerMetadata: submitted.imageResponse.rawResponse };
    }
    const status = await submitted.api.getVideo(handle.providerJobId);
    if (status.state === "failed") {
      return { state: "failed", error: status.error ?? "HTTP video generation failed.", retry: "safe" };
    }
    if (status.state === "queued" || status.state === "running") {
      return { state: status.state, ...(status.progress === undefined ? {} : { progress: status.progress }) };
    }
    return {
      state: "succeeded",
      providerMetadata: status.providerMetadata,
      ...(status.actualCostUsd === undefined ? {} : { actualCostUsd: status.actualCostUsd }),
    };
  }

  public async fetchResult(
    handle: AdapterJobHandle,
    destinationDirectory: string,
  ): Promise<GenerationResult> {
    const submitted = this.#submitted.get(handle.providerJobId);
    if (submitted === undefined) throw new Error(`Unknown HTTP generation job ${handle.providerJobId}.`);
    await mkdir(destinationDirectory, { recursive: true });
    const outputs: GenerationResult["outputs"] = [];
    let raw: Record<string, unknown>;
    if (submitted.imageResponse !== undefined) {
      raw = submitted.imageResponse.rawResponse;
      for (const [index, output] of submitted.imageResponse.outputs.entries()) {
        const filePath = join(destinationDirectory, `candidate-${String(index)}.png`);
        await writeFile(filePath, Buffer.from(output.base64, "base64"));
        outputs.push({
          filePath,
          mime: "image/png",
          width: submitted.request.width,
          height: submitted.request.height,
          ...(submitted.request.seed === undefined
            ? {}
            : { seed: submitted.request.seed + index }),
          providerMetadata: structuredClone(output.providerMetadata),
          rights: {
            origin: "generated",
            licensor: this.descriptor.provider,
            ...(this.#config.providerTermsUrl === undefined
              ? {}
              : { providerTermsUrl: this.#config.providerTermsUrl }),
            restrictions: [],
            confirmedBy: "provider",
          },
        });
      }
    } else {
      const bytes = await submitted.api.downloadVideo(handle.providerJobId);
      const filePath = join(destinationDirectory, "candidate-0.mp4");
      await writeFile(filePath, bytes);
      const durationSeconds = submitted.request.durationFrames === undefined ||
          submitted.request.fps === undefined
        ? undefined
        : submitted.request.durationFrames / fpsNumber(submitted.request.fps);
      const status = await submitted.api.getVideo(handle.providerJobId);
      raw = status.providerMetadata;
      outputs.push({
        filePath,
        mime: "video/mp4",
        width: submitted.request.width,
        height: submitted.request.height,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        ...(submitted.request.seed === undefined ? {} : { seed: submitted.request.seed }),
        providerMetadata: status.providerMetadata,
        rights: {
          origin: "generated",
          licensor: this.descriptor.provider,
          ...(this.#config.providerTermsUrl === undefined
            ? {}
            : { providerTermsUrl: this.#config.providerTermsUrl }),
          restrictions: [],
          confirmedBy: "provider",
        },
      });
    }
    const rawResponseRef = join(destinationDirectory, "raw-response.json");
    await writeFile(rawResponseRef, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    return { outputs, rawResponseRef };
  }

  public async cancel(handle: AdapterJobHandle): Promise<void> {
    const submitted = this.#submitted.get(handle.providerJobId);
    await submitted?.api.cancel?.(handle.providerJobId);
  }
}
