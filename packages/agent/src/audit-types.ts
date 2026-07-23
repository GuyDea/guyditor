export type DataClass = "metadata" | "prompt" | "transcript" | "frames" | "audio" | "video";

export interface AuditBase {
  ts: string;
  sessionId: string;
  seq: number;
  projectId: string;
  type: string;
}

export interface SessionRecord extends AuditBase {
  type: "session.start" | "session.end";
  director: {
    profileId: string;
    modelLabel: string;
    locality: "local" | "remote";
  };
  policySnapshot?: object;
}

export interface InstructionRecord extends AuditBase {
  type: "instruction";
  source: "creator" | "annotation";
  text: string;
  annotationId?: string;
}

export interface ToolCallRecord extends AuditBase {
  type: "tool.call" | "tool.result";
  tool: string;
  callId: string;
  paramsDigest: object;
  ok?: boolean;
  errorCode?: string;
  dataClassesReturned?: DataClass[];
  durationMs?: number;
}

export interface ProposalRecord extends AuditBase {
  type: "proposal.created" | "proposal.outcome";
  proposalId: string;
  opCount?: number;
  riskClass?: "low" | "normal" | "consequential";
  outcome?: "accepted" | "rejected" | "withdrawn" | "auto_accepted";
  transactionId?: string;
  revision?: string;
  creatorFeedback?: string;
}

export interface ExternalCallRecord extends AuditBase {
  type: "external.call";
  adapterId: string;
  provider: string;
  purpose: string;
  dataClassesSent: DataClass[];
  payloadSummary: {
    frames?: number;
    transcriptWords?: number;
    videoSeconds?: number;
    audioSeconds?: number;
    promptChars?: number;
  };
  units: {
    inputTokens?: number;
    outputTokens?: number;
    images?: number;
    seconds?: number;
  };
  costUsd: { estimated: number; actual?: number };
  outcome: "ok" | "error" | "cancelled";
  durationMs: number;
}

export interface CostChargeRecord extends AuditBase {
  type: "cost.charge";
  externalCallSeq: number;
  costUsd: number;
  totals: { taskUsd: number; episodeUsd: number; cumulativeUsd: number };
}

export interface PolicyRecord extends AuditBase {
  type: "policy.autoaccept";
  proposalId: string;
  transactionId: string;
  matchedPolicy: object;
}

export interface BudgetEventRecord extends AuditBase {
  type: "budget.event";
  level: "task" | "episode" | "cumulative";
  kind: "warn" | "cap_block" | "creator_override";
  thresholdUsd: number;
  projectedUsd: number;
}

export interface TemplateAuthorRecord extends AuditBase {
  type: "template.author.submitted" | "template.author.reviewed";
  submissionId: string;
  templateId: string;
  model: string;
  status: "awaiting_review" | "changes_requested" | "rejected" | "superseded" | "published";
  decision?: "approve" | "reject" | "request_changes";
  reason?: string;
  contentHash?: string;
}

export type AuditRecord =
  | SessionRecord
  | InstructionRecord
  | ToolCallRecord
  | ProposalRecord
  | ExternalCallRecord
  | CostChargeRecord
  | PolicyRecord
  | BudgetEventRecord
  | TemplateAuthorRecord;

export type AuditRecordDraft = AuditRecord extends infer RecordType
  ? RecordType extends AuditRecord
    ? Omit<RecordType, "ts" | "seq">
    : never
  : never;

export interface AuditReplayWarning {
  code: "invalid_json" | "invalid_record" | "non_monotonic_sequence" | "read_error";
  sessionId: string;
  line?: number;
  message: string;
}

export interface AuditReplay {
  records: AuditRecord[];
  warnings: AuditReplayWarning[];
}

export interface AuditRetention {
  /** Delete inactive session logs older than this many 24-hour days. Defaults to 365. */
  retentionDays: number;
  /** Keep at most this many logs after age pruning. Active sessions are never deleted. */
  maxSessions?: number;
}

export interface AuditPruneOptions {
  currentSessionIds?: readonly string[];
}

export interface AuditPruneResult {
  deletedSessionIds: string[];
  keptSessionIds: string[];
}
