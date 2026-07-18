import type { Result } from "../errors.js";
import type {
  FrameTime,
  TimeValue,
} from "../time/index.js";
import type { GuyditorProject } from "../project/model.js";

export type SemanticAnchor = string;

export interface AnchorRange {
  start: SemanticAnchor;
  end: SemanticAnchor;
}

export interface AnchorLastResolved {
  timeline: FrameTime;
  revision: string;
  context?: { wordsBefore: string[]; wordsAfter: string[] };
}

export interface AnchorResolution {
  status: "resolved" | "orphaned";
  timeline?: FrameTime;
  approximate?: boolean;
  source?: { assetId: string; time: FrameTime };
  reason?:
    | "word-deleted"
    | "word-not-in-edit"
    | "beat-orphaned"
    | "clip-deleted"
    | "ann-orphaned"
    | "offset-out-of-range"
    | "beyond-timeline";
  lastResolved?: AnchorLastResolved;
}

export interface ResolvedAnchorRange {
  start: AnchorResolution;
  end: AnchorResolution;
}

export type ParsedAnchor =
  | {
      kind: "word";
      wordId: string;
      edge: "start" | "end";
      offset: number;
    }
  | { kind: "beat"; beatId: string; offset: number }
  | { kind: "clip"; clipId: string; sourceFrame: number; offset: number }
  | { kind: "ann"; annotationId: string }
  | { kind: "timeline"; sequenceId: string; frames: number }
  | { kind: "timeline"; frames: number; fps: string };

export interface WordLookupResolution {
  wordId: string;
  assetId: string;
  start: TimeValue;
  end: TimeValue;
  approximate: boolean;
  context?: { wordsBefore: string[]; wordsAfter: string[] };
}

export interface WordLookup {
  resolveWord(
    project: GuyditorProject,
    wordId: string,
  ): Result<WordLookupResolution | undefined> |
    Promise<Result<WordLookupResolution | undefined>>;
}

export interface AnnotationResolver {
  resolveAnnotation(
    project: GuyditorProject,
    annotationId: string,
    sequenceId: string,
  ): Result<AnchorResolution | undefined> |
    Promise<Result<AnchorResolution | undefined>>;
}

export interface AnchorResolverDependencies {
  wordLookup?: WordLookup;
  annotationResolver?: AnnotationResolver;
}
