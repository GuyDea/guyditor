import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobQueue, ProjectStore } from "../../core/src/index.js";
import type { Result } from "../../core/src/index.js";
import { CaptureWatcher, MediaEngine } from "./index.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];
const queues: JobQueue[] = [];
const watchers: CaptureWatcher[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

afterEach(async () => {
  await Promise.all(watchers.splice(0).map(async (watcher) => watcher.stop()));
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function waitUntil(predicate: () => boolean, label: string | (() => string)): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${typeof label === "string" ? label : label()}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("CaptureWatcher watch-folder integration", () => {
  it("keeps an unavailable saved watch folder nonfatal and reports it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guyditor-capture-offline-"));
    temporaryDirectories.push(root);
    const store = await valueOf(ProjectStore.createProject(
      path.join(root, "project"),
      { name: "Offline capture root" },
      { profilesDirectory: path.join(REPOSITORY_ROOT, "profiles") },
    ));
    const { queue } = JobQueue.open(path.join(store.root, ".guyditor/jobs.sqlite"));
    queues.push(queue);
    const warnings: Array<{ code: string; path: string }> = [];
    const watcher = new CaptureWatcher({
      project: store,
      media: new MediaEngine({ jobQueue: queue, followUpJobs: [] }),
      jobQueue: queue,
      onWarning: ({ code, path: warningPath }) => {
        warnings.push({ code, path: warningPath });
      },
    });
    watchers.push(watcher);
    const missing = path.join(root, "offline-volume", "captures");

    await expect(watcher.start([{
      path: missing,
      convention: "guyditor",
      autoIngest: true,
      autoJobs: { proxy: false, analysis: false, transcription: false },
    }])).resolves.toBeUndefined();

    expect(watcher.configs).toEqual([expect.objectContaining({ path: missing })]);
    expect(warnings).toContainEqual({
      code: "E_CAPTURE_WATCH_FAILED",
      path: missing,
    });
  });

  it("stabilizes drops, groups a session, chains configured jobs, imports marker files, and emits ingest events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guyditor-capture-"));
    temporaryDirectories.push(root);
    const store = await valueOf(ProjectStore.createProject(
      path.join(root, "project"),
      { name: "Capture test" },
      { profilesDirectory: path.join(REPOSITORY_ROOT, "profiles") },
    ));
    const watchRoot = path.join(root, "watch");
    const sessionRoot = path.join(watchRoot, "20260719-1030_ep12-hooks");
    await mkdir(sessionRoot, { recursive: true });
    const { queue } = JobQueue.open(path.join(store.root, ".guyditor/jobs.sqlite"));
    queues.push(queue);
    const media = new MediaEngine({ jobQueue: queue, followUpJobs: [] });
    const ingested: string[][] = [];
    const seededTakes: Array<{ assetId: string; id: string; index: number }> = [];
    const markerFiles: Array<{ path: string; sessionId: string }> = [];
    const warnings: string[] = [];
    const watcher = new CaptureWatcher({
      project: store,
      media,
      jobQueue: queue,
      stability: { awaitWriteFinishMs: 20, pollIntervalMs: 10, verifyUnchangedMs: 20 },
      onIngested: (assetIds) => ingested.push([...assetIds]),
      onTakeSeeded: (assetId, take) => {
        seededTakes.push({ assetId, ...take });
        return Promise.resolve();
      },
      importMarkerFile: (markerPath, sessionId) => {
        markerFiles.push({ path: markerPath, sessionId });
        return Promise.resolve();
      },
      onWarning: ({ code, message }) => warnings.push(`${code}: ${message}`),
    });
    watchers.push(watcher);
    await watcher.start([{
      path: watchRoot,
      convention: "guyditor",
      autoIngest: true,
      autoJobs: { proxy: false, analysis: true, transcription: true },
    }]);

    await Promise.all([
      copyFile(path.join(REPOSITORY_ROOT, ".fixtures/bars-1080p30-10s.mp4"), path.join(sessionRoot, "cam-a_t03.mp4")),
      copyFile(path.join(REPOSITORY_ROOT, ".fixtures/speech-48k-20s.wav"), path.join(sessionRoot, "mic-lav_t03.wav")),
    ]);
    await waitUntil(
      () => ingested.flat().length === 2,
      () => `two watcher.ingested assets (${JSON.stringify({ warnings, jobs: queue.list().map(({ kind, state, error }) => ({ kind, state, error })) })})`,
    );

    const assets = store.currentProject.assets;
    expect(assets).toHaveLength(2);
    expect(new Set(assets.map(({ session }) => session))).toEqual(new Set([expect.stringMatching(/^ses_[a-z2-7]{10}$/u)]));
    expect(assets.every(({ takes }) => takes?.length === 1)).toBe(true);
    expect(seededTakes).toHaveLength(2);
    expect(seededTakes.map(({ index }) => index)).toEqual([3, 3]);
    expect(new Set(seededTakes.map(({ assetId }) => assetId)))
      .toEqual(new Set(assets.map(({ id }) => id)));
    expect(queue.list().map(({ kind }) => kind).sort()).toEqual([
      "ingest", "ingest", "peaks.generate", "peaks.generate",
      "transcribe", "transcribe", "vad", "vad",
    ]);
    const overview = await queue.overview();
    expect(overview.queued.map(({ kind }) => kind).sort()).toEqual([
      "transcribe", "transcribe", "vad", "vad",
    ]);
    expect(overview.queued.every(({ dependencyChain }) =>
      dependencyChain.some(({ kind, state }) => kind === "ingest" && state === "done"),
    )).toBe(true);

    await writeFile(path.join(sessionRoot, "markers.json"), JSON.stringify({
      format: "guyditor.take-markers-intake/v1",
      session: "ep12-hooks",
      clock: "recording",
      markers: [],
    }), "utf8");
    await waitUntil(() => markerFiles.length === 1, "marker-file import");
    expect(markerFiles[0]).toMatchObject({
      path: path.join(sessionRoot, "markers.json"),
      sessionId: assets[0]!.session,
    });

    await watcher.reconcile();
    expect(queue.list().filter(({ kind }) => kind === "ingest")).toHaveLength(2);
  }, 20_000);

  it("waits for an in-flight marker handler before close completes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guyditor-capture-close-"));
    temporaryDirectories.push(root);
    const store = await valueOf(ProjectStore.createProject(
      path.join(root, "project"),
      { name: "Capture close test" },
      { profilesDirectory: path.join(REPOSITORY_ROOT, "profiles") },
    ));
    const watchRoot = path.join(root, "watch");
    await mkdir(watchRoot, { recursive: true });
    const { queue } = JobQueue.open(path.join(store.root, ".guyditor/jobs.sqlite"));
    queues.push(queue);
    const entered = deferred();
    const release = deferred();
    const watcher = new CaptureWatcher({
      project: store,
      media: new MediaEngine({ jobQueue: queue, followUpJobs: [] }),
      jobQueue: queue,
      stability: { awaitWriteFinishMs: 20, pollIntervalMs: 10, verifyUnchangedMs: 20 },
      importMarkerFile: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    watchers.push(watcher);
    await watcher.start([{
      path: watchRoot,
      convention: "guyditor",
      autoIngest: true,
      autoJobs: { proxy: false, analysis: false, transcription: false },
    }]);
    await writeFile(path.join(watchRoot, "markers.json"), JSON.stringify({
      format: "guyditor.take-markers-intake/v1",
      session: "close-test",
      clock: "recording",
      markers: [],
    }), "utf8");

    const reconciling = watcher.reconcile();
    await entered.promise;
    let closeCompleted = false;
    const closing = watcher.close().then(() => {
      closeCompleted = true;
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect(closeCompleted).toBe(false);
    release.resolve();
    await Promise.all([reconciling, closing]);
    await expect(watcher.reconcile()).rejects.toThrow(/closed/iu);
  });
});
