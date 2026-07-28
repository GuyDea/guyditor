import { useEffect, useRef, useState } from "react";

import type { Asset, Clip } from "../../../../core/src/index.js";
import type { PeaksFile, PeaksTier } from "../../../../media/src/index.js";

export const TIMELINE_FRAME_HEIGHT = 96 as const;
export const MAX_TIMELINE_FRAMES = 12;
export const PIXELS_PER_TIMELINE_FRAME = 96;

export interface WaveformColumn {
  minimum: number;
  maximum: number;
}

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

  const entries = await Promise.all(
    requests.map(async ({ asset, clip, width }) => {
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
      const peaksPromise = hasAudio
        ? peaksFor(asset)
        : Promise.resolve(null);
      const [resolvedFrames, peaks] = await Promise.all([
        framePromise,
        peaksPromise,
      ]);
      const urls = new Map(
        resolvedFrames.map(({ sourceFrame, url }) =>
          [sourceFrame, url] as const),
      );
      return [clip.id, {
        frameUrls: sourceFrames.map(
          (sourceFrame) => urls.get(sourceFrame) ?? null,
        ),
        hasAudio,
        hasVideo: asset.video !== undefined,
        sourceFrames,
        waveform: peaks === null ? [] : waveformColumns(peaks, clip, width),
      }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function useTimelineMedia(
  requests: readonly TimelineMediaRequest[],
  key: string,
): Record<string, TimelineClipMediaState> {
  const [result, setResult] = useState<TimelineMediaResult>({
    key,
    clips: {},
  });
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  useEffect(() => {
    let current = true;
    setResult({ key, clips: {} });
    void loadTimelineMedia(
      requestsRef.current,
      (service, method, params) =>
        window.guyditor.call(service, method, params),
    ).then((clips) => {
      if (current) setResult({ key, clips });
    });
    return () => {
      current = false;
    };
  }, [key]);
  return currentTimelineMediaResult(result, key);
}
