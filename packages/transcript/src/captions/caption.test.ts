import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CaptionTrack, GuyditorProject } from "../../../core/src/index.js";
import type { TranscriptSidecar } from "../types.js";
import {
  DEFAULT_CAPTION_STYLE,
  buildWordTimelineMap,
  compileCaptionTrack,
  importSubtitleText,
  loadPinnedCaptionPreset,
  parseCaptionPreset,
  pinCaptionPresetVersion,
  serializeCaptionPreset,
  serializeSubtitles,
} from "./index.js";

const track: CaptionTrack = {
  id: "cts_aaaaaaaaaa",
  name: "Captions",
  sourceLayerIds: ["lyr_aaaaaaaaaa"],
  preset: { presetId: "pre_aaaaaaaaaa", version: 1 },
  styleOverrides: {},
  breakOverrides: [],
  emphasisOverrides: [{ wordId: "w000002", emphasis: true }],
  timingOffsets: [],
  enabled: true,
};

const sidecar: TranscriptSidecar = {
  schema: "guyditor.transcript/v1",
  assetId: "ast_aaaaaaaaaa",
  audio: { rate: 48_000, channels: 1, streamIndex: 0 },
  language: "en",
  languageProbability: 1,
  provenance: {
    engine: { name: "fixture", version: "1", model: "synthetic" },
    alignment: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    jobId: "job_aaaaaaaaaa",
  },
  speakers: [{ id: "spk_aaaaaaaaaa", label: "Guy" }],
  segments: [{
    id: "seg_aaaaaaaaaa",
    speaker: "spk_aaaaaaaaaa",
    language: "en",
    start: { samples: 0, rate: 48_000 },
    end: { samples: 96_000, rate: 48_000 },
    words: ["w000001", "w000002", "w000003", "w000004"],
  }],
  words: {
    w000001: { text: "One", punctBefore: "", punctAfter: "", start: { samples: 0, rate: 48_000 }, end: { samples: 12_000, rate: 48_000 }, confidence: 1, alignment: "manual", state: "active", origin: "correction" },
    w000002: { text: "two", punctBefore: "", punctAfter: "", start: { samples: 24_000, rate: 48_000 }, end: { samples: 36_000, rate: 48_000 }, confidence: 1, alignment: "manual", state: "active", origin: "correction" },
    w000003: { text: "three", punctBefore: "", punctAfter: "", start: { samples: 48_000, rate: 48_000 }, end: { samples: 60_000, rate: 48_000 }, confidence: 1, alignment: "manual", state: "active", origin: "correction" },
    w000004: { text: "four", punctBefore: "", punctAfter: ".", start: { samples: 72_000, rate: 48_000 }, end: { samples: 84_000, rate: 48_000 }, confidence: 1, alignment: "manual", state: "active", origin: "correction" },
  },
};

describe("caption presets", () => {
  it("round-trips the immutable v1 preset with the complete CaptionStyle schema", () => {
    const preset = {
      format: "guyditor.caption-preset/v1" as const,
      presetId: "pre_aaaaaaaaaa",
      name: "Fixture captions",
      version: 1,
      style: DEFAULT_CAPTION_STYLE,
    };

    const serialized = serializeCaptionPreset(preset);
    expect(parseCaptionPreset(serialized)).toEqual(preset);
    expect(serialized).toContain("format: guyditor.caption-preset/v1");
    expect(serialized).toContain("wordsPerLine: 4");
  });

  it("snapshots and hash-verifies the first pinned immutable preset version", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-caption-preset-"));
    const globalRoot = join(root, "global");
    const projectRoot = join(root, "project");
    await mkdir(join(globalRoot, "captions"), { recursive: true });
    const content = serializeCaptionPreset({
      format: "guyditor.caption-preset/v1",
      presetId: "pre_aaaaaaaaaa",
      name: "Fixture captions",
      version: 1,
      style: DEFAULT_CAPTION_STYLE,
    });
    await writeFile(join(globalRoot, "captions/pre_aaaaaaaaaa@1.yaml"), content, "utf8");
    const pinned = await pinCaptionPresetVersion({
      globalRoot,
      projectRoot,
      project: { presets: [] },
      presetId: "pre_aaaaaaaaaa",
      version: 1,
    });
    expect(pinned.pin.path).toBe("presets/pre_aaaaaaaaaa@1.yaml");
    expect(pinned.pin.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(await readFile(join(projectRoot, pinned.pin.path), "utf8")).toBe(content);
    expect(await loadPinnedCaptionPreset(projectRoot, pinned.pin)).toEqual(pinned.preset);
  });
});

