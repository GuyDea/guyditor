import type { FrameTime } from "../time/index.js";

export type RiskClass = "low" | "normal" | "consequential";
export type CaptionImpact = "none" | "shift" | "retime" | "realign";

export interface OperationInput {
  op: string;
  params: Record<string, unknown>;
}

export interface OperationContext {
  baseRevision: string;
  origin: "ui" | "agent" | "system";
  sessionId?: string;
  proposalId?: string;
  dryRun: boolean;
}

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
  affected: string[];
}

export interface ContinuityWarning {
  code:
    | "clipped-phoneme-risk"
    | "ambience-jump"
    | "click-risk"
    | "jump-cut"
    | "caption-realign-required";
  severity: "info" | "warning";
  boundary: { beforeClip?: string; afterClip?: string };
  evidence: string;
  suggestion?: string;
  autoFix?: OperationInput;
}

export interface AppliedOperation {
  op: string;
  params: Record<string, unknown>;
  summary: string;
  inverse: OperationInput[];
  captionImpact: CaptionImpact;
  warnings: ContinuityWarning[];
  affected: string[];
}

export interface SemanticFieldDelta {
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface SemanticDiffEntry {
  summary: string;
  op: string;
  anchors: string[];
  before?: unknown;
  after?: unknown;
  /** M0 entity-level extension used by trim/split/join. */
  entityId: string;
  entityType: "clip" | "effect";
  change: "added" | "removed" | "modified";
  fields: SemanticFieldDelta[];
}

export interface SemanticDiff {
  base: string;
  entries: SemanticDiffEntry[];
  stats: {
    durationDelta: FrameTime;
    clipsAdded: number;
    clipsRemoved: number;
    clipsModified: number;
    affectedLayers: string[];
    affectedWordRanges: { fromWord: string; toWord: string }[];
    affectedDeliverables: string[];
  };
}

export interface OperationBatchResult {
  base: string;
  applied: AppliedOperation[];
  riskClass: RiskClass;
  diff: SemanticDiff;
  transactionId?: string;
}

// TODO(Part 5 §5.12): add risk escalation and deliverable/word-range impact
// once those catalogs and resolvers are available.
