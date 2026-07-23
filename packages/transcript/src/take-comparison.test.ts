import { describe, expect, it } from "vitest";

import type { TakeRecord } from "../../core/src/index.js";
import {
  extractTakeTranscript,
  groupTakeTranscripts,
} from "./index.js";
import type { TranscriptSidecar } from "./index.js";

function transcript(): TranscriptSidecar {
  return {
    schema: "guyditor.transcript/v1",
    assetId: "ast_aaaaaaaaaa",
    audio: { rate: 48_000, channels: 1, streamIndex: 0 },
    language: "en",
    languageProbability: 1,
    provenance: {
      engine: { name: "synthetic", version: "1", model: "fixture" },
      alignment: null,
      createdAt: "2026-07-22T12:00:00.000Z",
      jobId: "job_aaaaaaaaaa",
    },
    speakers: [{ id: "spk_aaaaaaaaaa", label: "Creator" }],
    segments: [{
      id: "seg_aaaaaaaaaa",
      speaker: "spk_aaaaaaaaaa",
      language: "en",
      start: { samples: 0, rate: 48_000 },
      end: { samples: 192_000, rate: 48_000 },
      words: ["w000001", "w000002", "w000003", "w000004"],
    }],
    words: {
      w000001: { text: "Make", punctBefore: "", punctAfter: "", start: { samples: 0, rate: 48_000 }, end: { samples: 24_000, rate: 48_000 }, confidence: 1, alignment: "asr", state: "active", origin: "asr" },
      w000002: { text: "your", punctBefore: "", punctAfter: "", start: { samples: 24_000, rate: 48_000 }, end: { samples: 48_000, rate: 48_000 }, confidence: 1, alignment: "asr", state: "active", origin: "asr" },
      w000003: { text: "opening", punctBefore: "", punctAfter: "", start: { samples: 96_000, rate: 48_000 }, end: { samples: 120_000, rate: 48_000 }, confidence: 1, alignment: "asr", state: "active", origin: "asr" },
      w000004: { text: "specific", punctBefore: "", punctAfter: ".", start: { samples: 120_000, rate: 48_000 }, end: { samples: 144_000, rate: 48_000 }, confidence: 1, alignment: "asr", state: "active", origin: "asr" },
    },
  };
}

describe("FR-304 take transcript grouping", () => {
  it("extracts the exact transcript and word evidence inside a take's frame range", () => {
    const take: TakeRecord = {
      id: "tak_aaaaaaaaaa",
      assetId: "ast_aaaaaaaaaa",
      index: 1,
      range: { start: 0, end: 24, fps: "24/1" },
      quality: "unrated",
      notes: [],
      sourceMarkerIds: [],
    };

    expect(extractTakeTranscript(take, transcript())).toEqual({
      takeId: "tak_aaaaaaaaaa",
      transcriptText: "Make your",
      wordRange: { from: "w000001", to: "w000002" },
      wordCount: 2,
    });
  });

  it("groups normalized matching content and leaves a different line separate", () => {
    const groups = groupTakeTranscripts([
      { takeId: "tak_cccccccccc", transcriptText: "A completely different closing line." },
      { takeId: "tak_bbbbbbbbbb", transcriptText: "Make your opening specific" },
      { takeId: "tak_aaaaaaaaaa", transcriptText: "Make your opening specific!" },
    ]);

    expect(groups).toEqual([
      {
        leadTakeId: "tak_aaaaaaaaaa",
        candidates: [
          { takeId: "tak_aaaaaaaaaa", transcriptText: "Make your opening specific!", similarityToLead: 1 },
          { takeId: "tak_bbbbbbbbbb", transcriptText: "Make your opening specific", similarityToLead: 1 },
        ],
      },
      {
        leadTakeId: "tak_cccccccccc",
        candidates: [{
          takeId: "tak_cccccccccc",
          transcriptText: "A completely different closing line.",
          similarityToLead: 1,
        }],
      },
    ]);
  });
});
