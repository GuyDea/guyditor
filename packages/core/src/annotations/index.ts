export {
  fitMapGeometry,
  normalizeAnnotationGeometry,
  normalizeCanvasPoint,
  normalizedPointToPixels,
  roundSpatial,
  simplifyFreehand,
} from "./coordinates.js";
export {
  parseAnnotationSidecar,
  serializeAnnotationSidecar,
  validateAnnotation,
  validateAnnotationSidecar,
} from "./sidecar.js";
export { AnnotationService } from "./service.js";
export type { AnnotationServiceOptions } from "./service.js";
export {
  annotationLastResolved,
  createAnnotationAnchorResolver,
  resolveAnnotationRecord,
} from "./resolver.js";
export type {
  AnnotationAnchorResolverDependencies,
  ObjectTrackLookup,
} from "./resolver.js";
export { buildAnnotationContext } from "./context.js";
export type {
  AnnotationContextPackage,
  AnnotationContextProject,
  AnnotationTranscriptSource,
  AnnotationTranscriptWord,
  DataClass,
  FrameExtractionLayerRequest,
  FrameExtractionRequest,
  NearbyFramesExtractionRequest,
} from "./context.js";
export type {
  Annotation,
  AnnotationAnchor,
  AnnotationGeometry,
  AnnotationPersistedState,
  AnnotationShape,
  AnnotationSidecar,
  AnnotationState,
  AnnotationStateChange,
  AnnotationStyle,
  NormPoint,
  OrphanInfo,
  SourceProjection,
  SourceTime,
} from "./types.js";
