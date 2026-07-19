import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseProjectYaml } from "../../core/src/index.js";
import type { RestyleAdapterConstraints } from "../../core/src/index.js";

import * as packageModule from "./index.js";
import { createRestylePlan } from "./index.js";

const FIXTURE_ROOT = resolve(".fixtures");

const CONSTRAINTS: RestyleAdapterConstraints = {
  maxSegmentSeconds: 10,
  maxResolution: { width: 1920, height: 1080 },
  fpsSupport: ["30/1"],
  costPerSecond: 0.14,
  concurrency: 2,
};

async function basicFixture() {
  const parsed = parseProjectYaml(await readFile(
    resolve(FIXTURE_ROOT, "projects/basic/episode.guyditor.yaml"),
    "utf8",
  ));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

async function fixtureSignals() {
  const manifest = JSON.parse(await readFile(
    resolve(FIXTURE_ROOT, "manifest.json"),
    "utf8",
  )) as {
    files: Record<string, {
      groundTruth?: { silenceMap?: Array<{ start: string; end: string }> };
    }>;
  };
  const transcript = JSON.parse(await readFile(
    resolve(FIXTURE_ROOT, "projects/basic/sidecars/transcript-speech.json"),
    "utf8",
  )) as {
    words: Record<string, {
      start: { samples: number; rate: number };
      end: { samples: number; rate: number };
    }>;
  };
  const rational = (source: string): number => {
    const [numerator, denominator] = source.split("/").map(Number);
    return numerator! / denominator!;
  };
  return {
    words: Object.entries(transcript.words).map(([id, word]) => ({
      id,
      startFrame: Math.round(word.start.samples * 30 / word.start.rate),
      endFrame: Math.round(word.end.samples * 30 / word.end.rate),
    })),
    beats: [{ id: "beat_aaaaaaaaaa", frame: 210 }],
    vadSilences: manifest.files["speech-48k-20s.wav"]!.groundTruth!.silenceMap!
      .map(({ start, end }) => ({
        startFrame: Math.round(rational(start) * 30),
        endFrame: Math.round(rational(end) * 30),
      })),
    lowMotionFrames: [102, 288, 390],
  };
}

describe("@guyditor/deliver", () => {
  it("loads the @guyditor/deliver package entry point", () => {
    expect(packageModule).toBeDefined();
  });

  it("plans the speech+bars deliverable at manifest silence and prices the whole plan", async () => {
    const result = createRestylePlan({
      project: await basicFixture(),
      deliverableId: "dlv_aaaaaaaaaa",
      coverage: "full",
      adapterId: "adp_klingaaaaa",
      model: "kling-video-o1",
      constraints: CONSTRAINTS,
      prompt: "Watercolor documentary",
      providerSettings: { creativity: 0.35 },
      seed: 7,
      createdAt: "2026-07-19T10:00:00.000Z",
      signals: await fixtureSignals(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.chunks.map(({ sourceRange }) => sourceRange)).toEqual([
      { startFrame: 0, endFrame: 288 },
      { startFrame: 288, endFrame: 420 },
    ]);
    expect(result.value.chunks[0]).toMatchObject({
      semanticAnchors: {
        start: expect.stringMatching(/^word:/),
        end: expect.stringMatching(/^word:/),
        boundaryKind: "vad-silence",
        evidence: expect.arrayContaining(["low-motion:288"]),
      },
      durationSeconds: 9.6,
      estimatedCostUsd: 1.344,
    });
    expect(result.value.chunks.every(({ durationSeconds }) =>
      durationSeconds <= CONSTRAINTS.maxSegmentSeconds)).toBe(true);
    expect(result.value.estimatedCost).toEqual({ currency: "USD", amount: 1.96 });
    expect(result.value.sourceAssets.map(({ assetId }) => assetId)).toEqual([
      "ast_aaaaaaaaaa",
      "ast_cccccccccc",
      "ast_dddddddddd",
      "ast_eeeeeeeeee",
    ]);
  });

  it("keeps a short target as one chunk and falls back to timeline anchors without words", async () => {
    const result = createRestylePlan({
      project: await basicFixture(),
      deliverableId: "dlv_aaaaaaaaaa",
      coverage: [{ startFrame: 20, endFrame: 80 }],
      adapterId: "adp_klingaaaaa",
      model: "kling-video-o1",
      constraints: CONSTRAINTS,
      prompt: "Ink wash",
      providerSettings: {},
      createdAt: "2026-07-19T10:00:00.000Z",
      signals: { words: [], beats: [], vadSilences: [], lowMotionFrames: [] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.coverage.mode).toBe("ranges");
    expect(result.value.chunks).toEqual([expect.objectContaining({
      sourceRange: { startFrame: 20, endFrame: 80 },
      semanticAnchors: {
        start: "timeline:seq_aaaaaaaaaa@20",
        end: "timeline:seq_aaaaaaaaaa@80",
        boundaryKind: "range-edge",
      },
      durationSeconds: 2,
      estimatedCostUsd: 0.28,
    })]);
  });

  it("snaps to low motion without words and rejects unsupported output constraints", async () => {
    const project = await basicFixture();
    const snapped = createRestylePlan({
      project,
      deliverableId: "dlv_aaaaaaaaaa",
      coverage: "full",
      adapterId: "adp_klingaaaaa",
      model: "kling-video-o1",
      constraints: { ...CONSTRAINTS, maxSegmentSeconds: 5 },
      prompt: "Ink wash",
      providerSettings: {},
      createdAt: "2026-07-19T10:00:00.000Z",
      signals: { words: [], beats: [], vadSilences: [], lowMotionFrames: [140] },
    });
    expect(snapped.ok).toBe(true);
    if (!snapped.ok) throw new Error(snapped.error.message);
    expect(snapped.value.chunks[0]).toMatchObject({
      sourceRange: { startFrame: 0, endFrame: 140 },
      semanticAnchors: { boundaryKind: "low-motion" },
    });

    expect(createRestylePlan({
      project,
      deliverableId: "dlv_aaaaaaaaaa",
      coverage: "full",
      adapterId: "adp_klingaaaaa",
      model: "kling-video-o1",
      constraints: { ...CONSTRAINTS, maxResolution: { width: 1280, height: 720 } },
      prompt: "Ink wash",
      providerSettings: {},
      createdAt: "2026-07-19T10:00:00.000Z",
      signals: { words: [], beats: [], vadSilences: [], lowMotionFrames: [] },
    })).toMatchObject({ ok: false, error: { code: "E_RESTYLE_CONSTRAINT" } });
  });
});
