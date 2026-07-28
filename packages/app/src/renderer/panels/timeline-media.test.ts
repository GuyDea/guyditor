import { describe, expect, it, vi } from "vitest";

import type { Asset, Clip } from "../../../../core/src/index.js";
import type { PeaksFile } from "../../../../media/src/index.js";
import {
  createTimelineMediaCache,
  currentTimelineMediaResult,
  loadTimelineMedia,
  MAX_TIMELINE_MEDIA_CACHE_ENTRIES,
  mergeTimelineMediaResolutions,
  planTimelineMediaRequests,
  representativeSourceFrames,
  selectPeaksTier,
  timelineMediaResultIsCacheable,
  timelineMediaRequestIdentity,
  timelineMediaRequestKey,
  type TimelineMediaCache,
  type TimelineClipMediaState,
  type TimelineMediaRequest,
  type TimelineMediaResolution,
  updateTimelineMediaCache,
  waveformColumns,
} from "./timeline-media.js";

const PROJECT_SCOPE = '["/projects/alpha","prj_aaaaaaaaaa"]';
const OTHER_PROJECT_SCOPE = '["/projects/beta","prj_bbbbbbbbbb"]';

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

function videoWithAudio(): Asset {
  return {
    id: "ast_aaaaaaaaaa",
    kind: "video",
    path: "media/a.mp4",
    sha256: "a".repeat(64),
    probe: { duration: { frames: 240, fps: "24/1" }, fps: "24/1" },
    video: {
      codec: "h264",
      width: 1920,
      height: 1080,
      fps: "24/1",
      pixFmt: "yuv420p",
      hasAlpha: false,
      rotation: 0,
    },
    audio: [{
      index: 0,
      codec: "aac",
      sampleRate: 48_000,
      channels: 1,
      layout: "mono",
    }],
  };
}

function mediaRequest(
  clipId: string,
  sourceIn: number,
  sourceOut: number,
  width = 96,
): TimelineMediaRequest {
  const asset = videoWithAudio();
  return {
    asset,
    clip: {
      id: clipId,
      asset: asset.id,
      source: {
        in: { frames: sourceIn, fps: "24/1" },
        out: { frames: sourceOut, fps: "24/1" },
      },
    },
    width,
  };
}

