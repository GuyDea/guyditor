# Timeline Media Tiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render representative video frames with overlaid, range-correct waveforms on every visible audio-bearing timeline clip.

**Architecture:** A new `packages/media` service lazily extracts hash-keyed JPEG frames with bounded ffmpeg concurrency and exposes them through a validated `MediaEngine` IPC method. Pure renderer helpers select representative source frames and project existing peaks into zoom-aware SVG columns; a batched hook loads only virtualized clips, and a focused component renders the approved filmstrip/waveform treatment without changing timeline edit behavior.

**Tech Stack:** TypeScript 5.9, React 18, Electron IPC, Zustand, ffmpeg, Vitest 4, Playwright, CSS.

---

## Scope and file map

This is one cohesive feature: the media cache, IPC boundary, renderer projection,
and tile component are all required for one working timeline experience. Keep the
responsibilities split as follows:

- `packages/media/src/timeline-frames.ts` — frame cache paths, ffmpeg command,
  cache validation, single-flight, and bounded extraction.
- `packages/media/src/timeline-frames.test.ts` — cache, command, fallback,
  deduplication, concurrency, and failure tests.
- `packages/media/src/cache.ts` / `cache.test.ts` — include timeline-frame bytes.
- `packages/media/src/index.ts` — export the focused timeline-frame contract.
- `packages/app/src/main/project-services.ts` — own one frame service per project.
- `packages/app/src/main/service-host.ts` / `service-host.test.ts` — instantiate
  the service and return cache-owned file URLs.
- `packages/app/src/main/surfaces.ts` / `surfaces.test.ts` — validate the batched
  IPC request.
- `packages/app/src/renderer/panels/timeline-media.ts` — pure sampling/projection,
  batched loading, and stale-result guard.
- `packages/app/src/renderer/panels/timeline-media.test.ts` — math, batching,
  degradation, and stale-result tests.
- `packages/app/src/renderer/panels/TimelineClipMedia.tsx` — decorative filmstrip,
  scrim, waveform SVG, labels, and baseline.
- `packages/app/src/renderer/panels/TimelineClipMedia.test.ts` — static renderer
  coverage for all media combinations.
- `packages/app/src/renderer/panels/TimelinePanel.tsx` / `TimelinePanel.test.ts` —
  visible-clip integration and preservation of timeline behavior.
- `packages/app/src/renderer/styles.css` — the approved 68-pixel hybrid tile.
- `packages/app/e2e/workspace.spec.ts` — an unselected-clip waveform regression.
- `docs/traceability.md` — point FR-906 at the new cache and renderer coverage.

### Task 1: Pure frame sampling and waveform projection

**Files:**
- Create: `packages/app/src/renderer/panels/timeline-media.test.ts`
- Create: `packages/app/src/renderer/panels/timeline-media.ts`

- [ ] **Step 1: Write failing representative-frame tests**

Create the test file with fixtures that use real `Clip` and `PeaksFile` shapes:

```ts
import { describe, expect, it } from "vitest";

import type { Clip } from "../../../../core/src/index.js";
import type { PeaksFile } from "../../../../media/src/index.js";
import {
  representativeSourceFrames,
  selectPeaksTier,
  waveformColumns,
} from "./timeline-media.js";

function clip(sourceIn = 120, sourceOut = 240): Clip {
  return {
    id: "clp_aaaaaaaaaa",
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: sourceIn, fps: "24/1" },
      out: { frames: sourceOut, fps: "24/1" },
    },
  };
}

describe("representativeSourceFrames", () => {
  it("samples partition centers from the trimmed source range", () => {
    expect(representativeSourceFrames(clip(), 36)).toEqual([180]);
    expect(representativeSourceFrames(clip(), 192)).toEqual([150, 210]);
  });

  it("caps wide clips and removes duplicate short-range samples", () => {
    expect(representativeSourceFrames(clip(), 2_000)).toHaveLength(12);
    expect(representativeSourceFrames(clip(10, 12), 480)).toEqual([10, 11]);
  });
});

function peaks(): PeaksFile {
  return {
    format: "guyditor.peaks/v1",
    assetId: "ast_aaaaaaaaaa",
    sourceHash: "a".repeat(64),
    sampleRate: 48_000,
    tiers: [
      { samplesPerPeak: 960, data: [-1, 1, -2, 2, -3, 3, -4, 4] },
      { samplesPerPeak: 9_600, data: [-5, 5, -6, 6, -7, 7, -8, 8] },
      { samplesPerPeak: 48_000, data: [-1, 1, -2, 2, -3, 3, -4, 4] },
    ],
  };
}

describe("waveform projection", () => {
  it("chooses the coarsest tier that stays within four pixels", () => {
    expect(selectPeaksTier(peaks(), 100).samplesPerPeak).toBe(960);
    expect(selectPeaksTier(peaks(), 3_000).samplesPerPeak).toBe(9_600);
    expect(selectPeaksTier(peaks(), 12_000).samplesPerPeak).toBe(48_000);
  });

  it("crops to the clip source range and caps columns at one per two pixels", () => {
    const ranged = clip(1, 3);
    ranged.source.in.fps = "1/1";
    ranged.source.out.fps = "1/1";

    expect(waveformColumns(peaks(), ranged, 4)).toEqual([
      { minimum: -2, maximum: 2 },
      { minimum: -3, maximum: 3 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/timeline-media.test.ts
```

Expected: FAIL because `./timeline-media.js` does not exist.

- [ ] **Step 3: Implement the pure algorithms**

Create `timeline-media.ts` with these public contracts and exact rules:

