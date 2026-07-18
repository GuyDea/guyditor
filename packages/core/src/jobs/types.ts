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
}

export interface JobFilter {
  kind?: string;
  state?: JobState | readonly JobState[];
}

export interface JobQueueOptions {
  concurrency?: number;
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
