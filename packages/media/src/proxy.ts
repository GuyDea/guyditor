import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { Asset, Rational } from "../../core/src/index.js";

import {
  proxyCommand,
  proxyProfile,
} from "./commands.js";
import type { ProxyTier } from "./commands.js";
import { probeMedia } from "./probe.js";
import { runFfmpeg } from "./run.js";

export const PROXY_PROFILE_VERSION = 1;

export interface ProxyMetadata {
  assetId: string;
  sourceHash: string;
  tier: ProxyTier;
  profileVersion: number;
  ffmpegVersion: string;
  createdAt: string;
  durationFrames: number;
}

export interface ProxyCachePaths {
  media: string;
  mediaPart: string;
  metadata: string;
  metadataPart: string;
}

export interface ProxyGenerateResult {
  assetId: string;
  path: string;
  tier: ProxyTier;
}

function rationalNumber(value: Rational): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(value);
  if (match === null) throw new TypeError(`Invalid rational ${value}.`);
  return Number(match[1]) / Number(match[2]);
}

export function sourceDurationFrames(
  asset: Asset,
  projectFps: Rational,
): number | undefined {
  const duration = asset.probe.duration;
  if (duration !== undefined && "frames" in duration) return duration.frames;
  if (duration !== undefined && "samples" in duration) {
    return Math.round(
      (duration.samples / duration.rate) * rationalNumber(projectFps),
    );
  }
  return asset.image === undefined ? undefined : 1;
}

export function proxyCachePaths(
  projectRoot: string,
  asset: Asset,
  tier: ProxyTier,
): ProxyCachePaths | undefined {
  const profile = proxyProfile(asset, tier);
  if (profile === undefined) return undefined;
  const media = path.join(
    projectRoot,
    ".guyditor/cache/proxies",
    `${asset.id}.${asset.sha256.slice(0, 8)}.${tier}.${profile.extension}`,
  );
  const metadata = `${media}.meta.json`;
  return {
    media,
    mediaPart: `${media}.part`,
    metadata,
    metadataPart: `${metadata}.part`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(text: string): ProxyMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (
    typeof parsed["assetId"] !== "string" ||
    typeof parsed["sourceHash"] !== "string" ||
    parsed["tier"] !== "edit" ||
    !Number.isSafeInteger(parsed["profileVersion"]) ||
    typeof parsed["ffmpegVersion"] !== "string" ||
    typeof parsed["createdAt"] !== "string" ||
    !Number.isSafeInteger(parsed["durationFrames"]) ||
    Number(parsed["durationFrames"]) < 0
  ) {
    return undefined;
  }
  return {
    assetId: parsed["assetId"],
    createdAt: parsed["createdAt"],
    durationFrames: Number(parsed["durationFrames"]),
    ffmpegVersion: parsed["ffmpegVersion"],
    profileVersion: Number(parsed["profileVersion"]),
    sourceHash: parsed["sourceHash"],
    tier: "edit",
  };
}

async function nonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const entry = await stat(filePath);
    return entry.isFile() && entry.size > 0;
  } catch {
    return false;
  }
}

async function readMetadata(filePath: string): Promise<ProxyMetadata | undefined> {
  try {
    return parseMetadata(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/** The five ordered FR-003 checks. A small image has no required proxy and is current. */
export async function proxyIsStale(
  projectRoot: string,
  asset: Asset,
  tier: ProxyTier,
  projectFps: Rational,
): Promise<boolean> {
  const paths = proxyCachePaths(projectRoot, asset, tier);
  if (paths === undefined) return false;
  if (!await nonEmptyFile(paths.media)) return true;
  const metadata = await readMetadata(paths.metadata);
  if (metadata === undefined) return true;
  if (metadata.sourceHash !== asset.sha256) return true;
  if (metadata.profileVersion !== PROXY_PROFILE_VERSION) return true;
  const expectedDuration = sourceDurationFrames(asset, projectFps);
  return expectedDuration === undefined ||
    Math.abs(metadata.durationFrames - expectedDuration) > 2;
}

function resolvedAsset(projectRoot: string, asset: Asset): Asset {
  return {
    ...asset,
    path: path.isAbsolute(asset.path)
      ? asset.path
      : path.join(projectRoot, asset.path),
  };
}

export async function generateProxy(
  projectRoot: string,
  asset: Asset,
  tier: ProxyTier,
  projectFps: Rational,
  signal: AbortSignal,
  now: () => Date,
): Promise<ProxyGenerateResult> {
  const paths = proxyCachePaths(projectRoot, asset, tier);
  if (paths === undefined) {
    throw new TypeError(`Asset ${asset.id} does not require an ${tier} proxy.`);
  }
  await mkdir(path.dirname(paths.media), { recursive: true });
  const command = proxyCommand(resolvedAsset(projectRoot, asset), tier, paths.mediaPart);
  if (command === undefined) {
    throw new TypeError(`Asset ${asset.id} does not compile an ${tier} proxy.`);
  }
  const run = await runFfmpeg(command, { signal });
  await rename(paths.mediaPart, paths.media);

  const probed = await probeMedia(paths.media);
  const durationAsset: Asset = { ...asset, probe: probed.probe };
  const durationFrames = sourceDurationFrames(durationAsset, projectFps);
  if (durationFrames === undefined) {
    throw new Error(`Proxy ${paths.media} has no measurable duration.`);
  }
  const metadata: ProxyMetadata = {
    assetId: asset.id,
    createdAt: now().toISOString(),
    durationFrames,
    ffmpegVersion: run.binary.version,
    profileVersion: PROXY_PROFILE_VERSION,
    sourceHash: asset.sha256,
    tier,
  };
  await writeFile(paths.metadataPart, `${JSON.stringify(metadata)}\n`, "utf8");
  await rename(paths.metadataPart, paths.metadata);
  return { assetId: asset.id, path: paths.media, tier };
}
