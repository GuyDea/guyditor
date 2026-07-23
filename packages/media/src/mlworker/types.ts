import type {
  GuyditorError,
  JsonValue,
  Result,
} from "../../../core/src/index.js";

export type MlworkerTaskMethod = "align" | "matte" | "track" | "transcribe" | "vad";

export interface MlworkerCapability {
  task: string;
  engine: string;
  engineVersion: string;
  models?: string[];
}

export interface MlworkerDevice {
  type: "cpu" | "cuda" | "mps";
  name?: string;
  vramMb?: number;
}

export interface MlworkerHello {
  protocol: number;
  workerVersion: string;
  python: string;
  device: MlworkerDevice;
  capabilities: MlworkerCapability[];
}

export interface MlworkerProgress {
  taskId: string;
  progress: number;
  stage?: string;
}

export type MlworkerState =
  | "stopped"
  | "starting"
  | "ready"
  | "restarting"
  | "unavailable";

export interface MlworkerStateEvent {
  kind: "mlworker.state";
  state: MlworkerState;
  failureCount: number;
  reason?: string;
}

export interface MlworkerRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: MlworkerProgress) => void;
}

export interface MlworkerTaskRunner {
  runTask(
    method: MlworkerTaskMethod,
    params: Record<string, JsonValue>,
    options?: MlworkerRunOptions,
  ): Promise<Result<JsonValue>>;
}

export interface SampleTime {
  samples: number;
  rate: number;
}

export interface MlworkerWord {
  text: string;
  start: SampleTime;
  end: SampleTime;
  probability: number;
}

export interface MlworkerSegment {
  index: number;
  start: SampleTime;
  end: SampleTime;
  text: string;
  avgLogprob: number;
  noSpeechProb: number;
  words: MlworkerWord[];
}

export interface MlworkerTranscribeResult {
  language: string;
  languageProbability: number;
  duration: SampleTime;
  segments: MlworkerSegment[];
  engine: { name: string; version: string; model: string };
}

export interface MlworkerAlignedToken {
  segmentIndex: number;
  tokenIndex: number;
  start: SampleTime;
  end: SampleTime;
  score: number;
  aligned: boolean;
}

export interface MlworkerAlignResult {
  tokens: MlworkerAlignedToken[];
  engine: { name: string; version: string; model: string };
}

export interface MlworkerVadInterval {
  start: number;
  end: number;
}

export interface MlworkerVadResult {
  duration: number;
  speech: MlworkerVadInterval[];
  silence: MlworkerVadInterval[];
  engine: { name: string; version: string };
}

export type MlworkerTrackKind = "face" | "body" | "object" | "screen-region";

export interface MlworkerTrackBox {
  kind: MlworkerTrackKind;
  trackId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface MlworkerTrackSample {
  frame: number;
  boxes: MlworkerTrackBox[];
}

export interface MlworkerTrackResult {
  frameCount: number;
  width: number;
  height: number;
  fps: number;
  sampleEvery: number;
  samples: MlworkerTrackSample[];
  engine: { name: "mediapipe"; version: string };
}

export interface MlworkerMatteResult {
  schema: "guyditor.matte/v1";
  path: string;
  format: "ffv1-gray-mkv";
  sha256: string;
  cacheKey: string;
  source: {
    path: string;
    sha256: string;
    frames: { from: number; to: number };
  };
  width: number;
  height: number;
  frameCount: number;
  fps: string;
  alpha: { minimum: number; maximum: number; nonZeroFrames: number };
  engine: { name: "rvm"; version: string; model: "rvm_mobilenetv3" | "rvm_resnet50" };
  params: {
    model: "rvm_mobilenetv3" | "rvm_resnet50";
    downsampleRatio: number;
    stabilization: {
      enabled: boolean;
      alphaMin: number;
      motionGain: number;
      minSpeckleArea: number;
    };
  };
}

export type MlworkerError = GuyditorError;
