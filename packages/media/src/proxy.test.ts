import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProject,
  JobQueue,
  ProjectStore,
} from "../../core/src/index.js";
import type {
  Asset,
  JobRecord,
  Rational,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { MediaEngine } from "./ingest.js";
import type { IngestJobResult } from "./ingest.js";
import { probeMedia } from "./probe.js";
import { runFfmpeg } from "./run.js";
import {
  PROXY_PROFILE_VERSION,
  proxyCachePaths,
  proxyIsStale,
} from "./proxy.js";
import type { ProxyMetadata } from "./proxy.js";

const temporaryDirectories: string[] = [];
const queues: JobQueue[] = [];
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE_ROOT = path.join(REPOSITORY_ROOT, ".fixtures");
const FIXTURES_AVAILABLE = existsSync(path.join(FIXTURE_ROOT, "manifest.json"));

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true }),
  ));
});

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function waitForJob(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const deadline = Date.now() + 60_000;
  while (true) {
    const job = queue.get(jobId);
    if (job?.state === "done" || job?.state === "failed") return job;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${jobId}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function projectEngine(): Promise<{
  engine: MediaEngine;
  queue: JobQueue;
  store: ProjectStore;
}> {
  const root = await sandbox();
  const store = await valueOf(ProjectStore.createProject(
    path.join(root, "project"),
    { name: "Proxy test" },
    { profilesDirectory: path.join(REPOSITORY_ROOT, "profiles") },
  ));
  const { queue } = JobQueue.open(path.join(store.root, ".guyditor/jobs.sqlite"));
  queues.push(queue);
  return {
    engine: new MediaEngine({
      followUpJobs: [],
      jobQueue: queue,
      now: () => new Date("2026-07-18T12:00:00.000Z"),
    }),
    queue,
    store,
  };
}

async function ingestAsset(
  engine: MediaEngine,
  queue: JobQueue,
  store: ProjectStore,
  sourcePath: string,
): Promise<Asset> {
  const completed = await waitForJob(
    queue,
    engine.ingest(store, { sources: [{ path: sourcePath }] }).jobId,
  );
  expect(completed.state).toBe("done");
  const result = completed.payload as unknown as IngestJobResult;
  const assetId = result.assets[0]?.assetId;
  const asset = store.currentProject.assets.find(({ id }) => id === assetId);
  if (asset === undefined) throw new Error("Ingest did not register an asset.");
  return asset;
}

async function sandbox(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "guyditor-proxy-"));
  temporaryDirectories.push(directory);
  return directory;
}

function videoAsset(): Asset {
  return {
    id: "ast_aaaaaaaaaa",
    kind: "video",
    path: "media/source.mp4",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    probe: { duration: { fps: "30/1", frames: 300 }, fps: "30/1" },
    video: {
      codec: "h264",
      fps: "30/1",
      hasAlpha: false,
      height: 1_080,
      pixFmt: "yuv420p",
      rotation: 0,
      width: 1_920,
    },
  };
}

function metadata(asset: Asset): ProxyMetadata {
  return {
    assetId: asset.id,
    createdAt: "2026-07-18T12:00:00.000Z",
    durationFrames: 300,
    ffmpegVersion: "ffmpeg version test",
    profileVersion: PROXY_PROFILE_VERSION,
    sourceHash: asset.sha256,
    tier: "edit",
  };
}

async function writeValidEntry(root: string, asset: Asset): Promise<void> {
  const paths = proxyCachePaths(root, asset, "edit");
  if (paths === undefined) throw new Error("Expected a proxy path.");
  await mkdir(path.dirname(paths.media), { recursive: true });
  await writeFile(paths.media, "non-empty");
  await writeFile(paths.metadata, JSON.stringify(metadata(asset)));
}

