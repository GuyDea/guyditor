import { describe, expect, it } from "vitest";

import type { CaptionTrack } from "../../../core/src/index.js";
import type { TranscriptSidecar } from "../types.js";
import {
  DEFAULT_CAPTION_STYLE,
  compileDerivativeCaptionTrack,
} from "./index.js";

const track: CaptionTrack = {
  id: "cts_aaaaaaaaaa",
  name: "Derivative captions",
  sourceLayerIds: ["lyr_aaaaaaaaaa"],
  preset: { presetId: "pre_aaaaaaaaaa", version: 1 },
  styleOverrides: { sizePct: 4.8, weight: 800 },
  breakOverrides: [],
  emphasisOverrides: [],
  timingOffsets: [],
  enabled: true,
};

const sidecar: TranscriptSidecar = {
  schema: "guyditor.transcript/v1",
  assetId: "ast_aaaaaaaaaa",
  audio: { streamIndex: 0, rate: 48_000, channels: 1 },
  language: "en",
  languageProbability: 1,
  speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker" }],
  segments: [{
    id: "seg_aaaaaaaaaa",
    start: { samples: 0, rate: 48_000 },
    end: { samples: 192_000, rate: 48_000 },
    speaker: "spk_aaaaaaaaaa",
    language: null,
    words: ["w000001", "w000002", "w000003", "w000004"],
  }],
  words: Object.fromEntries([
    ["w000001", "Canonical"],
    ["w000002", "timing"],
    ["w000003", "stays"],
    ["w000004", "exact"],
  ].map(([id, text], index) => [id, {
    text,
    punctBefore: "",
    punctAfter: index === 3 ? "." : "",
    start: { samples: index * 48_000, rate: 48_000 },
    end: { samples: index * 48_000 + 36_000, rate: 48_000 },
    confidence: 1,
    state: "active" as const,
    origin: "asr" as const,
    alignment: "asr" as const,
  }])),
  provenance: {
    jobId: "job_aaaaaaaaaa",
    createdAt: "2026-07-22T10:00:00.000Z",
    engine: { name: "fixture", version: "1", model: "fixture" },
    alignment: null,
  },
};

describe("short-form derivative captions", () => {
  it("reuses canonical word instances and relays out inside the profile title-safe area", () => {
    const model = compileDerivativeCaptionTrack({
      track,
      timeline: {
        sequenceId: "seq_aaaaaaaaaa",
        instances: ["w000001", "w000002", "w000003", "w000004"].map((wordId, index) => ({
          wordId,
          clipId: "clp_aaaaaaaaaa",
          layerId: "lyr_aaaaaaaaaa",
          start: { num: index, den: 1 },
          end: { num: index * 4 + 3, den: 4 },
          truncated: false,
        })),
        diagnostics: { clippedWords: [], ambiguousRanges: [], orphanedAnchors: [] },
      },
      sidecars: [sidecar],
      presetStyle: DEFAULT_CAPTION_STYLE,
      profile: {
        video: { resolution: { width: 1080, height: 1920 }, fps: { default: "30/1" } },
        safeAreas: { title: { top: 0.06, bottom: 0.26, left: 0.05, right: 0.16 } },
        captionDefaults: {
          fontSizePct: 5.4,
          weight: 700,
          maxLines: 2,
          maxCharsPerLine: 18,
          placement: { anchor: "center", verticalCenter: 0.62 },
          perWordHighlight: true,
        },
      },
      measureText: (text, fontPx) => [...text].length * fontPx / 2,
    });

    expect(model.outputs).toEqual({ width: 1080, height: 1920, fps: "30/1" });
    expect(model.styleResolved).toMatchObject({
      sizePct: 4.8,
      weight: 800,
      maxLines: 2,
      placement: { anchor: "middle", align: "center" },
      highlight: { mode: "per-word" },
    });
    expect(model.cues.flatMap(({ lines }) => lines)
      .every((line) => line.words.reduce((length, word, index) =>
        length + [...word.displayText].length + (index === 0 ? 0 : 1), 0) <= 18)).toBe(true);
    const titleSafe = { x: 0.05, y: 0.06, w: 0.79, h: 0.68 };
    for (const cue of model.cues) {
      expect(cue.box.x).toBeGreaterThanOrEqual(titleSafe.x - 1e-9);
      expect(cue.box.y).toBeGreaterThanOrEqual(titleSafe.y - 1e-9);
      expect(cue.box.x + cue.box.w).toBeLessThanOrEqual(titleSafe.x + titleSafe.w + 1e-9);
      expect(cue.box.y + cue.box.h).toBeLessThanOrEqual(titleSafe.y + titleSafe.h + 1e-9);
    }
    expect(model.cues.flatMap(({ lines }) => lines.flatMap(({ words }) => words))
      .map(({ wordId, start, end }) => ({ wordId, start, end }))).toEqual([
        { wordId: "w000001", start: { num: 0, den: 1 }, end: { num: 3, den: 4 } },
        { wordId: "w000002", start: { num: 1, den: 1 }, end: { num: 7, den: 4 } },
        { wordId: "w000003", start: { num: 2, den: 1 }, end: { num: 11, den: 4 } },
        { wordId: "w000004", start: { num: 3, den: 1 }, end: { num: 15, den: 4 } },
      ]);
  });
});
