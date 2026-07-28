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
    if (
      sourceFrames.length > 12 ||
      new Set(sourceFrames).size !== sourceFrames.length
    ) {
      throw new RangeError("Timeline frame requests require at most 12 unique frames.");
    }
    return await Promise.all(sourceFrames.map(async (sourceFrame) => ({
      sourceFrame,
      path: await this.#resolveOne(projectRoot, asset, sourceFrame, height),
    })));
  }

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
}
