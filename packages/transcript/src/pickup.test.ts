import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createProject } from "../../core/src/index.js";
import type { ContinuityWarning, GuyditorProject } from "../../core/src/index.js";
import type { TranscriptSidecar } from "./types.js";
import { TranscriptEngine } from "./engine.js";
import { planPickupSplice } from "./pickup.js";
import { createTranscriptWorkspace } from "./operations.js";
import { parseTranscriptSidecar, serializeTranscriptSidecar } from "./sidecar.js";

function transcript(
  assetId: string,
  words: Array<{ id: string; text: string; start: number; end: number }>,
): TranscriptSidecar {
  return {
    schema: "guyditor.transcript/v1",
    assetId,
    audio: { rate: 48_000, channels: 1, streamIndex: 0 },
    language: "en",
    languageProbability: 1,
    provenance: {
      engine: { name: "fixture", version: "1", model: "synthetic" },
      alignment: { name: "fixture-align", version: "1", model: "ctc" },
      createdAt: "2026-07-19T10:00:00Z",
      jobId: "job_aaaaaaaaaa",
    },
    speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker" }],
    segments: [{
      id: "seg_aaaaaaaaaa",
      speaker: "spk_aaaaaaaaaa",
      language: "en",
      start: { samples: words[0]!.start, rate: 48_000 },
      end: { samples: words.at(-1)!.end, rate: 48_000 },
      words: words.map(({ id }) => id),
    }],
    words: Object.fromEntries(words.map(({ id, text, start, end }) => [id, {
      text,
      punctBefore: "",
      punctAfter: "",
      start: { samples: start, rate: 48_000 },
      end: { samples: end, rate: 48_000 },
      confidence: 0.95,
      alignment: "ctc" as const,
      state: "active" as const,
      origin: "asr" as const,
    }])),
  };
}

