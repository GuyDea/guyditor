import type { SemanticAnchor } from "../project/index.js";
import type { FrameTime } from "../time/index.js";
import type { DivergenceClass } from "../deliverables/types.js";

export interface SemanticOperation {
  op: string;
  params: Record<string, unknown>;
  summary: string;
  inverse?: { op: string; params: Record<string, unknown> } |
    Array<{ op: string; params: Record<string, unknown> }>;
}

export interface TransactionRecord {
  id: string;
  baseRevision: string;
  resultRevision: string;
  operations: SemanticOperation[];
  instruction: {
    kind: "user-text" | "annotation" | "ui-direct" | "skill-policy";
    text?: string;
    annotation?: string;
  };
  actor: { kind: "human" | "agent" | "tool"; id: string; model?: string };
  versions: {
    app: string;
    schema: string;
    skills: { id: string; version: string }[];
    presets: { id: string; version: number }[];
    tools: { name: string; version: string }[];
  };
  acceptance: {
    status: "accepted" | "auto-accepted-low-risk";
    by: string;
    at: string;
    proposal?: string;
  };
  reason?: string;
  orphanedAnchors: { owner: string; anchor: SemanticAnchor }[];
  addresses: string[];
  divergence?: DivergenceClass;
  undoOf?: string;
  redoOf?: string;
}

export interface RevisionLock {
  revision: string;
  masterSha256: string;
  assets: { id: string; path: string; sha256: string }[];
  sidecars: { name: string; schema: string; sha256: string }[];
  presets: { id: string; version: number; sha256: string }[];
  skills: { id: string; version: string; contentHash: string }[];
  profiles: { id: string; version: string }[];
  templates: { id: string; version: string; contentHash: string }[];
  tools: { name: string; version: string }[];
}

export interface ChangedTimelineRange {
  start: FrameTime;
  end: FrameTime;
  affectedObjects: string[];
}

export interface RevisionComparison {
  a: string;
  b: string;
  lineal: boolean;
  summary: Array<{
    objectId?: string;
    text: string;
    transaction?: string;
    instruction?: TransactionRecord["instruction"];
    actor?: TransactionRecord["actor"];
    reason?: string;
  }>;
  changedRanges: ChangedTimelineRange[];
  previews: Array<{
    range: { start: FrameTime; end: FrameTime };
    framePairs: Array<{ at: FrameTime; aImage?: string; bImage?: string }>;
  }>;
}
