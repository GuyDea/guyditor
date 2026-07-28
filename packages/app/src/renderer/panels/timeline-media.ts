import { useEffect, useRef, useState } from "react";

import type { Asset, Clip } from "../../../../core/src/index.js";
import type { PeaksFile, PeaksTier } from "../../../../media/src/index.js";

export const TIMELINE_FRAME_HEIGHT = 96 as const;
export const MAX_TIMELINE_FRAMES = 12;
export const PIXELS_PER_TIMELINE_FRAME = 96;
export const MAX_TIMELINE_MEDIA_CACHE_ENTRIES = 64;

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

export interface TimelineMediaCacheEntry {
  identity: string;
  media: TimelineClipMediaState;
}

export interface TimelineMediaCache {
  projectScope: string;
  entries: Map<string, TimelineMediaCacheEntry>;
}

export interface TimelineMediaResolution {
  identity: string;
  media: TimelineClipMediaState;
  request: TimelineMediaRequest;
}

export interface TimelineMediaRequestPlan {
  clips: Record<string, TimelineClipMediaState>;
  identities: Map<string, string>;
  missing: TimelineMediaRequest[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimelinePeaks(value: unknown, asset: Asset): PeaksFile | null {
  if (
    !isRecord(value) ||
    value["format"] !== "guyditor.peaks/v1" ||
    value["assetId"] !== asset.id ||
    value["sourceHash"] !== asset.sha256 ||
    value["sampleRate"] !== 48_000 ||
    !Array.isArray(value["tiers"])
  ) {
    return null;
  }
  const tiers: PeaksTier[] = [];
  for (const entry of value["tiers"]) {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry["samplesPerPeak"]) ||
      Number(entry["samplesPerPeak"]) <= 0 ||
      !Array.isArray(entry["data"]) ||
      entry["data"].some((sample) =>
        !Number.isInteger(sample) ||
        Number(sample) < -127 ||
        Number(sample) > 127)
    ) {
      return null;
    }
    tiers.push({
      samplesPerPeak: Number(entry["samplesPerPeak"]),
      data: entry["data"].map(Number),
    });
  }
  return {
    format: "guyditor.peaks/v1",
    assetId: asset.id,
    sourceHash: asset.sha256,
    sampleRate: 48_000,
    tiers,
  };
}

function parseTimelineFrames(value: unknown): TimelineFrameResolution[] {
  if (!Array.isArray(value)) return [];
  const frames: TimelineFrameResolution[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const sourceFrame = entry["sourceFrame"];
    const url = entry["url"];
    if (
      !Number.isSafeInteger(sourceFrame) ||
      Number(sourceFrame) < 0 ||
      !(
        url === null ||
        (typeof url === "string" && url.startsWith("file:"))
      )
    ) {
      continue;
    }
    frames.push({ sourceFrame: Number(sourceFrame), url });
  }
  return frames;
}

