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
