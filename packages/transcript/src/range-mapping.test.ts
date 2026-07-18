import { describe, expect, it } from "vitest";

import { mapWordRangeToSourceRange } from "./range-mapping.js";
import type { TranscriptSidecar } from "./types.js";

function sidecar(): TranscriptSidecar {
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
    segments: [{
      id: "seg_aaaaaaaaaa",
      speaker: "spk_aaaaaaaaaa",
      language: "en",
      start: { samples: 0, rate: 1_000 },
      end: { samples: 1_000, rate: 1_000 },
      words: ["w000001", "w000002", "w000003"],
    }],
    words: {
      w000001: {
        text: "one",
        punctBefore: "",
        punctAfter: "",
        start: { samples: 50, rate: 1_000 },
        end: { samples: 150, rate: 1_000 },
        confidence: 1,
        alignment: "asr",
        state: "active",
        origin: "asr",
      },
      w000002: {
        text: "two",
        punctBefore: "",
        punctAfter: "",
        start: { samples: 300, rate: 1_000 },
        end: { samples: 450, rate: 1_000 },
        confidence: 1,
        alignment: "asr",
        state: "active",
        origin: "asr",
      },
      w000003: {
        text: "three",
        punctBefore: "",
        punctAfter: ".",
        start: { samples: 800, rate: 1_000 },
        end: { samples: 950, rate: 1_000 },
        confidence: 1,
        alignment: "asr",
        state: "active",
        origin: "asr",
      },
    },
  };
}

describe("mapWordRangeToSourceRange", () => {
  it("maps inclusive word IDs to exact canonical sample boundaries", () => {
    const result = mapWordRangeToSourceRange(
      sidecar(),
      { fromWord: "w000002", toWord: "w000003" },
      { paddingMs: 0, snapPolicy: "none" },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        assetId: "ast_aaaaaaaaaa",
        wordRange: { fromWord: "w000002", toWord: "w000003" },
        wordIds: ["w000002", "w000003"],
        start: { samples: 300, rate: 1_000 },
        end: { samples: 950, rate: 1_000 },
        paddingMs: 0,
        snapPolicy: "none",
      },
    });
  });

  it("applies the 120 ms default padding and clamps the leading source edge", () => {
    const first = mapWordRangeToSourceRange(
      sidecar(),
      { fromWord: "w000001", toWord: "w000001" },
    );
    const last = mapWordRangeToSourceRange(
      sidecar(),
      { fromWord: "w000003", toWord: "w000003" },
      {
        sourceDuration: { samples: 1_000, rate: 1_000 },
        snapPolicy: "word-boundary",
      },
    );

    expect(first).toMatchObject({
      ok: true,
      value: {
        start: { samples: 0, rate: 1_000 },
        end: { samples: 270, rate: 1_000 },
        paddingMs: 120,
        snapPolicy: "none",
      },
    });
    expect(last).toMatchObject({
      ok: true,
      value: {
        start: { samples: 680, rate: 1_000 },
        end: { samples: 1_000, rate: 1_000 },
        snapPolicy: "word-boundary",
      },
    });
  });

  it("rejects reversed, missing, and deleted range endpoints", () => {
    const transcript = sidecar();
    transcript.words["w000002"]!.state = "deleted";

    expect(mapWordRangeToSourceRange(
      transcript,
      { fromWord: "w000003", toWord: "w000001" },
    )).toMatchObject({ ok: false, error: { code: "E_TRANSCRIPT_WORD_RANGE" } });
    expect(mapWordRangeToSourceRange(
      transcript,
      { fromWord: "w000001", toWord: "w000099" },
    )).toMatchObject({ ok: false, error: { code: "E_TRANSCRIPT_WORD_RANGE" } });
    expect(mapWordRangeToSourceRange(
      transcript,
      { fromWord: "w000002", toWord: "w000003" },
    )).toMatchObject({ ok: false, error: { code: "E_TRANSCRIPT_WORD_RANGE" } });
  });
});
