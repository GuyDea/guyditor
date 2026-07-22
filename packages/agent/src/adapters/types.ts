import type {
  RestyleAdapterConstraints,
  RestyleFrameRange,
  RightsMetadata,
} from "../../../core/src/index.js";
import type { DataClass } from "../audit-types.js";
import type { CostEstimate } from "../cost-meter.js";

export interface AdapterDescriptor {
  adapterId: string;
  canonicalName: string;
  adapterVersion: string;
  displayName: string;
  provider: string;
  local: boolean;
  capabilities: Array<"generate" | "restyle">;
  modes: Array<"image" | "video">;
  models: Array<{
    id: string;
    mode: "video";
    maxWidth: number;
    maxHeight: number;
    maxDurationSec: number;
    supportsSeed: boolean;
  }>;
  requestSchema: object;
  dataClassesSent: DataClass[];
  maxConcurrent: number;
}

export interface GenerationRequest {
  requestId: string;
  mode: "image" | "video";
  model: string;
  prompt: string;
  negativePrompt?: string;
  referenceAssetIds?: string[];
  width: number;
  height: number;
  durationFrames?: number;
  fps?: string;
  seed?: number;
  count: number;
  providerSettings: Record<string, unknown>;
}

export interface GenerationResult {
  outputs: Array<{
    filePath: string;
    mime: string;
    width: number;
    height: number;
    durationSeconds?: number;
    seed?: number;
    providerMetadata: Record<string, unknown>;
    rights?: Partial<RightsMetadata>;
  }>;
  rawResponseRef: string;
}

export interface QuotaInfo {
  remainingRequests?: number;
  ratePerMinute?: number;
  resetAt?: string;
}

export interface RestyleRequest {
  requestId: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  inputFilePath: string;
  inputMime: string;
  referenceAssetIds: string[];
  sourceRange: RestyleFrameRange & { sequenceId: string };
  width: number;
  height: number;
  fps: string;
  durationSeconds: number;
  seed?: number;
  providerSettings: Record<string, unknown>;
}

export interface AdapterJobHandle {
  adapterId: string;
  providerJobId: string;
  opaque?: string;
}

export type AdapterJobStatus =
  | { state: "queued" | "running"; progress?: number; etaSeconds?: number }
  | {
      state: "succeeded";
      providerMetadata: Record<string, unknown>;
      actualCostUsd?: number;
    }
  | { state: "failed"; error: string; retry: "safe" | "unsafe" | "none" };

export interface RestyleResult {
  output: {
    filePath: string;
    mime: string;
    width: number;
    height: number;
    durationSeconds: number;
    seed?: number;
    providerMetadata: Record<string, unknown>;
    rights: Partial<RightsMetadata>;
  };
  rawResponseRef: string;
  actualCostUsd?: number;
}

export interface RestyleAdapter {
  readonly descriptor: AdapterDescriptor;
  readonly constraints: RestyleAdapterConstraints;
  estimateCost(request: RestyleRequest): Promise<CostEstimate>;
  restyle(request: RestyleRequest, signal: AbortSignal): Promise<AdapterJobHandle>;
  poll(handle: AdapterJobHandle): Promise<AdapterJobStatus>;
  fetchResult(handle: AdapterJobHandle, destinationDirectory: string): Promise<RestyleResult>;
  cancel?(handle: AdapterJobHandle): Promise<void>;
  quota?(): Promise<QuotaInfo>;
}

/** Part 7 §7.8 generation capability retained alongside Amendment 001 restyle. */
export interface BrollProviderAdapter {
  readonly descriptor: AdapterDescriptor;
  estimateCost(request: GenerationRequest): Promise<CostEstimate>;
  submit(request: GenerationRequest, signal: AbortSignal): Promise<AdapterJobHandle>;
  poll(handle: AdapterJobHandle): Promise<AdapterJobStatus>;
  fetchResult(handle: AdapterJobHandle, destinationDirectory: string): Promise<GenerationResult>;
  cancel?(handle: AdapterJobHandle): Promise<void>;
  quota?(): Promise<QuotaInfo>;
}

export type ProviderAdapter = BrollProviderAdapter | RestyleAdapter;

export interface AdapterUserConfig {
  enabled: boolean;
  baseUrl?: string;
  apiKeyRef?: string;
  model?: string;
  [key: string]: unknown;
}
