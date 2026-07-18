import type { FrameTime } from "../time/index.js";
import type { OrphanedAnchorRecord } from "../anchors/bookkeeping.js";
import type { Result } from "../errors.js";
import type { GuyditorProject, SemanticAnchor } from "../project/index.js";
import type { SemanticOperation, TransactionRecord } from "../store/types.js";

export type RiskClass = "low" | "normal" | "consequential";
export type CaptionImpact = "none" | "shift" | "retime" | "realign";

export interface OperationInput {
  op: string;
  params: Record<string, unknown>;
}

export interface OperationContext {
  baseRevision: string;
  origin: "ui" | "agent" | "system";
  sessionId?: string;
  proposalId?: string;
  dryRun: boolean;
  actor?: TransactionRecord["actor"];
  instruction?: TransactionRecord["instruction"];
  acceptance?: TransactionRecord["acceptance"];
  reason?: string;
  addresses?: string[];
  undoOf?: string;
  redoOf?: string;
  recordUndo?: boolean;
}

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
  affected: string[];
}

export interface ContinuityWarning {
  code:
    | "clipped-phoneme-risk"
    | "ambience-jump"
    | "click-risk"
    | "jump-cut"
    | "caption-realign-required";
  severity: "info" | "warning";
  boundary: { beforeClip?: string; afterClip?: string };
  evidence: string;
  suggestion?: string;
  autoFix?: OperationInput;
}

export interface ContinuityGuardRequest {
  before: GuyditorProject;
  after: GuyditorProject;
  operation: OperationInput;
}

export type ContinuityGuard = (
  request: ContinuityGuardRequest,
) => readonly ContinuityWarning[] | Promise<readonly ContinuityWarning[]>;

export interface AppliedOperation {
  op: string;
  params: Record<string, unknown>;
  summary: string;
  inverse: OperationInput[];
  captionImpact: CaptionImpact;
  warnings: ContinuityWarning[];
  affected: string[];
}

export interface SemanticFieldDelta {
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface SemanticDiffEntry {
  summary: string;
  op: string;
  anchors: string[];
  before?: unknown;
  after?: unknown;
  /** Stable-ID entity detail retained from M0 and extended across the master model. */
  entityId: string;
  entityType: SemanticEntityType;
  change: "added" | "removed" | "modified";
  fields: SemanticFieldDelta[];
}

export type SemanticEntityType =
  | "project"
  | "asset"
  | "beat"
  | "sequence"
  | "clip"
  | "transition"
  | "effect"
  | "layer"
  | "item"
  | "caption"
  | "deliverable"
  | "preset"
  | "skill"
  | "sidecar";

export interface SemanticDiff {
  base: string;
  entries: SemanticDiffEntry[];
  orphanedAnchors: Omit<OrphanedAnchorRecord, "lastResolved">[];
  stats: {
    durationDelta: FrameTime;
    clipsAdded: number;
    clipsRemoved: number;
    clipsModified: number;
    affectedLayers: string[];
    affectedWordRanges: { fromWord: string; toWord: string }[];
    affectedDeliverables: string[];
  };
}

export interface OperationBatchResult {
  base: string;
  applied: AppliedOperation[];
  riskClass: RiskClass;
  diff: SemanticDiff;
  transactionId?: string;
}

export interface ProposalReason {
  text: string;
  sources: Array<{
    kind: "instruction" | "annotation" | "skill-rule" | "media-evidence";
    ref: string;
  }>;
}

export interface Proposal {
  id: string;
  baseRevision: string;
  status: "draft" | "ready" | "accepted" | "rejected" | "superseded" | "withdrawn";
  operations: SemanticOperation[];
  instruction: TransactionRecord["instruction"];
  actor: TransactionRecord["actor"];
  sessionId?: string;
  reason: ProposalReason;
  riskClass: RiskClass;
  addresses: string[];
  applied?: AppliedOperation[];
  diff?: SemanticDiff;
  warnings?: ContinuityWarning[];
  previewJobId?: string;
  staleBase?: boolean;
  supersededBy?: string;
  orphanedAnchors: { owner: string; anchor: SemanticAnchor }[];
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resultTransaction?: string;
}

export interface CreateProposalRequest {
  operations: OperationInput[];
  instruction: TransactionRecord["instruction"];
  actor: TransactionRecord["actor"];
  sessionId?: string;
  reason: ProposalReason;
  addresses: string[];
  warnings?: ContinuityWarning[];
}

export interface AutomationPolicy {
  enabled: boolean;
  maxRisk: "low";
  allowedOperations: string[];
  maxOpsPerProposal: number;
  maxAutoAcceptsPerSession: number;
  notify: string;
}

export interface ProposalStore {
  readonly head: string;
  readAcceptedRevision(): Promise<Result<string>>;
  saveProposal(
    proposal: Proposal,
    proposedProject: GuyditorProject,
  ): Promise<Result<Proposal>>;
  readProposal(id: string): Promise<Result<Proposal>>;
  updateProposal(proposal: Proposal): Promise<Result<Proposal>>;
  archiveProposal(id: string): Promise<Result<Proposal>>;
}