```ts
import type { Clip } from "../../../../core/src/index.js";
import type { PeaksFile, PeaksTier } from "../../../../media/src/index.js";

export const TIMELINE_FRAME_HEIGHT = 96 as const;
export const MAX_TIMELINE_FRAMES = 12;
export const PIXELS_PER_TIMELINE_FRAME = 96;

export interface WaveformColumn {
  minimum: number;
  maximum: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function fpsValue(fps: string): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(fps);
  if (match === null) throw new TypeError(`Invalid frame rate ${fps}.`);
  return Number(match[1]) / Number(match[2]);
}

export function representativeSourceFrames(
  clip: Clip,
  width: number,
): number[] {
  const start = clip.source.in.frames;
  const duration = clip.source.out.frames - start;
  if (duration <= 0) return [];
  const count = clamp(
    Math.ceil(Math.max(1, width) / PIXELS_PER_TIMELINE_FRAME),
    1,
    MAX_TIMELINE_FRAMES,
  );
  return [...new Set(Array.from({ length: count }, (_unused, index) =>
    clamp(
      start + Math.floor((index + 0.5) * duration / count),
      start,
      clip.source.out.frames - 1,
    ),
  ))];
}

export function selectPeaksTier(
  peaks: PeaksFile,
  samplesPerPixel: number,
): PeaksTier {
  const sorted = [...peaks.tiers].sort(
    (left, right) => left.samplesPerPeak - right.samplesPerPeak,
  );
  if (sorted.length === 0) {
    return { samplesPerPeak: 960, data: [] };
  }
  return sorted.filter(({ samplesPerPeak }) =>
    samplesPerPeak <= samplesPerPixel * 4).at(-1) ?? sorted[0]!;
}

export function waveformColumns(
  peaks: PeaksFile,
  clip: Clip,
  width: number,
): WaveformColumn[] {
  const sourceFps = fpsValue(clip.source.in.fps);
  const startSample = Math.floor(
    clip.source.in.frames / sourceFps * peaks.sampleRate,
  );
  const endSample = Math.ceil(
    clip.source.out.frames / sourceFps * peaks.sampleRate,
  );
  const samplesPerPixel = Math.max(
    1,
    (endSample - startSample) / Math.max(1, width),
  );
  const tier = selectPeaksTier(peaks, samplesPerPixel);
  const firstPair = Math.max(0, Math.floor(startSample / tier.samplesPerPeak));
  const lastPair = Math.min(
    tier.data.length / 2,
    Math.ceil(endSample / tier.samplesPerPeak),
  );
  const pairCount = Math.max(0, lastPair - firstPair);
  if (pairCount === 0) return [];
  const count = Math.min(pairCount, Math.max(1, Math.ceil(width / 2)));
  return Array.from({ length: count }, (_unused, column) => {
    const from = firstPair + Math.floor(column * pairCount / count);
    const to = firstPair + Math.max(
      Math.floor((column + 1) * pairCount / count),
      Math.floor(column * pairCount / count) + 1,
    );
    let minimum = 0;
    let maximum = 0;
    for (let pair = from; pair < Math.min(lastPair, to); pair += 1) {
      minimum = Math.min(minimum, tier.data[pair * 2] ?? 0);
      maximum = Math.max(maximum, tier.data[pair * 2 + 1] ?? 0);
    }
    return { minimum, maximum };
  });
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/timeline-media.test.ts
pnpm --filter @guyditor/app typecheck
```

Expected: both commands PASS.

- [ ] **Step 5: Commit the pure renderer behavior**

```bash
git add packages/app/src/renderer/panels/timeline-media.ts packages/app/src/renderer/panels/timeline-media.test.ts
git diff --cached --check
git commit -m "feat(app): project timeline media samples"
```

### Task 2: Lazy timeline-frame cache and bounded extraction

**Files:**
- Create: `packages/media/src/timeline-frames.test.ts`
- Create: `packages/media/src/timeline-frames.ts`
- Modify: `packages/media/src/index.ts`

- [ ] **Step 1: Write failing cache-path and command tests**

Start `timeline-frames.test.ts` with a complete video asset fixture and these
assertions:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run packages/media/src/timeline-frames.test.ts
```

Expected: FAIL because `timeline-frames.js` does not exist.

- [ ] **Step 3: Implement paths, validation, and command compilation**

Create `timeline-frames.ts` with:

```ts
import { access, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { Asset } from "../../core/src/index.js";
import { proxyCachePaths } from "./proxy.js";
import { runFfmpeg } from "./run.js";
import type { FfmpegRunResult, RunFfmpegOptions } from "./run.js";

export interface TimelineFrameCachePaths {
  file: string;
  part: string;
}

export interface TimelineFrameResult {
  sourceFrame: number;
  path: string | null;
}

type FrameRunner = (
  args: readonly string[],
  options?: RunFfmpegOptions,
) => Promise<FfmpegRunResult>;

export function timelineFrameCachePaths(
  projectRoot: string,
  asset: Asset,
  sourceFrame: number,
  height: number,
): TimelineFrameCachePaths {
  if (!Number.isSafeInteger(sourceFrame) || sourceFrame < 0) {
    throw new RangeError("Timeline source frame must be a non-negative safe integer.");
  }
  if (height !== 96) throw new RangeError("Timeline frame height must be 96.");
  const file = path.join(
    projectRoot,
    ".guyditor/cache/timeline-frames",
    `${asset.id}.${asset.sha256.slice(0, 8)}`,
    `${String(sourceFrame)}.h${String(height)}.jpg`,
  );
  return { file, part: `${file}.part` };
}

function fpsValue(fps: string): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(fps);
  if (match === null) throw new TypeError(`Invalid frame rate ${fps}.`);
  return Number(match[1]) / Number(match[2]);
}

export function timelineFrameCommand(
  asset: Asset,
  sourcePath: string,
  sourceFrame: number,
  height: number,
  target: string,
): string[] {
  if (asset.video === undefined) {
    throw new TypeError(`Asset ${asset.id} does not contain video.`);
  }
  const seconds = sourceFrame / fpsValue(asset.video.fps);
  return [
    "-y", "-nostdin", "-ss", seconds.toFixed(9), "-i", sourcePath,
    "-map", "0:v:0", "-frames:v", "1",
    "-vf", `scale=-2:${String(height)}:flags=lanczos`,
    "-an", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2", target,
  ];
}
```

- [ ] **Step 4: Add failing cache-hit, fallback, failure, and concurrency tests**

Append tests that inject a fake runner. The fake runner must write to
`args.at(-1)!` so the production atomic rename is exercised:

```ts
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
```

- [ ] **Step 5: Implement the bounded, single-flight service**

Add a `TimelineFrameService` whose constructor is exactly:

```ts
export class TimelineFrameService {
  readonly #concurrency: number;
  readonly #inflight = new Map<string, Promise<string | null>>();
  readonly #run: FrameRunner;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  public constructor(options: {
    concurrency?: number;
    run?: FrameRunner;
  } = {}) {
    this.#concurrency = options.concurrency ?? 2;
    this.#run = options.run ?? runFfmpeg;
  }

  public async resolve(
    projectRoot: string,
    asset: Asset,
    sourceFrames: readonly number[],
    height: 96,
  ): Promise<TimelineFrameResult[]> {
    if (asset.video === undefined) {
      throw new TypeError(`Asset ${asset.id} does not contain video.`);
    }
    if (sourceFrames.length > 12 || new Set(sourceFrames).size !== sourceFrames.length) {
      throw new RangeError("Timeline frame requests require at most 12 unique frames.");
    }
    return await Promise.all(sourceFrames.map(async (sourceFrame) => ({
      sourceFrame,
      path: await this.#resolveOne(projectRoot, asset, sourceFrame, height),
    })));
  }
}
```

Implement its private operations with these non-negotiable details:

1. `#resolveOne` derives the canonical output path and returns it immediately only
   when `stat(file)` reports a non-empty regular file.
