import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { synthesizePromptClip } from "../../../media/src/index.js";

import type {
  AdapterDescriptor,
  AdapterJobHandle,
  AdapterJobStatus,
  BrollProviderAdapter,
  GenerationRequest,
  GenerationResult,
} from "./types.js";

export const DETERMINISTIC_GENERATION_ADAPTER_ID = "adp_stubgenaaa";
export const DETERMINISTIC_GENERATION_ADAPTER_CANONICAL_NAME = ["adp", "stubgen"].join("_");

export class DeterministicGenerationAdapter implements BrollProviderAdapter {
  public readonly descriptor: AdapterDescriptor = {
    adapterId: DETERMINISTIC_GENERATION_ADAPTER_ID,
    canonicalName: DETERMINISTIC_GENERATION_ADAPTER_CANONICAL_NAME,
    adapterVersion: "1.0.0",
    displayName: "Deterministic offline generator",
    provider: "Guyditor deterministic stub",
    local: true,
    availability: "available",
    capabilities: ["generate"],
    modes: ["video"],
    models: [{
      id: "ffmpeg-synth-v1",
      mode: "video",
      maxWidth: 3840,
      maxHeight: 2160,
      maxDurationSec: 30,
      supportsSeed: true,
    }],
    requestSchema: { type: "object", additionalProperties: false, properties: {} },
    dataClassesSent: [],
    maxConcurrent: 2,
  };

  readonly #requests = new Map<string, GenerationRequest>();

  public estimateCost(request: GenerationRequest) {
    return Promise.resolve({
      adapterId: this.descriptor.adapterId,
      currency: "USD",
      amount: 0,
      units: { outputs: request.count, localCompute: 1 },
      confidence: "quote" as const,
    });
  }

  public submit(request: GenerationRequest, signal: AbortSignal): Promise<AdapterJobHandle> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (request.mode !== "video" || request.durationFrames === undefined || request.fps === undefined) {
      throw new TypeError("The deterministic adapter requires video durationFrames and fps.");
    }
    const providerJobId = `stub-${request.requestId}`;
    this.#requests.set(providerJobId, structuredClone(request));
    return Promise.resolve({ adapterId: this.descriptor.adapterId, providerJobId });
  }

  public poll(handle: AdapterJobHandle): Promise<AdapterJobStatus> {
    return Promise.resolve(this.#requests.has(handle.providerJobId)
      ? {
          state: "succeeded",
          providerMetadata: { mode: "deterministic-ffmpeg-stub" },
          actualCostUsd: 0,
        }
      : { state: "failed", error: "Unknown deterministic generation job.", retry: "none" });
  }

  public async fetchResult(
    handle: AdapterJobHandle,
    destinationDirectory: string,
  ): Promise<GenerationResult> {
    const request = this.#requests.get(handle.providerJobId);
    if (request === undefined || request.durationFrames === undefined || request.fps === undefined) {
      throw new Error(`Unknown deterministic generation job ${handle.providerJobId}.`);
    }
    const outputs: GenerationResult["outputs"] = [];
    for (let index = 0; index < request.count; index += 1) {
      const seed = (request.seed ?? 0) + index;
      const filePath = join(destinationDirectory, `candidate-${String(index)}.mp4`);
      const generated = await synthesizePromptClip({
        outputPath: filePath,
        prompt: request.prompt,
        seed,
        width: request.width,
        height: request.height,
        durationFrames: request.durationFrames,
        fps: request.fps,
      });
      outputs.push({
        filePath,
        mime: generated.mime,
        width: generated.width,
        height: generated.height,
        durationSeconds: generated.durationSeconds,
        seed,
        providerMetadata: {
          mode: "deterministic-ffmpeg-stub",
          synthesizer: "lavfi+drawbox-v1",
          parameters: generated.parameters,
        },
        rights: {
          origin: "generated",
          licensor: "Guyditor deterministic stub",
          providerTermsUrl: "https://guyditor.dev/terms/deterministic-stub",
          restrictions: [],
          confirmedBy: "provider",
        },
      });
    }
    const rawResponseRef = join(destinationDirectory, "raw-response.json");
    await writeFile(rawResponseRef, `${JSON.stringify({
      mode: "deterministic-ffmpeg-stub",
      requestId: request.requestId,
      outputs: outputs.map(({ seed, providerMetadata }) => ({ seed, providerMetadata })),
    }, null, 2)}\n`, "utf8");
    return { outputs, rawResponseRef };
  }

  public cancel(handle: AdapterJobHandle): Promise<void> {
    this.#requests.delete(handle.providerJobId);
    return Promise.resolve();
  }
}
