import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type {
  GuyditorError,
  GuyditorErrorCode,
  Result,
} from "../errors.js";
import type {
  EnqueueJobInput,
  JobChangeEvent,
  JobChangeListener,
  JobExecutor,
  JobFilter,
  JobDependencyNode,
  JobOverview,
  JobOverviewSources,
  JobQueueOptions,
  JobRecord,
  JobState,
  JobStatus,
  JsonValue,
} from "./types.js";
import { makeId } from "../project/ids.js";

const PROGRESS_WRITE_INTERVAL_MS = 250;
const JOB_ID = /^job_[a-z2-7]{10}$/u;

const JOBS_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY
    CHECK(length(id) = 14)
    CHECK(substr(id, 1, 3) = 'job')
    CHECK(substr(id, 4, 1) = '_')
    CHECK(substr(id, 5) NOT GLOB '*[^a-z2-7]*'),
  kind TEXT NOT NULL CHECK(length(kind) > 0),
  state TEXT NOT NULL
    CHECK(state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  progress REAL NOT NULL CHECK(progress >= 0.0 AND progress <= 1.0),
  title TEXT NOT NULL CHECK(length(title) > 0),
  cancellable INTEGER NOT NULL CHECK(cancellable IN (0, 1)),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  error TEXT CHECK(error IS NULL OR json_valid(error)),
  createdAt TEXT NOT NULL,
  startedAt TEXT,
  finishedAt TEXT,
  etaSeconds REAL CHECK(etaSeconds IS NULL OR etaSeconds >= 0.0),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  dependsOn TEXT CHECK(dependsOn IS NULL OR json_valid(dependsOn))
) STRICT;
`;

export interface JobQueueOpenResult {
  queue: JobQueue;
  recoveryNeeded: boolean;
}

interface PendingProgress {
  progress: number;
  etaSeconds?: number;
}

interface ActiveJob {
  controller: AbortController;
  lastProgressWriteAt: number;
  pendingProgress: PendingProgress | undefined;
  progressTimer: ReturnType<typeof setTimeout> | undefined;
}

function createJobId(): string {
  return makeId("job");
}

function jsonText(value: JsonValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Job payload must be JSON serializable.");
  return serialized;
}

function stringValue(
  row: Record<string, unknown>,
  column: string,
): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`Invalid jobs.sqlite value for ${column}.`);
  }
  return value;
}

function numberValue(
  row: Record<string, unknown>,
  column: string,
): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new Error(`Invalid jobs.sqlite value for ${column}.`);
  }
  return value;
}

function nullableStringValue(
  row: Record<string, unknown>,
  column: string,
): string | undefined {
  const value = row[column];
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid jobs.sqlite value for ${column}.`);
  }
  return value;
}

function nullableNumberValue(
  row: Record<string, unknown>,
  column: string,
): number | undefined {
  const value = row[column];
  if (value === null) return undefined;
  if (typeof value !== "number") {
    throw new Error(`Invalid jobs.sqlite value for ${column}.`);
  }
  return value;
}

function rowToJob(row: Record<string, unknown>): JobRecord {
  const dependsOnText = nullableStringValue(row, "dependsOn");
  const dependsOnValue = dependsOnText === undefined
    ? []
    : JSON.parse(dependsOnText) as unknown;
  if (
    !Array.isArray(dependsOnValue) ||
    !dependsOnValue.every((dependency): dependency is string =>
      typeof dependency === "string" && JOB_ID.test(dependency))
  ) {
    throw new Error("Invalid jobs.sqlite value for dependsOn.");
  }
  const job: JobRecord = {
    jobId: stringValue(row, "id"),
    kind: stringValue(row, "kind"),
    state: stringValue(row, "state") as JobState,
    progress: numberValue(row, "progress"),
    dependsOn: [...dependsOnValue],
    title: stringValue(row, "title"),
    cancellable: numberValue(row, "cancellable") === 1,
    payload: JSON.parse(stringValue(row, "payload")) as JsonValue,
    createdAt: stringValue(row, "createdAt"),
    attempt: numberValue(row, "attempt"),
  };

  const error = nullableStringValue(row, "error");
  const startedAt = nullableStringValue(row, "startedAt");
  const finishedAt = nullableStringValue(row, "finishedAt");
  const etaSeconds = nullableNumberValue(row, "etaSeconds");
  if (error !== undefined) job.error = JSON.parse(error) as GuyditorError;
  if (startedAt !== undefined) job.startedAt = startedAt;
  if (finishedAt !== undefined) job.finishedAt = finishedAt;
  if (etaSeconds !== undefined) job.etaSeconds = etaSeconds;
  return job;
}

