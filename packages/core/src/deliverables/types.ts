import type { FrameTime } from "../time/index.js";

export type DeliverableKind = "longform" | "short";
export type DeliverableStatus = "draft" | "in-review" | "approved" | "stale";
export type DivergenceClass =
  | "hook"
  | "order"
  | "pacing"
  | "cuts"
  | "graphics"
  | "captions"
  | "cta"
  | "ending"
  | "framing";

export const DIVERGENCE_CLASSES = Object.freeze([
  "hook",
  "order",
  "pacing",
  "cuts",
  "graphics",
  "captions",
  "cta",
  "ending",
  "framing",
] as const satisfies readonly DivergenceClass[]);

export interface WordRange {
  startWordId: string;
  endWordId: string;
}

export interface SourceRangeRef {
  assetId: string;
  range: { start: FrameTime; end: FrameTime };
  words?: WordRange;
  longformClipId?: string;
}

export interface DependencyEntry {
  derivativeClipId: string;
  source: SourceRangeRef;
}

export interface StaleReason {
  transactionId: string;
  revision: string;
  affected: Array<{ dependency: DependencyEntry; change: string }>;
  detectedAt: string;
}

export interface DeliverableDivergence {
  class: DivergenceClass;
  transactionIds: string[];
}
