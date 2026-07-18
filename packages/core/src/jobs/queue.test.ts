import { mkdtemp, rm } from "node:fs/promises";
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
