export type RenderNodeKind =
  | "source"
  | "trim"
  | "transform"
  | "pip"
  | "key"
  | "composite"
  | "overlay"
  | "audiochain"
  | "encode";

export interface RenderNode {
  id: string;
  kind: RenderNodeKind;
  inputs: string[];
  params: SourceNodeParams | TrimNodeParams | TransformNodeParams | PipNodeParams | KeyNodeParams
        | CompositeNodeParams | OverlayNodeParams | AudioChainNodeParams | EncodeNodeParams;
}

export interface PipNodeParams {
  style: import("../../core/src/index.js").PipStyle;
  styleKeyframes: Array<{
    atOutputFrame: number;
    style: import("../../core/src/index.js").PipStyle | Partial<import("../../core/src/index.js").PipStyle>;
  }>;
  rasterAssets?: {
    maskPath: string;
    underlayPath: string;
    chromePath: string;
    sha256: string;
    durationFrames: number;
  };
}

export interface RenderGraph {
  graphVersion: "guyditor-rg/1";
  revision: string;
  deliverableId: string;
  variant: "burnin" | "clean" | "preview";
  outputFps: string;
  outputSize: { w: number; h: number };
  nodes: RenderNode[];
  toolchain: ToolchainManifest;
}

export interface SourceNodeParams {
  assetId: string;
  assetSha256: string;
  stream: "video" | "audio";
  path: string;
  useProxy: boolean;
  still?: boolean;
  preserveAlpha?: boolean;
}

export interface TrimNodeParams {
  in: { frames: number; fps: string } | { samples: number; rate: number };
  out: { frames: number; fps: string } | { samples: number; rate: number };
  speed?: { num: number; den: number };
  freezeAtFrame?: number;
}

export interface TransformNodeParams {
  keyframes: Array<{
    atOutputFrame: number;
    crop?: [number, number, number, number];
    scale?: number | [number, number];
    pos?: [number, number];
    anchor?: [number, number];
    rotateDeg?: number;
    opacity?: number;
  }>;
  interpolation: "linear" | "easePreset";
  easePresetId?: string;
}

export interface KeyNodeParams {
  method: "chroma" | "neuralMatte" | "alphaMatte";
  keyColor?: string;
  tolerance?: number;
  edgeSoftness?: number;
  spillSuppression?: number;
  garbageMaskAssetId?: string;
  matteAssetId?: string;
  preBlur?: number;
  edge?: { erodePx: number; featherPx: number };
  spill?: { mode: "off" | "despill" | "average"; strength: number; channel?: "green" | "blue" };
  masks?: Array<{
    id: string;
    role: "garbage" | "holdout";
    path: string;
    sha256: string;
    animated: boolean;
  }>;
  postColor?: {
    exposure: number;
    contrast: number;
    temperatureK?: number;
    tint?: number;
    saturation: number;
  };
  matteSource?: "alpha" | "luma";
  invertMatte?: boolean;
}

export interface CompositeNodeParams {
  canvas: { w: number; h: number; background: string };
  mode?: "timeline.sequential" | "timeline.anchored" | "stack";
  durationFrames?: number;
  inputSettings?: Array<{
    atOutputFrame?: number;
    durationFrames: number;
    transitionFromPreviousFrames?: number;
    layerId?: string;
    blend?: "normal" | "multiply" | "screen" | "overlay" | "darken"
      | "lighten" | "addition" | "subtract" | "difference";
    opacity?: number;
  }>;
}

export interface OverlayNodeParams {
  overlayAssetPath: string;
  overlaySha256: string;
  atOutputFrame: number;
  durationFrames: number;
}

export interface AudioChainNodeParams {
  inputSettings?: Array<{
    durationSamples: number;
    transitionFromPreviousSamples?: number;
  }>;
  stages: Array<{
    stage: "gain" | "fade" | "channelmap" | "denoise" | "eq" | "compress"
      | "limit" | "duck" | "loudnorm";
    params: Record<string, number | string | boolean>;
  }>;
}

export interface EncodeNodeParams {
  profileId: string;
  profileVersion: string;
  profileSha256: string;
  vcodec: string;
  vcodecParams: Record<string, string | number>;
  acodec: string;
  abitrate: string;
  pixFmt: string;
  container: "mp4" | "mov" | "webm";
}

export interface ToolchainManifest {
  ffmpeg: { version: string; buildSha256: string };
  ffprobe: { version: string; buildSha256: string };
  renderPackage: string;
  overlayRenderer: {
    version: string;
    canvasVersion: string;
    fontHashes: Record<string, string>;
  };
  encoderThreads: number;
  os: "darwin" | "win32" | "linux";
}