2. The in-flight map key is the canonical output file. Insert the extraction
   promise before awaiting it and delete it in `finally`.
3. `#withPermit` starts immediately while `#active < #concurrency`; otherwise it
   awaits a queued resolver. Its `finally` decrements `#active` and releases one
   waiter.
4. Extraction creates the output directory, prefers an accessible edit proxy,
   falls back to an absolute source path or `path.resolve(projectRoot, asset.path)`,
   runs `timelineFrameCommand`, and renames `.part` to the final file.
5. `#resolveOne` catches extraction errors and returns `null`, but argument and
   asset validation happen before that catch.

Use these concrete private methods:

```ts
  async #resolveOne(
    projectRoot: string,
    asset: Asset,
    sourceFrame: number,
    height: 96,
  ): Promise<string | null> {
    const paths = timelineFrameCachePaths(
      projectRoot,
      asset,
      sourceFrame,
      height,
    );
    if (await this.#nonEmpty(paths.file)) return paths.file;
    const existing = this.#inflight.get(paths.file);
    if (existing !== undefined) return await existing;
    const pending = this.#withPermit(async () => {
      if (await this.#nonEmpty(paths.file)) return paths.file;
      try {
        await mkdir(path.dirname(paths.file), { recursive: true });
        const sourcePath = await this.#sourcePath(projectRoot, asset);
        await this.#run(timelineFrameCommand(
          asset,
          sourcePath,
          sourceFrame,
          height,
          paths.part,
        ));
        await rename(paths.part, paths.file);
        return paths.file;
      } catch {
        return null;
      }
    });
    this.#inflight.set(paths.file, pending);
    try {
      return await pending;
    } finally {
      if (this.#inflight.get(paths.file) === pending) {
        this.#inflight.delete(paths.file);
      }
    }
  }

  async #nonEmpty(file: string): Promise<boolean> {
    try {
      const entry = await stat(file);
      return entry.isFile() && entry.size > 0;
    } catch {
      return false;
    }
  }

  async #sourcePath(projectRoot: string, asset: Asset): Promise<string> {
    const proxy = proxyCachePaths(projectRoot, asset, "edit");
    if (proxy !== undefined) {
      try {
        await access(proxy.media);
        return proxy.media;
      } catch {
        // Source fallback below.
      }
    }
    return path.isAbsolute(asset.path)
      ? asset.path
      : path.resolve(projectRoot, asset.path);
  }

  async #withPermit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#concurrency) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
```

- [ ] **Step 6: Export the contract and verify GREEN**

Add to `packages/media/src/index.ts`:

```ts
export {
  TimelineFrameService,
  timelineFrameCachePaths,
  timelineFrameCommand,
} from "./timeline-frames.js";
export type {
  TimelineFrameCachePaths,
  TimelineFrameResult,
} from "./timeline-frames.js";
```

Run:

```bash
pnpm vitest run packages/media/src/timeline-frames.test.ts
pnpm --filter @guyditor/media typecheck
pnpm --filter @guyditor/media lint
```

Expected: all commands PASS with no warnings.

- [ ] **Step 7: Commit the frame cache**

```bash
git add packages/media/src/timeline-frames.ts packages/media/src/timeline-frames.test.ts packages/media/src/index.ts
git diff --cached --check
git commit -m "feat(media): cache timeline preview frames"
```

### Task 3: Timeline-frame cache accounting

**Files:**
- Modify: `packages/media/src/cache.test.ts`
- Modify: `packages/media/src/cache.ts`

- [ ] **Step 1: Extend the existing cache estimate test first**

In the first `MediaEngine.estimateCacheUse` test, create 13 bytes beneath
`.guyditor/cache/timeline-frames/ast_aaaaaaaaaa.aaaaaaaa/`, then change the
expected result to:

```ts
expect(await engine.estimateCacheUse(store)).toEqual({
  byClass: { peaks: 12, proxies: 11, timelineFrames: 13 },
  projectedProxies: [
    { assetId: "ast_aaaaaaaaaa", bytes: 3_285_000, tier: "edit" },
    { assetId: "ast_bbbbbbbbbb", bytes: 320_000, tier: "edit" },
  ],
  totalBytes: 36,
});
```

Update the second test to assert:

```ts
expect(estimate.totalBytes)
  .toBe(estimate.byClass.proxies + estimate.byClass.timelineFrames);
```

- [ ] **Step 2: Run the cache test and verify RED**

Run:

```bash
pnpm vitest run packages/media/src/cache.test.ts
```

Expected: FAIL because `timelineFrames` is absent and `totalBytes` excludes it.

- [ ] **Step 3: Add the cache class**

Change the public type and estimate implementation:

```ts
export interface CacheUseEstimate {
  byClass: {
    peaks: number;
    proxies: number;
    timelineFrames: number;
  };
  projectedProxies: ProjectedProxySize[];
  totalBytes: number;
}
```

Read the third directory in the existing `Promise.all`:

