export { ANCHOR_PATTERN, parseAnchor } from "./parser.js";
export { AnchorResolverRegistry } from "./registry.js";
export { resolveAnchor, resolveAnchorRange } from "./resolver.js";
export { resolveNavigationTarget } from "./navigation.js";
export type { NavigationTarget, TimelinePosition } from "./navigation.js";
export {
  computeAnchorTransitions,
  validateProjectAnchors,
} from "./bookkeeping.js";
export type {
  AnchorTransitionResult,
  AnchorValidationReport,
  OrphanedAnchorRecord,
} from "./bookkeeping.js";
export type { StoredAnchorPath, StoredAnchorReference } from "./owners.js";
export { storedAnchors } from "./owners.js";
export type {
  AnchorLastResolved,
  AnchorRange,
  AnchorResolution,
  AnchorResolverDependencies,
  AnnotationResolver,
  ParsedAnchor,
  ResolvedAnchorRange,
  SemanticAnchor,
  WordLookup,
  WordLookupResolution,
} from "./types.js";
