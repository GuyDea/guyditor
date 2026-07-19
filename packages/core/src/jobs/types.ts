import type { GuyditorError } from "../errors.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JobState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface JobStatus {
  jobId: string;
  kind: string;
  state: JobState;
  progress: number;
  dependsOn: string[];
  error?: GuyditorError;
  title: string;
  cancellable: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  etaSeconds?: number;
}

export interface JobRecord extends JobStatus {
  payload: JsonValue;
  attempt: number;
}

export interface EnqueueJobInput {
  kind: string;
  title: string;
  payload: JsonValue;
  cancellable: boolean;
  dependsOn?: string[];
}

export interface JobFilter {
  kind?: string;
  state?: JobState | readonly JobState[];
}

export interface JobDependencyNode {
  jobId: string;
  kind: string;
  title: string;
  state: JobState;
  dependencies: JobDependencyNode[];
}

export interface QueuedJobOverview extends JobStatus {
  dependencyChain: JobDependencyNode[];
}

export interface CreatorProposalWait {
  proposalId: string;
  title: string;
  createdAt: string;
}

export interface CreatorAnnotationWait {
  annotationId: string;
  code: string;
  message: string;
  sequenceId?: string;
}

export interface CreatorConfirmationWait {
  confirmToken: string;
  taskId: string;
  level: "task" | "episode" | "cumulative";
  message: string;
  estimatedUsd: number;
  createdAt: string;
}

export interface ExternalProviderWait {
  callId: string;
  provider: string;
  title: string;
  elapsedSeconds: number;
  spendUsd: number;
}

type OverviewValues<Value> = readonly Value[] | Promise<readonly Value[]>;

export interface JobOverviewSources {
  proposals?: () => OverviewValues<CreatorProposalWait>;
  annotations?: () => OverviewValues<CreatorAnnotationWait>;
  confirmations?: () => OverviewValues<CreatorConfirmationWait>;
  external?: () => OverviewValues<ExternalProviderWait>;
}

export interface JobOverview {
  running: JobStatus[];
  queued: QueuedJobOverview[];
  /** Failed jobs remain visible here until the creator retries or otherwise resolves them. */
  retryable: JobStatus[];
  waitingOnCreator: {
    proposals: CreatorProposalWait[];
    annotations: CreatorAnnotationWait[];
    confirmations: CreatorConfirmationWait[];
  };
  waitingOnExternal: ExternalProviderWait[];
  /** ETA seconds are cost weights when positive; jobs without an ETA use weight 1. */
  aggregateFraction: number;
  idle: boolean;
}

export interface JobQueueOptions {
  concurrency?: number;
  overviewSources?: JobOverviewSources;
}

export type JobChangeEvent = {
  kind: "job.state" | "job.progress";
  job: JobRecord;
};

export interface JobExecutorContext {
  signal: AbortSignal;
  reportProgress: (progress: number, etaSeconds?: number) => void;
}

export type JobExecutor = (
  job: JobRecord,
  context: JobExecutorContext,
) => Promise<JsonValue | void>;

export type JobChangeListener = (event: JobChangeEvent) => void;