function mediaState(sourceFrame: number): TimelineClipMediaState {
  return {
    frameUrls: [`file:///cache/${String(sourceFrame)}.jpg`],
    hasAudio: true,
    hasVideo: true,
    sourceFrames: [sourceFrame],
    waveform: [{ minimum: -48, maximum: 48 }],
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

describe("timeline media request planning", () => {
  const first = mediaRequest("clp_aaaaaaaaaa", 0, 24);
  const second = mediaRequest("clp_bbbbbbbbbb", 24, 48);
  const third = mediaRequest("clp_cccccccccc", 48, 72);
  const firstMedia = mediaState(12);
  const secondMedia = mediaState(36);
  const thirdMedia = mediaState(60);
  const mediaCache = (
    projectScope = PROJECT_SCOPE,
  ): TimelineMediaCache => ({
    projectScope,
    entries: new Map([
      [first.clip.id, {
        identity: timelineMediaRequestIdentity(PROJECT_SCOPE, first),
        media: firstMedia,
      }],
      [second.clip.id, {
        identity: timelineMediaRequestIdentity(PROJECT_SCOPE, second),
        media: secondMedia,
      }],
      [third.clip.id, {
        identity: timelineMediaRequestIdentity(PROJECT_SCOPE, third),
        media: thirdMedia,
      }],
    ]),
  });

  it("retains overlapping media and returns only added requests as missing", () => {
    const cache = mediaCache();
    cache.entries.delete(third.clip.id);
    const plan = planTimelineMediaRequests(
      PROJECT_SCOPE,
      [first, second, third],
      cache,
    );

    expect(plan.clips).toEqual({
      [first.clip.id]: firstMedia,
      [second.clip.id]: secondMedia,
    });
    expect(plan.missing.map(({ clip }) => clip.id)).toEqual([third.clip.id]);
  });

  it("returns a clip with changed media identity as missing", () => {
    const cache = mediaCache();
    const changedSecond = { ...second, width: 192 };
    const plan = planTimelineMediaRequests(
      PROJECT_SCOPE,
      [first, changedSecond],
      cache,
    );

    expect(plan.clips).toEqual({ [first.clip.id]: firstMedia });
    expect(plan.missing.map(({ clip }) => clip.id)).toEqual([second.clip.id]);
  });

  it("includes cached media only for currently requested clips", () => {
    const plan = planTimelineMediaRequests(
      PROJECT_SCOPE,
      [second],
      mediaCache(),
    );

    expect(plan.clips).toEqual({ [second.clip.id]: secondMedia });
    expect(plan.missing).toEqual([]);
    expect([...plan.identities.keys()]).toEqual([second.clip.id]);
  });

  it("invalidates identities when media capabilities or metadata change", () => {
    const originalIdentity = timelineMediaRequestIdentity(
      PROJECT_SCOPE,
      first,
    );
    const variants: Asset[] = [
      { ...first.asset, kind: "image" },
      { ...first.asset, path: "media/relinked.mp4" },
      {
        ...first.asset,
        video: { ...first.asset.video!, fps: "30/1" },
      },
      { ...first.asset, audio: [] },
      {
        ...first.asset,
        probe: { ...first.asset.probe, fps: "30/1" },
      },
      {
        ...first.asset,
        probe: {
          ...first.asset.probe,
          audio: { rate: 44_100, channels: 2 },
        },
      },
    ];

    for (const asset of variants) {
      expect(timelineMediaRequestIdentity(
        PROJECT_SCOPE,
        { ...first, asset },
      )).not.toBe(originalIdentity);
    }
  });

  it("canonicalizes probe audio metadata independent of property order", () => {
    const rateFirst = {
      ...first,
      asset: {
        ...first.asset,
        probe: {
          ...first.asset.probe,
          audio: { rate: 48_000, channels: 2 },
        },
      },
    };
    const channelsFirst = {
      ...first,
      asset: {
        ...first.asset,
        probe: {
          ...first.asset.probe,
          audio: { channels: 2, rate: 48_000 },
        },
      },
    };

    expect(timelineMediaRequestIdentity(PROJECT_SCOPE, rateFirst))
      .toBe(timelineMediaRequestIdentity(PROJECT_SCOPE, channelsFirst));
  });

  it("invalidates and clears cached media across project scopes", () => {
    const cache = mediaCache();
    const plan = planTimelineMediaRequests(
      OTHER_PROJECT_SCOPE,
      [first],
      cache,
    );

    expect(plan.clips).toEqual({});
    expect(plan.missing.map(({ clip }) => clip.id)).toEqual([first.clip.id]);
    const reset = updateTimelineMediaCache(
      cache,
      OTHER_PROJECT_SCOPE,
      plan.identities,
      [],
    );
    expect(reset.projectScope).toBe(OTHER_PROJECT_SCOPE);
    expect(reset.entries.size).toBe(0);
  });

  it("renders degraded results but leaves them retryable", () => {
    const cache = createTimelineMediaCache(PROJECT_SCOPE);
    const plan = planTimelineMediaRequests(
      PROJECT_SCOPE,
      [first],
      cache,
    );
    const degraded = {
      ...firstMedia,
      frameUrls: [null],
      waveform: [],
    };
    const resolution: TimelineMediaResolution = {
      identity: plan.identities.get(first.clip.id)!,
      media: degraded,
      request: first,
    };

    expect(mergeTimelineMediaResolutions(plan, [resolution])).toEqual({
      [first.clip.id]: degraded,
    });
    const updated = updateTimelineMediaCache(
      cache,
      PROJECT_SCOPE,
      plan.identities,
      [resolution],
    );
    expect(updated.entries.size).toBe(0);
    expect(planTimelineMediaRequests(
      PROJECT_SCOPE,
      [first],
      updated,
    ).missing.map(({ clip }) => clip.id)).toEqual([first.clip.id]);
  });

  it("requires every requested audio and rich-video component before caching", () => {
    expect(timelineMediaResultIsCacheable(first, firstMedia)).toBe(true);
    expect(timelineMediaResultIsCacheable(first, {
      ...firstMedia,
      waveform: [],
    })).toBe(false);
    expect(timelineMediaResultIsCacheable(first, {
      ...firstMedia,
      frameUrls: [null],
    })).toBe(false);

    const probeOnlyAsset: Asset = {
      ...first.asset,
      probe: {
        ...first.asset.probe,
        audio: { rate: 48_000, channels: 1 },
      },
    };
    delete probeOnlyAsset.video;
    delete probeOnlyAsset.audio;
    const probeOnly: TimelineMediaRequest = {
      ...first,
      asset: probeOnlyAsset,
    };
    expect(timelineMediaResultIsCacheable(probeOnly, {
      ...firstMedia,
      frameUrls: [null],
    })).toBe(true);
  });

  it("bounds LRU retention and ignores late offscreen resolutions", () => {
    const requests = Array.from(
      { length: MAX_TIMELINE_MEDIA_CACHE_ENTRIES + 1 },
      (_unused, index) => mediaRequest(
        `clp_${String(index).padStart(10, "0")}`,
        index * 24,
        (index + 1) * 24,
      ),
    );
    let cache = createTimelineMediaCache(PROJECT_SCOPE);
    const initial = planTimelineMediaRequests(
      PROJECT_SCOPE,
      requests.slice(0, MAX_TIMELINE_MEDIA_CACHE_ENTRIES),
      cache,
    );
    cache = updateTimelineMediaCache(
      cache,
      PROJECT_SCOPE,
      initial.identities,
      requests.slice(0, MAX_TIMELINE_MEDIA_CACHE_ENTRIES).map(
        (request, index): TimelineMediaResolution => ({
          identity: initial.identities.get(request.clip.id)!,
          media: mediaState(index * 24 + 12),
          request,
        }),
      ),
    );

    const last = requests.at(-1)!;
    const lastPlan = planTimelineMediaRequests(
      PROJECT_SCOPE,
      [last],
      cache,
    );
    cache = updateTimelineMediaCache(
      cache,
      PROJECT_SCOPE,
      lastPlan.identities,
      [{
        identity: lastPlan.identities.get(last.clip.id)!,
        media: mediaState(MAX_TIMELINE_MEDIA_CACHE_ENTRIES * 24 + 12),
        request: last,
      }],
    );
    expect(cache.entries.size).toBe(MAX_TIMELINE_MEDIA_CACHE_ENTRIES);
    expect(cache.entries.has(requests[0]!.clip.id)).toBe(false);
    expect(cache.entries.has(last.clip.id)).toBe(true);

    const late = requests[0]!;
    cache = updateTimelineMediaCache(
      cache,
      PROJECT_SCOPE,
      lastPlan.identities,
      [{
        identity: timelineMediaRequestIdentity(PROJECT_SCOPE, late),
        media: mediaState(12),
        request: late,
      }],
    );
    expect(cache.entries.has(late.clip.id)).toBe(false);
    expect([...lastPlan.identities.keys()]).toEqual([last.clip.id]);
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

describe("timeline media loading", () => {
  it("uses kind and probe metadata for slots and waveform loading", async () => {
    const asset: Asset = {
      id: "ast_aaaaaaaaaa",
      kind: "video",
      path: "media/a.mp4",
      sha256: "a".repeat(64),
      probe: {
        duration: { frames: 240, fps: "24/1" },
        fps: "24/1",
        audio: { rate: 48_000, channels: 1 },
      },
    };
    const call = vi.fn(async (_service: string, method: string) =>
      method === "readPeaks" ? peaks() : []);

    const result = await loadTimelineMedia(
      [{ asset, clip: clip(), width: 192 }],
      call,
    );

    expect(result["clp_aaaaaaaaaa"]).toMatchObject({
      frameUrls: [null, null],
      hasAudio: true,
      hasVideo: true,
      sourceFrames: [150, 210],
    });
    expect(call.mock.calls.filter(([, method]) => method === "readPeaks"))
      .toHaveLength(1);
    expect(call.mock.calls.filter(([, method]) =>
      method === "resolveTimelineFrames"))
      .toHaveLength(0);
  });

  it("loads peaks once per asset and frames for each visible clip", async () => {
    const asset = videoWithAudio();
    const clips = [clip(0, 24), { ...clip(24, 48), id: "clp_bbbbbbbbbb" }];
    const call = vi.fn(async (
      _service: string,
      method: string,
      params: unknown,
    ) => {
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

    expect(
      call.mock.calls.filter(([, method]) => method === "readPeaks"),
    ).toHaveLength(1);
    expect(
      call.mock.calls.filter(
        ([, method]) => method === "resolveTimelineFrames",
      ),
    ).toHaveLength(2);
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

  it("retains filmstrip data when a successful peaks response is malformed", async () => {
    const asset = videoWithAudio();
    const call = vi.fn(async (
      _service: string,
      method: string,
      params: unknown,
    ) => {
      if (method === "readPeaks") return {};
      const sourceFrames = (params as { sourceFrames: number[] }).sourceFrames;
      return [...sourceFrames].reverse().map((sourceFrame) => ({
        sourceFrame,
        url: `file:///cache/${String(sourceFrame)}.jpg`,
      }));
    });

    const result = await loadTimelineMedia(
      [{ asset, clip: clip(), width: 192 }],
      call,
    );

    expect(result["clp_aaaaaaaaaa"]).toMatchObject({
      frameUrls: [
        "file:///cache/150.jpg",
        "file:///cache/210.jpg",
      ],
      hasAudio: true,
      hasVideo: true,
      waveform: [],
    });
  });

  it("sanitizes partial frame responses while retaining valid waveform data", async () => {
    const asset = videoWithAudio();
    const rangedClip = clip(0, 24);
    const call = vi.fn(async (_service: string, method: string) => {
      if (method === "readPeaks") return peaks();
      return [
        { sourceFrame: 18, url: "file:///cache/18.jpg" },
        { sourceFrame: 6, url: "https://example.com/6.jpg" },
        { sourceFrame: -1, url: "file:///cache/invalid.jpg" },
        { sourceFrame: 6, url: 42 },
        null,
      ];
    });

    const result = await loadTimelineMedia(
      [{ asset, clip: rangedClip, width: 192 }],
      call,
    );

    expect(result["clp_aaaaaaaaaa"]).toMatchObject({
      frameUrls: [null, "file:///cache/18.jpg"],
      hasAudio: true,
      hasVideo: true,
      waveform: waveformColumns(peaks(), rangedClip, 192),
    });
  });

  it("degrades synchronous media call failures", async () => {
    const asset = videoWithAudio();
    const result = await loadTimelineMedia(
      [{ asset, clip: clip(), width: 192 }],
      () => {
        throw new Error("offline");
      },
    );

    expect(result["clp_aaaaaaaaaa"]).toMatchObject({
      frameUrls: [null, null],
      hasAudio: true,
      hasVideo: true,
      waveform: [],
    });
  });

  it("rejects late results with a different timeline request key", () => {
    const first = timelineMediaRequestKey(
      PROJECT_SCOPE,
      "rev_00001",
      "seq_aaaaaaaaaa",
      4,
      [],
    );
    const second = timelineMediaRequestKey(
      PROJECT_SCOPE,
      "rev_00002",
      "seq_aaaaaaaaaa",
      4,
      [],
    );
    expect(currentTimelineMediaResult({ key: first, clips: {} }, second))
      .toEqual({});
  });
});
