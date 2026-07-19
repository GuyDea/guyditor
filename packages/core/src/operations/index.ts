export { OperationEngine } from "./engine.js";
export { applyClipOperation } from "./clip.js";
export type {
  DispatchedOperationApplication,
  IdFactory,
  OperationDispatcher,
  OperationCommitter,
  OperationEngineOptions,
} from "./engine.js";
export type {
  AppliedOperation,
  AuditSink,
  AuditSinkEvent,
  AutomationPolicy,
  CaptionImpact,
  ContinuityWarning,
  ContinuityGuard,
  ContinuityGuardRequest,
  CreateProposalRequest,
  OperationBatchResult,
  OperationContext,
  OperationInput,
  Proposal,
  ProposalReason,
  ProposalStore,
  RiskClass,
  SemanticDiff,
  SemanticDiffEntry,
  SemanticEntityType,
  SemanticFieldDelta,
  ValidationIssue,
} from "./types.js";
