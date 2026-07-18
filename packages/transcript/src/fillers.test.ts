import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILLER_RULE_SET,
  detectFillerCandidates,
} from "./fillers.js";
import type { TranscriptSidecar } from "./types.js";

function word(
  text: string,
  start: number,
  end: number,
  confidence = 1,
  punctAfter = "",
) {
  return {
    text,
    punctBefore: "",
    punctAfter,
    start: { samples: start, rate: 1_000 },
    end: { samples: end, rate: 1_000 },
    confidence,
    alignment: "asr" as const,
    state: "active" as const,
    origin: "asr" as const,
  };
}

function transcript(): TranscriptSidecar {
  const firstWords = [
    "w000001", "w000002", "w000003", "w000004", "w000005", "w000006",
    "w000007", "w000008", "w000009", "w000010", "w000011",
  ];
  const secondWords = ["w000012", "w000013", "w000014"];
  return {
    schema: "guyditor.transcript/v1",
    assetId: "ast_aaaaaaaaaa",
    audio: { rate: 1_000, channels: 1, streamIndex: 0 },
    language: "en",
    languageProbability: 1,
    provenance: {
      engine: { name: "test", version: "1", model: "fixture" },
      alignment: null,
      createdAt: "2026-07-19T00:00:00Z",
      jobId: "job_aaaaaaaaaa",
    },
    speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker" }],
    segments: [
      {
        id: "seg_aaaaaaaaaa",
        speaker: "spk_aaaaaaaaaa",
        language: "en",
        start: { samples: 0, rate: 1_000 },
        end: { samples: 8_000, rate: 1_000 },
        words: firstWords,
      },
      {
        id: "seg_bbbbbbbbbb",
        speaker: "spk_aaaaaaaaaa",
        language: "en",
        start: { samples: 8_300, rate: 1_000 },
        end: { samples: 10_000, rate: 1_000 },
        words: secondWords,
      },
    ],
    words: {
      w000001: word("um", 100, 250),
      w000002: word("like", 400, 550),
      w000003: word("this", 800, 1_000),
      w000004: word("is", 1_100, 1_250),
      w000005: word("really", 1_350, 1_650),
      w000006: word("useful", 1_750, 2_050),
      w000007: word("this", 3_000, 3_200),
      w000008: word("is", 3_300, 3_450),
      w000009: word("really", 3_550, 3_850),
      w000010: word("we", 7_300, 7_450),
      w000011: word("should", 7_550, 7_800),
      w000012: word("we", 8_300, 8_450),
      w000013: word("should", 8_550, 8_800),
      w000014: word("leave", 8_900, 9_300, 1, "."),
    },
  };
}

describe("pause and filler detection", () => {
  it("applies pause thresholds, sentence-boundary protection, and retainMs", async () => {
    const sidecar = transcript();
    sidecar.words["w000009"]!.punctAfter = ".\"";
    const result = await detectFillerCandidates({
      sidecar,
      vad: [
        { start: { samples: 2_100, rate: 1_000 }, end: { samples: 2_900, rate: 1_000 }, kind: "silence", rmsDb: -80 },
        { start: { samples: 4_000, rate: 1_000 }, end: { samples: 5_000, rate: 1_000 }, kind: "silence", rmsDb: -80 },
        { start: { samples: 5_500, rate: 1_000 }, end: { samples: 6_800, rate: 1_000 }, kind: "silence", rmsDb: -80 },
      ],
      rules: DEFAULT_FILLER_RULE_SET,
    });

    const pauses = result.candidates.filter(({ kind }) => kind === "pause");
    expect(pauses).toHaveLength(2);
    expect(pauses[0]).toMatchObject({
      sourceRange: {
        start: { samples: 2_200, rate: 1_000 },
        end: { samples: 2_800, rate: 1_000 },
      },
      rule: "pauses.minRemovableMs",
      defaultSelected: true,
    });
    expect(pauses[1]).toMatchObject({
      sourceRange: {
        start: { samples: 5_600, rate: 1_000 },
        end: { samples: 6_700, rate: 1_000 },
      },
      rule: "pauses.keepAtSentenceBoundaryMs",
    });
  });

  it("detects remove/review lexicon entries, 8-word-window repeats, and false starts", async () => {
    const result = await detectFillerCandidates({
      sidecar: transcript(),
      vad: [{
        start: { samples: 7_800, rate: 1_000 },
        end: { samples: 8_300, rate: 1_000 },
        kind: "silence",
        rmsDb: -70,
      }],
      rules: DEFAULT_FILLER_RULE_SET,
    });

    expect(result.candidates).toContainEqual(expect.objectContaining({
      kind: "filler",
      wordRange: { fromWord: "w000001", toWord: "w000001" },
      rule: "fillers.remove:um",
      defaultSelected: true,
    }));
    expect(result.candidates).toContainEqual(expect.objectContaining({
      kind: "filler",
      wordRange: { fromWord: "w000002", toWord: "w000002" },
      rule: "fillers.review:like",
      defaultSelected: false,
    }));
    expect(result.candidates).toContainEqual(expect.objectContaining({
      kind: "repeat",
      wordRange: { fromWord: "w000003", toWord: "w000005" },
      rule: "repeats.verbatim-3gram-within-15s",
      defaultSelected: false,
    }));
    expect(result.candidates).toContainEqual(expect.objectContaining({
      kind: "false-start",
      wordRange: { fromWord: "w000010", toWord: "w000011" },
      rule: "falseStarts.trailing-leading-match",
      defaultSelected: false,
    }));
  });

  it("drops protected candidates and disables defaults in over-dense 60 second windows", async () => {
    const rules = structuredClone(DEFAULT_FILLER_RULE_SET);
    rules.limits.maxDensityPerMinute = 1;
    const result = await detectFillerCandidates({
      sidecar: transcript(),
      vad: [],
      rules,
      protectedRanges: [{
        assetId: "ast_aaaaaaaaaa",
        start: { samples: 50, rate: 1_000 },
        end: { samples: 300, rate: 1_000 },
        reason: "open annotation ann_aaaaaaaaaa",
      }],
    });

    expect(result.candidates.some(({ wordRange }) =>
      wordRange?.fromWord === "w000001")).toBe(false);
    expect(result.reviewWindows).toHaveLength(1);
    expect(result.candidates.every(({ defaultSelected, reviewRequired }) =>
      !defaultSelected && reviewRequired === true)).toBe(true);
  });

  it("protects the full adjacent VAD pause when a beat marks its boundary", async () => {
    const result = await detectFillerCandidates({
      sidecar: transcript(),
      vad: [{
        start: { samples: 2_100, rate: 1_000 },
        end: { samples: 2_900, rate: 1_000 },
        kind: "silence",
        rmsDb: -80,
      }],
      rules: DEFAULT_FILLER_RULE_SET,
      protectedRanges: [{
        assetId: "ast_aaaaaaaaaa",
        start: { samples: 2_099, rate: 1_000 },
        end: { samples: 2_101, rate: 1_000 },
        reason: "protected beat beat_aaaaaaaaaa",
      }],
    });

    expect(result.candidates.some(({ kind }) => kind === "pause")).toBe(false);
  });
});