```ts
const [proxies, peaks, timelineFrames, projectedProxies] = await Promise.all([
  directoryBytes(path.join(projectRoot, ".guyditor/cache/proxies")),
  directoryBytes(path.join(projectRoot, ".guyditor/cache/peaks")),
  directoryBytes(path.join(projectRoot, ".guyditor/cache/timeline-frames")),
  projectedProxySizes(projectRoot, assets, projectFps),
]);
return {
  byClass: { peaks, proxies, timelineFrames },
  projectedProxies,
  totalBytes: proxies + peaks + timelineFrames,
};
```

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
pnpm vitest run packages/media/src/cache.test.ts
pnpm --filter @guyditor/media typecheck
```

Expected: PASS.

```bash
git add packages/media/src/cache.ts packages/media/src/cache.test.ts
git diff --cached --check
git commit -m "feat(media): account for timeline frame cache"
```

### Task 4: Validated frame-resolution IPC

**Files:**
- Modify: `packages/app/src/main/surfaces.test.ts`
- Modify: `packages/app/src/main/surfaces.ts`
- Modify: `packages/app/src/main/project-services.ts`
- Modify: `packages/app/src/main/service-host.test.ts`
- Modify: `packages/app/src/main/service-host.ts`

- [ ] **Step 1: Write the failing surface-contract test**

Add `resolveTimelineFrames` to the expected `MediaEngine` method list. Add:

```ts
it("bounds timeline frame resolution to cache-owned thumbnail requests", () => {
  const media = IPC_SURFACES.find(({ service }) => service === "MediaEngine");
  const schema = media?.methods["resolveTimelineFrames"]?.paramsSchema as {
    required?: unknown;
    properties?: {
      sourceFrames?: { maxItems?: unknown; uniqueItems?: unknown };
      height?: { enum?: unknown };
    };
  } | undefined;

  expect(schema?.required).toEqual(["assetId", "sourceFrames", "height"]);
  expect(schema?.properties?.sourceFrames).toMatchObject({
    maxItems: 12,
    uniqueItems: true,
  });
  expect(schema?.properties?.height?.enum).toEqual([96]);
});
```

- [ ] **Step 2: Run the surface test and verify RED**

Run:

```bash
pnpm vitest run packages/app/src/main/surfaces.test.ts
```

Expected: FAIL because `resolveTimelineFrames` is not exposed.

- [ ] **Step 3: Add the exact IPC schema**

Add this `MediaEngine` method after `resolveProxy`:

```ts
resolveTimelineFrames: {
  paramsSchema: {
    type: "object",
    required: ["assetId", "sourceFrames", "height"],
    properties: {
      assetId: { type: "string", pattern: "^ast_[a-z2-7]{10}$" },
      sourceFrames: {
        type: "array",
        maxItems: 12,
        uniqueItems: true,
        items: { type: "integer", minimum: 0 },
      },
      height: { enum: [96] },
    },
    additionalProperties: false,
  },
  resultSchema: { type: "array" },
  budgetMs: 2_000,
},
```

Run the surface test again and expect PASS.

- [ ] **Step 4: Write the failing main-service cache-hit test**

Import `pathToFileURL`, `TimelineFrameService`, and
`timelineFrameCachePaths`. Create a project whose first asset has full video
metadata, prewrite a non-empty cached frame at source frame 12, open it through
`testAppHost`, and call the service:

```ts
const service = windowHost.resolveService("MediaEngine");
const resolveFrames = service?.["resolveTimelineFrames"];
if (typeof resolveFrames !== "function") {
  throw new Error("Timeline frame service is unavailable.");
}
await expect(Reflect.apply(resolveFrames, service, [{
  assetId: video.id,
  sourceFrames: [12],
  height: 96,
}])).resolves.toEqual([{
  sourceFrame: 12,
  url: pathToFileURL(paths.file).href,
}]);
```

- [ ] **Step 5: Run the service test and verify RED**

Run:

```bash
pnpm vitest run packages/app/src/main/service-host.test.ts \
  -t "resolves cache-owned timeline frame URLs"
```

Expected: FAIL because the project service and method do not exist.

- [ ] **Step 6: Own and expose the per-project service**

In `project-services.ts`, import `TimelineFrameService` as a type and add:

```ts
timelineFrames: TimelineFrameService;
```

In `#openProject`, next to `MediaEngine`, create:

```ts
const media = new MediaEngine({ jobQueue: jobs, mlworker: this.#app.mlworker });
const timelineFrames = new TimelineFrameService();
```

Include `timelineFrames` in `openedProject.value`.

In the `MediaEngine` service map, add:

```ts
resolveTimelineFrames: async ({
  assetId,
  sourceFrames,
  height,
}: {
  assetId: string;
  sourceFrames: number[];
  height: 96;
}) => {
  const asset = project.store.currentProject.assets.find(({ id }) => id === assetId);
  if (asset === undefined) throw new Error(`Asset ${assetId} does not exist.`);
  const frames = await project.timelineFrames.resolve(
    project.store.root,
    asset,
    sourceFrames,
    height,
  );
  return frames.map(({ sourceFrame, path }) => ({
    sourceFrame,
    url: path === null ? null : pathToFileURL(path).href,
  }));
},
```

- [ ] **Step 7: Verify IPC and service integration**

Run:

```bash
pnpm vitest run packages/app/src/main/surfaces.test.ts
pnpm vitest run packages/app/src/main/service-host.test.ts \
  -t "resolves cache-owned timeline frame URLs"
pnpm --filter @guyditor/app typecheck
```

Expected: all commands PASS.

- [ ] **Step 8: Commit the IPC slice**

```bash
git add packages/app/src/main/surfaces.ts packages/app/src/main/surfaces.test.ts \
  packages/app/src/main/project-services.ts packages/app/src/main/service-host.ts \
  packages/app/src/main/service-host.test.ts
git diff --cached --check
git commit -m "feat(app): expose cached timeline frames"
```

### Task 5: Batched visible-clip media loading

**Files:**
- Modify: `packages/app/src/renderer/panels/timeline-media.test.ts`
- Modify: `packages/app/src/renderer/panels/timeline-media.ts`

- [ ] **Step 1: Add failing loader tests**

Define the renderer-side contracts in the test through the wished-for API:

```ts
// Extend the existing Vitest import with `vi`.
import { describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../core/src/index.js";
import {
  currentTimelineMediaResult,
  loadTimelineMedia,
  timelineMediaRequestKey,
} from "./timeline-media.js";

function videoWithAudio(): Asset {
  return {
    id: "ast_aaaaaaaaaa",
    kind: "video",
    path: "media/a.mp4",
    sha256: "a".repeat(64),
    probe: { duration: { frames: 240, fps: "24/1" }, fps: "24/1" },
    video: {
      codec: "h264", width: 1920, height: 1080, fps: "24/1",
      pixFmt: "yuv420p", hasAlpha: false, rotation: 0,
    },
    audio: [{
      index: 0, codec: "aac", sampleRate: 48_000, channels: 1, layout: "mono",
    }],
  };
}

it("loads peaks once per asset and frames for each visible clip", async () => {
  const asset = videoWithAudio();
  const clips = [clip(0, 24), { ...clip(24, 48), id: "clp_bbbbbbbbbb" }];
  const call = vi.fn(async (_service: string, method: string, params: unknown) => {
    if (method === "readPeaks") return peaks();
    const sourceFrames = (params as { sourceFrames: number[] }).sourceFrames;
    return sourceFrames.map((sourceFrame) => ({
      sourceFrame,
      url: `file:///cache/${String(sourceFrame)}.jpg`,
    }));
  });

  const result = await loadTimelineMedia(
    clips.map((clip) => ({ asset, clip, width: 192 })),
    call,
  );

  expect(call.mock.calls.filter(([, method]) => method === "readPeaks")).toHaveLength(1);
  expect(call.mock.calls.filter(([, method]) =>
    method === "resolveTimelineFrames")).toHaveLength(2);
  expect(result["clp_bbbbbbbbbb"]).toMatchObject({
    frameUrls: expect.arrayContaining([expect.stringContaining("jpg")]),
    hasAudio: true,
    hasVideo: true,
  });
});

