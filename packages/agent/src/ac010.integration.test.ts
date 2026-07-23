import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { motionPresetPin } from "../../compositor/src/index.js";
import { createProject } from "../../core/src/index.js";
import type { CaptionTrack, Result } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { renderCaptionPng } from "../../render/src/index.js";
import {
  compileCaptionTrack,
  DEFAULT_CAPTION_STYLE,
  loadPinnedCaptionPreset,
  pinCaptionPresetVersion,
  serializeCaptionPreset,
} from "../../transcript/src/index.js";
import type { TranscriptSidecar } from "../../transcript/src/index.js";
import { SkillRegistry } from "./skills/index.js";

const roots: string[] = [];
const CAPTION_ID = "pre_aaaaaaaaaa";
const SKILL_ID = "skl_preference";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  expect(settled.ok, settled.ok ? "" : JSON.stringify(settled.error)).toBe(true);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

const track: CaptionTrack = {
  id: "cts_aaaaaaaaaa",
  name: "captions",
  sourceLayerIds: ["lyr_aaaaaaaaaa"],
  preset: { presetId: CAPTION_ID, version: 1 },
  styleOverrides: {},
  breakOverrides: [],
  emphasisOverrides: [{ wordId: "w000001", emphasis: true }],
  timingOffsets: [],
  enabled: true,
};

const transcript: TranscriptSidecar = {
  schema: "guyditor.transcript/v1",
  assetId: "ast_aaaaaaaaaa",
  audio: { rate: 48_000, channels: 1, streamIndex: 0 },
  language: "en",
  languageProbability: 1,
  provenance: {
    engine: { name: "fixture", version: "1", model: "synthetic" },
    alignment: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    jobId: "job_aaaaaaaaaa",
  },
  speakers: [{ id: "spk_aaaaaaaaaa", label: "Creator" }],
  segments: [{
    id: "seg_aaaaaaaaaa",
    speaker: "spk_aaaaaaaaaa",
    language: "en",
    start: { samples: 0, rate: 48_000 },
    end: { samples: 48_000, rate: 48_000 },
    words: ["w000001", "w000002"],
  }],
  words: {
    w000001: {
      text: "Exact",
      punctBefore: "",
      punctAfter: "",
      start: { samples: 0, rate: 48_000 },
      end: { samples: 18_000, rate: 48_000 },
      confidence: 1,
      alignment: "manual",
      state: "active",
      origin: "correction",
    },
    w000002: {
      text: "preferences",
      punctBefore: "",
      punctAfter: ".",
      start: { samples: 24_000, rate: 48_000 },
      end: { samples: 42_000, rate: 48_000 },
      confidence: 1,
      alignment: "manual",
      state: "active",
      origin: "correction",
    },
  },
};

function captionHash(style: typeof DEFAULT_CAPTION_STYLE): string {
  const model = compileCaptionTrack({
    track,
    timeline: {
      sequenceId: "seq_aaaaaaaaaa",
      instances: [
        { wordId: "w000001", clipId: "clp_aaaaaaaaaa", layerId: "lyr_aaaaaaaaaa", start: { num: 0, den: 1 }, end: { num: 3, den: 8 }, truncated: false },
        { wordId: "w000002", clipId: "clp_aaaaaaaaaa", layerId: "lyr_aaaaaaaaaa", start: { num: 1, den: 2 }, end: { num: 7, den: 8 }, truncated: false },
      ],
      diagnostics: { clippedWords: [], ambiguousRanges: [], orphanedAnchors: [] },
    },
    sidecars: [transcript],
    style,
    safeArea: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
    output: { width: 640, height: 360, fps: "30/1" },
  });
  return createHash("sha256").update(renderCaptionPng(model, 15)).digest("hex");
}

function skillManifest(version: string, rule: string): string {
  return [
    "format: guyditor-skill/v1",
    `id: ${SKILL_ID}`,
    "name: creator-editorial",
    `version: ${version}`,
    "title: Creator editorial direction",
    "categories: [pacing, subtitle_style, motion_transitions]",
    `summary: Use ${CAPTION_ID}@1 and pre_pipsmoothm@1 as exact preset inputs.`,
    "rules:",
    "  - id: rule_cadence",
    "    category: pacing",
    "    strength: prefer",
    `    text: ${rule}`,
    "examples:",
    "  approved: []",
    "  rejected: []",
    "body: SKILL.md",
    "",
  ].join("\n");
}