function publicJobStatus(job: JobRecord): JobStatus {
  return {
    jobId: job.jobId,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    dependsOn: [...job.dependsOn],
    ...(job.error === undefined ? {} : { error: structuredClone(job.error) }),
    title: job.title,
    cancellable: job.cancellable,
    createdAt: job.createdAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.etaSeconds === undefined ? {} : { etaSeconds: job.etaSeconds }),
  };
}

function isGuyditorError(error: unknown): error is GuyditorError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return typeof candidate.code === "string" && /^E_[A-Z0-9_]+$/.test(candidate.code) &&
    typeof candidate.message === "string" &&
    Array.isArray(candidate.affected) &&
    candidate.affected.every((affected) => typeof affected === "string") &&
    typeof candidate.acceptedStateChanged === "boolean" &&
    (candidate.retry === "safe" || candidate.retry === "unsafe" || candidate.retry === "none") &&
    (candidate.suggestion === undefined || typeof candidate.suggestion === "string");
}

function executorError(error: unknown, jobId: string): GuyditorError {
  if (isGuyditorError(error)) return error;
  return makeGuyditorError(
    "E_JOB_EXECUTOR_FAILED",
    error instanceof Error ? error.message : String(error),
    {
      affected: [jobId],
      retry: "safe",
      suggestion: "Retry the job after checking the executor's inputs and dependencies.",
    },
  );
}

function jobFailure(
  code: GuyditorErrorCode,
  message: string,
  jobId: string,
): { ok: false; error: GuyditorError } {
  return failure(makeGuyditorError(code, message, { affected: [jobId] }));
}

function queueConcurrency(options: JobQueueOptions): number {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("JobQueue concurrency must be a positive integer.");
  }
  return concurrency;
}

function migrateJobsSchema(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(jobs)").all();
  if (!columns.some((column) => column["name"] === "dependsOn")) {
    database.exec(`
      ALTER TABLE jobs
      ADD COLUMN dependsOn TEXT CHECK(dependsOn IS NULL OR json_valid(dependsOn));
    `);
  }
}

export class JobQueue {
  readonly #database: DatabaseSync;
  readonly #concurrency: number;
  readonly #overviewSources: JobOverviewSources;
  readonly #executors = new Map<string, JobExecutor>();
  readonly #listeners = new Set<JobChangeListener>();
  readonly #active = new Map<string, ActiveJob>();
  #closed = false;

  private constructor(
    database: DatabaseSync,
    concurrency: number,
    overviewSources: JobOverviewSources,
  ) {
    this.#database = database;
    this.#concurrency = concurrency;
    this.#overviewSources = overviewSources;
  }

