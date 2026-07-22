import type { SemanticAnchor } from "../anchors/types.js";
import type { Rational } from "../time/types.js";

export interface RestyleAdapterConstraints {
  maxSegmentSeconds: number;
  maxResolution: { width: number; height: number };
  fpsSupport: "any" | Rational[];
  costPerSecond: number;
  concurrency: number;
}

export interface RestyleFrameRange {
  /** Inclusive timeline frame. */
  startFrame: number;
  /** Exclusive timeline frame. */
  endFrame: number;
}

export type RestyleCoverage =
  | { mode: "full"; ranges: RestyleFrameRange[] }
  | { mode: "ranges"; ranges: RestyleFrameRange[] };

export type RestyleBoundaryKind =
  | "range-edge"
  | "vad-silence"
  | "word-gap"
  | "beat"
  | "low-motion"
  | "hard-cap";

export interface RestyleSemanticAnchors {
  start: SemanticAnchor;
  end: SemanticAnchor;
  boundaryKind: RestyleBoundaryKind;
  evidence?: string[];
}

export type RestyleChunkStatus =
  | "planned"
  | "queued"
  | "generating"
  | "generated"
  | "approved"
  | "failed"
  | "stale";

export interface RestyleChunk {
  id: string;
  index: number;
  sourceRange: RestyleFrameRange;
  semanticAnchors: RestyleSemanticAnchors;
  durationSeconds: number;
  estimatedCostUsd: number;
  status: RestyleChunkStatus;
  jobId?: string;
  assetId?: string;
  providerJobId?: string;
  error?: string;
  stale?: {
    reason: "source-range-overlap";
    markedAt: string;
    transactionId: string;
  };
}

export type RestyleSeamTreatment =
  | {
      kind: "interstitial";
      templateId: string;
      params: Record<string, unknown>;
      durationFrames: number;
      resumeExact: true;
    }
  | { kind: "punch-in" }
  | { kind: "none" };

export type RestyleSeamBoundary =
  | "internal"
  | "untouched-to-restyled"
  | "restyled-to-untouched";

export type RestyleSeamStatus = "planned" | "applied" | "review";

export interface RestyleSeam {
  id: string;
  /** Exact source-timeline frame at which the boundary occurs. */
  frame: number;
  boundary: RestyleSeamBoundary;
  beforeChunkId?: string;
  afterChunkId?: string;
  treatment: RestyleSeamTreatment;
  status: RestyleSeamStatus;
  application?: {
    chunkId: string;
    atFrame: number;
    itemId?: string;
  };
  review?: {
    reason: "adjacent-chunk-stale" | "treatment-changed";
    markedAt?: string;
    transactionId?: string;
  };
}

export type RestyleSeamDefault =
  | { kind: "interstitial" }
  | { kind: "punch-in" }
  | { kind: "none" };

export interface RestyleSeamPolicy {
  internal: RestyleSeamDefault;
  rangeEdge: RestyleSeamDefault;
  interstitial: {
    templateId: string;
    params: Record<string, unknown>;
    durationFrames: number;
  };
}

export interface RestylePlan {
  schema: "guyditor.restyle/v1";
  id: string;
  deliverableId: string;
  sequenceId: string;
  sourceAssets: Array<{ assetId: string; sha256: string }>;
  adapterId: string;
  model: string;
  createdAt: string;
  coverage: RestyleCoverage;
  constraints: RestyleAdapterConstraints;
  settings: {
    prompt: string;
    negativePrompt?: string;
    seed?: number;
    providerSettings: Record<string, unknown>;
  };
  chunks: RestyleChunk[];
  seams: RestyleSeam[];
  estimatedCost: { currency: "USD"; amount: number };
}

export interface RightsMetadata {
  origin: "captured" | "licensed" | "stock" | "generated" | "programmatic" | "unknown";
  licenseName?: string;
  licenseUrl?: string;
  licensor?: string;
  purchaseRef?: string;
  restrictions: string[];
  attributionText?: string;
  providerTermsUrl?: string;
  confirmedBy?: "creator" | "provider";
  confirmedAt?: string;
}

export interface RestyleGenerationProvenance {
  schema: "guyditor.provenance/v1";
  assetId: string;
  generation: {
    adapterId: string;
    adapterVersion: string;
    provider: string;
    endpoint?: string;
    model: string;
    prompt: string;
    negativePrompt?: string | null;
    settings: Record<string, unknown>;
    settingsSchemaHash?: string;
    seed?: number;
    requestId: string;
    jobId: string;
    referenceAssetIds: string[];
    sourceRange: RestyleFrameRange & { sequenceId: string };
    createdAt: string;
    providerMetadata: Record<string, unknown>;
  };
  rights: RightsMetadata;
  reviewAnnotationId?: string;
  contentHash: string;
}
