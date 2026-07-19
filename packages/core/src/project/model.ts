import type {
  FrameTime,
  Rational,
  SampleTime,
  TimeValue,
} from "../time/index.js";

import type {
  AnchorLastResolved,
  SemanticAnchor,
} from "../anchors/types.js";

export type { AnchorRange, SemanticAnchor } from "../anchors/types.js";

export type AnchorMetadata = Partial<Record<
  "/anchor" | "/at" | "/duration/until",
  { lastResolved: AnchorLastResolved }
>>;

export interface GuyditorProject {
  format: "guyditor/v1";
  revision: string;
  project: { id: string; name: string; created: string };
  settings: ProjectSettings;
  transcript: { nextWordOrdinal: number };
  assets: Asset[];
  beats: Beat[];
  sequences: Sequence[];
  layers: Layer[];
  captions: CaptionTrack[];
  annotations: AnnotationIndex;
  deliverables: Deliverable[];
  templates?: Record<string, { version: string; contentHash: string }>;
  avoidRegions?: AvoidRegion[];
  watchFolders?: unknown[];
  presets: PresetPin[];
  skills: SkillPin[];
  sidecars: SidecarRef[];
}

export interface ProjectSettings {
  timeline: { fps: Rational; width: number; height: number };
  audio: { sampleRate: number; channels: number };
  primaryDeliverable: string;
  automation?: unknown;
}

export interface Asset {
  id: string;
  kind:
    | "video"
    | "audio"
    | "image"
    | "animation"
    | "subtitle"
    | "generated"
    | "other";
  path: string;
  knownPaths?: string[];
  sha256: string;
  bytes?: number;
  container?: string;
  probe: {
    duration?: TimeValue;
    width?: number;
    height?: number;
    fps?: Rational;
    audio?: { rate: number; channels: number };
    capturedAt?: string;
  };
  video?: {
    codec: string;
    width: number;
    height: number;
    fps: Rational;
    pixFmt: string;
    hasAlpha: boolean;
    rotation: 0 | 90 | 180 | 270;
    colorSpace?: string;
    bitrate?: number;
  };
  audio?: Array<{
    index: number;
    codec: string;
    sampleRate: number;
    channels: number;
    layout: string;
    bitrate?: number;
  }>;
  image?: { width: number; height: number; hasAlpha: boolean };
  captureTime?: {
    value: string;
    source: "container" | "file-mtime";
  };
  timecode?: { start: string; fps: Rational };
  session?: string;
  takes?: string[];
  markers?: string[];
  analyses?: Record<string, unknown>;
  sync?: unknown;
  integrity?: "ok" | "missing" | "mismatch";
  ingest?: {
    at: string;
    ffprobeVersion: string;
    via: "manual" | "watch" | "pickup" | "agent" | "generated";
  };
  provenance?: { sidecar: string };
  rights?: { source: string; license: string; restrictions?: string };
}

export interface Beat {
  id: string;
  name: string;
  anchor: SemanticAnchor;
  anchorMetadata?: AnchorMetadata;
  chapter?: { title: string };
}

export interface Sequence {
  id: string;
  name: string;
  clips: Clip[];
  audio?: { targetLufs: number; truePeakDb: number };
}

export interface Clip {
  id: string;
  asset: string;
  source: { in: FrameTime; out: FrameTime };
  gapBefore?: FrameTime;
  overlapPrevious?: FrameTime;
  transitionAfter?: Transition;
  effects?: Effect[];
  audio?: {
    gainDb?: number;
    fadeIn?: FrameTime;
    fadeInCurve?: string;
    fadeOut?: FrameTime;
    fadeOutCurve?: string;
    mute?: boolean;
    offset?: SampleTime;
    channels?: "left" | "right" | "mix" | number[];
    chain?: unknown;
  };
  loop?: { enabled: boolean; crossfade?: FrameTime };
  anchor?: SemanticAnchor;
  anchorMetadata?: AnchorMetadata;
  punchIn?: {
    level: number;
    anchor: { x: number; y: number } | "face-track";
  };
}

export interface Transition {
  id: string;
  preset: string;
  duration: FrameTime;
  params?: Record<string, unknown>;
  intent?: string;
}