function mediaCall(
  call: MediaCall,
  method: string,
  params: unknown,
): Promise<unknown> {
  return Promise.resolve().then(() =>
    call("MediaEngine", method, params));
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

function timelineMediaRequestFields(
  projectScope: string,
  { asset, clip, width }: TimelineMediaRequest,
): Record<string, unknown> {
  return {
    projectScope,
    clipId: clip.id,
    asset: {
      id: asset.id,
      kind: asset.kind,
      path: asset.path,
      sourceHash: asset.sha256,
      video: asset.video === undefined ? null : {
        codec: asset.video.codec,
        width: asset.video.width,
        height: asset.video.height,
        fps: asset.video.fps,
        pixFmt: asset.video.pixFmt,
        hasAlpha: asset.video.hasAlpha,
        rotation: asset.video.rotation,
        colorSpace: asset.video.colorSpace ?? null,
        bitrate: asset.video.bitrate ?? null,
      },
      audio: (asset.audio ?? []).map((stream) => ({
        index: stream.index,
        codec: stream.codec,
        sampleRate: stream.sampleRate,
        channels: stream.channels,
        layout: stream.layout,
        bitrate: stream.bitrate ?? null,
      })),
      probe: {
        fps: asset.probe.fps ?? null,
        audio: asset.probe.audio === undefined ? null : {
          rate: asset.probe.audio.rate,
          channels: asset.probe.audio.channels,
        },
      },
    },
    sourceIn: clip.source.in,
    sourceOut: clip.source.out,
    width,
    sourceFrames: representativeSourceFrames(clip, width),
  };
}

export function timelineMediaRequestIdentity(
  projectScope: string,
  request: TimelineMediaRequest,
): string {
  return JSON.stringify(timelineMediaRequestFields(projectScope, request));
}

export function planTimelineMediaRequests(
  projectScope: string,
  requests: readonly TimelineMediaRequest[],
  cache: TimelineMediaCache,
): TimelineMediaRequestPlan {
  const clips: Record<string, TimelineClipMediaState> = {};
  const identities = new Map<string, string>();
  const missing: TimelineMediaRequest[] = [];
  const entries = cache.projectScope === projectScope
    ? cache.entries
    : new Map<string, TimelineMediaCacheEntry>();
  for (const request of requests) {
    const identity = timelineMediaRequestIdentity(projectScope, request);
    const clipId = request.clip.id;
    identities.set(clipId, identity);
    const cached = entries.get(clipId);
    if (cached?.identity === identity) {
      clips[clipId] = cached.media;
    } else {
      missing.push(request);
    }
  }
  return { clips, identities, missing };
}

export function createTimelineMediaCache(
  projectScope: string,
): TimelineMediaCache {
  return { projectScope, entries: new Map() };
}

export function timelineMediaResultIsCacheable(
  request: TimelineMediaRequest,
  media: TimelineClipMediaState,
): boolean {
  const { hasAudio } = timelineAssetMediaSemantics(request.asset);
  if (hasAudio && media.waveform.length === 0) return false;
  if (request.asset.video !== undefined) {
    const requestedFrames = representativeSourceFrames(
      request.clip,
      request.width,
    );
    if (
      media.frameUrls.length !== requestedFrames.length ||
      media.frameUrls.some((url) => url === null)
    ) {
      return false;
    }
  }
  return true;
}

export function mergeTimelineMediaResolutions(
  plan: TimelineMediaRequestPlan,
  resolutions: readonly TimelineMediaResolution[],
): Record<string, TimelineClipMediaState> {
  const clips = { ...plan.clips };
  for (const { identity, media, request } of resolutions) {
    const clipId = request.clip.id;
    if (plan.identities.get(clipId) === identity) {
      clips[clipId] = media;
    }
  }
  return clips;
}

export function updateTimelineMediaCache(
  cache: TimelineMediaCache,
  projectScope: string,
  desiredIdentities: ReadonlyMap<string, string>,
  resolutions: readonly TimelineMediaResolution[],
  maximumEntries = MAX_TIMELINE_MEDIA_CACHE_ENTRIES,
): TimelineMediaCache {
  const entries = cache.projectScope === projectScope
    ? new Map(cache.entries)
    : new Map<string, TimelineMediaCacheEntry>();
  for (const [clipId, identity] of desiredIdentities) {
    const cached = entries.get(clipId);
    if (cached === undefined) continue;
    entries.delete(clipId);
    if (cached.identity === identity) {
      entries.set(clipId, cached);
    }
  }
  for (const resolution of resolutions) {
    const clipId = resolution.request.clip.id;
    if (
      desiredIdentities.get(clipId) !== resolution.identity ||
      !timelineMediaResultIsCacheable(
        resolution.request,
        resolution.media,
      )
    ) {
      continue;
    }
    entries.delete(clipId);
    entries.set(clipId, {
      identity: resolution.identity,
      media: resolution.media,
    });
  }
  while (entries.size > maximumEntries) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return { projectScope, entries };
}

export function timelineMediaProjectScope(
  projectPath: string | undefined,
  projectId: string | undefined,
): string {
  return JSON.stringify([projectPath ?? null, projectId ?? null]);
}

export function timelineMediaRequestKey(
  projectScope: string,
  revision: string,
  sequenceId: string,
  zoom: number,
  requests: readonly TimelineMediaRequest[],
): string {
  return JSON.stringify({
    projectScope,
    revision,
    sequenceId,
    zoom,
    requests: requests.map((request) =>
      timelineMediaRequestFields(projectScope, request)),
  });
}

export function timelineAssetMediaSemantics(
  asset: Asset,
): Pick<TimelineClipMediaState, "hasAudio" | "hasVideo"> {
  return {
    hasAudio: (asset.audio?.length ?? 0) > 0 ||
      asset.probe.audio !== undefined,
    hasVideo: asset.kind === "video" || asset.video !== undefined,
  };
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
    const pending = mediaCall(call, "readPeaks", { assetId: asset.id })
      .then((value) => parseTimelinePeaks(value, asset))
      .catch(() => null);
    peaksByAsset.set(key, pending);
    return pending;
  };

  const entries = await Promise.all(
    requests.map(async ({ asset, clip, width }) => {
      const { hasAudio, hasVideo } = timelineAssetMediaSemantics(asset);
      const sourceFrames = hasVideo
        ? representativeSourceFrames(clip, width)
        : [];
      const framePromise = asset.video === undefined
        ? Promise.resolve([] as TimelineFrameResolution[])
        : mediaCall(call, "resolveTimelineFrames", {
            assetId: asset.id,
            sourceFrames,
            height: TIMELINE_FRAME_HEIGHT,
          })
            .then(parseTimelineFrames)
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
        hasVideo,
        sourceFrames,
        waveform: (() => {
          if (peaks === null) return [];
          try {
            return waveformColumns(peaks, clip, width);
          } catch {
            return [];
          }
        })(),
      }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function useTimelineMedia(
  projectScope: string,
  requests: readonly TimelineMediaRequest[],
  key: string,
): Record<string, TimelineClipMediaState> {
  const cacheRef = useRef(createTimelineMediaCache(projectScope));
  const inFlightRef = useRef(
    new Map<string, Promise<TimelineClipMediaState | undefined>>(),
  );
  const scopeRef = useRef(projectScope);
  scopeRef.current = projectScope;
  const [result, setResult] = useState<TimelineMediaResult>({
    key,
    clips: {},
  });
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const renderPlan = planTimelineMediaRequests(
    projectScope,
    requests,
    cacheRef.current,
  );
  useEffect(() => {
    let current = true;
    if (cacheRef.current.projectScope !== projectScope) {
      cacheRef.current = createTimelineMediaCache(projectScope);
      inFlightRef.current.clear();
    }
    const plan = planTimelineMediaRequests(
      projectScope,
      requestsRef.current,
      cacheRef.current,
    );
    cacheRef.current = updateTimelineMediaCache(
      cacheRef.current,
      projectScope,
      plan.identities,
      [],
    );
    setResult({ key, clips: plan.clips });

    const newRequests = plan.missing.filter((request) =>
      !inFlightRef.current.has(
        plan.identities.get(request.clip.id)!,
      ));
    if (newRequests.length > 0) {
      const batch = loadTimelineMedia(
        newRequests,
        (service, method, params) =>
          window.guyditor.call(service, method, params),
      ).catch((): Record<string, TimelineClipMediaState> => ({}));
      for (const request of newRequests) {
        const identity = plan.identities.get(request.clip.id)!;
        const pending = batch
          .then((clips) => clips[request.clip.id])
          .finally(() => {
            if (inFlightRef.current.get(identity) === pending) {
              inFlightRef.current.delete(identity);
            }
          });
        inFlightRef.current.set(identity, pending);
      }
    }

    const pending = plan.missing.map((request) => {
      const identity = plan.identities.get(request.clip.id)!;
      return inFlightRef.current.get(identity)!.then((media) => ({
        identity,
        media,
        request,
      }));
    });
    void Promise.all(pending).then((entries) => {
      const resolutions = entries.flatMap(({ identity, media, request }) =>
        media === undefined ? [] : [{ identity, media, request }]);
      if (
        scopeRef.current === projectScope &&
        cacheRef.current.projectScope === projectScope
      ) {
        const desired = planTimelineMediaRequests(
          projectScope,
          requestsRef.current,
          cacheRef.current,
        ).identities;
        cacheRef.current = updateTimelineMediaCache(
          cacheRef.current,
          projectScope,
          desired,
          resolutions,
        );
      }
      if (!current) return;
      const currentPlan = planTimelineMediaRequests(
        projectScope,
        requestsRef.current,
        cacheRef.current,
      );
      setResult({
        key,
        clips: mergeTimelineMediaResolutions(
          currentPlan,
          resolutions,
        ),
      });
    });
    return () => {
      current = false;
    };
  }, [key]);
  return result.key === key
    ? currentTimelineMediaResult(result, key)
    : renderPlan.clips;
}
