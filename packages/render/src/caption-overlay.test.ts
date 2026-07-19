import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CaptionTrack } from "../../core/src/index.js";
import {
  DEFAULT_CAPTION_STYLE,
  compileCaptionTrack,
} from "../../transcript/src/index.js";
import type { TranscriptSidecar } from "../../transcript/src/index.js";
import {
  captionOverlayKey,
  renderCaptionOverlaySequence,
  renderCaptionPng,
} from "./caption-overlay.js";

const track: CaptionTrack = {
  id: "cts_aaaaaaaaaa",
  name: "captions",
  sourceLayerIds: ["lyr_aaaaaaaaaa"],
  preset: { presetId: "pre_aaaaaaaaaa", version: 1 },
  styleOverrides: {},
  breakOverrides: [],
  emphasisOverrides: [{ wordId: "w000001", emphasis: true }],
  timingOffsets: [],
  enabled: true,
};

const sidecar: TranscriptSidecar = {
  schema: "guyditor.transcript/v1",
  assetId: "ast_aaaaaaaaaa",
  audio: { rate: 48_000, channels: 1, streamIndex: 0 },
  language: "en",
  languageProbability: 1,
  provenance: { engine: { name: "fixture", version: "1", model: "synthetic" }, alignment: null, createdAt: "2026-07-19T00:00:00.000Z", jobId: "job_aaaaaaaaaa" },
  speakers: [{ id: "spk_aaaaaaaaaa", label: "Guy" }],
  segments: [{ id: "seg_aaaaaaaaaa", speaker: "spk_aaaaaaaaaa", language: "en", start: { samples: 0, rate: 48_000 }, end: { samples: 48_000, rate: 48_000 }, words: ["w000001", "w000002"] }],
  words: {
    w000001: { text: "Corrected", punctBefore: "", punctAfter: "", start: { samples: 0, rate: 48_000 }, end: { samples: 18_000, rate: 48_000 }, confidence: 1, alignment: "manual", state: "active", origin: "correction" },
    w000002: { text: "caption", punctBefore: "", punctAfter: "!", start: { samples: 24_000, rate: 48_000 }, end: { samples: 42_000, rate: 48_000 }, confidence: 1, alignment: "manual", state: "active", origin: "correction" },
  },
};

function model() {
  return compileCaptionTrack({
    track,
    timeline: {
      sequenceId: "seq_aaaaaaaaaa",
      instances: [
        { wordId: "w000001", clipId: "clp_aaaaaaaaaa", layerId: "lyr_aaaaaaaaaa", start: { num: 0, den: 1 }, end: { num: 3, den: 8 }, truncated: false },
        { wordId: "w000002", clipId: "clp_aaaaaaaaaa", layerId: "lyr_aaaaaaaaaa", start: { num: 1, den: 2 }, end: { num: 7, den: 8 }, truncated: false },
      ],
      diagnostics: { clippedWords: [], ambiguousRanges: [], orphanedAnchors: [] },
    },
    sidecars: [sidecar],
    style: {
      ...DEFAULT_CAPTION_STYLE,
      background: { color: "#101820CC", padXPct: 0.5, padYPct: 0.3, radiusPct: 0.4, scope: "block" },
    },
    safeArea: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
    output: { width: 640, height: 360, fps: "30/1" },
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("deterministic caption overlay renderer", () => {
  it("produces byte-identical straight-alpha PNGs with the bundled font", () => {
    const first = renderCaptionPng(model(), 15);
    const second = renderCaptionPng(model(), 15);
    expect(sha256(first)).toBe(sha256(second));
    expect([...first.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("keys and caches a zero-padded image2 sequence from canonical inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-overlay-"));
    const renderModel = model();
    const firstKey = captionOverlayKey(renderModel, { preset: track.preset });
    const changedKey = captionOverlayKey({
      ...renderModel,
      styleResolved: { ...renderModel.styleResolved, color: "#00FF00FF" },
    }, { preset: track.preset });
    expect(changedKey).not.toBe(firstKey);

    const plan = await renderCaptionOverlaySequence({
      model: renderModel,
      cacheRoot: root,
      versions: { preset: track.preset },
    });
    expect(plan.overlayKey).toBe(firstKey);
    expect(plan.pathPattern).toBe(join(root, firstKey, "%08d.png"));
    expect(plan.atOutputFrame).toBe(0);
    expect(plan.durationFrames).toBe(27);
    expect([...await readFile(join(root, firstKey, "00000015.png"))].slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