describe("SYNC and LINEBREAK/HIGHLIGHT", () => {
  it("recomputes exact word anchors after trim, split, and reorder without accumulated offsets", () => {
    const project: GuyditorProject = {
      format: "guyditor/v1" as const,
      revision: "rev_00001",
      project: { id: "prj_aaaaaaaaaa", name: "captions", created: "2026-07-19T00:00:00.000Z" },
      settings: { timeline: { fps: "30/1", width: 1920, height: 1080 }, audio: { sampleRate: 48_000, channels: 2 }, primaryDeliverable: "dlv_aaaaaaaaaa" },
      transcript: { nextWordOrdinal: 5 },
      assets: [{ id: "ast_aaaaaaaaaa", kind: "video" as const, path: "fixture.mp4", sha256: "a".repeat(64), probe: { duration: { frames: 120, fps: "30/1" }, fps: "30/1" } }],
      beats: [],
      sequences: [{ id: "seq_aaaaaaaaaa", name: "main", clips: [
        { id: "clp_bbbbbbbbbb", asset: "ast_aaaaaaaaaa", source: { in: { frames: 30, fps: "30/1" }, out: { frames: 60, fps: "30/1" } } },
        { id: "clp_aaaaaaaaaa", asset: "ast_aaaaaaaaaa", source: { in: { frames: 0, fps: "30/1" }, out: { frames: 30, fps: "30/1" } } },
      ] }],
      layers: [{ id: "lyr_aaaaaaaaaa", kind: "video" as const, name: "speech", order: 0, enabled: true, locked: false, sequence: "seq_aaaaaaaaaa" }],
      captions: [track],
      annotations: { sidecar: "annotations", summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 } },
      deliverables: [{ id: "dlv_aaaaaaaaaa", kind: "longform" as const, name: "main", profile: "youtube@1.0.0", sequenceId: "seq_aaaaaaaaaa", captionsTrackId: track.id, status: "draft" as const }],
      presets: [{ id: "pre_aaaaaaaaaa", name: "Fixture", kind: "caption" as const, version: 1, path: "presets/pre_aaaaaaaaaa@1.yaml", sha256: "b".repeat(64) }],
      skills: [],
      sidecars: [],
    };

    const timeline = buildWordTimelineMap({ project, sequenceId: "seq_aaaaaaaaaa", track, sidecars: [sidecar] });
    expect(timeline.instances.map(({ wordId, clipId, start }) => ({ wordId, clipId, start }))).toEqual([
      { wordId: "w000003", clipId: "clp_bbbbbbbbbb", start: { num: 0, den: 1 } },
      { wordId: "w000004", clipId: "clp_bbbbbbbbbb", start: { num: 1, den: 2 } },
      { wordId: "w000001", clipId: "clp_aaaaaaaaaa", start: { num: 1, den: 1 } },
      { wordId: "w000002", clipId: "clp_aaaaaaaaaa", start: { num: 3, den: 2 } },
    ]);
    expect(timeline.diagnostics.clippedWords).toEqual([]);

    const withFreeze = structuredClone(project);
    withFreeze.sequences[0]!.clips[0]!.effects = [{
      id: "efx_aaaaaaaaaa",
      kind: "freeze",
      params: { hold: { frames: 30, fps: "30/1" } },
    }];
    const afterUnsupportedRetime = buildWordTimelineMap({
      project: withFreeze,
      sequenceId: "seq_aaaaaaaaaa",
      track,
      sidecars: [sidecar],
    });
    expect(afterUnsupportedRetime.instances.find(({ wordId }) => wordId === "w000001")?.start)
      .toEqual({ num: 2, den: 1 });
    expect(afterUnsupportedRetime.diagnostics.ambiguousRanges).toContainEqual({
      start: { num: 0, den: 1 },
      end: { num: 2, den: 1 },
      layerIds: ["lyr_aaaaaaaaaa"],
    });
  });

  it("clamps caption lead-in to the containing derived clip start", () => {
    const model = compileCaptionTrack({
      track,
      timeline: {
        sequenceId: "seq_aaaaaaaaaa",
        instances: [{
          wordId: "w000001",
          clipId: "clp_aaaaaaaaaa",
          layerId: "lyr_aaaaaaaaaa",
          clipStart: { num: 2, den: 1 },
          start: { num: 21, den: 10 },
          end: { num: 12, den: 5 },
          truncated: false,
        }],
        diagnostics: { clippedWords: [], ambiguousRanges: [], orphanedAnchors: [] },
      },
      sidecars: [sidecar],
      style: {
        ...DEFAULT_CAPTION_STYLE,
        highlight: { ...DEFAULT_CAPTION_STYLE.highlight, leadInMs: 500 },
      },
      safeArea: { x: 0, y: 0, w: 1, h: 1 },
      output: { width: 1920, height: 1080, fps: "30/1" },
      measureText: (text, fontPx) => text.length * fontPx / 2,
    });

    expect(model.cues[0]?.start).toEqual({ num: 2, den: 1 });
  });

  it("keeps cue boundaries exact, applies deterministic overrides, and selects one word per frame", () => {
    const timeline = {
      sequenceId: "seq_aaaaaaaaaa",
      instances: [
        { wordId: "w000001", clipId: "clp_aaaaaaaaaa", layerId: "lyr_aaaaaaaaaa", start: { num: 0, den: 1 }, end: { num: 1, den: 4 }, truncated: false },
        { wordId: "w000002", clipId: "clp_aaaaaaaaaa", layerId: "lyr_aaaaaaaaaa", start: { num: 1, den: 2 }, end: { num: 3, den: 4 }, truncated: false },
        { wordId: "w000003", clipId: "clp_aaaaaaaaaa", layerId: "lyr_aaaaaaaaaa", start: { num: 1, den: 1 }, end: { num: 5, den: 4 }, truncated: false },
        { wordId: "w000004", clipId: "clp_aaaaaaaaaa", layerId: "lyr_aaaaaaaaaa", start: { num: 3, den: 2 }, end: { num: 7, den: 4 }, truncated: false },
      ],
      diagnostics: { clippedWords: [], ambiguousRanges: [], orphanedAnchors: [] },
    };
    const model = compileCaptionTrack({
      track: { ...track, breakOverrides: [{ afterWordId: "w000002", kind: "line" }] },
      timeline,
      sidecars: [sidecar],
      style: { ...DEFAULT_CAPTION_STYLE, wordsPerLine: 3, maxLines: 2 },
      safeArea: { x: 0, y: 0, w: 1, h: 1 },
      output: { width: 1920, height: 1080, fps: "30000/1001" },
      measureText: (text, fontPx) => [...text].length * fontPx / 2,
    });

    expect(model.cues).toHaveLength(1);
    expect(model.cues[0]?.start).toEqual({ num: 0, den: 1 });
    expect(model.cues[0]?.end).toEqual({ num: 7, den: 4 });
    expect(model.cues[0]?.lines.map((line) => line.words.map(({ wordId }) => wordId))).toEqual([
      ["w000001", "w000002"],
      ["w000003", "w000004"],
    ]);
    expect(model.cues[0]?.lines[0]?.words[1]).toMatchObject({ emphasized: true });
    expect(model.captionsAtFrame(15).cues[0]?.lines[0]?.words.map(({ state }) => state)).toEqual(["past", "current"]);
    expect(model.captionsAtFrame(30).cues[0]?.lines.flatMap(({ words }) => words).filter(({ state }) => state === "current")).toHaveLength(1);
  });
});