export interface Effect {
  id: string;
  kind: string;
  params: Record<string, unknown>;
}

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "addition"
  | "subtract"
  | "difference";

export interface Transform2D {
  anchor: { x: number; y: number };
  position: { x: number; y: number };
  scale: { x: number; y: number };
  rotationDeg: number;
  crop?: { x: number; y: number; w: number; h: number };
}

export interface ColorCorrection {
  exposure: number;
  contrast: number;
  temperatureK?: number;
  tint?: number;
  saturation: number;
}

export interface ChromaKeyParams {
  keyColor: string;
  tolerance: number;
  softness: number;
  preBlur: number;
  edge: { erodePx: number; featherPx: number };
  spill: { mode: "off" | "despill" | "average"; strength: number };
}

export interface NeuralMatteParams {
  model: "rvm_mobilenetv3" | "rvm_resnet50";
  matteAssetId?: string;
  downsampleRatio: number;
  stabilization: {
    enabled: boolean;
    alphaMin: number;
    motionGain: number;
    minSpeckleArea: number;
  };
}

export interface KeyMask {
  id: string;
  role: "garbage" | "holdout";
  shape: "rect" | "ellipse" | "polygon";
  points: Array<{ x: number; y: number }>;
  featherPx: number;
  frames?: { from: number; to: number };
}

export interface KeySettings {
  schema: "guyditor/key@1";
  mode: "off" | "chroma" | "neural";
  chroma?: ChromaKeyParams;
  neural?: NeuralMatteParams;
  masks: KeyMask[];
  postColor?: ColorCorrection;
}

export type AnchorName =
  | "top_left"
  | "top"
  | "top_right"
  | "left"
  | "center"
  | "right"
  | "bottom_left"
  | "bottom"
  | "bottom_right";

export interface ShapeMask {
  shape: "none" | "rect" | "rounded" | "circle" | "ellipse";
  cornerRadius?: number;
  featherPx?: number;
}

export interface PipStyle {
  mask: ShapeMask;
  border?: { widthPx: number; color: string; opacity: number };
  shadow?: {
    dx: number;
    dy: number;
    blurPx: number;
    color: string;
    opacity: number;
  };
  background?: { color?: string; blurSigma?: number; padPx?: number };
  deviceFrame?: { templateId: string; params?: Record<string, unknown> };
}

export interface PlacementConstraints {
  anchor: AnchorName;
  width?: string;
  height?: string;
  margin?: string;
  margin_x?: string;
  margin_y?: string;
  offset_x?: string;
  offset_y?: string;
  aspect?: string;
  fit?: "contain" | "cover" | "stretch";
}

export type AspectClass = "16:9" | "9:16" | "1:1" | "4:5";

export interface ResponsivePlacement {
  base: PlacementConstraints;
  overrides?: Partial<Record<AspectClass, Partial<PlacementConstraints>>>;
}

export interface PipTransition {
  preset: string;
  durationFrames: number;
  params?: { direction?: "left" | "right" | "up" | "down"; overshoot?: number };
}

export interface PipKeyframe {
  id: string;
  at: SemanticAnchor;
  placement: PlacementConstraints;
  style?: Partial<PipStyle>;
  transition?: PipTransition;
}

export interface AvoidSolverConfig {
  enabled: boolean;
  sources: Array<AvoidRegion["source"]>;
  softOverlapMax: number;
  holdFrames: number;
  fallbackAnchors: AnchorName[];
  moveTransition: { preset: string; durationFrames: number };
}

export interface PipConfig {
  style: PipStyle;
  placement: ResponsivePlacement;
  keyframes: PipKeyframe[];
  avoid?: AvoidSolverConfig;
}

export interface AvoidRegion {
  id: string;
  source: "caption" | "face" | "subject" | "marked" | "safe_area" | "cursor" | "diagram";
  hardness: "hard" | "soft";
  rect: { x: number; y: number; w: number; h: number };
  frames?: { from: number; to: number };
  fromAnnotation?: string;
}

