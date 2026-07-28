import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Asset } from "../../core/src/index.js";
import {
  TimelineFrameService,
  timelineFrameCachePaths,
  timelineFrameCommand,
} from "./timeline-frames.js";
import { proxyCachePaths } from "./proxy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function asset(): Asset {
  return {
    id: "ast_aaaaaaaaaa",
    kind: "video",
    path: "media/source.mp4",
    sha256: "0123456789abcdef".repeat(4),
    probe: { duration: { frames: 300, fps: "30/1" }, fps: "30/1" },
    video: {
      codec: "h264",
      width: 1920,
      height: 1080,
      fps: "30/1",
      pixFmt: "yuv420p",
      hasAlpha: false,
      rotation: 0,
    },
  };
}

describe("timeline frame cache", () => {
  it("keys paths by asset hash, frame, and height", () => {
    expect(timelineFrameCachePaths("/project", asset(), 42, 96)).toEqual({
      file: path.join(
        "/project/.guyditor/cache/timeline-frames",
        "ast_aaaaaaaaaa.01234567/42.h96.jpg",
      ),
      part: path.join(
        "/project/.guyditor/cache/timeline-frames",
        "ast_aaaaaaaaaa.01234567/42.h96.jpg.part",
      ),
    });
  });

  it("compiles exact seek, video-only scale, and JPEG output", () => {
    expect(timelineFrameCommand(asset(), "/proxy/edit.mp4", 42, 96, "/out.part"))
      .toEqual([
        "-y", "-nostdin", "-ss", "1.400000000", "-i", "/proxy/edit.mp4",
        "-map", "0:v:0", "-frames:v", "1",
        "-vf", "scale=-2:96:flags=lanczos",
        "-an", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2", "/out.part",
      ]);
  });
});

async function sandbox(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "guyditor-timeline-frames-"));
  roots.push(root);
  return root;
}

it("reuses non-empty cache files and single-flights duplicate misses", async () => {
  const root = await sandbox();
  const item = asset();
  const paths = timelineFrameCachePaths(root, item, 42, 96);
  const run = vi.fn(async (args: readonly string[]) => {
    await mkdir(path.dirname(args.at(-1)!), { recursive: true });
    await writeFile(args.at(-1)!, "jpeg");
    return {
      binary: { path: "ffmpeg", source: "path" as const, version: "test" },
      exitCode: 0 as const,
      stderrLines: [],
      stdout: "",
    };
  });
  const service = new TimelineFrameService({ run });

  const [first, duplicate] = await Promise.all([
    service.resolve(root, item, [42], 96),
    service.resolve(root, item, [42], 96),
  ]);
  const cached = await service.resolve(root, item, [42], 96);

  expect(run).toHaveBeenCalledOnce();
  expect(first).toEqual([{ sourceFrame: 42, path: paths.file }]);
  expect(duplicate).toEqual(first);
  expect(cached).toEqual(first);
});

it("prefers an existing edit proxy and degrades an individual failure", async () => {
  const root = await sandbox();
  const item = asset();
  const proxy = proxyCachePaths(root, item, "edit")!;
  await mkdir(path.dirname(proxy.media), { recursive: true });
  await writeFile(proxy.media, "proxy");
  const run = vi.fn(async (args: readonly string[]) => {
    if (args.includes("2.000000000")) throw new Error("decode failed");
    await mkdir(path.dirname(args.at(-1)!), { recursive: true });
    await writeFile(args.at(-1)!, "jpeg");
    return {
      binary: { path: "ffmpeg", source: "path" as const, version: "test" },
      exitCode: 0 as const,
      stderrLines: [],
      stdout: "",
    };
  });
  const service = new TimelineFrameService({ run });

  await expect(service.resolve(root, item, [30, 60], 96)).resolves.toEqual([
    expect.objectContaining({ sourceFrame: 30, path: expect.any(String) }),
    { sourceFrame: 60, path: null },
  ]);
  expect(run.mock.calls[0]![0]).toContain(proxy.media);
});

