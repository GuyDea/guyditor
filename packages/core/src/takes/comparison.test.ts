import { describe, expect, it } from "vitest";

import {
  parseTakeComparison,
  serializeTakeComparison,
  takeComparisonSidecarRef,
  validateTakeComparison,
} from "../index.js";
import type { TakeComparison } from "../index.js";

function comparison(): TakeComparison {
  return {
    id: "tkc_aaaaaaaaaa",
    slot: { wordRange: { fromWord: "w000001", toWord: "w000004" } },
    candidates: [
      {
        takeId: "tak_aaaaaaaaaa",
        assetId: "ast_aaaaaaaaaa",
        sourceRange: {
          in: { frames: 0, fps: "24/1" },
          out: { frames: 96, fps: "24/1" },
        },
        transcriptText: "Make your opening specific",
        scriptMatch: { score: 1, deviations: [] },
        delivery: {
          wordsPerMinute: 150,
          fillerCount: 0,
          pauseRatio: 0.18,
          energyVariance: 0.5,
          restartCount: 0,
        },
        technical: {
          audioClippingPct: 0,
          noiseFloorDb: -54,
          focusScore: 0.92,
          exposureScore: 0.86,
          framingScore: 0.9,
        },
        preference: {
          score: 0.88,
          rubricId: "skl_aaaaaaaaaa",
          rubricVersion: "1.2.0",
        },
        markers: { qualityFlags: ["good"], notes: ["clean ending"] },
      },
      {
        takeId: "tak_bbbbbbbbbb",
        assetId: "ast_bbbbbbbbbb",
        sourceRange: {
          in: { frames: 12, fps: "24/1" },
          out: { frames: 120, fps: "24/1" },
        },
        transcriptText: "Make your opening specific",
        scriptMatch: { score: 1, deviations: [] },
        delivery: {
          wordsPerMinute: 132,
          fillerCount: 1,
          pauseRatio: 0.3,
          energyVariance: 2.25,
          restartCount: 1,
        },
        technical: { audioClippingPct: 0.8, noiseFloorDb: -42 },
        preference: {
          score: 0.44,
          rubricId: "skl_aaaaaaaaaa",
          rubricVersion: "1.2.0",
        },
        markers: { qualityFlags: ["unrated"], notes: [] },
      },
    ],
    recommendation: {
      takeId: "tak_aaaaaaaaaa",
      reasons: [{
        criterion: "delivery.pacing",
        detail: "The preferred take is closer to the pinned pacing rule.",
        evidence: "tak_aaaaaaaaaa wordsPerMinute=150; pauseRatio=0.18",
      }],
      confidence: "high",
    },
    createdAt: "2026-07-22T12:00:00.000Z",
  };
}

describe("FR-304 TakeComparison schema", () => {
  it("round-trips the complete comparison and builds its load-bearing sidecar ref", () => {
    const source = comparison();
    const serialized = serializeTakeComparison(source);

    expect(parseTakeComparison(serialized)).toEqual(source);
    expect(validateTakeComparison(source)).toEqual(source);
    expect(takeComparisonSidecarRef(source, {
      ast_aaaaaaaaaa: "a".repeat(64),
      ast_bbbbbbbbbb: "b".repeat(64),
    })).toMatchObject({
      name: "take-comparison-tkc_aaaaaaaaaa",
      path: "sidecars/takes/tkc_aaaaaaaaaa.json",
      schema: "guyditor.take-comparison/v1",
      inputs: [
        { asset: "ast_aaaaaaaaaa", sha256: "a".repeat(64) },
        { asset: "ast_bbbbbbbbbb", sha256: "b".repeat(64) },
      ],
    });
  });

  it("requires inspectable recommendation reasons and retains every candidate", () => {
    const noReason = comparison();
    noReason.recommendation!.reasons = [];
    expect(() => validateTakeComparison(noReason)).toThrow(/reason/i);

    const missingCandidate = comparison();
    missingCandidate.recommendation!.takeId = "tak_cccccccccc";
    expect(() => validateTakeComparison(missingCandidate)).toThrow(/candidate/i);

    const selected = comparison();
    selected.selectedTakeId = "tak_bbbbbbbbbb";
    expect(validateTakeComparison(selected).candidates).toHaveLength(2);
  });
});
