import { describe, expect, it } from "vitest";

import { deriveTakeMetrics } from "./index.js";

describe("FR-304 take delivery and technical metrics", () => {
  it("derives the specified metric set deterministically from measured signals", () => {
    const first = deriveTakeMetrics({
      durationSeconds: 12,
      wordCount: 30,
      fillerCount: 2,
      silenceSeconds: 2.4,
      loudnessLufs: [-18, -16, -17, -17],
      restartCount: 1,
      technical: {
        audioClippingPct: 0.25,
        noiseFloorDb: -54,
        focusScore: 0.92,
        exposureScore: 0.84,
        framingScore: 0.9,
      },
    });

    expect(first).toEqual({
      delivery: {
        wordsPerMinute: 150,
        fillerCount: 2,
        pauseRatio: 0.2,
        energyVariance: 0.5,
        restartCount: 1,
      },
      technical: {
        audioClippingPct: 0.25,
        noiseFloorDb: -54,
        focusScore: 0.92,
        exposureScore: 0.84,
        framingScore: 0.9,
      },
    });
    expect(deriveTakeMetrics({
      durationSeconds: 12,
      wordCount: 30,
      fillerCount: 2,
      silenceSeconds: 2.4,
      loudnessLufs: [-18, -16, -17, -17],
      restartCount: 1,
      technical: first.technical,
    })).toEqual(first);
  });

  it("rejects missing or non-finite analysis rather than inventing metrics", () => {
    expect(() => deriveTakeMetrics({
      durationSeconds: 0,
      wordCount: 3,
      fillerCount: 0,
      silenceSeconds: 0,
      loudnessLufs: [],
      restartCount: 0,
      technical: { audioClippingPct: 0, noiseFloorDb: -60 },
    })).toThrow(/duration/i);
  });
});
