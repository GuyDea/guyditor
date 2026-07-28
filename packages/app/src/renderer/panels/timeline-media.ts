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
  return [
    ...new Set(
      Array.from({ length: count }, (_unused, index) =>
        clamp(
          start + Math.floor(((index + 0.5) * duration) / count),
          start,
          clip.source.out.frames - 1,
        ),
      ),
    ),
  ];
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
  return (
    sorted
      .filter(
        ({ samplesPerPeak }) => samplesPerPeak <= samplesPerPixel * 4,
      )
      .at(-1) ?? sorted[0]!
  );
}

export function waveformColumns(
  peaks: PeaksFile,
  clip: Clip,
  width: number,
): WaveformColumn[] {
  const sourceFps = fpsValue(clip.source.in.fps);
  const startSample = Math.floor(
    (clip.source.in.frames / sourceFps) * peaks.sampleRate,
  );
  const endSample = Math.ceil(
    (clip.source.out.frames / sourceFps) * peaks.sampleRate,
  );
  const samplesPerPixel = Math.max(
    1,
    (endSample - startSample) / Math.max(1, width),
  );
  const tier = selectPeaksTier(peaks, samplesPerPixel);
  const firstPair = Math.max(
    0,
    Math.floor(startSample / tier.samplesPerPeak),
  );
  const lastPair = Math.min(
    tier.data.length / 2,
    Math.ceil(endSample / tier.samplesPerPeak),
  );
  const pairCount = Math.max(0, lastPair - firstPair);
  if (pairCount === 0) return [];
  const count = Math.min(pairCount, Math.max(1, Math.ceil(width / 2)));
  return Array.from({ length: count }, (_unused, column) => {
    const from = firstPair + Math.floor((column * pairCount) / count);
    const to =
      firstPair +
      Math.max(
        Math.floor(((column + 1) * pairCount) / count),
        Math.floor((column * pairCount) / count) + 1,
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