function project(): GuyditorProject {
  return {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: { id: "prj_aaaaaaaaaa", name: "Pickup", created: "2026-07-19T10:00:00Z" },
    settings: {
      timeline: { fps: "24/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: 20 },
    assets: [
      { id: "ast_aaaaaaaaaa", kind: "video", path: "media/main.mp4", sha256: "a".repeat(64), probe: {} },
      { id: "ast_bbbbbbbbbb", kind: "audio", path: "media/pickups/fix.wav", sha256: "b".repeat(64), probe: {} },
    ],
    beats: [],
    sequences: [{
      id: "seq_aaaaaaaaaa",
      name: "main",
      clips: [{
        id: "clp_aaaaaaaaaa",
        asset: "ast_aaaaaaaaaa",
        source: { in: { frames: 0, fps: "24/1" }, out: { frames: 120, fps: "24/1" } },
      }],
    }],
    layers: [{
      id: "lyr_aaaaaaaaaa", kind: "video", name: "main", order: 0,
      enabled: true, locked: false, sequence: "seq_aaaaaaaaaa",
    }],
    captions: [{
      id: "cts_aaaaaaaaaa",
      name: "captions",
      sourceLayerIds: ["lyr_aaaaaaaaaa"],
      preset: { presetId: "pre_aaaaaaaaaa", version: 1 },
      styleOverrides: {}, breakOverrides: [], emphasisOverrides: [], timingOffsets: [], enabled: true,
    }],
    annotations: { sidecar: "annotations", summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 } },
    deliverables: [{
      id: "dlv_aaaaaaaaaa", kind: "longform", name: "master", profile: "youtube@1.0.0",
      sequenceId: "seq_aaaaaaaaaa", captionsTrackId: "cts_aaaaaaaaaa", status: "draft",
    }],
    presets: [], skills: [], sidecars: [],
  };
}

describe("pickup splice planning", () => {
  it("retimes repaired words and caption inputs while evaluating continuity as a review-gated proposal", async () => {
    const original = transcript("ast_aaaaaaaaaa", [
      { id: "w000001", text: "The", start: 0, end: 20_000 },
      { id: "w000002", text: "year", start: 24_000, end: 48_000 },
      { id: "w000003", text: "nineteen", start: 48_000, end: 72_000 },
      { id: "w000004", text: "ninety", start: 72_000, end: 96_000 },
      { id: "w000005", text: "ended", start: 100_000, end: 124_000 },
    ]);
    const pickup = transcript("ast_bbbbbbbbbb", [
      { id: "w000010", text: "twenty", start: 48_000, end: 68_000 },
      { id: "w000011", text: "sixteen", start: 68_000, end: 92_000 },
    ]);
    const warning: ContinuityWarning = {
      code: "ambience-jump",
      severity: "warning",
      boundary: { beforeClip: "clp_aaaaaaaaaa" },
      evidence: "room-tone delta exceeds the local threshold",
      suggestion: "Use the captured room-tone padding.",
    };
    const evaluateContinuity = vi.fn(() => [warning]);

    const result = await planPickupSplice({
      project: project(),
      transcript: original,
      pickupTranscript: pickup,
      wordRange: { fromWord: "w000003", toWord: "w000004" },
      pickupAssetId: "ast_bbbbbbbbbb",
      pickupRange: { in: { samples: 48_000, rate: 48_000 }, out: { samples: 92_000, rate: 48_000 } },
      alignmentConfidence: 0.92,
      trigger: { markerId: "mrk_aaaaaaaaaa" },
      evaluateContinuity,
    });

    expect(result.kind).toBe("proposal");
    if (result.kind !== "proposal") throw new Error("expected proposal");
    expect(result.operation).toMatchObject({
      op: "pickup.splice",
      params: {
        wordRange: { fromWord: "w000003", toWord: "w000004" },
        pickupAssetId: "ast_bbbbbbbbbb",
        pickupRange: { in: { samples: 48_000, rate: 48_000 }, out: { samples: 92_000, rate: 48_000 } },
        roomTonePaddingMs: 120,
        repairedWordIds: ["w000003", "w000004"],
        trigger: { markerId: "mrk_aaaaaaaaaa" },
      },
    });
    expect(result.updatedTranscript.words["w000003"]).toMatchObject({
      text: "twenty", start: { samples: 48_000, rate: 48_000 },
      end: { samples: 68_000, rate: 48_000 }, origin: "pickup", alignment: "ctc",
    });
    expect(result.updatedTranscript.words["w000004"]).toMatchObject({
      text: "sixteen", start: { samples: 68_000, rate: 48_000 },
      end: { samples: 92_000, rate: 48_000 }, origin: "pickup", alignment: "ctc",
    });
    expect(result.captionUpdates).toEqual([{
      captionId: "cts_aaaaaaaaaa",
      wordIds: ["w000003", "w000004"],
      impact: "realign",
    }]);
    expect(evaluateContinuity).toHaveBeenCalledOnce();
    expect(result.warnings).toEqual([warning]);
    expect(result.mechanics).toEqual({
      crossfadeAtZeroCrossings: true,
      roomTonePaddingMs: 120,
      roomToneFill: true,
      clippedPhonemeCheck: true,
    });
    expect(result.reviewRequired).toBe(true);
    expect(result.directApply).toBe(false);

    const model = project();
    model.sidecars = [
      {
        name: "transcript-main", path: "sidecars/transcripts/ast_aaaaaaaaaa.transcript.json",
        schema: "guyditor.transcript/v1", sha256: "c".repeat(64),
        inputs: [{ asset: "ast_aaaaaaaaaa", sha256: "a".repeat(64) }],
      },
      {
        name: "transcript-pickup", path: "sidecars/transcripts/ast_bbbbbbbbbb.transcript.json",
        schema: "guyditor.transcript/v1", sha256: "d".repeat(64),
        inputs: [{ asset: "ast_bbbbbbbbbb", sha256: "b".repeat(64) }],
      },
    ];
    const workspace = createTranscriptWorkspace(
      [structuredClone(original), structuredClone(pickup)],
      structuredClone(model.sidecars),
      (prefix) => `${prefix}_${"c".repeat(10)}`,
    );
    const applied = await workspace.dispatcher(model, result.operation, {
      baseRevision: model.revision,
      origin: "system",
      dryRun: true,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.value.model.layers).toContainEqual(expect.objectContaining({
      id: "lyr_cccccccccc",
      kind: "audio",
      name: "Pickups",
      items: [expect.objectContaining({
        id: "clp_cccccccccc",
        asset: "ast_bbbbbbbbbb",
        at: "word:w000003",
      })],
    }));
    const written = workspace.writes.get("sidecars/transcripts/ast_aaaaaaaaaa.transcript.json");
    expect(written).toBeDefined();
    expect(parseTranscriptSidecar(written!).words["w000003"]).toMatchObject({
      text: "twenty",
      origin: "pickup",
      start: { samples: 48_000, rate: 48_000 },
    });
  });

  it("surfaces FR-208 low confidence and creates no splice proposal", async () => {
    const original = transcript("ast_aaaaaaaaaa", [
      { id: "w000001", text: "wrong", start: 0, end: 24_000 },
    ]);
    const pickup = transcript("ast_bbbbbbbbbb", [
      { id: "w000010", text: "right", start: 0, end: 24_000 },
    ]);
    const result = await planPickupSplice({
      project: project(),
      transcript: original,
      pickupTranscript: pickup,
      wordRange: { fromWord: "w000001", toWord: "w000001" },
      pickupAssetId: "ast_bbbbbbbbbb",
      pickupRange: { in: { samples: 0, rate: 48_000 }, out: { samples: 24_000, rate: 48_000 } },
      alignmentConfidence: 0.49,
      evaluateContinuity: () => [],
    });
    expect(result).toMatchObject({
      kind: "needs-review",
      code: "E_PICKUP_ALIGNMENT_LOW_CONFIDENCE",
      proposalCreated: false,
      confidence: 0.49,
    });
  });

  it("persists and accepts the splice only through the transcript-aware proposal gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-pickup-proposal-"));
    try {
      const original = transcript("ast_aaaaaaaaaa", [
        { id: "w000001", text: "year", start: 24_000, end: 48_000 },
        { id: "w000002", text: "nineteen", start: 48_000, end: 72_000 },
        { id: "w000003", text: "ninety", start: 72_000, end: 96_000 },
      ]);
      const pickup = transcript("ast_bbbbbbbbbb", [
        { id: "w000010", text: "twenty", start: 48_000, end: 68_000 },
        { id: "w000011", text: "sixteen", start: 68_000, end: 92_000 },
      ]);
      const model = project();
      model.presets = [{
        id: "pre_aaaaaaaaaa",
        name: "captions",
        kind: "caption",
        version: 1,
        path: "presets/pre_aaaaaaaaaa@1.yaml",
        sha256: "a".repeat(64),
      }];
      model.assets[0]!.audio = [{
        index: 0, codec: "aac", sampleRate: 48_000, channels: 1, layout: "mono",
      }];
      model.assets[1]!.audio = [{
        index: 0, codec: "pcm_s16le", sampleRate: 48_000, channels: 1, layout: "mono",
      }];
      const originalText = serializeTranscriptSidecar(original);
      const pickupText = serializeTranscriptSidecar(pickup);
      const annotationsText = "format: guyditor.annotations/v1\nannotations: []\n";
      model.sidecars = [
        {
          name: "transcript-main",
          path: "sidecars/transcripts/ast_aaaaaaaaaa.transcript.json",
          schema: "guyditor.transcript/v1",
          sha256: createHash("sha256").update(originalText).digest("hex"),
          inputs: [{ asset: "ast_aaaaaaaaaa", sha256: "a".repeat(64) }],
        },
        {
          name: "transcript-pickup",
          path: "sidecars/transcripts/ast_bbbbbbbbbb.transcript.json",
          schema: "guyditor.transcript/v1",
          sha256: createHash("sha256").update(pickupText).digest("hex"),
          inputs: [{ asset: "ast_bbbbbbbbbb", sha256: "b".repeat(64) }],
        },
        {
          name: "annotations",
          path: "sidecars/annotations.yaml",
          schema: "guyditor.annotations/v1",
          sha256: createHash("sha256").update(annotationsText).digest("hex"),
          inputs: [],
        },
      ];
      const created = await createProject(root, model);
      if (!created.ok) throw created.error;
      expect(created.ok).toBe(true);
      await mkdir(join(root, "sidecars/transcripts"), { recursive: true });
      await writeFile(join(root, model.sidecars[0]!.path), originalText, "utf8");
      await writeFile(join(root, model.sidecars[1]!.path), pickupText, "utf8");
      await writeFile(join(root, model.sidecars[2]!.path), annotationsText, "utf8");
      const plan = await planPickupSplice({
        project: created.value.currentProject,
        transcript: original,
        pickupTranscript: pickup,
        wordRange: { fromWord: "w000002", toWord: "w000003" },
        pickupAssetId: "ast_bbbbbbbbbb",
        pickupRange: {
          in: { samples: 48_000, rate: 48_000 },
          out: { samples: 92_000, rate: 48_000 },
        },
        alignmentConfidence: 0.92,
        evaluateContinuity: () => [{
          code: "ambience-jump",
          severity: "warning",
          boundary: {},
          evidence: "pickup and original room-tone envelopes differ",
        }],
      });
      expect(plan.kind).toBe("proposal");
      if (plan.kind !== "proposal") throw new Error("expected pickup proposal plan");
      const engine = new TranscriptEngine({
        appVersion: "0.0.0-test",
        idFactory: (prefix) => `${prefix}_${"c".repeat(10)}`,
      });
      const proposed = await engine.createProposal(created.value, {
        operations: [plan.operation],
        instruction: { kind: "ui-direct", text: "Review pickup" },
        actor: { kind: "tool", id: "pickup.test" },
        reason: {
          text: "Use the aligned corrective recording.",
          sources: [{ kind: "media-evidence", ref: "ast_bbbbbbbbbb" }],
        },
        addresses: [],
        warnings: plan.warnings,
      });
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) throw proposed.error;
      expect(proposed.value.status).toBe("ready");
      expect(created.value.currentProject.revision).toBe("rev_00001");
      expect(await readFile(join(root, model.sidecars[0]!.path), "utf8"))
        .toContain('"text":"nineteen"');

      const accepted = await engine.acceptProposal(created.value, proposed.value.id, "creator");
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) throw accepted.error;
      expect(accepted.value.status).toBe("accepted");
      expect(created.value.currentProject.revision).toBe("rev_00002");
      const committed = parseTranscriptSidecar(
        await readFile(join(root, model.sidecars[0]!.path), "utf8"),
      );
      expect(committed.words["w000002"]).toMatchObject({ text: "twenty", origin: "pickup" });
      expect(committed.words["w000003"]).toMatchObject({ text: "sixteen", origin: "pickup" });
      expect(created.value.currentProject.layers).toContainEqual(expect.objectContaining({
        name: "Pickups",
        items: [expect.objectContaining({ asset: "ast_bbbbbbbbbb", at: "word:w000002" })],
      }));
      expect(accepted.value.warnings).toContainEqual(expect.objectContaining({
        code: "ambience-jump",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