export interface Layer {
  id: string;
  kind:
    | "video"
    | "image"
    | "animation"
    | "text"
    | "caption"
    | "matte"
    | "adjustment"
    | "audio"
    | "music"
    | "ambience"
    | "sfx";
  name: string;
  order: number;
  enabled: boolean;
  locked: boolean;
  opacity?: number;
  blend?: BlendMode;
  transform?: Transform2D;
  matte?: { layerId: string; source: "alpha" | "luma"; invert?: boolean };
  pip?: PipConfig;
  adjustment?: ColorCorrection;
  ducking?: unknown;
  sequence?: string;
  items?: PlacedItem[];
}

export interface PlacedItem {
  id: string;
  asset?: string;
  template?: string;
  at: SemanticAnchor;
  duration: FrameTime | { until: SemanticAnchor } | "intrinsic";
  anchorMetadata?: AnchorMetadata;
  source?: { in: FrameTime; out: FrameTime } | { annotationId: string };
  effects?: Effect[];
  params?: Record<string, unknown>;
  seed?: number;
  layout?: Record<string, unknown>;
}

export interface CaptionTrack {
  id: string;
  name: string;
  sourceLayerIds: string[];
  preset: { presetId: string; version: number };
  styleOverrides: Partial<CaptionStyle>;
  breakOverrides: CueBreakOverride[];
  emphasisOverrides: { wordId: string; emphasis: boolean }[];
  timingOffsets: {
    firstWordId: string;
    startMs?: number;
    endMs?: number;
  }[];
  enabled: boolean;
}

export interface CueBreakOverride {
  afterWordId: string;
  kind: "line" | "cue" | "join";
}

export interface CaptionStyle {
  typeface: {
    family: string;
    fontAssetId: string;
    fallbackAssetIds: string[];
  };
  sizePct: number;
  weight: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
  italic: boolean;
  letterSpacingPct: number;
  lineSpacing: number;
  color: string;
  outline: { color: string; widthPct: number } | null;
  shadow: {
    color: string;
    dxPct: number;
    dyPct: number;
    blurPct: number;
  } | null;
  background: {
    color: string;
    padXPct: number;
    padYPct: number;
    radiusPct: number;
    scope: "word" | "line" | "block";
  } | null;
  transform: "none" | "upper" | "lower" | "title";
  wordsPerLine: number;
  maxLines: 1 | 2 | 3;
  maxWidthPct: number;
  placement: {
    anchor: "top" | "middle" | "bottom";
    offsetYPct: number;
    align: "left" | "center" | "right";
  };
  safeArea: "platform" | "none";
  highlight: {
    mode: "per-word" | "per-line" | "none";
    style: "color" | "scale" | "weight" | "underline" | "background";
    color?: string;
    scale?: number;
    weight?: number;
    pastWords: "keep" | "dim";
    dimOpacity?: number;
    maxGapMs: number;
    holdMs: number;
    leadInMs: number;
  };
  emphasisStyle: {
    style: "color" | "scale" | "weight" | "underline";
    color?: string;
    scale?: number;
    weight?: number;
  };
  cueGapMs: number;
  maxCueDurationMs: number;
  speakerStyles: Record<string, Partial<CaptionStyle>>;
}

export interface AnnotationIndex {
  sidecar: string;
  summary: {
    open: number;
    resolved: number;
    rejected: number;
    reopened: number;
  };
}

export interface Deliverable {
  id: string;
  kind: "longform" | "short";
  name: string;
  profile: string;
  profileOverrides?: Record<string, unknown>;
  sequenceId: string;
  captionsTrackId?: string;
  status: "draft" | "in-review" | "approved" | "stale";
  approvedRevision?: string;
  dependencies?: unknown[];
  divergences?: { class: string; transactionIds: string[] }[];
  staleReasons?: unknown[];
  publishFiles?: { path: string; sha256: string }[];
}

export interface PresetPin {
  id: string;
  name: string;
  kind: "caption" | "transition" | "look" | "motion" | "layout" | "graphic";
  version: number;
  path: string;
  sha256: string;
}

export interface SkillPin {
  id: string;
  name: string;
  version: string;
  path: string;
  contentHash: string;
}

export interface SidecarRef {
  name: string;
  path: string;
  schema: string;
  sha256: string;
  generatedBy?: { tool: string; version: string; job?: string };
  inputs: { asset?: string; sidecar?: string; sha256: string }[];
}
