import {
  mkdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { Asset } from "../../core/src/index.js";

import { peaksDecodeCommand } from "./commands.js";
import { runFfmpeg } from "./run.js";

export const PEAK_SAMPLE_RATE = 48_000;
export const PEAK_SAMPLES_PER_PEAK = [960, 9_600, 48_000] as const;

export interface PeaksTier {
  samplesPerPeak: number;
  data: number[];
}

export interface PeaksFile {
  format: "guyditor.peaks/v1";
  assetId: string;
  sourceHash: string;
  sampleRate: 48000;
  tiers: PeaksTier[];
}

export interface PeaksCachePaths {
  file: string;
  part: string;
}

export interface PeaksGenerateResult {
  assetId: string;
  path: string;
}

interface TierState {
  count: number;
  data: number[];
  maximum: number;
  minimum: number;
  samplesPerPeak: number;
}

function scaledInt8(sample: number): number {
  const magnitude = Math.round(Math.abs(sample) * 127 / 32_768);
  return Math.max(-127, Math.min(127, sample < 0 ? -magnitude : magnitude));
}

function flushTier(tier: TierState): void {
  if (tier.count === 0) return;
  tier.data.push(scaledInt8(tier.minimum), scaledInt8(tier.maximum));
  tier.count = 0;
  tier.minimum = 32_767;
  tier.maximum = -32_768;
}

/** Incremental mono s16le reducer. It retains peak arrays, never the decoded PCM stream. */
export class PcmPeakAccumulator {
  readonly #tiers: TierState[] = PEAK_SAMPLES_PER_PEAK.map(
    (samplesPerPeak) => ({
      count: 0,
      data: [],
      maximum: -32_768,
      minimum: 32_767,
      samplesPerPeak,
    }),
  );
  #finished = false;
  #pendingLowByte: number | undefined;

  public write(chunk: Buffer): void {
    if (this.#finished) throw new Error("Cannot write PCM after finishing peaks.");
    let offset = 0;
    if (this.#pendingLowByte !== undefined && chunk.length > 0) {
      const unsigned = this.#pendingLowByte | (chunk[0]! << 8);
      this.#addSample(unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned);
      this.#pendingLowByte = undefined;
      offset = 1;
    }
    while (offset + 1 < chunk.length) {
      this.#addSample(chunk.readInt16LE(offset));
      offset += 2;
    }
    if (offset < chunk.length) this.#pendingLowByte = chunk[offset];
  }

  public finish(): PeaksTier[] {
    if (this.#finished) throw new Error("Peaks have already been finished.");
    this.#finished = true;
    if (this.#pendingLowByte !== undefined) {
      throw new Error("Decoded PCM ended with a partial s16le sample.");
    }
    for (const tier of this.#tiers) flushTier(tier);
    return this.#tiers.map(({ data, samplesPerPeak }) => ({
      data,
      samplesPerPeak,
    }));
  }

  #addSample(sample: number): void {
    for (const tier of this.#tiers) {
      tier.minimum = Math.min(tier.minimum, sample);
      tier.maximum = Math.max(tier.maximum, sample);
      tier.count += 1;
      if (tier.count === tier.samplesPerPeak) flushTier(tier);
    }
  }
}

export function peaksCachePaths(projectRoot: string, asset: Asset): PeaksCachePaths {
  const file = path.join(
    projectRoot,
    ".guyditor/cache/peaks",
    `${asset.id}.${asset.sha256.slice(0, 8)}.peaks.json`,
  );
  return { file, part: `${file}.part` };
}

function resolvedAsset(projectRoot: string, asset: Asset): Asset {
  return {
    ...asset,
    path: path.isAbsolute(asset.path)
      ? asset.path
      : path.join(projectRoot, asset.path),
  };
}

export async function generatePeaks(
  projectRoot: string,
  asset: Asset,
  signal: AbortSignal,
): Promise<PeaksGenerateResult> {
  const paths = peaksCachePaths(projectRoot, asset);
  const accumulator = new PcmPeakAccumulator();
  await runFfmpeg(peaksDecodeCommand(resolvedAsset(projectRoot, asset)), {
    collectStdout: false,
    onStdoutChunk: (chunk) => accumulator.write(chunk),
    signal,
  });
  const peaks: PeaksFile = {
    assetId: asset.id,
    format: "guyditor.peaks/v1",
    sampleRate: PEAK_SAMPLE_RATE,
    sourceHash: asset.sha256,
    tiers: accumulator.finish(),
  };
  await mkdir(path.dirname(paths.file), { recursive: true });
  await writeFile(paths.part, `${JSON.stringify(peaks)}\n`, "utf8");
  await rename(paths.part, paths.file);
  return { assetId: asset.id, path: paths.file };
}
