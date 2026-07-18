export {
  ProjectStore,
  canonicalJson,
  createProject,
  openProject,
} from "./store.js";
export type { ProjectStoreOptions } from "./store.js";
export type {
  CreateProjectRequest,
  WatchFolderConfig,
} from "./store.js";
export type {
  ChangedTimelineRange,
  RevisionComparison,
  RevisionLock,
  SemanticOperation,
  TransactionRecord,
} from "./types.js";
export { computeChangedRanges } from "./history.js";
