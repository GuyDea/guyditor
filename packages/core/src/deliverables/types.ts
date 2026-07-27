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
  | "audio"
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
  "audio",
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

export interface FramingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FramingCrop {
  keyframes: Array<{ at: FrameTime; rect: FramingRect }>;
}

export interface FramingOverride {
  id: string;
  decisionId: string;
  crop?: FramingCrop;
  layout?: string;
  note?: string;
}

export type PublishArtifactStatus = "draft" | "approved" | "stale";

export interface PublishMetadataDocument {
  format: "guyditor-publish/v1";
  deliverableId: string;
  profile: string;
  language: string;
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  cta?: string;
  status: PublishArtifactStatus;
  draftedBy?: { agent: string; model: string; skillVersions: Record<string, string> };
  approvedRevision?: string;
}

export interface PublishChapter {
  beatId: string;
  title: string;
  startSeconds: number;
}

export interface PublishChapterList {
  format: "guyditor-chapters/v1";
  deliverableId: string;
  derivedAtRevision: string;
  status: PublishArtifactStatus;
  chapters: PublishChapter[];
  textSha256: string;
  approvedRevision?: string;
  warnings?: string[];
  stale?: {
    transactionId: string;
    revision: string;
    detectedAt: string;
    warning: string;
  };
}

export interface DeliverablePublishState {
  metadata?: PublishMetadataDocument;
  chapters?: PublishChapterList;
  selectedThumbnail?: string;
}