describe("proxy cache paths", () => {
  it("keys the edit proxy and metadata by asset ID and source hash8", () => {
    const paths = proxyCachePaths("/project", videoAsset(), "edit");

    expect(paths).toEqual({
      media: path.join(
        "/project",
        ".guyditor/cache/proxies/ast_aaaaaaaaaa.01234567.edit.mp4",
      ),
      mediaPart: path.join(
        "/project",
        ".guyditor/cache/proxies/ast_aaaaaaaaaa.01234567.edit.mp4.part",
      ),
      metadata: path.join(
        "/project",
        ".guyditor/cache/proxies/ast_aaaaaaaaaa.01234567.edit.mp4.meta.json",
      ),
      metadataPart: path.join(
        "/project",
        ".guyditor/cache/proxies/ast_aaaaaaaaaa.01234567.edit.mp4.meta.json.part",
      ),
    });
  });

  it("documents small images as not requiring a proxy", () => {
    const image = videoAsset();
    delete image.video;
    image.kind = "image";
    image.image = { hasAlpha: false, height: 1_080, width: 1_920 };

    expect(proxyCachePaths("/project", image, "edit")).toBeUndefined();
  });
});

describe("proxyIsStale", () => {
  const projectFps: Rational = "24/1";

  it("accepts an entry only when all five checks pass", async () => {
    const root = await sandbox();
    const asset = videoAsset();
    await writeValidEntry(root, asset);

    await expect(proxyIsStale(root, asset, "edit", projectFps)).resolves.toBe(false);
  });

  it("fails check 1 when the media file is missing or empty", async () => {
    const root = await sandbox();
    const asset = videoAsset();
    await writeValidEntry(root, asset);
    const paths = proxyCachePaths(root, asset, "edit");
    if (paths === undefined) throw new Error("Expected a proxy path.");

    await unlink(paths.media);
    await expect(proxyIsStale(root, asset, "edit", projectFps)).resolves.toBe(true);
    await writeFile(paths.media, "");
    await expect(proxyIsStale(root, asset, "edit", projectFps)).resolves.toBe(true);
  });

  it("fails check 2 when metadata is missing, malformed, or has the wrong shape", async () => {
    const root = await sandbox();
    const asset = videoAsset();
    await writeValidEntry(root, asset);
    const paths = proxyCachePaths(root, asset, "edit");
    if (paths === undefined) throw new Error("Expected a proxy path.");

    await unlink(paths.metadata);
    await expect(proxyIsStale(root, asset, "edit", projectFps)).resolves.toBe(true);
    await writeFile(paths.metadata, "not json");
    await expect(proxyIsStale(root, asset, "edit", projectFps)).resolves.toBe(true);
    await writeFile(paths.metadata, JSON.stringify({ ...metadata(asset), assetId: 42 }));
    await expect(proxyIsStale(root, asset, "edit", projectFps)).resolves.toBe(true);
  });

  it("fails check 3 when sourceHash differs", async () => {
    const root = await sandbox();
    const asset = videoAsset();
    await writeValidEntry(root, asset);
    const paths = proxyCachePaths(root, asset, "edit");
    if (paths === undefined) throw new Error("Expected a proxy path.");
    await writeFile(paths.metadata, JSON.stringify({
      ...metadata(asset),
      sourceHash: "f".repeat(64),
    }));

    await expect(proxyIsStale(root, asset, "edit", projectFps)).resolves.toBe(true);
  });

  it("fails check 4 when profileVersion differs", async () => {
    const root = await sandbox();
    const asset = videoAsset();
    await writeValidEntry(root, asset);
    const paths = proxyCachePaths(root, asset, "edit");
    if (paths === undefined) throw new Error("Expected a proxy path.");
    await writeFile(paths.metadata, JSON.stringify({
      ...metadata(asset),
      profileVersion: PROXY_PROFILE_VERSION + 1,
    }));

    await expect(proxyIsStale(root, asset, "edit", projectFps)).resolves.toBe(true);
  });

  it("fails check 5 when duration differs by more than two source frames", async () => {
    const root = await sandbox();
    const asset = videoAsset();
    await writeValidEntry(root, asset);
    const paths = proxyCachePaths(root, asset, "edit");
    if (paths === undefined) throw new Error("Expected a proxy path.");
    await writeFile(paths.metadata, JSON.stringify({
      ...metadata(asset),
      durationFrames: 297,
    }));

    await expect(proxyIsStale(root, asset, "edit", projectFps)).resolves.toBe(true);
  });

  it("does not treat an interrupted .part file as a proxy", async () => {
    const root = await sandbox();
    const asset = videoAsset();
    const paths = proxyCachePaths(root, asset, "edit");
    if (paths === undefined) throw new Error("Expected a proxy path.");
    await mkdir(path.dirname(paths.mediaPart), { recursive: true });
    await writeFile(paths.mediaPart, "interrupted encode");
    await writeFile(paths.metadataPart, JSON.stringify(metadata(asset)));

    await expect(proxyIsStale(root, asset, "edit", projectFps)).resolves.toBe(true);
  });
});

