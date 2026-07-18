import { existsSync } from "node:fs";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  ProjectStore,
} from "../../core/src/index.js";
import type {
  JobRecord,
  Result,
} from "../../core/src/index.js";
import {
  FORMAT_SUPPORT_TIERS,
  MediaEngine,
  runFfmpeg,
} from "./index.js";
import type { IngestJobResult } from "./index.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE_ROOT = path.join(REPOSITORY_ROOT, ".fixtures");
const FIXTURES_AVAILABLE = existsSync(path.join(FIXTURE_ROOT, "manifest.json"));
const temporaryDirectories: string[] = [];
const queues: JobQueue[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true }),
  ));
});

async function sandbox(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "guyditor-ingest-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function projectAndQueue(): Promise<{
  queue: JobQueue;
  store: ProjectStore;
}> {
  const root = await sandbox();
  const store = await valueOf(ProjectStore.createProject(
    path.join(root, "project"),
    { name: "Ingest test" },
    { profilesDirectory: path.join(REPOSITORY_ROOT, "profiles") },
  ));
  const { queue } = JobQueue.open(path.join(store.root, ".guyditor/jobs.sqlite"));
  queues.push(queue);
  return { queue, store };
}

async function waitForJob(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const deadline = Date.now() + 10_000;
  while (true) {
    const job = queue.get(jobId);
    if (job?.state === "done" || job?.state === "failed") return job;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${jobId}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function completedResult(queue: JobQueue, jobId: string): Promise<IngestJobResult> {
  const job = await waitForJob(queue, jobId);
  expect(job.state).toBe("done");
  return job.payload as unknown as IngestJobResult;
}

describe.skipIf(!FIXTURES_AVAILABLE)("MediaEngine fixture ingest", () => {
  it("classifies and maps every fixture media kind in one batch transaction", async () => {
    const { queue, store } = await projectAndQueue();
    const engine = new MediaEngine({ jobQueue: queue, followUpJobs: [] });
    const sources = [
      "bars-1080p30-10s.mp4",
      "screencast-1080p30-15s.mp4",
      "greenscreen-720p30-6s.mp4",
      "speech-48k-20s.wav",
      "stills/diagram-1080.png",
    ].map((fixturePath) => ({ path: path.join(FIXTURE_ROOT, fixturePath) }));

    const queued = engine.ingest(store, { sources, via: "manual" });

    expect(queued).toMatchObject({ kind: "ingest", state: "queued", cancellable: false });
    const result = await completedResult(queue, queued.jobId);
    expect(result.assets.map(({ kind }) => kind)).toEqual([
      "video",
      "video",
      "video",
      "audio",
      "image",
    ]);
    expect(result.assets.map(({ supportTier }) => supportTier)).toEqual([1, 1, 1, 1, 1]);
    expect(result.warnings).toEqual([]);
    expect(store.currentProject.assets).toHaveLength(5);
    expect(store.currentProject.assets[0]).toMatchObject({
      kind: "video",
      container: expect.stringContaining("mp4"),
      probe: {
        duration: { frames: 300, fps: "30/1" },
        width: 1920,
        height: 1080,
        fps: "30/1",
        audio: { rate: 48_000, channels: 1 },
        capturedAt: expect.any(String),
      },
      video: { codec: "h264", width: 1920, height: 1080, fps: "30/1" },
      audio: [expect.objectContaining({ codec: "aac", sampleRate: 48_000 })],
      captureTime: { source: "container", value: expect.any(String) },
      integrity: "ok",
    });
    expect(store.currentProject.assets[3]).toMatchObject({
      kind: "audio",
      probe: {
        duration: { samples: 960_000, rate: 48_000 },
        audio: { rate: 48_000, channels: 1 },
      },
    });
    expect(store.currentProject.assets[4]).toMatchObject({
      kind: "image",
      image: { width: 1920, height: 1080 },
    });

    const journalLines = (await readFile(
      path.join(store.root, "history/transactions.jsonl"),
      "utf8",
    )).trim().split("\n");
    expect(journalLines).toHaveLength(2);
    const transaction = JSON.parse(journalLines[1]!) as {
      operations: Array<{ op: string; params: { assets: unknown[] }; summary: string }>;
    };
    expect(transaction.operations).toHaveLength(1);
    expect(transaction.operations[0]).toMatchObject({
      op: "asset.ingest",
      summary: "Ingest 5 assets",
    });
    expect(transaction.operations[0]?.params.assets).toHaveLength(5);
  });

  it("deduplicates by hash, appends knownPaths, and preserves the existing asset ID", async () => {
    const { queue, store } = await projectAndQueue();
    const engine = new MediaEngine({ jobQueue: queue, followUpJobs: [] });
    const original = path.join(FIXTURE_ROOT, "bars-1080p30-10s.mp4");
    const first = await completedResult(
      queue,
      engine.ingest(store, { sources: [{ path: original }] }).jobId,
    );
    const duplicatePath = path.join(store.root, "media/bars-copy.mp4");
    await copyFile(original, duplicatePath);

    const duplicate = await completedResult(
      queue,
      engine.ingest(store, { sources: [{ path: duplicatePath }] }).jobId,
    );

    expect(duplicate.assets).toMatchObject([{
      assetId: first.assets[0]?.assetId,
      duplicate: true,
    }]);
    expect(store.currentProject.assets).toHaveLength(1);
    expect(store.currentProject.assets[0]?.knownPaths).toContain("media/bars-copy.mp4");

    const repeated = await completedResult(
      queue,
      engine.ingest(store, { sources: [{ path: original }] }).jobId,
    );
    expect(repeated.transactionId).toMatch(/^txn_[a-z2-7]{10}$/u);
    expect(store.currentProject.revision).toBe("rev_00004");
    const journalLines = (await readFile(
      path.join(store.root, "history/transactions.jsonl"),
      "utf8",
    )).trim().split("\n");
    expect(journalLines).toHaveLength(4);
  });

  it("never changes source bytes or mtime", async () => {
    const { queue, store } = await projectAndQueue();
    const engine = new MediaEngine({ jobQueue: queue, followUpJobs: [] });
    const source = path.join(FIXTURE_ROOT, "stills/logo-256.png");
    const beforeBytes = await readFile(source);
    const beforeStat = await stat(source, { bigint: true });

    await completedResult(
      queue,
      engine.ingest(store, { sources: [{ path: source }] }).jobId,
    );

    const afterStat = await stat(source, { bigint: true });
    expect(await readFile(source)).toEqual(beforeBytes);
    expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
  });

  it("queues only configured, applicable, deduplicated follow-up job records", async () => {
    const { queue, store } = await projectAndQueue();
    const engine = new MediaEngine({
      jobQueue: queue,
      followUpJobs: ["proxy.generate", "peaks.generate", "transcribe"],
    });
    const result = await completedResult(queue, engine.ingest(store, {
      sources: [
        { path: path.join(FIXTURE_ROOT, "bars-1080p30-10s.mp4") },
        { path: path.join(FIXTURE_ROOT, "screencast-1080p30-15s.mp4") },
      ],
    }).jobId);

    expect(result.followUpJobIds).toHaveLength(4);
    expect(queue.list({ state: "queued" }).map(({ kind }) => kind)).toEqual([
      "proxy.generate",
      "peaks.generate",
      "transcribe",
      "proxy.generate",
    ]);
  });
});

describe("MediaEngine ingest errors and special classification", () => {
  it("maps corrupt probe failure to a safe media envelope without registration", async () => {
    const { queue, store } = await projectAndQueue();
    const engine = new MediaEngine({ jobQueue: queue, followUpJobs: [] });
    const corrupt = path.join(store.root, "media/corrupt.mp4");
    await writeFile(corrupt, "not media", "utf8");

    const failed = await waitForJob(
      queue,
      engine.ingest(store, { sources: [{ path: corrupt }] }).jobId,
    );

    expect(failed).toMatchObject({
      state: "failed",
      error: {
        code: "E_MEDIA_PROBE_FAILED",
        message: expect.stringContaining("ffprobe could not read"),
        retry: "safe",
        acceptedStateChanged: false,
      },
    });
    expect(store.currentProject.assets).toEqual([]);
    expect(store.currentProject.revision).toBe("rev_00001");
  });

  it("rejects empty and cache sources before probing", async () => {
    const { queue, store } = await projectAndQueue();
    const engine = new MediaEngine({ jobQueue: queue, followUpJobs: [] });
    const empty = path.join(store.root, "media/empty.wav");
    await writeFile(empty, "", "utf8");
    const emptyJob = await waitForJob(
      queue,
      engine.ingest(store, { sources: [{ path: empty }] }).jobId,
    );
    expect(emptyJob.error?.code).toBe("E_MEDIA_INGEST_INVALID_SOURCE");

    const cacheSource = path.join(store.root, ".guyditor/cache/source.mp4");
    await writeFile(cacheSource, "not empty", "utf8");
    const cacheJob = await waitForJob(
      queue,
      engine.ingest(store, { sources: [{ path: cacheSource }] }).jobId,
    );
    expect(cacheJob.error?.code).toBe("E_MEDIA_INGEST_INVALID_SOURCE");
  });

  it("classifies GIF, subtitle, and explicit generated media", async () => {
    const { queue, store } = await projectAndQueue();
    const engine = new MediaEngine({ jobQueue: queue, followUpJobs: [] });
    const gif = path.join(store.root, "media/motion.gif");
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x32:rate=2:duration=1",
      gif,
    ]);
    const subtitle = path.join(store.root, "media/captions.srt");
    await writeFile(subtitle, [
      "1",
      "00:00:00,000 --> 00:00:01,000",
      "Hello",
      "",
    ].join("\n"), "utf8");
    const generated = path.join(store.root, "media/generated-frame.png");
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=32x32:d=1",
      "-frames:v",
      "1",
      generated,
    ]);

    const result = await completedResult(queue, engine.ingest(store, {
      sources: [
        { path: gif },
        { path: subtitle },
        {
          path: generated,
          generated: true,
          provenance: { sidecar: "annotations" },
        },
      ],
      via: "generated",
    }).jobId);

    expect(result.assets.map(({ kind }) => kind)).toEqual([
      "animation",
      "subtitle",
      "generated",
    ]);
    expect(store.currentProject.assets[2]).toMatchObject({
      kind: "generated",
      provenance: { sidecar: "annotations" },
    });
  });

  it("registers probed Tier-3 media as other with a best-effort warning", async () => {
    const { queue, store } = await projectAndQueue();
    const engine = new MediaEngine({ jobQueue: queue, followUpJobs: [] });
    const source = path.join(store.root, "media/ffv1.mkv");
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x32:r=2:d=1",
      "-c:v",
      "ffv1",
      source,
    ]);

    const result = await completedResult(
      queue,
      engine.ingest(store, { sources: [{ path: source }] }).jobId,
    );

    expect(result.assets).toMatchObject([{
      kind: "other",
      supportTier: 3,
    }]);
    expect(result.warnings).toMatchObject([{
      code: "E_MEDIA_UNSUPPORTED_BESTEFFORT",
      assetId: result.assets[0]?.assetId,
    }]);
    expect(store.currentProject.assets[0]?.kind).toBe("other");
  });
});

describe("format support table", () => {
  it("publishes the binding Tier-1 and Tier-2 container and codec data", () => {
    expect(FORMAT_SUPPORT_TIERS.containers.tier1).toEqual(expect.arrayContaining([
      "mp4", "mov", "matroska", "webm", "wav", "mp3", "m4a", "flac",
    ]));
    expect(FORMAT_SUPPORT_TIERS.containers.tier2).toEqual(expect.arrayContaining([
      "mxf", "avi", "mpegts",
    ]));
    expect(FORMAT_SUPPORT_TIERS.videoCodecs.tier1).toEqual(expect.arrayContaining([
      "h264", "hevc", "prores", "vp9",
    ]));
    expect(FORMAT_SUPPORT_TIERS.videoCodecs.tier2).toEqual(expect.arrayContaining([
      "av1", "dnxhd", "mjpeg",
    ]));
  });
});
