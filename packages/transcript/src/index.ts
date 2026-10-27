export {
  parseTranscriptSidecar,
  serializeTranscriptSidecar,
  validateTranscriptSidecar,
} from "./sidecar.js";
export {
  ALIGNMENT_CONFIDENCE_THRESHOLD,
  TranscriptEngine,
} from "./engine.js";
export { findWord, resolveWord } from "./lookup.js";
export {
  createTranscriptWordLookup,
  registerTranscriptWordLookup,
} from "./anchor-lookup.js";
export { createAnnotationTranscriptSource } from "./annotation-context.js";
export { mapWordRangeToSourceRange } from "./range-mapping.js";
export {
  detectSpokenTakeMarkers,
  importJsonTakeMarkers,
  importTakeNotes,
} from "./take-markers.js";
export {
  extractTakeTranscript,
  groupTakeTranscripts,
} from "./take-comparison.js";
export type {
  TakeTranscriptCandidate,
  TakeTranscriptGroup,
} from "./take-comparison.js";
export {
  PICKUP_ALIGNMENT_CONFIDENCE_THRESHOLD,
  planPickupSplice,
} from "./pickup.js";
export type {
  PickupSpliceInput,
  PickupSplicePlan,
} from "./pickup.js";
export type {
  SpokenMarkerOptions,
  TakeMarkerImportOptions,
} from "./take-markers.js";
export * from "./fillers.js";
export * from "./captions/index.js";
export * from "./assembly/index.js";
export {
  assessSourceRangeContinuity,
  continuityEvidenceOperation,
  createTranscriptContinuityGuard,
} from "./continuity.js";
export type {
  ContinuityPeaks,
  ContinuityPeaksTier,
  TranscriptContinuityOptions,
} from "./continuity.js";
export type {
  TranscriptEngineOptions,
  TranscriptAlignmentJobs,
  TranscriptMutationResult,
  SubtitleImportResult,
} from "./engine.js";
export type {
  RawTranscriptionSegment,
  RawTranscriptionWord,
  AlignedToken,
  AlignResult,
  SampleTime,
  TranscribeResult,
  TranscriptAlignment,
  TranscriptEngineIdentity,
  TranscriptSegment,
  TranscriptSidecar,
  TranscriptSpeaker,
  TranscriptWord,
  TranscriptWordOrigin,
  TranscriptRealignRequest,
  TranscriptWordRange,
  WordLocation,
  WordResolution,
} from "./types.js";
export type {
  TranscriptRangeSnapPolicy,
  WordRangeMappingOptions,
  WordSourceRange,
} from "./range-mapping.js";