describe("MediaEngine.ensureProxy", () => {
  it("enqueues one idempotent job per asset and tier when stale", async () => {
    const root = await sandbox();
    const project = projectFixture();
    project.assets[0] = videoAsset();
    const store = await valueOf(createProject(path.join(root, "project"), project));
    const { queue } = JobQueue.open(
      path.join(store.root, ".guyditor/jobs.sqlite"),
      { concurrency: 1 },
    );
    queues.push(queue);
    queue.registerExecutor("test.hold", async (_job, { signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }));
    queue.enqueue({
      cancellable: true,
      kind: "test.hold",
      payload: null,
      title: "Hold executor",
    });
    const engine = new MediaEngine({ followUpJobs: [], jobQueue: queue });

    const [first, repeated] = await Promise.all([
      engine.ensureProxy(store, videoAsset().id, "edit"),
      engine.ensureProxy(store, videoAsset().id, "edit"),
    ]);

    expect(first?.jobId).toBe(repeated?.jobId);
    expect(queue.list({ kind: "proxy.generate" })).toHaveLength(1);
    expect(first).toMatchObject({
      kind: "proxy.generate",
      payload: {
        assetId: "ast_aaaaaaaaaa",
        projectRoot: store.root,
        tier: "edit",
      },
    });
  });

  it("does not enqueue a proxy for images at or below 2048 pixels", async () => {
    const root = await sandbox();
    const project = projectFixture();
    const image = videoAsset();
    delete image.video;
    image.kind = "image";
    image.image = { hasAlpha: false, height: 1_080, width: 1_920 };
    project.assets[0] = image;
    const store = await valueOf(createProject(path.join(root, "project"), project));
    const { queue } = JobQueue.open(path.join(store.root, ".guyditor/jobs.sqlite"));
    queues.push(queue);
    const engine = new MediaEngine({ followUpJobs: [], jobQueue: queue });

    await expect(engine.ensureProxy(store, image.id, "edit")).resolves.toBeUndefined();
    expect(queue.list({ kind: "proxy.generate" })).toEqual([]);
  });
});

