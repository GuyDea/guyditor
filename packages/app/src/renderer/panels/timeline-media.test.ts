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
