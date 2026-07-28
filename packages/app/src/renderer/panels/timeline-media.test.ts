import { describe, expect, it, vi } from "vitest";

import type { Asset, Clip } from "../../../../core/src/index.js";
import type { PeaksFile } from "../../../../media/src/index.js";
import {
  currentTimelineMediaResult,
  loadTimelineMedia,
  representativeSourceFrames,
  selectPeaksTier,
  timelineMediaRequestKey,
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

describe("timeline media loading", () => {
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
      "rev_00001",
      "seq_aaaaaaaaaa",
      4,
      [],
    );
    const second = timelineMediaRequestKey(
      "rev_00002",
      "seq_aaaaaaaaaa",
      4,
      [],
    );
    expect(currentTimelineMediaResult({ key: first, clips: {} }, second))
      .toEqual({});
  });
});
