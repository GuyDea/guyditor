export type TakeQuality = "good" | "bad" | "flubbed" | "unrated";

export type MarkerType =
  | "take-start"
  | "take-end"
  | "good"
  | "bad"
  | "mistake"
  | "note"
  | "chapter"
  | "spoken";

export interface TakeRecord {
  id: string;
  assetId: string;
  index: number;
  range: { start: number; end: number; fps: string };
  quality: TakeQuality;
  notes: string[];
  sourceMarkerIds: string[];
}

export interface MarkerRecord {
  id: string;
  assetId: string;
  at: { frame: number; fps: string } | { start: number; end: number; fps: string };
  type: MarkerType;
  note?: string;
  anchor?: string;
  detected?: boolean;
  source: "json" | "notes" | "spoken";
}

export interface TakeMarkerSidecar {
  format: "guyditor.take-markers/v1";
  assetId: string;
  markers: MarkerRecord[];
  takes: TakeRecord[];
}

export interface TakeComparison {
  id: string;
  slot: {
    beatId?: string;
    scriptSection?: string;
    wordRange?: { fromWord: string; toWord: string };
  };
  candidates: TakeCandidate[];
  recommendation?: {
    takeId: string;
    reasons: Array<{ criterion: string; detail: string; evidence: string }>;
    confidence: "low" | "medium" | "high";
  };
  selectedTakeId?: string;
  createdAt: string;
}

export interface TakeCandidate {
  takeId: string;
  assetId: string;
  sourceRange: {
    in: { frames: number; fps: string };
    out: { frames: number; fps: string };
  };
  transcriptText: string;
  scriptMatch?: { score: number; deviations: string[] };
  delivery: {
    wordsPerMinute: number;
    fillerCount: number;
    pauseRatio: number;
    energyVariance: number;
    restartCount: number;
  };
  technical: {
    audioClippingPct: number;
    noiseFloorDb: number;
    focusScore?: number;
    exposureScore?: number;
    framingScore?: number;
  };
  preference: { score: number; rubricId: string; rubricVersion: string };
  markers: { qualityFlags: string[]; notes: string[] };
}