describe("AC-010 — reuse creator preferences", () => {
  it("keeps exact preset/skill pins and caption pixels until the skill is explicitly upgraded", async () => {
    const globalSkills = await mkdtemp(join(tmpdir(), "guyditor-ac010-skills-"));
    const globalPresets = await mkdtemp(join(tmpdir(), "guyditor-ac010-presets-"));
    const projectA = await mkdtemp(join(tmpdir(), "guyditor-ac010-a-"));
    const projectB = await mkdtemp(join(tmpdir(), "guyditor-ac010-b-"));
    const source = await mkdtemp(join(tmpdir(), "guyditor-ac010-source-"));
    roots.push(globalSkills, globalPresets, projectA, projectB, source);

    await mkdir(join(globalPresets, "captions"), { recursive: true });
    const presetContent = serializeCaptionPreset({
      format: "guyditor.caption-preset/v1",
      presetId: CAPTION_ID,
      name: "Creator exact captions",
      version: 1,
      style: {
        ...DEFAULT_CAPTION_STYLE,
        background: {
          color: "#101820CC",
          padXPct: 0.5,
          padYPct: 0.3,
          radiusPct: 0.4,
          scope: "block",
        },
      },
    });
    await writeFile(join(globalPresets, "captions", `${CAPTION_ID}@1.yaml`), presetContent, "utf8");

    const modelA = projectFixture();
    modelA.skills = [];
    modelA.presets = [];
    const captionPinned = await pinCaptionPresetVersion({
      globalRoot: globalPresets,
      projectRoot: projectA,
      project: modelA,
      presetId: CAPTION_ID,
      version: 1,
    });
    captionPinned.project.presets.push(motionPresetPin("smooth_move"));
    captionPinned.project.presets.sort((left, right) => left.id.localeCompare(right.id));
    const storeA = await valueOf(createProject(projectA, captionPinned.project));

    await mkdir(join(source, "examples"));
    await writeFile(join(source, "skill.yaml"), skillManifest("1.0.0", "Keep pauses longer than 700 ms."), "utf8");
    await writeFile(join(source, "SKILL.md"), "# Creator editorial direction\n\nPreset references are versioned inputs.\n", "utf8");
    const registry = new SkillRegistry({
      globalRoot: globalSkills,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
    await registry.publish(source);
    await registry.associateProject(storeA, SKILL_ID, "1.0.0", { appVersion: "0.0.0-ac010" });

    const pack = await registry.createPreferencePack(storeA);
    const modelB = projectFixture();
    modelB.skills = [];
    modelB.presets = [];
    const packedB = await registry.applyPreferencePack(projectB, modelB, pack);
    const storeB = await valueOf(createProject(projectB, packedB));

    expect(storeB.currentProject.presets.map(({ id, version }) => ({ id, version })))
      .toEqual(storeA.currentProject.presets.map(({ id, version }) => ({ id, version })));
    expect(storeB.currentProject.skills.map(({ id, version }) => ({ id, version })))
      .toEqual(storeA.currentProject.skills.map(({ id, version }) => ({ id, version })));
    const captionPinA = storeA.currentProject.presets.find(({ id }) => id === CAPTION_ID);
    const captionPinB = storeB.currentProject.presets.find(({ id }) => id === CAPTION_ID);
    expect(captionPinA).toBeDefined();
    expect(captionPinB).toBeDefined();
    if (captionPinA === undefined || captionPinB === undefined) return;
    const [presetA, presetB] = await Promise.all([
      loadPinnedCaptionPreset(projectA, captionPinA),
      loadPinnedCaptionPreset(projectB, captionPinB),
    ]);
    const goldenA = captionHash(presetA.style as typeof DEFAULT_CAPTION_STYLE);
    const goldenB = captionHash(presetB.style as typeof DEFAULT_CAPTION_STYLE);
    expect(goldenB).toBe(goldenA);

    const revisionBeforeV2 = storeB.currentProject.revision;
    const masterBeforeV2 = await readFile(join(projectB, "episode.guyditor.yaml"), "utf8");
    const journalBeforeV2 = await readFile(join(projectB, "history/transactions.jsonl"), "utf8");
    await writeFile(join(source, "skill.yaml"), skillManifest("2.0.0", "Open with the thesis inside 10 seconds."), "utf8");
    await registry.publish(source);

    expect((await registry.versions(SKILL_ID))).toEqual(["1.0.0", "2.0.0"]);
    expect((await registry.pinned(storeB)).map(({ manifest }) => manifest.version)).toEqual(["1.0.0"]);
    expect(storeB.currentProject.revision).toBe(revisionBeforeV2);
    expect(await readFile(join(projectB, "episode.guyditor.yaml"), "utf8")).toBe(masterBeforeV2);
    expect(await readFile(join(projectB, "history/transactions.jsonl"), "utf8")).toBe(journalBeforeV2);

    await registry.upgradeProject(storeB, SKILL_ID, "2.0.0", { appVersion: "0.0.0-ac010" });
    expect((await registry.pinned(storeB)).map(({ manifest }) => manifest.version)).toEqual(["2.0.0"]);
    expect(storeB.currentProject.revision).not.toBe(revisionBeforeV2);
    expect(await readFile(join(projectB, "history/transactions.jsonl"), "utf8"))
      .toContain('"op":"skill.pin.set"');
  });
});
