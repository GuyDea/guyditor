import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CaptionTrack } from "../../../core/src/index.js";
import type { TranscriptSidecar } from "../types.js";
import { compileCaptionTrack } from "./compiler.js";
import { DEFAULT_CAPTION_STYLE } from "./preset.js";
import { halfEvenMilliseconds, rational } from "./rational.js";
import { parseSubtitleCues, serializeSubtitles } from "./subtitles.js";

const PROPERTY_PARAMETERS = { numRuns: 500, verbose: true } as const;

describe("P-W5 exact caption boundaries", () => {
  it("anchors every cue exactly and rounds every subtitle cue independently", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        durationSamples: fc.integer({ min: 96, max: 24_000 }),
        gapSamples: fc.integer({ min: 48, max: 12_000 }),
      }), { minLength: 1, maxLength: 80 }),
      (spans) => {
        let cursor = 0;
        const words: TranscriptSidecar["words"] = {};
        const wordIds = spans.map((span, index) => {
          const wordId = `w${String(index + 1).padStart(6, "0")}`;
          const start = cursor;
          const end = start + span.durationSamples;
          cursor = end + span.gapSamples;
          words[wordId] = {
            text: `word${String(index + 1)}`,
            punctBefore: "",
            punctAfter: "",
            start: { samples: start, rate: 48_000 },
            end: { samples: end, rate: 48_000 },
            confidence: 1,
            alignment: "manual",
            state: "active",
            origin: "correction",
          };
          return wordId;
        });
        const sidecar: TranscriptSidecar = {
          schema: "guyditor.transcript/v1",
          assetId: "ast_aaaaaaaaaa",
          audio: { rate: 48_000, channels: 1, streamIndex: 0 },
          language: "en",
          languageProbability: 1,
          provenance: {
            engine: { name: "property", version: "1", model: "synthetic" },
            alignment: null,
            createdAt: "2026-07-19T00:00:00.000Z",
            jobId: "job_aaaaaaaaaa",
          },
          speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker 1" }],
          segments: [{
            id: "seg_aaaaaaaaaa",
            speaker: "spk_aaaaaaaaaa",
            language: "en",
            start: { samples: 0, rate: 48_000 },
            end: { samples: cursor, rate: 48_000 },
            words: wordIds,
          }],
          words,
        };
        const track: CaptionTrack = {
          id: "cts_aaaaaaaaaa",
          name: "P-W5",
          sourceLayerIds: ["lyr_aaaaaaaaaa"],
          preset: { presetId: "pre_aaaaaaaaaa", version: 1 },
          styleOverrides: {},
          breakOverrides: wordIds.slice(0, -1).map((afterWordId) => ({
            afterWordId,
            kind: "cue" as const,
          })),
          emphasisOverrides: [],
          timingOffsets: [],
          enabled: true,
        };
        const instances = wordIds.map((wordId) => ({
          wordId,
          clipId: "clp_aaaaaaaaaa",
          layerId: "lyr_aaaaaaaaaa",
          start: rational(words[wordId]!.start.samples, 48_000),
          end: rational(words[wordId]!.end.samples, 48_000),
          truncated: false,
        }));
        const model = compileCaptionTrack({
          track,
          timeline: {
            sequenceId: "seq_aaaaaaaaaa",
            instances,
            diagnostics: { clippedWords: [], ambiguousRanges: [], orphanedAnchors: [] },
          },
          sidecars: [sidecar],
          style: {
            ...DEFAULT_CAPTION_STYLE,
            cueGapMs: 100_000,
            maxCueDurationMs: 100_000,
            highlight: { ...DEFAULT_CAPTION_STYLE.highlight, leadInMs: 0, holdMs: 0 },
          },
          safeArea: { x: 0, y: 0, w: 1, h: 1 },
          output: { width: 1920, height: 1080, fps: "30000/1001" },
          measureText: (text, fontPx) => text.length * fontPx / 2,
        });

        expect(model.cues).toHaveLength(instances.length);
        for (const [index, cue] of model.cues.entries()) {
          expect(cue.start).toEqual(instances[index]!.start);
          expect(cue.end).toEqual(instances[index]!.end);
        }

        for (const format of ["srt", "vtt"] as const) {
          const serialized = serializeSubtitles(model, {
            format,
            vttWordTimestamps: format === "vtt",
            vttPositioning: format === "vtt",
            includeSpeakerLabels: false,
          });
          const parsed = parseSubtitleCues(serialized, format);
          for (const [index, cue] of parsed.entries()) {
            expect(cue.startMs).toBe(halfEvenMilliseconds(instances[index]!.start));
            expect(cue.endMs).toBe(halfEvenMilliseconds(instances[index]!.end));
          }
        }
      },
    ), PROPERTY_PARAMETERS);
  });
});
