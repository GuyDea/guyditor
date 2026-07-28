import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProject,
  JobQueue,
} from "../../core/src/index.js";
import type {
  Asset,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { MediaEngine } from "./ingest.js";
import {
  PROXY_PROFILE_VERSION,
  proxyCachePaths,
} from "./proxy.js";
import type { ProxyMetadata } from "./proxy.js";

const temporaryDirectories: string[] = [];
const queues: JobQueue[] = [];

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

function timedAssets(): Asset[] {
  return [
    {
      audio: [{
        channels: 1,
        codec: "aac",
        index: 1,
        layout: "mono",
        sampleRate: 48_000,
      }],
      id: "ast_aaaaaaaaaa",
      kind: "video",
      path: "media/video.mp4",
      probe: { duration: { fps: "30/1", frames: 300 }, fps: "30/1" },
      sha256: "a".repeat(64),
      video: {
        codec: "h264",
        fps: "30/1",
        hasAlpha: false,
        height: 1_080,
        pixFmt: "yuv420p",
        rotation: 0,
        width: 1_920,
      },
    },
    {
      audio: [{
        channels: 1,
        codec: "pcm_s16le",
        index: 0,
        layout: "mono",
        sampleRate: 48_000,
      }],
      id: "ast_bbbbbbbbbb",
      kind: "audio",
      path: "media/speech.wav",
      probe: { duration: { rate: 48_000, samples: 960_000 } },
      sha256: "b".repeat(64),
    },
    {
      id: "ast_cccccccccc",
      image: { hasAlpha: false, height: 2_000, width: 3_000 },
      kind: "image",
      path: "media/large.png",
      probe: {},
      sha256: "c".repeat(64),
    },
  ];
}

async function estimateFixture(): Promise<{
  assets: Asset[];
  engine: MediaEngine;
  root: string;
  store: Awaited<ReturnType<typeof createProject>> extends Result<infer T> ? T : never;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "guyditor-cache-"));
  temporaryDirectories.push(root);
  const project = projectFixture();
  const assets = timedAssets();
  project.assets = assets;
  const store = await valueOf(createProject(path.join(root, "project"), project));
  const { queue } = JobQueue.open(path.join(store.root, ".guyditor/jobs.sqlite"));
  queues.push(queue);
  return {
    assets,
    engine: new MediaEngine({ followUpJobs: [], jobQueue: queue }),
    root,
    store,
  };
}

describe("MediaEngine.estimateCacheUse", () => {
  it("scans proxy/peaks bytes and projects timed assets lacking a proxy", async () => {
    const { engine, store } = await estimateFixture();
    const proxyDirectory = path.join(store.root, ".guyditor/cache/proxies/nested");
    const peaksDirectory = path.join(store.root, ".guyditor/cache/peaks");
    const timelineFramesDirectory = path.join(
      store.root,
      ".guyditor/cache/timeline-frames/ast_aaaaaaaaaa.aaaaaaaa",
    );
    await mkdir(proxyDirectory, { recursive: true });
    await mkdir(peaksDirectory, { recursive: true });
    await mkdir(timelineFramesDirectory, { recursive: true });
    await writeFile(path.join(proxyDirectory, "orphan.bin"), Buffer.alloc(11));
    await writeFile(path.join(peaksDirectory, "one.json"), Buffer.alloc(7));
    await writeFile(path.join(peaksDirectory, "interrupted.part"), Buffer.alloc(5));
    await writeFile(path.join(timelineFramesDirectory, "frame.bin"), Buffer.alloc(13));

    await expect(engine.estimateCacheUse(store)).resolves.toEqual({
      byClass: { peaks: 12, proxies: 11, timelineFrames: 13 },
      projectedProxies: [
        { assetId: "ast_aaaaaaaaaa", bytes: 3_285_000, tier: "edit" },
        { assetId: "ast_bbbbbbbbbb", bytes: 320_000, tier: "edit" },
      ],
      totalBytes: 36,
    });
  });

  it("does not project an asset with a current proxy", async () => {
    const { assets, engine, store } = await estimateFixture();
    const video = assets[0];
    if (video === undefined) throw new Error("Video fixture is missing.");
    const paths = proxyCachePaths(store.root, video, "edit");
    if (paths === undefined) throw new Error("Video proxy paths are missing.");
    await mkdir(path.dirname(paths.media), { recursive: true });
    await writeFile(paths.media, Buffer.alloc(10));
    const metadata: ProxyMetadata = {
      assetId: video.id,
      createdAt: "2026-07-18T12:00:00.000Z",
      durationFrames: 300,
      ffmpegVersion: "ffmpeg version test",
      profileVersion: PROXY_PROFILE_VERSION,
      sourceHash: video.sha256,
      tier: "edit",
    };
    await writeFile(paths.metadata, JSON.stringify(metadata));

    const estimate = await engine.estimateCacheUse(store);

    expect(estimate.projectedProxies.map(({ assetId }) => assetId))
      .toEqual(["ast_bbbbbbbbbb"]);
    expect(estimate.byClass.proxies).toBeGreaterThan(10);
    expect(estimate.totalBytes)
      .toBe(estimate.byClass.proxies + estimate.byClass.timelineFrames);
  });
});
