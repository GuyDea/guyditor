import type {
  CaptionStyle,
  CaptionTrack,
  GuyditorProject,
} from "../../../core/src/index.js";
import type { TranscriptSidecar } from "../types.js";

export type RationalSec = { num: number; den: number };

export interface WordInstance {
  wordId: string;
  clipId: string;
  layerId: string;
  /** Internal derived boundary used to clamp cue lead-in without rounding. */
  clipStart?: RationalSec;
  start: RationalSec;
  end: RationalSec;
  truncated: boolean;
}

export interface SyncDiagnostics {
  clippedWords: { wordId: string; clipId: string; coverage: number }[];
  ambiguousRanges: { start: RationalSec; end: RationalSec; layerIds: string[] }[];
  provisionalAssetIds?: string[];
  orphanedAnchors: {
    anchor: string;
    owner: string;
    reason: "deleted" | "unmapped" | "approximate";
  }[];
}

export interface WordTimelineMap {
  sequenceId: string;
  instances: WordInstance[];
  diagnostics: SyncDiagnostics;
}

export interface NormRect { x: number; y: number; w: number; h: number }

export type CaptionWordState = "past" | "current" | "future";

export interface CaptionCueWord {
  wordId: string;
  displayText: string;
  start: RationalSec;
  end: RationalSec;
  highlightStart: RationalSec;
  highlightEnd: RationalSec;
  startFrame: number;
  endFrame: number;
  emphasized: boolean;
  box: NormRect;
}

export interface CaptionCueLine {
  box: NormRect;
  words: CaptionCueWord[];
}

export interface CaptionCue {
  firstWordId: string;
  clipId: string;
  speakerId: string;
  speakerLabel: string;
  start: RationalSec;
  end: RationalSec;
  startFrame: number;
  endFrame: number;
  box: NormRect;
  lines: CaptionCueLine[];
  overflow: string[];
}

export interface CaptionFrameSpec {
  cues: {
    firstWordId: string;
    box: NormRect;
    lines: {
      box: NormRect;
      words: {
        wordId: string;
        displayText: string;
        state: CaptionWordState;
        emphasized: boolean;
        box: NormRect;
      }[];
    }[];
  }[];
  styleResolved: CaptionStyle;
}

export interface CaptionRenderModel {
  trackId: string;
  outputs: { width: number; height: number; fps: string };
  cues: CaptionCue[];
  diagnostics: SyncDiagnostics;
  captionsAtFrame(frame: number): CaptionFrameSpec;
  styleResolved: CaptionStyle;
}

export interface CaptionPreset {
  format: "guyditor.caption-preset/v1";
  presetId: string;
  name: string;
  version: number;
  style: CaptionStyle;
}

export interface BuildWordTimelineMapOptions {
  project: GuyditorProject;
  sequenceId: string;
  track: CaptionTrack;
  sidecars: readonly TranscriptSidecar[];
}

export interface CompileCaptionTrackOptions {
  track: CaptionTrack;
  timeline: WordTimelineMap;
  sidecars: readonly TranscriptSidecar[];
  style: CaptionStyle;
  safeArea: NormRect;
  output: { width: number; height: number; fps: string };
  measureText?: (text: string, fontPx: number, style: CaptionStyle) => number;
  maxCharsPerLine?: number;
}

export interface DerivativeCaptionProfile {
  video: {
    resolution: { width: number; height: number };
    fps: { default: string };
  };
  safeAreas: {
    title: { top: number; bottom: number; left: number; right: number };
  };
  captionDefaults: {
    fontSizePct?: number;
    weight?: CaptionStyle["weight"];
    maxLines: 1 | 2 | 3;
    maxCharsPerLine: number;
    placement: { anchor: "left" | "center" | "right"; verticalCenter: number };
    perWordHighlight: boolean;
  };
}

export interface CompileDerivativeCaptionTrackOptions {
  track: CaptionTrack;
  timeline: WordTimelineMap;
  sidecars: readonly TranscriptSidecar[];
  presetStyle: CaptionStyle;
  profile: DerivativeCaptionProfile;
  measureText?: CompileCaptionTrackOptions["measureText"];
}

export interface SubtitleExportOptions {
  format: "srt" | "vtt";
  vttWordTimestamps: boolean;
  vttPositioning: boolean;
  includeSpeakerLabels: boolean;
}

export interface ImportSubtitleOptions {
  format: "srt" | "vtt";
  assetId: string;
  firstWordOrdinal: number;
  sampleRate: number;
  now: string;
  jobId: string;
}

export interface ImportedSubtitle {
  sidecar: TranscriptSidecar;
  provisional: true;
  nextWordOrdinal: number;
}