describe("SRT/VTT IO", () => {
  it("rounds each cue half-even from canonical rationals and imports provisional word timing", () => {
    const timeline = {
      sequenceId: "seq_aaaaaaaaaa",
      instances: [
        { wordId: "w000001", clipId: "clp_aaaaaaaaaa", layerId: "lyr_aaaaaaaaaa", start: { num: 1, den: 2000 }, end: { num: 2001, den: 2000 }, truncated: false },
        { wordId: "w000002", clipId: "clp_aaaaaaaaaa", layerId: "lyr_aaaaaaaaaa", start: { num: 4001, den: 2000 }, end: { num: 6001, den: 2000 }, truncated: false },
      ],
      diagnostics: { clippedWords: [], ambiguousRanges: [], orphanedAnchors: [] },
    };
    const model = compileCaptionTrack({
      track: { ...track, breakOverrides: [{ afterWordId: "w000001", kind: "cue" }] },
      timeline,
      sidecars: [sidecar],
      style: DEFAULT_CAPTION_STYLE,
      safeArea: { x: 0, y: 0, w: 1, h: 1 },
      output: { width: 1920, height: 1080, fps: "30/1" },
      measureText: (text, fontPx) => text.length * fontPx / 2,
    });
    const srt = serializeSubtitles(model, { format: "srt", vttWordTimestamps: false, vttPositioning: false, includeSpeakerLabels: false });
    const vtt = serializeSubtitles(model, { format: "vtt", vttWordTimestamps: true, vttPositioning: true, includeSpeakerLabels: false });
    expect(srt).toContain("00:00:00,000 --> 00:00:01,000");
    expect(srt).toContain("00:00:02,000 --> 00:00:03,000");
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.000");
    expect(vtt).toContain("<00:00:00.000>One");

    const imported = importSubtitleText(srt, {
      format: "srt",
      assetId: "ast_bbbbbbbbbb",
      firstWordOrdinal: 10,
      sampleRate: 48_000,
      now: "2026-07-19T00:00:00.000Z",
      jobId: "job_bbbbbbbbbb",
    });
    expect(imported.provisional).toBe(true);
    expect(Object.keys(imported.sidecar.words)).toEqual(["w000010", "w000011"]);
    expect(imported.sidecar.words["w000010"]).toMatchObject({ alignment: "imported", origin: "import", confidence: null });
  });
});