describe.skipIf(!FIXTURES_AVAILABLE)("proxy.generate fixture executor", () => {
  it("creates an atomic 960x540 H.264 native-fps faststart proxy and metadata", async () => {
    const { engine, queue, store } = await projectEngine();
    const asset = await ingestAsset(
      engine,
      queue,
      store,
      path.join(FIXTURE_ROOT, "bars-1080p30-10s.mp4"),
    );

    const queued = await engine.ensureProxy(store, asset.id, "edit");
    if (queued === undefined) throw new Error("Video proxy was not queued.");
    const completed = await waitForJob(queue, queued.jobId);

    expect(completed.state).toBe("done");
    const paths = proxyCachePaths(store.root, asset, "edit");
    if (paths === undefined) throw new Error("Expected proxy paths.");
    const probed = await probeMedia(paths.media);
    if (probed.video === undefined) throw new Error("Proxy has no video stream.");
    expect(probed.video).toMatchObject({
      codec: "h264",
      fps: "30/1",
      height: 540,
      width: 960,
    });
    expect(probed.video.width % 2).toBe(0);
    expect(probed.video.height % 2).toBe(0);
    const mp4 = await readFile(paths.media);
    expect(mp4.indexOf("moov")).toBeGreaterThan(0);
    expect(mp4.indexOf("mdat")).toBeGreaterThan(0);
    expect(mp4.indexOf("moov")).toBeLessThan(mp4.indexOf("mdat"));
    const parsed = JSON.parse(await readFile(paths.metadata, "utf8")) as ProxyMetadata;
    expect(Object.keys(parsed).sort()).toEqual([
      "assetId",
      "createdAt",
      "durationFrames",
      "ffmpegVersion",
      "profileVersion",
      "sourceHash",
      "tier",
    ]);
    expect(parsed).toMatchObject({
      assetId: asset.id,
      createdAt: "2026-07-18T12:00:00.000Z",
      durationFrames: expect.any(Number),
      ffmpegVersion: expect.stringMatching(/^ffmpeg version /u),
      profileVersion: PROXY_PROFILE_VERSION,
      sourceHash: asset.sha256,
      tier: "edit",
    });
    expect(Math.abs(parsed.durationFrames - 300)).toBeLessThanOrEqual(2);
    await expect(access(paths.mediaPart)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.metadataPart)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(proxyIsStale(
      store.root,
      asset,
      "edit",
      store.currentProject.settings.timeline.fps,
    )).resolves.toBe(false);
  });

  it("creates a 48 kHz stereo AAC audio proxy", async () => {
    const { engine, queue, store } = await projectEngine();
    const asset = await ingestAsset(
      engine,
      queue,
      store,
      path.join(FIXTURE_ROOT, "speech-48k-20s.wav"),
    );

    const queued = await engine.ensureProxy(store, asset.id, "edit");
    if (queued === undefined) throw new Error("Audio proxy was not queued.");
    expect((await waitForJob(queue, queued.jobId)).state).toBe("done");
    const paths = proxyCachePaths(store.root, asset, "edit");
    if (paths === undefined) throw new Error("Expected proxy paths.");
    const probed = await probeMedia(paths.media);

    expect(path.extname(paths.media)).toBe(".m4a");
    expect(probed.video).toBeUndefined();
    expect(probed.audio?.[0]).toMatchObject({
      channels: 2,
      codec: "aac",
      sampleRate: 48_000,
    });
  });

  it("skips the 1920x1080 fixture image but proxies a synthesized large image", async () => {
    const { engine, queue, store } = await projectEngine();
    const small = await ingestAsset(
      engine,
      queue,
      store,
      path.join(FIXTURE_ROOT, "stills/diagram-1080.png"),
    );
    await expect(engine.ensureProxy(store, small.id, "edit")).resolves.toBeUndefined();

    const largePath = path.join(path.dirname(store.root), "large.png");
    await runFfmpeg([
      "-y",
      "-f", "lavfi",
      "-i", "color=c=blue:s=3000x2000:d=0.1",
      "-frames:v", "1",
      largePath,
    ]);
    const large = await ingestAsset(engine, queue, store, largePath);
    const queued = await engine.ensureProxy(store, large.id, "edit");
    if (queued === undefined) throw new Error("Large image proxy was not queued.");
    expect((await waitForJob(queue, queued.jobId)).state).toBe("done");
    const paths = proxyCachePaths(store.root, large, "edit");
    if (paths === undefined) throw new Error("Expected proxy paths.");
    const probed = await probeMedia(paths.media);

    expect(path.extname(paths.media)).toBe(".jpg");
    expect(probed.image).toMatchObject({ height: 1_364, width: 2_048 });
  });
});
