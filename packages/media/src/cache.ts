import {
  readdir,
  stat,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type {
  Asset,
  Rational,
} from "../../core/src/index.js";

import { proxyProfile } from "./commands.js";
import { proxyIsStale } from "./proxy.js";

export interface ProjectedProxySize {
  assetId: string;
  bytes: number;
  tier: "edit";
}

export interface CacheUseEstimate {
  byClass: {
    peaks: number;
    proxies: number;
    timelineFrames: number;
  };
  projectedProxies: ProjectedProxySize[];
  totalBytes: number;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

async function directoryBytes(directory: string): Promise<number> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
  } catch (error: unknown) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      bytes += await directoryBytes(child);
    } else if (entry.isFile()) {
      bytes += (await stat(child)).size;
    }
  }
  return bytes;
}

function rationalNumber(value: Rational): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(value);
  if (match === null) throw new TypeError(`Invalid rational ${value}.`);
  return Number(match[1]) / Number(match[2]);
}

function durationSeconds(asset: Asset): number | undefined {
  const duration = asset.probe.duration;
  if (duration === undefined) return undefined;
  return "frames" in duration
    ? duration.frames / rationalNumber(duration.fps)
    : duration.samples / duration.rate;
}

async function projectedProxySizes(
  projectRoot: string,
  assets: readonly Asset[],
  projectFps: Rational,
): Promise<ProjectedProxySize[]> {
  const projected: ProjectedProxySize[] = [];
  for (const asset of assets) {
    const profile = proxyProfile(asset, "edit");
    const seconds = durationSeconds(asset);
    if (
      profile?.estimatedBitrateKbps === undefined || seconds === undefined ||
      !await proxyIsStale(projectRoot, asset, "edit", projectFps)
    ) {
      continue;
    }
    const audioKbps = profile.kind === "opaque-video" || profile.kind === "alpha-video"
      ? 128
      : 0;
    projected.push({
      assetId: asset.id,
      bytes: Math.round(seconds * (profile.estimatedBitrateKbps + audioKbps) * 125),
      tier: "edit",
    });
  }
  return projected;
}

export async function estimateProjectCacheUse(
  projectRoot: string,
  assets: readonly Asset[],
  projectFps: Rational,
): Promise<CacheUseEstimate> {
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
}
