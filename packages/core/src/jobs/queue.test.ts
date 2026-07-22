import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { JobQueue } from "./index.js";
import type { JobChangeEvent } from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function databasePath(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "guyditor-jobs-"));
  directories.push(project);
  return join(project, ".guyditor", "jobs.sqlite");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for JobQueue state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === undefined) throw new Error("Deferred was not initialized.");
      resolvePromise();
    },
  };
}

describe("JobQueue persistence", () => {
  it("persists a queued job across close and reopen", async () => {
    const path = await databasePath();
    const opened = JobQueue.open(path);

    expect(opened.recoveryNeeded).toBe(false);
    const enqueued = opened.queue.enqueue({
      kind: "analysis.scenes",
      title: "Detect scenes",
      payload: { assetId: "ast_aaaaaaaaaa" },
      cancellable: true,
    });

    expect(enqueued).toMatchObject({
      kind: "analysis.scenes",
      state: "queued",
      progress: 0,
      title: "Detect scenes",
      cancellable: true,
      payload: { assetId: "ast_aaaaaaaaaa" },
      attempt: 1,
    });
    expect(enqueued.jobId).toMatch(/^job_[a-z2-7]{10}$/);
    expect(new Date(enqueued.createdAt).toISOString()).toBe(enqueued.createdAt);
    expect(opened.queue.get(enqueued.jobId)).toEqual(enqueued);
    opened.queue.close();

    const reopened = JobQueue.open(path);
    expect(reopened.recoveryNeeded).toBe(false);
    expect(reopened.queue.list()).toEqual([enqueued]);

    const inspection = new DatabaseSync(path, { readOnly: true });
    expect(inspection.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    inspection.close();
    reopened.queue.close();
  });

  it("marks a directly persisted running job as safely interrupted", async () => {
    const path = await databasePath();
    const initial = JobQueue.open(path);
    const job = initial.queue.enqueue({
      kind: "render.export",
      title: "Export episode",
      payload: { deliverableId: "dlv_aaaaaaaaaa" },
      cancellable: true,
    });
    initial.queue.close();

    const direct = new DatabaseSync(path);
    direct.prepare(`
      UPDATE jobs
      SET state = 'running', startedAt = ?
      WHERE id = ?
    `).run("2026-07-18T12:00:00.000Z", job.jobId);
    direct.close();

    const recovered = JobQueue.open(path);
    expect(recovered.recoveryNeeded).toBe(true);
    expect(recovered.queue.get(job.jobId)).toMatchObject({
      state: "failed",
      attempt: 1,
      error: {
        code: "E_JOB_INTERRUPTED",
        affected: [job.jobId],
        acceptedStateChanged: false,
        retry: "safe",
      },
    });
    expect(recovered.queue.get(job.jobId)?.finishedAt).toBeDefined();
    recovered.queue.close();
  });

  it("rejects invalid concurrency before opening or recovering the database", async () => {
    const path = await databasePath();
    const initial = JobQueue.open(path);
    const job = initial.queue.enqueue({
      kind: "render.export",
      title: "Export episode",
      payload: null,
      cancellable: true,
    });
    initial.queue.close();
    const direct = new DatabaseSync(path);
    direct.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.jobId);
    direct.close();

    expect(() => JobQueue.open(path, { concurrency: 0 })).toThrow(
      "JobQueue concurrency must be a positive integer.",
    );

    const inspection = new DatabaseSync(path, { readOnly: true });
    expect(inspection.prepare("SELECT state FROM jobs WHERE id = ?").get(job.jobId))
      .toEqual({ state: "running" });
    inspection.close();
    const recovered = JobQueue.open(path);
    expect(recovered.recoveryNeeded).toBe(true);
    recovered.queue.close();
  });

  it("adds nullable dependency metadata when opening a pre-amendment database", async () => {
    const path = await databasePath();
    await mkdir(join(path, ".."), { recursive: true });
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        progress REAL NOT NULL,
        title TEXT NOT NULL,
        cancellable INTEGER NOT NULL,
        payload TEXT NOT NULL,
        error TEXT,
        createdAt TEXT NOT NULL,
        startedAt TEXT,
        finishedAt TEXT,
        etaSeconds REAL,
        attempt INTEGER NOT NULL
      ) STRICT;
      INSERT INTO jobs (
        id, kind, state, progress, title, cancellable, payload, error,
        createdAt, startedAt, finishedAt, etaSeconds, attempt
      ) VALUES (
        'job_aaaaaaaaaa', 'legacy', 'queued', 0.0, 'Legacy job', 1, '{}', NULL,
        '2026-07-19T00:00:00.000Z', NULL, NULL, NULL, 1
      );
    `);
    legacy.close();

    const { queue } = JobQueue.open(path);
    expect(queue.get("job_aaaaaaaaaa")).toMatchObject({
      jobId: "job_aaaaaaaaaa",
      dependsOn: [],
    });
    queue.close();

    const inspection = new DatabaseSync(path, { readOnly: true });
    const column = inspection.prepare("PRAGMA table_info(jobs)").all()
      .find((entry) => entry["name"] === "dependsOn");
    expect(column).toMatchObject({ name: "dependsOn", notnull: 0 });
    inspection.close();
  });
});

describe("JobQueue execution", () => {
  it("runs an executor, persists throttled progress, and completes with its result", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path, { concurrency: 1 });
    const release = deferred();
    const events: { event: JobChangeEvent; at: number }[] = [];
    queue.onChange((event) => events.push({ event, at: Date.now() }));
    queue.registerExecutor("analysis.scenes", async (_job, { reportProgress }) => {
      reportProgress(0.1, 12);
      reportProgress(0.2, 10);
      reportProgress(0.3, 8);
      await new Promise((resolve) => setTimeout(resolve, 300));
      reportProgress(0.7, 2);
      await release.promise;
      return { sceneCount: 4 };
    });

    const job = queue.enqueue({
      kind: "analysis.scenes",
      title: "Detect scenes",
      payload: { assetId: "ast_aaaaaaaaaa" },
      cancellable: true,
    });

    await waitFor(() => queue.get(job.jobId)?.progress === 0.3);
    expect(queue.get(job.jobId)).toMatchObject({ progress: 0.3, etaSeconds: 8 });
    await waitFor(() => queue.get(job.jobId)?.progress === 0.7);
    expect(queue.get(job.jobId)).toMatchObject({ progress: 0.7, etaSeconds: 2 });

    const progressEvents = events.filter(({ event }) => event.kind === "job.progress");
    expect(progressEvents.map(({ event }) => event.job.progress)).toEqual([0.1, 0.3, 0.7]);
    for (let index = 1; index < progressEvents.length; index += 1) {
      expect(progressEvents[index]!.at - progressEvents[index - 1]!.at).toBeGreaterThanOrEqual(240);
    }

    release.resolve();
    await waitFor(() => queue.get(job.jobId)?.state === "done");
    expect(queue.get(job.jobId)).toMatchObject({
      state: "done",
      progress: 1,
      payload: { sceneCount: 4 },
    });
    expect(queue.get(job.jobId)?.etaSeconds).toBeUndefined();
    expect(events.filter(({ event }) => event.kind === "job.state")
      .map(({ event }) => event.job.state)).toEqual(["queued", "running", "done"]);
    queue.close();

    const reopened = JobQueue.open(path);
    expect(reopened.queue.get(job.jobId)).toMatchObject({
      state: "done",
      progress: 1,
      payload: { sceneCount: 4 },
    });
    reopened.queue.close();
  });

  it("wraps a thrown executor error in a safely retryable envelope", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path);
    queue.registerExecutor("render.export", async () => {
      throw new Error("ffmpeg exited with status 1");
    });

    const job = queue.enqueue({
      kind: "render.export",
      title: "Export episode",
      payload: { deliverableId: "dlv_aaaaaaaaaa" },
      cancellable: true,
    });
    await waitFor(() => queue.get(job.jobId)?.state === "failed");

    expect(queue.get(job.jobId)).toMatchObject({
      state: "failed",
      error: {
        code: "E_JOB_EXECUTOR_FAILED",
        message: "ffmpeg exited with status 1",
        affected: [job.jobId],
        acceptedStateChanged: false,
        retry: "safe",
      },
    });
    queue.close();
  });

  it("does not let a throwing change listener strand a running job", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path);
    queue.onChange((event) => {
      if (event.kind === "job.state" && event.job.state === "running") {
        throw new Error("broken observer");
      }
    });
    queue.registerExecutor("analysis.silence", async () => ({ regions: 3 }));

    const job = queue.enqueue({
      kind: "analysis.silence",
      title: "Detect silence",
      payload: { assetId: "ast_aaaaaaaaaa" },
      cancellable: true,
    });
    await waitFor(() => queue.get(job.jobId)?.state === "done");

    expect(queue.get(job.jobId)).toMatchObject({
      state: "done",
      payload: { regions: 3 },
    });
    queue.close();
  });

  it("does not invoke an executor cancelled by its running-state listener", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path, { concurrency: 1 });
    let cancelledExecutorCalls = 0;
    queue.onChange((event) => {
      if (event.kind === "job.state" && event.job.kind === "analysis.cancel-before" &&
        event.job.state === "running") {
        queue.cancel(event.job.jobId);
      }
    });
    queue.registerExecutor("analysis.cancel-before", async (_job, { signal }) => {
      cancelledExecutorCalls += 1;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    });
    queue.registerExecutor("analysis.after-cancel", async () => ({ completed: true }));

    const cancelled = queue.enqueue({
      kind: "analysis.cancel-before",
      title: "Cancel before execute",
      payload: null,
      cancellable: true,
    });
    const following = queue.enqueue({
      kind: "analysis.after-cancel",
      title: "Run after cancellation",
      payload: null,
      cancellable: true,
    });
    await waitFor(() => queue.get(following.jobId)?.state === "done");

    expect(cancelledExecutorCalls).toBe(0);
    expect(queue.get(cancelled.jobId)?.state).toBe("cancelled");
    expect(queue.get(following.jobId)?.state).toBe("done");
    queue.close();
  });

  it("keeps unsupported jobs queued without blocking eligible work", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path, { concurrency: 1 });
    const startOrder: string[] = [];
    const unsupported = queue.enqueue({
      kind: "analysis.unsupported",
      title: "Wait for capability",
      payload: null,
      cancellable: true,
    });
    queue.registerExecutor("analysis.supported", async (job) => {
      startOrder.push(job.jobId);
      return null;
    });
    const supported = queue.enqueue({
      kind: "analysis.supported",
      title: "Run supported analysis",
      payload: null,
      cancellable: true,
    });

    await waitFor(() => queue.get(supported.jobId)?.state === "done");
    expect(queue.get(unsupported.jobId)?.state).toBe("queued");
    expect(startOrder).toEqual([supported.jobId]);

    queue.registerExecutor("analysis.unsupported", async (job) => {
      startOrder.push(job.jobId);
      return null;
    });
    await waitFor(() => queue.get(unsupported.jobId)?.state === "done");
    expect(startOrder).toEqual([supported.jobId, unsupported.jobId]);
    queue.close();
  });

  it("starts a dependency chain only after each prerequisite completes", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path, { concurrency: 3 });
    const ingestGate = deferred();
    const proxyGate = deferred();
    const transcribeGate = deferred();
    const startOrder: string[] = [];
    queue.registerExecutor("ingest", async (job) => {
      startOrder.push(job.jobId);
      await ingestGate.promise;
      return null;
    });
    queue.registerExecutor("proxy.generate", async (job) => {
      startOrder.push(job.jobId);
      await proxyGate.promise;
      return null;
    });
    queue.registerExecutor("transcribe", async (job) => {
      startOrder.push(job.jobId);
      await transcribeGate.promise;
      return null;
    });
    const ingest = queue.enqueue({
      kind: "ingest",
      title: "Ingest asset",
      payload: null,
      cancellable: true,
    });
    const proxy = queue.enqueue({
      kind: "proxy.generate",
      title: "Generate proxy",
      payload: null,
      cancellable: true,
      dependsOn: [ingest.jobId],
    });
    const transcribe = queue.enqueue({
      kind: "transcribe",
      title: "Transcribe asset",
      payload: null,
      cancellable: true,
      dependsOn: [proxy.jobId],
    });

    await waitFor(() => startOrder.length === 1);
    expect(startOrder).toEqual([ingest.jobId]);
    expect(queue.get(proxy.jobId)).toMatchObject({
      state: "queued",
      dependsOn: [ingest.jobId],
    });
    expect(queue.get(transcribe.jobId)).toMatchObject({
      state: "queued",
      dependsOn: [proxy.jobId],
    });

    ingestGate.resolve();
    await waitFor(() => startOrder.length === 2);
    expect(startOrder).toEqual([ingest.jobId, proxy.jobId]);
    proxyGate.resolve();
    await waitFor(() => startOrder.length === 3);
    expect(startOrder).toEqual([ingest.jobId, proxy.jobId, transcribe.jobId]);
    transcribeGate.resolve();
    await waitFor(() => queue.get(transcribe.jobId)?.state === "done");
    queue.close();
  });

  it("runs a terminal aggregate after every dependency finishes even when one failed", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path, { concurrency: 3 });
    queue.registerExecutor("batch.ok", async () => ({ output: "ok" }));
    queue.registerExecutor("batch.fail", async () => {
      throw new Error("fixture failure");
    });
    queue.registerExecutor("batch.parent", async (job) => ({
      items: job.dependsOn.map((jobId) => ({
        jobId,
        state: queue.get(jobId)?.state ?? "failed",
        error: queue.get(jobId)?.error?.code ?? null,
      })),
    }));
    const ok = queue.enqueue({
      kind: "batch.ok",
      title: "Valid item",
      payload: null,
      cancellable: true,
    });
    const failed = queue.enqueue({
      kind: "batch.fail",
      title: "Invalid item",
      payload: null,
      cancellable: true,
    });
    const parent = queue.enqueue({
      kind: "batch.parent",
      title: "Batch aggregate",
      payload: null,
      cancellable: true,
      dependsOn: [ok.jobId, failed.jobId],
      dependencyMode: "terminal",
    });

    await waitFor(() => queue.get(parent.jobId)?.state === "done");
    expect(queue.get(parent.jobId)).toMatchObject({
      state: "done",
      dependencyMode: "terminal",
      payload: {
        items: [
          { jobId: ok.jobId, state: "done", error: null },
          { jobId: failed.jobId, state: "failed", error: "E_JOB_EXECUTOR_FAILED" },
        ],
      },
    });
    queue.close();
  });

  it("fails descendants when a dependency fails and retries the affected chain", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path, { concurrency: 3 });
    queue.registerExecutor("chain.root", async (job) => {
      if (job.attempt === 1) throw new Error("root failed");
      return null;
    });
    queue.registerExecutor("chain.middle", async () => null);
    queue.registerExecutor("chain.leaf", async () => null);
    const root = queue.enqueue({
      kind: "chain.root",
      title: "Root",
      payload: null,
      cancellable: true,
    });
    const middle = queue.enqueue({
      kind: "chain.middle",
      title: "Middle",
      payload: null,
      cancellable: true,
      dependsOn: [root.jobId],
    });
    const leaf = queue.enqueue({
      kind: "chain.leaf",
      title: "Leaf",
      payload: null,
      cancellable: true,
      dependsOn: [middle.jobId],
    });
    const propagationSnapshots: Array<[string | undefined, string | undefined]> = [];
    queue.onChange(({ job }) => {
      if (job.error?.code !== "E_JOB_DEPENDENCY_FAILED") return;
      propagationSnapshots.push([
        queue.get(middle.jobId)?.state,
        queue.get(leaf.jobId)?.state,
      ]);
    });

    await waitFor(() => queue.get(leaf.jobId)?.state === "failed");
    expect(propagationSnapshots).not.toHaveLength(0);
    expect(propagationSnapshots.every((states) =>
      states[0] === "failed" && states[1] === "failed"
    )).toBe(true);
    expect(queue.get(middle.jobId)).toMatchObject({
      state: "failed",
      error: {
        code: "E_JOB_DEPENDENCY_FAILED",
        retry: "safe",
        affected: [middle.jobId, root.jobId],
      },
    });
    expect(queue.get(leaf.jobId)).toMatchObject({
      state: "failed",
      error: { code: "E_JOB_DEPENDENCY_FAILED", retry: "safe" },
    });

    const requeuedEvents: string[] = [];
    queue.onChange(({ job }) => {
      if (job.state === "queued" && job.attempt === 2) requeuedEvents.push(job.jobId);
    });
    expect(queue.retry(root.jobId)).toMatchObject({
      ok: true,
      value: { jobId: root.jobId, state: "queued", attempt: 2 },
    });
    expect(requeuedEvents).toEqual([root.jobId, middle.jobId, leaf.jobId]);
    await waitFor(() => queue.get(leaf.jobId)?.state === "done");
    expect(queue.get(middle.jobId)).toMatchObject({ state: "done", attempt: 2 });
    expect(queue.get(leaf.jobId)).toMatchObject({ state: "done", attempt: 2 });
    queue.close();
  });

  it("treats cancellation as dependency failure and leaf retry re-queues ancestors", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path, { concurrency: 2 });
    const root = queue.enqueue({
      kind: "chain.cancelled-root",
      title: "Cancelled root",
      payload: null,
      cancellable: true,
    });
    const leaf = queue.enqueue({
      kind: "chain.cancelled-leaf",
      title: "Cancelled leaf",
      payload: null,
      cancellable: true,
      dependsOn: [root.jobId],
    });
    expect(queue.cancel(root.jobId).ok).toBe(true);
    await waitFor(() => queue.get(leaf.jobId)?.state === "failed");
    expect(queue.get(leaf.jobId)).toMatchObject({
      error: { code: "E_JOB_DEPENDENCY_FAILED", retry: "safe" },
    });

    queue.registerExecutor("chain.cancelled-root", async () => null);
    queue.registerExecutor("chain.cancelled-leaf", async () => null);
    expect(queue.retry(leaf.jobId)).toMatchObject({
      ok: true,
      value: { jobId: leaf.jobId, state: "queued", attempt: 2 },
    });
    await waitFor(() => queue.get(leaf.jobId)?.state === "done");
    expect(queue.get(root.jobId)).toMatchObject({ state: "done", attempt: 2 });
    queue.close();
  });
});

describe("JobQueue lifecycle controls", () => {
  it("cancels a running cancellable job and aborts its executor signal", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path);
    const started = deferred();
    let abortObserved = false;
    queue.registerExecutor("transcript.align", async (_job, { signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          abortObserved = true;
          resolve();
        }, { once: true });
      });
      return null;
    });
    const job = queue.enqueue({
      kind: "transcript.align",
      title: "Align transcript",
      payload: { assetId: "ast_aaaaaaaaaa" },
      cancellable: true,
    });
    await started.promise;

    expect(queue.cancel(job.jobId)).toMatchObject({
      ok: true,
      value: { state: "cancelled" },
    });
    expect(abortObserved).toBe(true);
    await waitFor(() => queue.get(job.jobId)?.state === "cancelled");
    expect(queue.get(job.jobId)).toMatchObject({ state: "cancelled" });
    expect(queue.get(job.jobId)?.error).toBeUndefined();
    queue.close();
  });

  it("rejects cancellation of a non-cancellable job with a structured error", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path);
    const job = queue.enqueue({
      kind: "backup.project",
      title: "Back up project",
      payload: null,
      cancellable: false,
    });

    expect(queue.cancel(job.jobId)).toEqual({
      ok: false,
      error: {
        code: "E_JOB_NOT_CANCELLABLE",
        message: `Job ${job.jobId} is not cancellable.`,
        affected: [job.jobId],
        acceptedStateChanged: false,
        retry: "none",
      },
    });
    expect(queue.get(job.jobId)?.state).toBe("queued");
    queue.close();
  });

  it("retries a failed job with an incremented attempt", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path);
    const attempts: number[] = [];
    queue.registerExecutor("proxy.generate", async (job) => {
      attempts.push(job.attempt);
      if (job.attempt === 1) throw new Error("temporary failure");
      return { proxyPath: ".guyditor/cache/proxy.mp4" };
    });
    const job = queue.enqueue({
      kind: "proxy.generate",
      title: "Generate proxy",
      payload: { assetId: "ast_aaaaaaaaaa" },
      cancellable: true,
    });
    await waitFor(() => queue.get(job.jobId)?.state === "failed");

    expect(queue.retry(job.jobId)).toMatchObject({
      ok: true,
      value: { state: "queued", attempt: 2, progress: 0 },
    });
    await waitFor(() => queue.get(job.jobId)?.state === "done");
    expect(attempts).toEqual([1, 2]);
    expect(queue.get(job.jobId)).toMatchObject({
      state: "done",
      attempt: 2,
      payload: { proxyPath: ".guyditor/cache/proxy.mp4" },
    });
    queue.close();
  });

  it("waits for a cancelled executor to settle before starting its retry", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path, { concurrency: 2 });
    const firstStarted = deferred();
    const firstRelease = deferred();
    const firstReturned = deferred();
    const secondStarted = deferred();
    const secondRelease = deferred();
    queue.registerExecutor("analysis.faces", async (job, { signal }) => {
      if (job.attempt === 1) {
        firstStarted.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await firstRelease.promise;
        firstReturned.resolve();
        return { completedAttempt: 1 };
      }
      secondStarted.resolve();
      await secondRelease.promise;
      return { completedAttempt: 2 };
    });
    const job = queue.enqueue({
      kind: "analysis.faces",
      title: "Track faces",
      payload: { assetId: "ast_aaaaaaaaaa" },
      cancellable: true,
    });
    await firstStarted.promise;
    expect(queue.cancel(job.jobId).ok).toBe(true);
    expect(queue.retry(job.jobId)).toMatchObject({
      ok: true,
      value: { state: "queued", attempt: 2 },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queue.get(job.jobId)?.state).toBe("queued");
    firstRelease.resolve();
    await firstReturned.promise;
    await secondStarted.promise;
    expect(queue.get(job.jobId)).toMatchObject({ state: "running", attempt: 2 });

    secondRelease.resolve();
    await waitFor(() => queue.get(job.jobId)?.state === "done");
    expect(queue.get(job.jobId)).toMatchObject({
      state: "done",
      attempt: 2,
      payload: { completedAttempt: 2 },
    });
    queue.close();
  });

  it("runs no more than the configured concurrency in FIFO order", async () => {
    const path = await databasePath();
    const { queue } = JobQueue.open(path, { concurrency: 2 });
    const gates = [deferred(), deferred(), deferred()];
    const startOrder: string[] = [];
    let active = 0;
    let maximumActive = 0;
    queue.registerExecutor("analysis.waveform", async (job) => {
      const index = startOrder.length;
      startOrder.push(job.jobId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gates[index]!.promise;
      active -= 1;
      return null;
    });
    const jobs = [0, 1, 2].map((index) => queue.enqueue({
      kind: "analysis.waveform",
      title: `Build waveform ${String(index)}`,
      payload: { index },
      cancellable: true,
    }));

    await waitFor(() => startOrder.length === 2);
    expect(startOrder).toEqual(jobs.slice(0, 2).map(({ jobId }) => jobId));
    expect(maximumActive).toBe(2);
    gates[0]!.resolve();
    await waitFor(() => startOrder.length === 3);
    expect(startOrder).toEqual(jobs.map(({ jobId }) => jobId));
    expect(maximumActive).toBe(2);

    gates[1]!.resolve();
    gates[2]!.resolve();
    await waitFor(() => jobs.every(({ jobId }) => queue.get(jobId)?.state === "done"));
    expect(maximumActive).toBe(2);
    queue.close();
  });
});

describe("JobQueue overview", () => {
  it("groups active work and creator waits with ETA-weighted aggregate progress", async () => {
    const path = await databasePath();
    const release = deferred();
    const { queue } = JobQueue.open(path, {
      concurrency: 1,
      overviewSources: {
        proposals: async () => [{
          proposalId: "prp_aaaaaaaaaa",
          title: "Review tighter opening",
          createdAt: "2026-07-19T10:00:00.000Z",
        }],
        annotations: async () => [{
          annotationId: "ann_aaaaaaaaaa",
          code: "VAL-400",
          message: "Resolve the blocking framing note.",
          sequenceId: "seq_aaaaaaaaaa",
        }],
        confirmations: () => [{
          confirmToken: "confirm-overview",
          taskId: "generation-task",
          level: "task" as const,
          message: "Confirm projected spend.",
          estimatedUsd: 1.25,
          createdAt: "2026-07-19T10:01:00.000Z",
        }],
      },
    });
    queue.registerExecutor("overview.running", async (_job, { reportProgress }) => {
      reportProgress(0.5, 9);
      await release.promise;
      return null;
    });
    queue.registerExecutor("overview.queued", async () => null);
    const running = queue.enqueue({
      kind: "overview.running",
      title: "Running overview job",
      payload: null,
      cancellable: true,
    });
    const queued = queue.enqueue({
      kind: "overview.queued",
      title: "Queued overview job",
      payload: null,
      cancellable: true,
      dependsOn: [running.jobId],
    });
    await waitFor(() => queue.get(running.jobId)?.progress === 0.5);

    const overview = await queue.overview();
    expect(overview.running).toEqual([
      expect.objectContaining({
        jobId: running.jobId,
        state: "running",
        progress: 0.5,
        etaSeconds: 9,
      }),
    ]);
    expect(overview.queued).toEqual([
      expect.objectContaining({
        jobId: queued.jobId,
        state: "queued",
        dependencyChain: [{
          jobId: running.jobId,
          kind: "overview.running",
          title: "Running overview job",
          state: "running",
          dependencies: [],
        }],
      }),
    ]);
    expect(overview.waitingOnCreator).toEqual({
      proposals: [expect.objectContaining({ proposalId: "prp_aaaaaaaaaa" })],
      annotations: [expect.objectContaining({ annotationId: "ann_aaaaaaaaaa" })],
      confirmations: [expect.objectContaining({ confirmToken: "confirm-overview" })],
    });
    expect(overview.waitingOnExternal).toEqual([]);
    expect(overview.aggregateFraction).toBeCloseTo(0.45, 8);
    expect(overview.idle).toBe(false);

    release.resolve();
    await waitFor(() => queue.get(queued.jobId)?.state === "done");
    queue.close();
  });

  it("reports a complete aggregate and idle when every group is empty", async () => {
    const { queue } = JobQueue.open(":memory:");
    await expect(queue.overview()).resolves.toEqual({
      running: [],
      queued: [],
      retryable: [],
      waitingOnCreator: { proposals: [], annotations: [], confirmations: [] },
      waitingOnExternal: [],
      aggregateFraction: 1,
      idle: true,
    });
    queue.close();
  });

  it("keeps failed jobs needing attention in the shared overview until retried", async () => {
    const { queue } = JobQueue.open(":memory:");
    queue.registerExecutor("overview.failed", async () => {
      throw new Error("needs a retry");
    });
    const failed = queue.enqueue({
      kind: "overview.failed",
      title: "Failed overview job",
      payload: null,
      cancellable: true,
    });
    await waitFor(() => queue.get(failed.jobId)?.state === "failed");

    await expect(queue.overview()).resolves.toMatchObject({
      running: [],
      queued: [],
      retryable: [{ jobId: failed.jobId, state: "failed" }],
      aggregateFraction: 1,
      idle: false,
    });
    queue.close();
  });
});
