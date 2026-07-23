export {
  parseTakeMarkerSidecar,
  serializeTakeMarkerSidecar,
  validateTakeMarkerSidecar,
} from "./sidecar.js";
export {
  parseTakeComparison,
  serializeTakeComparison,
  takeComparisonSidecarRef,
  validateTakeComparison,
} from "./comparison.js";
export { applyTakeOperation } from "./operations.js";
export type {
  MarkerRecord,
  MarkerType,
  TakeMarkerSidecar,
  TakeQuality,
  TakeRecord,
  TakeCandidate,
  TakeComparison,
} from "./types.js";
