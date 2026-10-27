import type {
  ContinuityWarning,
  OperationEngine,
  Proposal,
  Result,
} from "../../../core/src/index.js";
import type { SampleTime, TranscriptSidecar, TranscriptWordRange } from "../types.js";

export interface FillerRuleSet {
  version: 1;
  pauses: {
    minRemovableMs: number;
    keepAtSentenceBoundaryMs: number;
    retainMs: number;
  };
  fillers: {
    remove: string[];
    review: string[];
    keep: string[];
  };
  repeats: { enabled: boolean; minWords: number };
  falseStarts: { enabled: boolean };
  limits: {
    maxDensityPerMinute: number;
    protectAnnotatedRanges: boolean;
    protectBeats: string[];
  };
  padding: { cutPaddingMs: number };
}

export interface SourceSampleRange {
  assetId: string;
  start: SampleTime;
  end: SampleTime;
}

export interface VadActivity {
  start: SampleTime;
  end: SampleTime;
  kind: "speech" | "silence";
  rmsDb: number;
}

export interface ProtectedSourceRange extends SourceSampleRange {
  reason: string;
}

export interface FillerCandidate {
  id: string;
  kind: "pause" | "filler" | "repeat" | "false-start";
  wordRange?: TranscriptWordRange;
  sourceRange: SourceSampleRange;
  rule: string;
  evidence: string;
  warnings: ContinuityWarning[];
  defaultSelected: boolean;
  reviewRequired?: boolean;
}

export interface FillerReviewWindow extends SourceSampleRange {
  reviewRequired: true;
  candidateIds: string[];
}

/** Restricts a detection run to ranges an assembly kept; carried through the job into its result. */
export interface FillerScope {
  assemblySessionId: string;
  keptRanges: SourceSampleRange[];
}

export interface FillerDetectionResult {
  candidates: FillerCandidate[];
  reviewWindows: FillerReviewWindow[];
  scope?: FillerScope;
}

export interface DetectFillerCandidatesInput {
  sidecar: TranscriptSidecar;
  vad: VadActivity[];
  rules: FillerRuleSet;
  protectedRanges?: ProtectedSourceRange[];
  continuityWarnings?: (
    sourceRange: SourceSampleRange,
  ) => ContinuityWarning[] | Promise<ContinuityWarning[]>;
}

export interface EnqueueFillerDetectionInput {
  assetIds?: string[];
  fillerRules?: FillerRuleSet;
  scope?: FillerScope;
}

export interface FillerProposalPolicy {
  engine: OperationEngine;
  selectedCandidateIds?: string[];
  idFactory: (prefix: "clp" | "fx") => string;
  cutPaddingMs?: number;
}

export type FillerProposalResult = Promise<Result<Proposal>>;