  public static open(
    databasePath: string,
    options: JobQueueOptions = {},
  ): JobQueueOpenResult {
    const concurrency = queueConcurrency(options);
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      database.exec("PRAGMA journal_mode = WAL;");
      database.exec(JOBS_SCHEMA_DDL);
      migrateJobsSchema(database);

      const interrupted = makeGuyditorError(
        "E_JOB_INTERRUPTED",
        "The job was interrupted when the previous process stopped.",
        {
          retry: "safe",
          suggestion: "Retry the job to run it again from a safe state.",
        },
      );
      const running = database.prepare("SELECT id FROM jobs WHERE state = 'running'").all();
      const finishedAt = new Date().toISOString();
      const recover = database.prepare(`
        UPDATE jobs
        SET state = 'failed', error = ?, finishedAt = ?, etaSeconds = NULL
        WHERE id = ? AND state = 'running'
      `);
      for (const row of running) {
        const jobId = stringValue(row, "id");
        recover.run(
          JSON.stringify({ ...interrupted, affected: [jobId] }),
          finishedAt,
          jobId,
        );
      }

      return {
        queue: new JobQueue(database, concurrency, options.overviewSources ?? {}),
        recoveryNeeded: running.length > 0,
      };
    } catch (error: unknown) {
      try {
        database.close();
      } catch {
        // Preserve the initialization error when SQLite also fails to close.
      }
      throw error;
    }
  }

  public enqueue(input: EnqueueJobInput): JobRecord {
    this.#ensureOpen();
    if (input.kind.length === 0) throw new TypeError("Job kind must not be empty.");
    if (input.title.length === 0) throw new TypeError("Job title must not be empty.");
    const dependsOn = input.dependsOn ?? [];
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new TypeError("Job dependencies must not contain duplicates.");
    }
    for (const dependencyId of dependsOn) {
      if (!JOB_ID.test(dependencyId)) {
        throw new TypeError(`Invalid job dependency ID ${dependencyId}.`);
      }
      if (this.get(dependencyId) === undefined) {
        throw new TypeError(`Job dependency ${dependencyId} does not exist.`);
      }
    }

    let jobId = createJobId();
    const exists = this.#database.prepare("SELECT 1 FROM jobs WHERE id = ?");
    while (exists.get(jobId) !== undefined) jobId = createJobId();
    const createdAt = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO jobs (
        id, kind, state, progress, title, cancellable, payload, error,
        createdAt, startedAt, finishedAt, etaSeconds, attempt, dependsOn
      ) VALUES (?, ?, 'queued', 0.0, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 1, ?)
    `).run(
      jobId,
      input.kind,
      input.title,
      input.cancellable ? 1 : 0,
      jsonText(input.payload),
      createdAt,
      dependsOn.length === 0 ? null : JSON.stringify(dependsOn),
    );
    const job = this.get(jobId);
    if (job === undefined) throw new Error(`Failed to read enqueued job ${jobId}.`);
    this.#emit({ kind: "job.state", job });
    this.#scheduleSoon();
    return job;
  }

  public list(filter: JobFilter = {}): JobRecord[] {
    this.#ensureOpen();
    const states = filter.state === undefined
      ? undefined
      : new Set(Array.isArray(filter.state) ? filter.state : [filter.state]);
    return this.#database.prepare("SELECT * FROM jobs ORDER BY rowid").all()
      .map(rowToJob)
      .filter((job) =>
        (filter.kind === undefined || job.kind === filter.kind) &&
        (states === undefined || states.has(job.state)),
      );
  }

  public get(jobId: string): JobRecord | undefined {
    this.#ensureOpen();
    const row = this.#database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    return row === undefined ? undefined : rowToJob(row);
  }

  public registerExecutor(kind: string, executor: JobExecutor): void {
    this.#ensureOpen();
    if (kind.length === 0) throw new TypeError("Executor kind must not be empty.");
    this.#executors.set(kind, executor);
    this.#scheduleSoon();
  }

  public async overview(): Promise<JobOverview> {
    this.#ensureOpen();
    const jobs = this.#database.prepare("SELECT * FROM jobs ORDER BY rowid").all()
      .map(rowToJob);
    const byId = new Map(jobs.map((job) => [job.jobId, job] as const));
    const dependencyNode = (jobId: string, ancestors: ReadonlySet<string>): JobDependencyNode => {
      const job = byId.get(jobId);
      if (job === undefined) {
        return {
          jobId,
          kind: "missing",
          title: `Missing dependency ${jobId}`,
          state: "failed",
          dependencies: [],
        };
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(jobId);
      return {
        jobId: job.jobId,
        kind: job.kind,
        title: job.title,
        state: job.state,
        dependencies: job.dependsOn
          .filter((dependencyId) => !nextAncestors.has(dependencyId))
          .map((dependencyId) => dependencyNode(dependencyId, nextAncestors)),
      };
    };
    const runningJobs = jobs.filter((job) => job.state === "running");
    const queuedJobs = jobs.filter((job) => job.state === "queued");
    const retryableJobs = jobs.filter((job) => job.state === "failed");
    const [proposals, annotations, confirmations, external] = await Promise.all([
      Promise.resolve(this.#overviewSources.proposals?.() ?? []),
      Promise.resolve(this.#overviewSources.annotations?.() ?? []),
      Promise.resolve(this.#overviewSources.confirmations?.() ?? []),
      Promise.resolve(this.#overviewSources.external?.() ?? []),
    ]);
    this.#ensureOpen();
    const active = [...runningJobs, ...queuedJobs];
    const totalWeight = active.reduce((total, job) =>
      total + (job.etaSeconds !== undefined && job.etaSeconds > 0 ? job.etaSeconds : 1), 0);
    const weightedProgress = active.reduce((total, job) => {
      const weight = job.etaSeconds !== undefined && job.etaSeconds > 0
        ? job.etaSeconds
        : 1;
      return total + job.progress * weight;
    }, 0);
    const waitingOnCreator = {
      proposals: structuredClone([...proposals]),
      annotations: structuredClone([...annotations]),
      confirmations: structuredClone([...confirmations]),
    };
    const waitingOnExternal = structuredClone([...external]);
    return {
      running: runningJobs.map(publicJobStatus),
      queued: queuedJobs.map((job) => ({
        ...publicJobStatus(job),
        dependencyChain: job.dependsOn.map((dependencyId) =>
          dependencyNode(dependencyId, new Set([job.jobId]))),
      })),
      retryable: retryableJobs.map(publicJobStatus),
      waitingOnCreator,
      waitingOnExternal,
      aggregateFraction: totalWeight === 0 ? 1 : weightedProgress / totalWeight,
      idle: active.length === 0 && retryableJobs.length === 0 &&
        waitingOnCreator.proposals.length === 0 &&
        waitingOnCreator.annotations.length === 0 &&
        waitingOnCreator.confirmations.length === 0 && waitingOnExternal.length === 0,
    };
  }

  public cancel(jobId: string): Result<JobRecord> {
    this.#ensureOpen();
    const job = this.get(jobId);
    if (job === undefined) {
      return jobFailure("E_JOB_NOT_FOUND", `Job ${jobId} does not exist.`, jobId);
    }
    if (!job.cancellable) {
      return jobFailure(
        "E_JOB_NOT_CANCELLABLE",
        `Job ${jobId} is not cancellable.`,
        jobId,
      );
    }
    if (job.state !== "queued" && job.state !== "running") {
      return jobFailure(
        "E_JOB_NOT_CANCELLABLE",
        `Job ${jobId} in state ${job.state} cannot be cancelled.`,
        jobId,
      );
    }

    this.#database.prepare(`
      UPDATE jobs
      SET state = 'cancelled', error = NULL, finishedAt = ?, etaSeconds = NULL
      WHERE id = ? AND state IN ('queued', 'running')
    `).run(new Date().toISOString(), jobId);
    const active = this.#active.get(jobId);
    if (active !== undefined) {
      this.#clearProgress(active);
      active.controller.abort();
    }
    const cancelled = this.get(jobId);
    if (cancelled === undefined) {
      return jobFailure("E_JOB_NOT_FOUND", `Job ${jobId} does not exist.`, jobId);
    }
    this.#emit({ kind: "job.state", job: cancelled });
    this.#scheduleSoon();
    return success(cancelled);
  }

  public retry(jobId: string): Result<JobRecord> {
    this.#ensureOpen();
    const job = this.get(jobId);
    if (job === undefined) {
      return jobFailure("E_JOB_NOT_FOUND", `Job ${jobId} does not exist.`, jobId);
    }
    if (job.state !== "failed" && job.state !== "cancelled") {
      return jobFailure(
        "E_JOB_NOT_RETRYABLE",
        `Job ${jobId} in state ${job.state} cannot be retried.`,
        jobId,
      );
    }

    const jobs = this.list();
    const byId = new Map(jobs.map((entry) => [entry.jobId, entry] as const));
    const requeue = new Set<string>([jobId]);
    const addFailedAncestors = (entry: JobRecord): void => {
      for (const dependencyId of entry.dependsOn) {
        const dependency = byId.get(dependencyId);
        if (
          dependency === undefined ||
          (dependency.state !== "failed" && dependency.state !== "cancelled") ||
          requeue.has(dependencyId)
        ) continue;
        requeue.add(dependencyId);
        addFailedAncestors(dependency);
      }
    };
    addFailedAncestors(job);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const entry of jobs) {
        if (
          entry.state !== "failed" ||
          entry.error?.code !== "E_JOB_DEPENDENCY_FAILED" ||
          requeue.has(entry.jobId) ||
          !entry.dependsOn.some((dependencyId) => requeue.has(dependencyId))
        ) continue;
        requeue.add(entry.jobId);
        expanded = true;
      }
    }

    const reset = this.#database.prepare(`
      UPDATE jobs
      SET state = 'queued', progress = 0.0, error = NULL,
          startedAt = NULL, finishedAt = NULL, etaSeconds = NULL,
          attempt = attempt + 1
      WHERE id = ? AND state IN ('failed', 'cancelled')
    `);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const entry of jobs) {
        if (requeue.has(entry.jobId)) reset.run(entry.jobId);
      }
      this.#database.exec("COMMIT;");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    for (const entry of jobs) {
      if (!requeue.has(entry.jobId)) continue;
      const updated = this.get(entry.jobId);
      if (updated?.state === "queued") this.#emit({ kind: "job.state", job: updated });
    }
    const queued = this.get(jobId);
    if (queued === undefined) {
      return jobFailure("E_JOB_NOT_FOUND", `Job ${jobId} does not exist.`, jobId);
    }
    this.#scheduleSoon();
    return success(queued);
  }

  public onChange(listener: JobChangeListener): () => void {
    this.#ensureOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const active of this.#active.values()) {
      if (active.progressTimer !== undefined) clearTimeout(active.progressTimer);
      active.controller.abort();
    }
    this.#active.clear();
    this.#listeners.clear();
    this.#database.close();
  }

  #scheduleSoon(): void {
    queueMicrotask(() => {
      if (!this.#closed) this.#schedule();
    });
  }

  #schedule(): void {
    this.#failBlockedDependencies();
    while (this.#active.size < this.#concurrency) {
      const jobs = this.list();
      const byId = new Map(jobs.map((job) => [job.jobId, job] as const));
      const next = jobs.filter((job) => job.state === "queued")
        .find((job) =>
          this.#executors.has(job.kind) && !this.#active.has(job.jobId) &&
          job.dependsOn.every((dependencyId) => byId.get(dependencyId)?.state === "done"),
        );
      if (next === undefined) return;
      const executor = this.#executors.get(next.kind);
      if (executor === undefined) return;

      const startedAt = new Date().toISOString();
      this.#database.prepare(`
        UPDATE jobs
        SET state = 'running', startedAt = ?, finishedAt = NULL, error = NULL
        WHERE id = ? AND state = 'queued'
      `).run(startedAt, next.jobId);
      const running = this.get(next.jobId);
      if (running === undefined || running.state !== "running") continue;

      const active: ActiveJob = {
        controller: new AbortController(),
        lastProgressWriteAt: 0,
        pendingProgress: undefined,
        progressTimer: undefined,
      };
      this.#active.set(running.jobId, active);
      this.#emit({ kind: "job.state", job: running });
      if (this.#closed) return;
      const claimed = this.get(running.jobId);
      if (
        this.#active.get(running.jobId) !== active ||
        active.controller.signal.aborted ||
        claimed?.state !== "running"
      ) {
        if (this.#active.get(running.jobId) === active) {
          this.#active.delete(running.jobId);
        }
        continue;
      }
      void this.#execute(running, executor, active);
    }
  }

  #failBlockedDependencies(): void {
    const jobs = this.list();
    const byId = new Map(jobs.map((job) => [job.jobId, job] as const));
    const blocked = new Map<string, string[]>();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const job of jobs) {
        if (job.state !== "queued" || blocked.has(job.jobId)) continue;
        const failedDependencies = job.dependsOn.filter((dependencyId) => {
          const dependency = byId.get(dependencyId);
          return dependency === undefined || dependency.state === "failed" ||
            dependency.state === "cancelled" || blocked.has(dependencyId);
        });
        if (failedDependencies.length === 0) continue;
        blocked.set(job.jobId, failedDependencies);
        expanded = true;
      }
    }
    if (blocked.size === 0) return;

    const fail = this.#database.prepare(`
      UPDATE jobs
      SET state = 'failed', error = ?, finishedAt = ?, etaSeconds = NULL
      WHERE id = ? AND state = 'queued'
    `);
    const finishedAt = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const job of jobs) {
        const failedDependencies = blocked.get(job.jobId);
        if (failedDependencies === undefined) continue;
        const envelope = makeGuyditorError(
          "E_JOB_DEPENDENCY_FAILED",
          `Job ${job.jobId} cannot run because ${failedDependencies.join(", ")} failed or was cancelled.`,
          {
            affected: [job.jobId, ...failedDependencies],
            retry: "safe",
            suggestion: "Retry this job to re-queue its dependency chain.",
          },
        );
        fail.run(JSON.stringify(envelope), finishedAt, job.jobId);
      }
      this.#database.exec("COMMIT;");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    for (const job of jobs) {
      if (!blocked.has(job.jobId)) continue;
      const failed = this.get(job.jobId);
      if (failed !== undefined) this.#emit({ kind: "job.state", job: failed });
    }
  }

  async #execute(
    job: JobRecord,
    executor: JobExecutor,
    active: ActiveJob,
  ): Promise<void> {
    try {
      const result = await executor(job, {
        signal: active.controller.signal,
        reportProgress: (progress, etaSeconds) => {
          this.#reportProgress(job.jobId, active, progress, etaSeconds);
        },
      });
      if (this.#closed) return;
      this.#clearProgress(active);
      const current = this.get(job.jobId);
      if (current === undefined || current.state !== "running") return;

      const payload = result === undefined ? current.payload : result;
      this.#database.prepare(`
        UPDATE jobs
        SET state = 'done', progress = 1.0, payload = ?, error = NULL,
            finishedAt = ?, etaSeconds = NULL
        WHERE id = ? AND state = 'running'
      `).run(jsonText(payload), new Date().toISOString(), job.jobId);
      const done = this.get(job.jobId);
      if (done !== undefined) this.#emit({ kind: "job.state", job: done });
    } catch (error: unknown) {
      if (this.#closed) return;
      this.#clearProgress(active);
      const current = this.get(job.jobId);
      if (current === undefined || current.state !== "running") return;

      const envelope = executorError(error, job.jobId);
      this.#database.prepare(`
        UPDATE jobs
        SET state = 'failed', error = ?, finishedAt = ?, etaSeconds = NULL
        WHERE id = ? AND state = 'running'
      `).run(JSON.stringify(envelope), new Date().toISOString(), job.jobId);
      const failed = this.get(job.jobId);
      if (failed !== undefined) this.#emit({ kind: "job.state", job: failed });
    } finally {
      this.#clearProgress(active);
      if (this.#active.get(job.jobId) === active) this.#active.delete(job.jobId);
      if (!this.#closed) this.#scheduleSoon();
    }
  }

  #reportProgress(
    jobId: string,
    active: ActiveJob,
    progress: number,
    etaSeconds?: number,
  ): void {
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
      throw new RangeError("Job progress must be a finite number from 0 through 1.");
    }
    if (etaSeconds !== undefined && (!Number.isFinite(etaSeconds) || etaSeconds < 0)) {
      throw new RangeError("Job ETA must be a finite non-negative number.");
    }
    if (
      this.#closed ||
      active.controller.signal.aborted ||
      this.#active.get(jobId) !== active
    ) return;

    const pending: PendingProgress = { progress };
    if (etaSeconds !== undefined) pending.etaSeconds = etaSeconds;
    const elapsed = Date.now() - active.lastProgressWriteAt;
    if (elapsed >= PROGRESS_WRITE_INTERVAL_MS) {
      this.#writeProgress(jobId, active, pending);
      return;
    }

    active.pendingProgress = pending;
    if (active.progressTimer !== undefined) return;
    active.progressTimer = setTimeout(() => {
      active.progressTimer = undefined;
      const latest = active.pendingProgress;
      active.pendingProgress = undefined;
      if (latest !== undefined) this.#writeProgress(jobId, active, latest);
    }, PROGRESS_WRITE_INTERVAL_MS - elapsed);
  }

  #writeProgress(
    jobId: string,
    active: ActiveJob,
    update: PendingProgress,
  ): void {
    if (
      this.#closed ||
      active.controller.signal.aborted ||
      this.#active.get(jobId) !== active
    ) return;
    const result = this.#database.prepare(`
      UPDATE jobs
      SET progress = ?, etaSeconds = ?
      WHERE id = ? AND state = 'running'
    `).run(update.progress, update.etaSeconds ?? null, jobId);
    if (Number(result.changes) === 0) return;

    active.lastProgressWriteAt = Date.now();
    const progressJob = this.get(jobId);
    if (progressJob !== undefined) this.#emit({ kind: "job.progress", job: progressJob });
  }

  #clearProgress(active: ActiveJob): void {
    if (active.progressTimer !== undefined) clearTimeout(active.progressTimer);
    active.progressTimer = undefined;
    active.pendingProgress = undefined;
  }

  #emit(event: JobChangeEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        this.#listeners.delete(listener);
      }
    }
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("JobQueue is closed.");
  }
}