it("does not publish zero-byte frame artifacts", async () => {
  const root = await sandbox();
  const item = asset();
  const paths = timelineFrameCachePaths(root, item, 42, 96);
  const run = vi.fn(async (args: readonly string[]) => {
    await mkdir(path.dirname(args.at(-1)!), { recursive: true });
    await writeFile(args.at(-1)!, "");
    return {
      binary: { path: "ffmpeg", source: "path" as const, version: "test" },
      exitCode: 0 as const,
      stderrLines: [],
      stdout: "",
    };
  });
  const service = new TimelineFrameService({ run });

  await expect(service.resolve(root, item, [42], 96)).resolves.toEqual([
    { sourceFrame: 42, path: null },
  ]);
  await expect(access(paths.file)).rejects.toThrow();
  await expect(access(paths.part)).rejects.toThrow();
});

it("does not publish untouched stale frame parts", async () => {
  const root = await sandbox();
  const item = asset();
  const paths = timelineFrameCachePaths(root, item, 42, 96);
  await mkdir(path.dirname(paths.part), { recursive: true });
  await writeFile(paths.part, "stale");
  const run = vi.fn(async () => ({
    binary: { path: "ffmpeg", source: "path" as const, version: "test" },
    exitCode: 0 as const,
    stderrLines: [],
    stdout: "",
  }));
  const service = new TimelineFrameService({ run });

  await expect(service.resolve(root, item, [42], 96)).resolves.toEqual([
    { sourceFrame: 42, path: null },
  ]);
  await expect(access(paths.file)).rejects.toThrow();
  await expect(access(paths.part)).rejects.toThrow();
});

it("runs at most two frame extractions concurrently", async () => {
  const root = await sandbox();
  const item = asset();
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const run = vi.fn(async (args: readonly string[]) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    await mkdir(path.dirname(args.at(-1)!), { recursive: true });
    await writeFile(args.at(-1)!, "jpeg");
    active -= 1;
    return {
      binary: { path: "ffmpeg", source: "path" as const, version: "test" },
      exitCode: 0 as const,
      stderrLines: [],
      stdout: "",
    };
  });
  const service = new TimelineFrameService({ run, concurrency: 2 });

  const pending = service.resolve(root, item, [1, 2, 3], 96);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  releases.shift()!();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  while (releases.length > 0) releases.shift()!();
  await pending;

  expect(maximumActive).toBe(2);
});

it("hands queued extractions the permit in FIFO order without barging", async () => {
  const root = await sandbox();
  const item = asset();
  let active = 0;
  let maximumActive = 0;
  const started: number[] = [];
  const releases = new Map<number, () => void>();
  const run = vi.fn(async (args: readonly string[]) => {
    const sourceFrame = Math.round(Number(args[3]) * 30);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    started.push(sourceFrame);
    await new Promise<void>((resolve) => releases.set(sourceFrame, resolve));
    await mkdir(path.dirname(args.at(-1)!), { recursive: true });
    await writeFile(args.at(-1)!, "jpeg");
    active -= 1;
    return {
      binary: { path: "ffmpeg", source: "path" as const, version: "test" },
      exitCode: 0 as const,
      stderrLines: [],
      stdout: "",
    };
  });
  const service = new TimelineFrameService({ run, concurrency: 1 });

  const firstTwo = service.resolve(root, item, [1, 2], 96);
  await vi.waitFor(() => expect(started).toEqual([1]));
  releases.get(1)!();
  const third = new Promise((resolve, reject) => {
    queueMicrotask(() => {
      service.resolve(root, item, [3], 96).then(resolve, reject);
    });
  });

  await vi.waitFor(() => expect(started).toEqual([1, 2]));
  expect(maximumActive).toBe(1);
  releases.get(2)!();
  await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
  expect(maximumActive).toBe(1);
  releases.get(3)!();
  await Promise.all([firstTwo, third]);

  expect(started).toEqual([1, 2, 3]);
  expect(maximumActive).toBe(1);
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid extraction concurrency %s",
  (concurrency) => {
    expect(() => new TimelineFrameService({ concurrency })).toThrow(RangeError);
  },
);
