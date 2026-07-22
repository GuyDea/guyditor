import { describe, expect, it } from "vitest";

import type {
  ResolvedSkill,
  TakeComparisonInput,
} from "./index.js";
import {
  buildTakeComparison,
  takePreferenceRubric,
} from "./index.js";

function skill(input: {
  category: "pacing" | "pauses_fillers";
  text: string;
}): ResolvedSkill {
  return {
    manifest: {
      id: input.category === "pacing" ? "skl_aaaaaaaaaa" : "skl_bbbbbbbbbb",
      name: input.category,
      version: "1.2.0",
      title: input.category,
      categories: [input.category],
      summary: input.text,
      rules: [{ id: `rule-${input.category}`, category: input.category, strength: "must", text: input.text }],
      examples: { approved: [], rejected: [] },
      contentHash: "a".repeat(64),
    },
    body: input.text,
    presetReferences: [],
  };
}

function input(): Omit<TakeComparisonInput, "rubric"> {
  return {
    comparisonId: "tkc_aaaaaaaaaa",
    createdAt: "2026-07-22T12:00:00.000Z",
    slot: { wordRange: { fromWord: "w000001", toWord: "w000004" } },
    candidates: [
      {
        take: {
          id: "tak_aaaaaaaaaa",
          assetId: "ast_aaaaaaaaaa",
          index: 1,
          range: { start: 0, end: 96, fps: "24/1" },
          quality: "good",
          notes: ["energetic"],
          sourceMarkerIds: [],
        },
        transcript: {
          takeId: "tak_aaaaaaaaaa",
          transcriptText: "Make your opening specific",
          wordRange: { from: "w000001", to: "w000004" },
          wordCount: 4,
          similarityToLead: 1,
        },
        delivery: {
          wordsPerMinute: 184,
          fillerCount: 3,
          pauseRatio: 0.34,
          energyVariance: 1.4,
          restartCount: 1,
        },
        technical: { audioClippingPct: 0.1, noiseFloorDb: -54 },
      },
      {
        take: {
          id: "tak_bbbbbbbbbb",
          assetId: "ast_bbbbbbbbbb",
          index: 2,
          range: { start: 10, end: 130, fps: "30/1" },
          quality: "good",
          notes: ["clean"],
          sourceMarkerIds: [],
        },
        transcript: {
          takeId: "tak_bbbbbbbbbb",
          transcriptText: "Make your opening specific",
          wordRange: { from: "w000101", to: "w000104" },
          wordCount: 4,
          similarityToLead: 1,
        },
        delivery: {
          wordsPerMinute: 145,
          fillerCount: 0,
          pauseRatio: 0.12,
          energyVariance: 0.4,
          restartCount: 0,
        },
        technical: { audioClippingPct: 0.1, noiseFloorDb: -54 },
      },
    ],
  };
}

describe("FR-304 deterministic take recommendation", () => {
  it("changes the recommendation when pinned creator-preference weighting changes", () => {
    const pacing = takePreferenceRubric([skill({
      category: "pacing",
      text: "Must deliver hooks at 175-190 words per minute.",
    })]);
    const cleanDelivery = takePreferenceRubric([skill({
      category: "pauses_fillers",
      text: "Must avoid fillers and long silence in final delivery.",
    })]);

    const fast = buildTakeComparison({ ...input(), rubric: pacing });
    const clean = buildTakeComparison({ ...input(), rubric: cleanDelivery });

    expect(fast.recommendation).toMatchObject({
      takeId: "tak_aaaaaaaaaa",
      reasons: expect.arrayContaining([
        expect.objectContaining({ criterion: "creator_preference" }),
      ]),
    });
    expect(clean.recommendation?.takeId).toBe("tak_bbbbbbbbbb");
    expect(fast.candidates.map(({ takeId }) => takeId)).toEqual([
      "tak_aaaaaaaaaa",
      "tak_bbbbbbbbbb",
    ]);
  });

  it("is byte-deterministic for identical metrics and exposes per-take evidence", () => {
    const rubric = takePreferenceRubric([skill({
      category: "pauses_fillers",
      text: "Prefer clean delivery with few fillers.",
    })]);

    const first = buildTakeComparison({ ...input(), rubric });
    const second = buildTakeComparison({ ...input(), rubric });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.candidates[0]).toMatchObject({
      sourceRange: { in: { frames: 0 }, out: { frames: 96 } },
      transcriptText: "Make your opening specific",
      preference: { rubricId: "skl_bbbbbbbbbb" },
      markers: { qualityFlags: ["good"] },
    });
    expect(first.recommendation?.reasons.every(({ evidence }) => evidence.length > 0)).toBe(true);
  });
});