it("degrades failed frame and peaks calls without losing media semantics", async () => {
  const asset = videoWithAudio();
  const result = await loadTimelineMedia(
    [{ asset, clip: clip(), width: 192 }],
    () => Promise.reject(new Error("offline")),
  );

  expect(result["clp_aaaaaaaaaa"]).toMatchObject({
    frameUrls: [null, null],
    hasAudio: true,
    hasVideo: true,
    waveform: [],
  });
});

it("rejects late results with a different timeline request key", () => {
  const first = timelineMediaRequestKey("rev_00001", "seq_aaaaaaaaaa", 4, []);
  const second = timelineMediaRequestKey("rev_00002", "seq_aaaaaaaaaa", 4, []);
  expect(currentTimelineMediaResult({ key: first, clips: {} }, second)).toEqual({});
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/timeline-media.test.ts
```

Expected: FAIL because the loader contracts are not implemented.

- [ ] **Step 3: Implement the loader contracts**

Add:

```ts
import { useEffect, useRef, useState } from "react";
import type { Asset } from "../../../../core/src/index.js";

export interface TimelineMediaRequest {
  asset: Asset;
  clip: Clip;
  width: number;
}

export interface TimelineClipMediaState {
  frameUrls: Array<string | null>;
  hasAudio: boolean;
  hasVideo: boolean;
  sourceFrames: number[];
  waveform: WaveformColumn[];
}

export interface TimelineMediaResult {
  key: string;
  clips: Record<string, TimelineClipMediaState>;
}

interface TimelineFrameResolution {
  sourceFrame: number;
  url: string | null;
}

type MediaCall = (
  service: "MediaEngine",
  method: string,
  params: unknown,
) => Promise<unknown>;
```

Add the pure key and stale-result guards:

```ts
export function timelineMediaRequestKey(
  revision: string,
  sequenceId: string,
  zoom: number,
  requests: readonly TimelineMediaRequest[],
): string {
  return JSON.stringify({
    revision,
    sequenceId,
    zoom,
    requests: requests.map(({ asset, clip, width }) => ({
      clipId: clip.id,
      assetId: asset.id,
      sourceHash: asset.sha256,
      sourceIn: clip.source.in,
      sourceOut: clip.source.out,
      width,
      sourceFrames: representativeSourceFrames(clip, width),
    })),
  });
}

export function currentTimelineMediaResult(
  result: TimelineMediaResult,
  key: string,
): Record<string, TimelineClipMediaState> {
  return result.key === key ? result.clips : {};
}
```

Implement `loadTimelineMedia` with one memoized peaks promise per asset and
independent degraded results:

```ts
export async function loadTimelineMedia(
  requests: readonly TimelineMediaRequest[],
  call: MediaCall,
): Promise<Record<string, TimelineClipMediaState>> {
  const peaksByAsset = new Map<string, Promise<PeaksFile | null>>();
  const peaksFor = (asset: Asset): Promise<PeaksFile | null> => {
    const key = `${asset.id}:${asset.sha256}`;
    const existing = peaksByAsset.get(key);
    if (existing !== undefined) return existing;
    const pending = call("MediaEngine", "readPeaks", { assetId: asset.id })
      .then((value) => value as PeaksFile | null)
      .catch(() => null);
    peaksByAsset.set(key, pending);
    return pending;
  };

  const entries = await Promise.all(requests.map(async ({ asset, clip, width }) => {
    const sourceFrames = asset.video === undefined
      ? []
      : representativeSourceFrames(clip, width);
    const hasAudio = (asset.audio?.length ?? 0) > 0;
    const framePromise = asset.video === undefined
      ? Promise.resolve([] as TimelineFrameResolution[])
      : call("MediaEngine", "resolveTimelineFrames", {
          assetId: asset.id,
          sourceFrames,
          height: TIMELINE_FRAME_HEIGHT,
        })
          .then((value) => value as TimelineFrameResolution[])
          .catch(() => []);
    const peaksPromise = hasAudio ? peaksFor(asset) : Promise.resolve(null);
    const [resolvedFrames, peaks] = await Promise.all([framePromise, peaksPromise]);
    const urls = new Map(resolvedFrames.map(({ sourceFrame, url }) =>
      [sourceFrame, url] as const));
    return [clip.id, {
      frameUrls: sourceFrames.map((sourceFrame) => urls.get(sourceFrame) ?? null),
      hasAudio,
      hasVideo: asset.video !== undefined,
      sourceFrames,
      waveform: peaks === null ? [] : waveformColumns(peaks, clip, width),
    }] as const;
  }));
  return Object.fromEntries(entries);
}
```

Add the hook:

```ts
export function useTimelineMedia(
  requests: readonly TimelineMediaRequest[],
  key: string,
): Record<string, TimelineClipMediaState> {
  const [result, setResult] = useState<TimelineMediaResult>({ key, clips: {} });
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  useEffect(() => {
    let current = true;
    setResult({ key, clips: {} });
    void loadTimelineMedia(requestsRef.current, (service, method, params) =>
      window.guyditor.call(service, method, params)).then((clips) => {
      if (current) setResult({ key, clips });
    });
    return () => { current = false; };
  }, [key]);
  return currentTimelineMediaResult(result, key);
}
```

The ref deliberately supplies the request snapshot associated with `key`; do not
add the freshly allocated request array to the effect dependencies and do not
suppress React hook dependency lint.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/timeline-media.test.ts
pnpm --filter @guyditor/app typecheck
pnpm --filter @guyditor/app lint
```

Expected: PASS.

```bash
git add packages/app/src/renderer/panels/timeline-media.ts \
  packages/app/src/renderer/panels/timeline-media.test.ts
git diff --cached --check
git commit -m "feat(app): load visible timeline media"
```

### Task 6: Hybrid clip-media component

**Files:**
- Create: `packages/app/src/renderer/panels/TimelineClipMedia.test.ts`
- Create: `packages/app/src/renderer/panels/TimelineClipMedia.tsx`
- Modify: `packages/app/src/renderer/styles.css`

- [ ] **Step 1: Write failing static-render tests**

Create `TimelineClipMedia.test.ts`:

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TimelineClipMedia } from "./TimelineClipMedia.js";

it("renders filmstrip frames and an overlaid waveform together", () => {
  const html = renderToStaticMarkup(createElement(TimelineClipMedia, {
    clipId: "clp_aaaaaaaaaa",
    durationFrames: 184,
    media: {
      frameUrls: ["file:///one.jpg", "file:///two.jpg"],
      hasAudio: true,
      hasVideo: true,
      sourceFrames: [12, 36],
      waveform: [
        { minimum: -64, maximum: 32 },
        { minimum: -20, maximum: 80 },
      ],
    },
  }));

  expect(html.match(/<img/g)).toHaveLength(2);
  expect(html).toContain('data-testid="timeline-filmstrip-clp_aaaaaaaaaa"');
  expect(html).toContain('data-testid="timeline-waveform-clp_aaaaaaaaaa"');
  expect(html).toContain("<path");
  expect(html).toContain("184f");
});

it("renders an audio baseline without filmstrip frames when peaks are absent", () => {
  const html = renderToStaticMarkup(createElement(TimelineClipMedia, {
    clipId: "clp_bbbbbbbbbb",
    durationFrames: 72,
    media: {
      frameUrls: [],
      hasAudio: true,
      hasVideo: false,
      sourceFrames: [],
      waveform: [],
    },
  }));

  expect(html).not.toContain("<img");
  expect(html).toContain('data-state="baseline"');
  expect(html).toContain('data-testid="timeline-waveform-clp_bbbbbbbbbb"');
});

it("omits waveform markup for silent video", () => {
  const html = renderToStaticMarkup(createElement(TimelineClipMedia, {
    clipId: "clp_cccccccccc",
    durationFrames: 48,
    media: {
      frameUrls: ["file:///silent.jpg"],
      hasAudio: false,
      hasVideo: true,
      sourceFrames: [10],
      waveform: [],
    },
  }));
  expect(html).toContain("<img");
  expect(html).not.toContain("timeline-waveform");
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/TimelineClipMedia.test.ts
```

Expected: FAIL because `TimelineClipMedia` does not exist.

- [ ] **Step 3: Implement the focused component**

Create `TimelineClipMedia.tsx`:

```tsx
import type { TimelineClipMediaState } from "./timeline-media.js";

function waveformPath(
  columns: TimelineClipMediaState["waveform"],
): string {
  return columns.map(({ minimum, maximum }, index) => {
    const top = 50 - maximum / 127 * 46;
    const bottom = 50 - minimum / 127 * 46;
    return `M${String(index + 0.5)} ${top.toFixed(3)}V${bottom.toFixed(3)}`;
  }).join("");
}

export function TimelineClipMedia({
  clipId,
  durationFrames,
  media,
}: {
  clipId: string;
  durationFrames: number;
  media: TimelineClipMediaState;
}): React.JSX.Element {
  return (
    <>
      {media.hasVideo ? (
        <span
          className="timeline-filmstrip"
          data-testid={`timeline-filmstrip-${clipId}`}
          aria-hidden="true"
        >
          {media.sourceFrames.map((sourceFrame, index) => {
            const url = media.frameUrls[index] ?? null;
            return url === null
              ? <i key={sourceFrame} />
              : <img key={sourceFrame} src={url} alt="" draggable={false} />;
          })}
        </span>
      ) : null}
      {media.hasVideo && media.hasAudio
        ? <span className="timeline-media-scrim" aria-hidden="true" />
        : null}
      {media.hasAudio ? (
        <svg
          className="timeline-waveform"
          data-state={media.waveform.length === 0 ? "baseline" : "ready"}
          data-testid={`timeline-waveform-${clipId}`}
          viewBox={`0 0 ${String(Math.max(1, media.waveform.length))} 100`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {media.waveform.length === 0
            ? <line x1="0" y1="50" x2="1" y2="50" />
            : <path d={waveformPath(media.waveform)} />}
        </svg>
      ) : null}
      <span className="timeline-clip-label">{clipId}</span>
      <small className="timeline-clip-duration">{durationFrames}f</small>
    </>
  );
}
```

- [ ] **Step 4: Add the approved CSS**

Replace the old clip/waveform rules with:

```css
.timeline-clips { position: relative; height: 86px; }
.timeline-clip {
  position: absolute;
  top: 8px;
  height: 68px;
  overflow: hidden;
  padding: 0;
  border-color: #3d687d;
  color: #dbe9ee;
  text-align: left;
  background: #234151;
}
.timeline-clip[data-selected="true"] {
  border-color: var(--amber);
  box-shadow: inset 0 0 0 1px var(--amber);
}
.timeline-filmstrip {
  position: absolute;
  z-index: 0;
  inset: 0;
  display: flex;
  pointer-events: none;
}
.timeline-filmstrip img,
.timeline-filmstrip i {
  min-width: 0;
  flex: 1 1 0;
  height: 100%;
  object-fit: cover;
  background: #234151;
}
.timeline-media-scrim {
  position: absolute;
  z-index: 1;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(180deg, rgb(5 10 13 / 62%), transparent 34%),
    rgb(5 11 14 / 20%);
}
.timeline-waveform {
  position: absolute;
  z-index: 2;
  inset: 16px 4px 4px;
  width: calc(100% - 8px);
  height: calc(100% - 20px);
  overflow: visible;
  pointer-events: none;
}
.timeline-waveform path {
  fill: none;
  stroke: #b8dfec;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  filter: drop-shadow(0 0 1px #071014);
}
.timeline-waveform line {
  stroke: #8ca4ae;
  stroke-width: 1;
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}
.timeline-clip-label,
.timeline-clip-duration {
  position: absolute;
  z-index: 3;
  top: 4px;
  padding: 2px 4px;
  color: #eef6f8;
  background: rgb(7 13 16 / 82%);
  font: 650 var(--fs-label)/1 ui-monospace, monospace;
  pointer-events: none;
}
.timeline-clip-label {
  left: 4px;
  max-width: calc(100% - 48px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline-clip-duration { right: 4px; }
```

Change `.jumpcut-seam` from `height: 58px` to `height: 76px`. Keep
`.timeline-playhead` anchored by its existing `top: -22px` and `bottom: -18px`;
the bottom anchor automatically spans the new 86-pixel row. Do not change either
element's horizontal behavior.

- [ ] **Step 5: Verify component GREEN**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/TimelineClipMedia.test.ts
pnpm --filter @guyditor/app typecheck
pnpm --filter @guyditor/app lint
```

Expected: PASS.

- [ ] **Step 6: Commit the component**

```bash
git add packages/app/src/renderer/panels/TimelineClipMedia.tsx \
  packages/app/src/renderer/panels/TimelineClipMedia.test.ts \
  packages/app/src/renderer/styles.css
git diff --cached --check
git commit -m "feat(app): render hybrid timeline clip media"
```

### Task 7: Integrate media loading into the virtualized timeline

**Files:**
- Modify: `packages/app/src/renderer/panels/TimelinePanel.tsx`
- Modify: `packages/app/src/renderer/panels/TimelinePanel.test.ts`
- Modify: `packages/app/src/renderer/panels/active-deliverable-panels.test.ts`
- Modify: `packages/app/e2e/helpers/workspace-project.ts`
- Modify: `packages/app/e2e/workspace.spec.ts`

- [ ] **Step 1: Write the failing integration expectations**

Add a pure exported helper to the wished-for test API:

```ts
import type { Asset } from "../../../../core/src/index.js";
import { timelineMediaRequests } from "./TimelinePanel.js";

it("builds media requests for every visible clip without consulting selection", () => {
  const asset = {
    ...projectFixture().assets[0]!,
    video: {
      codec: "h264", width: 1920, height: 1080, fps: "24/1",
      pixFmt: "yuv420p", hasAlpha: false, rotation: 0 as const,
    },
    audio: [{
      index: 0, codec: "aac", sampleRate: 48_000, channels: 1, layout: "mono",
    }],
  } satisfies Asset;
  const clips = projectFixture().sequences[0]!.clips;

  expect(timelineMediaRequests([
    { clipId: "clp_aaaaaaaaaa", width: 96 },
    { clipId: "clp_bbbbbbbbbb", width: 144 },
  ], clips, [asset]).map(({ clip }) => clip.id))
    .toEqual(["clp_aaaaaaaaaa", "clp_bbbbbbbbbb"]);
});
```

In `active-deliverable-panels.test.ts`, keep the existing active-sequence
assertions, give the fixture asset full video and audio metadata, and add that
server-rendered active clips contain their waveform test IDs even when
`selectedClipId` is null.

Add `timelineMedia?: boolean` to `WorkspaceProjectOptions`. When enabled:

- populate the fixture asset's video metadata for the existing
  `bars-1080p30-10s.mp4`;
- create a valid `guyditor.peaks/v1` file through `peaksCachePaths`;
- create cached timeline frames for the representative source frames required by
  the two default clips through `timelineFrameCachePaths`;
- use bytes from an existing repository PNG preview for each cached frame so
  Chromium can decode the image even though the cache extension is `.jpg`.

Use the production cache path helpers; do not duplicate cache-path strings in the
fixture. After project creation, seed the artifacts with:

```ts
if (options.timelineMedia === true) {
  const asset = created.currentProject.assets[0]!;
  const peaksPath = peaksCachePaths(created.root, asset).file;
  await mkdir(dirname(peaksPath), { recursive: true });
  await writeFile(peaksPath, `${JSON.stringify({
    format: "guyditor.peaks/v1",
    assetId: asset.id,
    sourceHash: asset.sha256,
    sampleRate: 48_000,
    tiers: [960, 9_600, 48_000].map((samplesPerPeak) => ({
      samplesPerPeak,
      data: Array.from({ length: 240 }, (_unused, index) =>
        index % 2 === 0 ? -48 - index % 32 : 48 + index % 32),
    })),
  })}\n`);
  const image = await readFile(resolve(
    import.meta.dirname,
    "../../../../templates/title-card/preview.png",
  ));
  for (const clip of created.currentProject.sequences[0]!.clips) {
    for (const sourceFrame of representativeSourceFrames(clip, 96)) {
      const paths = timelineFrameCachePaths(
        created.root,
        asset,
        sourceFrame,
        TIMELINE_FRAME_HEIGHT,
      );
      await mkdir(dirname(paths.file), { recursive: true });
      await writeFile(paths.file, image);
    }
  }
}
```

Add the required imports from `packages/media/src/index.js` and
`packages/app/src/renderer/panels/timeline-media.js`. Because `createProject`
persists the initial model before this block, add the following before the
`createProject` call and use the post-create block only for cache files:

```ts
if (options.timelineMedia === true) {
  model.assets[0]!.video = {
    codec: "h264",
    width: 1920,
    height: 1080,
    fps: "24/1",
    pixFmt: "yuv420p",
    hasAlpha: false,
    rotation: 0,
  };
}
```

Then add the failing Electron regression:

```ts
test("shows filmstrips and waveforms on selected and unselected timeline clips", async () => {
  const template = await createWorkspaceProject({ timelineMedia: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    const first = launched.page.getByTestId("timeline-clip-clp_aaaaaaaaaa");
    const second = launched.page.getByTestId("timeline-clip-clp_bbbbbbbbbb");
    await first.click();

    await expect(first.getByTestId("timeline-filmstrip-clp_aaaaaaaaaa"))
      .toBeVisible();
    await expect(second.getByTestId("timeline-filmstrip-clp_bbbbbbbbbb"))
      .toBeVisible();
    await expect(first.getByTestId("timeline-waveform-clp_aaaaaaaaaa"))
      .toBeVisible();
    await expect(second.getByTestId("timeline-waveform-clp_bbbbbbbbbb"))
      .toBeVisible();
    await expect(second).toHaveAttribute("data-selected", "false");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/TimelinePanel.test.ts \
  packages/app/src/renderer/panels/active-deliverable-panels.test.ts
pnpm --filter @guyditor/app test:e2e -- workspace.spec.ts \
  --grep "shows filmstrips and waveforms"
```

Expected: both focused runs FAIL because `timelineMediaRequests` and the timeline
media markup are absent.

- [ ] **Step 3: Replace selected-only peaks state with memoized visible requests**

In `TimelinePanel.tsx`:

1. remove `PeaksFile`, `peaks` state, the selected-asset `readPeaks` effect, and
   the local `Waveform` component;
2. import `Asset`, `TimelineClipMedia`, `representativeSourceFrames`,
   `timelineMediaRequestKey`, `TimelineMediaRequest`, and `useTimelineMedia`;
3. export this pure helper:

```ts
export function timelineMediaRequests(
  visible: readonly { clipId: string; width: number }[],
  clips: readonly Clip[],
  assets: readonly Asset[],
): TimelineMediaRequest[] {
  const byClip = new Map(clips.map((clip) => [clip.id, clip]));
  const byAsset = new Map(assets.map((asset) => [asset.id, asset]));
  return visible.flatMap(({ clipId, width }) => {
    const clip = byClip.get(clipId);
    if (clip === undefined) return [];
    const asset = byAsset.get(clip.asset);
    return asset === undefined ? [] : [{ asset, clip, width }];
  });
}
```

Build the placement input directly from `visibleClips` in derived order:

```ts
const mediaRequests = timelineMediaRequests(
  visibleClips.map((timed) => ({
    clipId: timed.clipId,
    width: Math.max(36, timed.duration.frames * zoom),
  })),
  sequence?.clips ?? [],
  snapshot?.master.assets ?? [],
);
```

Then compute:

```ts
const mediaKey = timelineMediaRequestKey(
  snapshot?.revision ?? "closed",
  sequence?.id ?? "none",
  zoom,
  mediaRequests,
);
const mediaByClip = useTimelineMedia(mediaRequests, mediaKey);
```

The serialized key makes equivalent freshly allocated request arrays stable across
renders; the hook captures the request snapshot through its ref.

- [ ] **Step 4: Render the focused component in every clip**

For each visible clip, calculate its exact display width once and replace the old
ID/duration/waveform children with:

```tsx
const asset = snapshot?.master.assets.find(({ id }) => id === clip.asset);
if (asset === undefined) return null;
const clipWidth = Math.max(36, timed.duration.frames * zoom);
const sourceFrames = representativeSourceFrames(clip, clipWidth);

<TimelineClipMedia
  clipId={clip.id}
  durationFrames={clipDuration(clip)}
  media={mediaByClip[clip.id] ?? {
    frameUrls: sourceFrames.map(() => null),
    hasAudio: (asset.audio?.length ?? 0) > 0,
    hasVideo: asset.video !== undefined,
    sourceFrames,
    waveform: [],
  }}
/>
```

Keep the existing button, handlers, selection data, left position, width,
drag/drop, and playhead update unchanged. Add an explicit `aria-label`:

```tsx
aria-label={`${clip.id}, ${String(clipDuration(clip))} frames`}
```

- [ ] **Step 5: Verify focused and existing timeline tests**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/TimelinePanel.test.ts \
  packages/app/src/renderer/panels/TimelineClipMedia.test.ts \
  packages/app/src/renderer/panels/timeline-media.test.ts \
  packages/app/src/renderer/panels/active-deliverable-panels.test.ts
pnpm --filter @guyditor/app test:e2e -- workspace.spec.ts \
  --grep "shows filmstrips and waveforms"
pnpm --filter @guyditor/app typecheck
pnpm --filter @guyditor/app lint
```

Expected: PASS.

- [ ] **Step 6: Commit the timeline integration**

```bash
git add packages/app/src/renderer/panels/TimelinePanel.tsx \
  packages/app/src/renderer/panels/TimelinePanel.test.ts \
  packages/app/src/renderer/panels/active-deliverable-panels.test.ts \
  packages/app/e2e/helpers/workspace-project.ts packages/app/e2e/workspace.spec.ts
git diff --cached --check
git commit -m "feat(app): show media on every visible timeline clip"
```

### Task 8: Visual critique, traceability, and targeted regression

**Files:**
- Modify: `docs/traceability.md`

- [ ] **Step 1: Capture and inspect the implemented timeline**

Run the Electron regression and capture the timeline for critique:

```bash
pnpm --filter @guyditor/app test:e2e -- workspace.spec.ts \
  --grep "shows filmstrips and waveforms"
```

During execution, temporarily save a Playwright screenshot to
`/tmp/guyditor-timeline-media.png`, inspect it, then remove the temporary
`page.screenshot` line before committing. Confirm:

- filmstrip cells fill the entire 68-pixel tile;
- waveform contrast remains readable over both bright and dark bars;
- labels do not cover the duration or waveform;
- the amber selected outline, playhead, and jump-cut controls remain above media;
- no tile content spills outside the timeline viewport.

- [ ] **Step 2: Update FR-906 traceability**

Update the FR-906 row to cite:

```text
packages/media/src/timeline-frames.test.ts
packages/app/src/renderer/panels/timeline-media.test.ts
packages/app/src/renderer/panels/TimelineClipMedia.test.ts
packages/app/e2e/workspace.spec.ts
```

State that the timeline now uses hash-keyed lazy frame previews and range/zoom-aware
waveforms for every visible audio-bearing clip, independent of selection.

- [ ] **Step 3: Run the targeted regression group**

Run:

```bash
pnpm vitest run packages/media/src/timeline-frames.test.ts \
  packages/media/src/cache.test.ts \
  packages/app/src/main/surfaces.test.ts \
  packages/app/src/main/service-host.test.ts \
  packages/app/src/renderer/panels/timeline-media.test.ts \
  packages/app/src/renderer/panels/TimelineClipMedia.test.ts \
  packages/app/src/renderer/panels/TimelinePanel.test.ts \
  packages/app/src/renderer/panels/active-deliverable-panels.test.ts
pnpm --filter @guyditor/app test:e2e -- workspace.spec.ts \
  --grep "shows filmstrips and waveforms|trims and splits|journals semantic reorder"
```

Expected: all tests PASS.

- [ ] **Step 4: Commit traceability**

```bash
git add docs/traceability.md
git diff --cached --check
git commit -m "docs(traceability): record timeline media tiles"
```

### Task 9: Full verification and branch review

**Files:**
- Verify only; update implementation or tests only if a command exposes a
  task-owned defect.

- [ ] **Step 1: Run repository formatting and convention checks**

```bash
git diff --check main...HEAD
pnpm check:conventions
```

Expected: PASS with no convention violations.

- [ ] **Step 2: Run package typechecks and lint**

```bash
pnpm --filter @guyditor/media typecheck
pnpm --filter @guyditor/media lint
pnpm --filter @guyditor/app typecheck
pnpm --filter @guyditor/app lint
```

Expected: all four commands PASS.

- [ ] **Step 3: Run the complete unit suite**

```bash
pnpm vitest run
```

Expected: all unit projects PASS.

- [ ] **Step 4: Run the relevant Electron suite**

```bash
pnpm --filter @guyditor/app test:e2e -- workspace.spec.ts active-deliverable.spec.ts
```

Expected: PASS, including timeline editing and active-deliverable switching.

- [ ] **Step 5: Review branch ownership and checkpoint quality**

```bash
git status --short --branch
git log --oneline main..HEAD
git diff --stat main...HEAD
git diff main...HEAD
```

Expected: a clean `fix/timeline-media-tiles` worktree containing only the approved
documentation, media cache, IPC, renderer, tests, styles, and traceability changes.

- [ ] **Step 6: Invoke required completion workflows**

Use `superpowers:verification-before-completion`, then
`superpowers:requesting-code-review`. Address any review findings with another
test-first red/green cycle and cohesive commit. Only after verification and review
are clean, use `superpowers:finishing-a-development-branch` to present integration
choices; do not push, merge, rebase, or delete the branch without explicit user
authorization.
