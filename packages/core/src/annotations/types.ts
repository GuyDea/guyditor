import type { FrameTime } from "../time/index.js";

export type SourceTime = FrameTime;

export type AnnotationShape =
  | "note"
  | "pin"
  | "rect"
  | "ellipse"
  | "arrow"
  | "freehand"
  | "spotlight"
  | "range";

export interface NormPoint {
  x: number;
  y: number;
}

export type AnnotationGeometry =
  | { kind: "pin"; at: NormPoint }
  | { kind: "rect"; origin: NormPoint; size: NormPoint; rotationDeg?: number }
  | { kind: "ellipse"; center: NormPoint; radii: NormPoint; rotationDeg?: number }
  | { kind: "arrow"; from: NormPoint; to: NormPoint }
  | { kind: "freehand"; points: NormPoint[]; closed: boolean }
  | {
      kind: "spotlight";
      region:
        | { rect: { origin: NormPoint; size: NormPoint } }
        | { ellipse: { center: NormPoint; radii: NormPoint } };
      dimOpacity: number;
    };

export interface AnnotationStyle {
  color: string;
  strokeWidth: number;
}

export type AnnotationAnchor =
  | { kind: "clip"; clipId: string; assetId: string; sourceFrame: SourceTime }
  | { kind: "word"; wordId: string; offset?: SourceTime }
  | { kind: "object"; trackId: string; assetId: string; sourceFrame: SourceTime }
  | { kind: "beat"; beatId: string; offset?: SourceTime }
  | { kind: "timeline"; sequenceId: string; frame: SourceTime };

export type AnnotationPersistedState = "open" | "resolved" | "rejected" | "reopened";
export type AnnotationState = AnnotationPersistedState | "addressed";

export interface AnnotationStateChange {
  at: string;
  from: AnnotationState;
  to: AnnotationState;
  actor: { kind: "human" | "agent"; id: string };
  txnId?: string;
  reason?: string;
}

export interface SourceProjection {
  assetId: string;
  clipId: string;
  geometry: AnnotationGeometry;
}

export interface OrphanInfo {
  detectedAtRevision: string;
  lastResolved: { sequenceId: string; timelineFrame: SourceTime };
}

export interface Annotation {
  id: string;
  shape: AnnotationShape;
  body: string;
  style?: AnnotationStyle;
  geometry: AnnotationGeometry | null;
  anchor: AnnotationAnchor;
  extent: SourceTime;
  canvasRef: { sequenceId: string; deliverableId?: string; aspect: string };
  sourceProjection?: SourceProjection;
  state: AnnotationPersistedState;
  blocking: boolean;
  author: { kind: "human" | "agent"; id: string };
  createdAt: string;
  history: AnnotationStateChange[];
  context?: { nearestWordId?: string; beatId?: string };
  resolvedBy?: { txnId: string; revision: string };
  orphan?: OrphanInfo;
  convertedTo?: { itemId: string; txnId: string };
}

export interface AnnotationSidecar {
  format: "guyditor.annotations/v1";
  annotations: Annotation[];
}
