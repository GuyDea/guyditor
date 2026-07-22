// This file is the single renderer/main source of truth for Part 1 §1.3.

import type { DivergenceClass, GuyditorProject, SidecarRef } from "../../../core/src/index.js";

export interface GuyditorError {              // Part 0 §0.4 envelope, verbatim
  code: string;                               // "E_" + SCREAMING_SNAKE, e.g. "E_MLWORKER_DOWN"
  message: string;
  affected: string[];                         // Part 0 prefixed IDs
  acceptedStateChanged: boolean;
  retry: "safe" | "unsafe" | "none";
  suggestion?: string;
}

export type ServiceName =
  | "ProjectStore" | "OperationEngine" | "MediaEngine" | "TranscriptEngine"
  | "CompositorModel" | "RenderService" | "JobQueue" | "AgentGateway"
  | "AuditLog" | "CostMeter" | "BackupService" | "DeliverableService"
  | "AnnotationService" | "SkillRegistry" | "AdapterRegistry" | "CaptureWatcher";

export interface IpcRequest {
  v: 1;
  requestId: string;        // "req_" + 10 base32 chars; ephemeral, never persisted
  service: ServiceName;
  method: string;           // camelCase method on the service's IpcSurface
  params: unknown;          // validated against the method's JSON Schema in main
}

export type IpcResponse<T = unknown> =
  | { v: 1; requestId: string; ok: true;  result: T }
  | { v: 1; requestId: string; ok: false; error: GuyditorError };

export interface JobStatus {                  // superset of Part 0's job shape
  jobId: string; kind: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;                           // 0..1
  dependsOn: string[];
  error?: GuyditorError;
  title: string;                              // human-readable, for the job panel
  cancellable: boolean;
  createdAt: string; startedAt?: string; finishedAt?: string; // ISO 8601 UTC
  etaSeconds?: number;
}

export interface JobDependencyNode {
  jobId: string;
  kind: string;
  title: string;
  state: JobStatus["state"];
  dependencies: JobDependencyNode[];
}

export interface QueuedJobOverview extends JobStatus {
  dependencyChain: JobDependencyNode[];
}

export interface JobOverview {
  running: JobStatus[];
  queued: QueuedJobOverview[];
  retryable: JobStatus[];
  waitingOnCreator: {
    proposals: Array<{ proposalId: string; title: string; createdAt: string }>;
    annotations: Array<{
      annotationId: string;
      code: string;
      message: string;
      sequenceId?: string;
    }>;
    confirmations: Array<{
      confirmToken: string;
      taskId: string;
      level: "task" | "episode" | "cumulative";
      message: string;
      estimatedUsd: number;
      createdAt: string;
    }>;
  };
  waitingOnExternal: Array<{
    callId: string;
    provider: string;
    title: string;
    elapsedSeconds: number;
    spendUsd: number;
  }>;
  aggregateFraction: number;
  idle: boolean;
}

export interface CapabilityReport {
  fingerprint: string;
  probedAt: string;
  cpu: { cores: number; model: string };
  memoryMb: number;
  gpus: { vendor: string; model: string; vramMb: number | null; driver: string }[];
  hwaccels: string[];
  encoders: { name: string; verified: boolean }[];
  decodeAccels: { api: string; verified: boolean }[];
  ml: {
    device: "cuda" | "mps" | "cpu";
    vramMb: number | null;
    capabilities: string[];
  };
  webgl2: boolean;
  disk: { path: string; freeBytes: number; totalBytes: number }[];
}

export type GdEvent =
  | { kind: "job.state";          seq: number; job: JobStatus }
  | { kind: "job.progress";       seq: number; jobId: string; progress: number; etaSeconds?: number }
  | { kind: "project.revision";   seq: number; revision: string }        // "rev_00017"
  | { kind: "proposal.updated";   seq: number; proposalId: string }      // "prp_..."
  | { kind: "annotation.updated"; seq: number; annotationId: string }
  | { kind: "watcher.ingested";   seq: number; assetIds: string[] }
  | { kind: "mlworker.state";     seq: number; state: "starting"|"ready"|"restarting"|"unavailable" }
  | { kind: "capability.changed"; seq: number; report: CapabilityReport }
  | { kind: "perf.budget.exceeded"; seq: number; budget: string; observedMs: number };

/*
Rules:

1. Every service that is renderer-callable exports an `IpcSurface` manifest
   `{ service, methods: { [name]: { paramsSchema, resultSchema, budgetMs } } }`.
   The preload script exposes a generated, fully typed facade `window.guyditor:
   GuyditorApi` (`call(service, method, params)` + `on(kind, handler)`); nothing
   else crosses the context bridge.
2. Main validates `params` against `paramsSchema` before dispatch; failure
   returns `E_IPC_SCHEMA` with `retry: 'none'`.
3. Events are broadcast to the owning window, carry a per-window monotonic
   `seq`, and are droppable: every event's full state is re-queryable (e.g.
   `JobQueue.list`), so a missed event never corrupts UI state. `job.progress`
   is throttled to ≤ 10 events/s per job.
4. The `AgentGateway` MCP tools call the same service methods with the same
   schemas (AD-009); an operation performed in the UI and one proposed by an
   agent are byte-identical `OperationEngine` inputs (FR-901).
*/

export type GdEventKind = GdEvent["kind"];
export type GdEventOfKind<Kind extends GdEventKind> = Extract<GdEvent, { kind: Kind }>;
export type GdEventWithoutSeq = GdEvent extends infer Event
  ? Event extends GdEvent
    ? Omit<Event, "seq">
    : never
  : never;

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface IpcMethodManifest {
  paramsSchema: JsonSchema;
  resultSchema: JsonSchema;
  budgetMs: number;
}

export interface IpcSurface {
  service: ServiceName;
  methods: Readonly<Record<string, IpcMethodManifest>>;
}

export interface GuyditorApi {
  call<Result = unknown>(service: ServiceName, method: string, params: unknown): Promise<Result>;
  on<Kind extends GdEventKind>(
    kind: Kind,
    handler: (event: GdEventOfKind<Kind>) => void,
  ): () => void;
}

export interface ExecuteRequest {
  operations: Array<{ op: string; params: Record<string, unknown> }>;
  intent: "direct" | "undo" | "redo";
  label: string;
  undoOf?: string;
  divergence?: DivergenceClass;
}

export interface ExecuteResult {
  txnId: string;
  revision: string;
  inverse: Array<{ op: string; params: Record<string, unknown> }>;
}

export interface ProjectSnapshot {
  revision: string;
  master: GuyditorProject;
  sidecarIndex: SidecarRef[];
  projectPath: string;
}

declare global {
  interface Window {
    guyditor: GuyditorApi;
  }
}
