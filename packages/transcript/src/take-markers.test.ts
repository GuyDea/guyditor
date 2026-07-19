import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseTakeMarkerSidecar,
  serializeTakeMarkerSidecar,
} from "../../core/src/index.js";
import type { TakeMarkerSidecar } from "../../core/src/index.js";
import type { TranscriptSidecar } from "./types.js";
import {
  detectSpokenTakeMarkers,
  importJsonTakeMarkers,
  importTakeNotes,
} from "./take-markers.js";

function ids(): (prefix: "mrk" | "tak") => string {
  let ordinal = 0;
  return (prefix) => `${prefix}_${String.fromCharCode(97 + ordinal++).repeat(10)}`;
}

function syntheticTranscript(): TranscriptSidecar {
  const texts = ["Okay", "cut", "that", "and", "take", "three", "that", "was", "good"];
  const words = Object.fromEntries(texts.map((text, index) => [
    `w${String(index + 1).padStart(6, "0")}`,
    {
      text,
      punctBefore: "",
      punctAfter: "",
      start: { samples: index * 24_000, rate: 48_000 },
      end: { samples: index * 24_000 + 20_000, rate: 48_000 },
      confidence: 0.99,
      alignment: "ctc" as const,
      state: "active" as const,
      origin: "asr" as const,
    },
  ]));
  return {
    schema: "guyditor.transcript/v1",
    assetId: "ast_aaaaaaaaaa",
    audio: { rate: 48_000, channels: 1, streamIndex: 0 },
    language: "en",
    languageProbability: 1,
    provenance: {
      engine: { name: "fixture", version: "1", model: "synthetic" },
      alignment: null,
      createdAt: "2026-07-19T10:00:00Z",
      jobId: "job_aaaaaaaaaa",
    },
    speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker" }],
    segments: [{
      id: "seg_aaaaaaaaaa",
      speaker: "spk_aaaaaaaaaa",
      language: "en",
      start: { samples: 0, rate: 48_000 },
      end: { samples: texts.length * 24_000, rate: 48_000 },
      words: texts.map((_text, index) => `w${String(index + 1).padStart(6, "0")}`),
    }],
    words,
  };
}

function expectExactSidecar(sidecar: TakeMarkerSidecar): void {
  expect(sidecar.format).toBe("guyditor.take-markers/v1");
  expect(JSON.stringify(sidecar)).not.toMatch(/"at":\s*[0-9]+\.[0-9]+/u);
  expect(sidecar.markers.every(({ at }) =>
    "frame" in at ? Number.isInteger(at.frame) : Number.isInteger(at.start) && Number.isInteger(at.end),
  )).toBe(true);
  expect(parseTakeMarkerSidecar(serializeTakeMarkerSidecar(sidecar))).toEqual(sidecar);
}

describe("take-marker intake", () => {
  it("imports JSON float seconds to exact source frames with half-frame ties earlier", async () => {
    const intake = await readFile(new URL("./__fixtures__/markers.json", import.meta.url), "utf8");
    const sidecar = importJsonTakeMarkers(intake, {
      assetId: "ast_aaaaaaaaaa",
      fps: "24/1",
      assetEndFrame: 240,
      idFactory: ids(),
    });

    expectExactSidecar(sidecar);
    expect(sidecar.markers.map(({ at }) => "frame" in at ? at.frame : at.start)).toEqual([1, 36, 48]);
    expect(sidecar.takes).toEqual([{
      id: "tak_dddddddddd",
      assetId: "ast_aaaaaaaaaa",
      index: 3,
      range: { start: 1, end: 48, fps: "24/1" },
      quality: "good",
      notes: ["said 2019, meant 2016"],
      sourceMarkerIds: ["mrk_aaaaaaaaaa", "mrk_bbbbbbbbbb", "mrk_cccccccccc"],
    }]);
  });

  it("imports timestamped notes using the documented flags", async () => {
    const intake = await readFile(new URL("./__fixtures__/notes.txt", import.meta.url), "utf8");
    const sidecar = importTakeNotes(intake, {
      assetId: "ast_aaaaaaaaaa",
      fps: "24/1",
      assetEndFrame: 240,
      idFactory: ids(),
    });

    expectExactSidecar(sidecar);
    expect(sidecar.markers.map(({ type }) => type)).toEqual(["take-start", "mistake", "good"]);
    expect(sidecar.takes[0]).toMatchObject({
      index: 3,
      range: { start: 1, end: 240, fps: "24/1" },
      quality: "good",
      notes: ["first line", "said 2019, meant 2016", "clean ending"],
    });
  });

  it("detects configured spoken phrases as dismissible word-anchored candidates", () => {
    const markers = detectSpokenTakeMarkers(syntheticTranscript(), {
      fps: "24/1",
      idFactory: ids(),
    });

    expect(markers.map(({ note, anchor, at }) => ({
      note,
      anchor,
      frame: "frame" in at ? at.frame : -1,
    }))).toEqual([
      { note: "cut that", anchor: "word:w000002", frame: 12 },
      { note: "take three", anchor: "word:w000005", frame: 48 },
      { note: "that was good", anchor: "word:w000007", frame: 72 },
    ]);
    expect(markers.every(({ type, detected, source }) =>
      type === "spoken" && detected === true && source === "spoken",
    )).toBe(true);
  });
});
