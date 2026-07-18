import { describe, expect, it } from "vitest";

import { OperationEngine } from "../index.js";
import type {
  GuyditorProject,
  IdPrefix,
  OperationBatchResult,
  OperationContext,
  OperationInput,
  OperationEngineOptions,
  Result,
  TransactionRecord,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const CLIP_ID = "clp_cccccccccc";
const EFFECT_ID = "fx_bbbbbbbbbb";
const TXN_ID = "txn_aaaaaaaaaa";

function idFactory(prefix: IdPrefix): string {
  if (prefix === "clp") return CLIP_ID;
  if (prefix === "fx") return EFFECT_ID;
  return TXN_ID;
}

function context(baseRevision = "rev_00001", dryRun = false): OperationContext {
  return { baseRevision, origin: "ui", dryRun };
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function withoutRevision(project: GuyditorProject): GuyditorProject {
  return { ...project, revision: "rev_00000" };
}

function moduloGeneratedClipIds(project: GuyditorProject): GuyditorProject {
  const normalized = structuredClone(withoutRevision(project));
  for (const sequence of normalized.sequences) {
    for (const [clipIndex, clip] of sequence.clips.entries()) {
      clip.id = `clip-${String(clipIndex)}`;
      for (const [effectIndex, effect] of (clip.effects ?? []).entries()) {
        effect.id = `effect-${String(clipIndex)}-${String(effectIndex)}`;
      }
    }
  }
  return normalized;
}

describe("OperationEngine", () => {
  it("validates and dispatches catalogued transcript operations at their declared risk", async () => {
    const original = projectFixture();
    let dispatched = "";
    const TranscriptAwareEngine = OperationEngine as unknown as new(
      project: GuyditorProject,
      options: OperationEngineOptions & {
        operationDispatcher: (
          project: GuyditorProject,
          input: OperationInput,
        ) => Result<{
          model: GuyditorProject;
          inverse: OperationInput[];
          affected: string[];
          summary: string;
        }>;
      },
    ) => OperationEngine;
    const engine = new TranscriptAwareEngine(original, {
      idFactory,
      operationDispatcher(project, input) {
        dispatched = input.op;
        return {
          ok: true,
          value: {
            model: {
              ...project,
              transcript: { nextWordOrdinal: 3 },
            },
            inverse: [{
              op: "transcript.create.remove",
              params: { assetId: "ast_aaaaaaaaaa" },
            }],
            affected: ["ast_aaaaaaaaaa"],
            summary: "Register canonical transcript for ast_aaaaaaaaaa",
          },
        };
      },
    });

    const result = await valueOf(engine.execute([{
      op: "transcript.create",
      params: {
        assetId: "ast_aaaaaaaaaa",
        sidecar: {
          path: "sidecars/transcripts/ast_aaaaaaaaaa.transcript.json",
          sha256: "a".repeat(64),
        },
        engine: { name: "faster-whisper", version: "1.1.0", model: "large-v3" },
        alignment: null,
        jobId: "job_aaaaaaaaaa",
      },
    }], context()));

    expect(dispatched).toBe("transcript.create");
    expect(result.riskClass).toBe("low");
    expect(result.applied[0]).toMatchObject({
      summary: "Register canonical transcript for ast_aaaaaaaaaa",
      inverse: [{
        op: "transcript.create.remove",
        params: { assetId: "ast_aaaaaaaaaa" },
      }],
      captionImpact: "shift",
    });
  });

  it("trims immutably and its inverse restores the model", async () => {
    const original = projectFixture();
    const originalSequence = original.sequences[0]!;
    const untouchedClip = originalSequence.clips[1]!;
    const engine = new OperationEngine(original, { idFactory });

    const result = await valueOf(engine.execute([
      {
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: 4, fps: "24/1" },
          snapPolicy: "none",
        },
      },
    ], context()));

    expect(engine.currentProject).not.toBe(original);
    expect(engine.currentProject.assets).toBe(original.assets);
    expect(engine.currentProject.sequences[0]).not.toBe(originalSequence);
    expect(engine.currentProject.sequences[0]!.clips[1]).toBe(untouchedClip);
    expect(engine.currentProject.sequences[0]!.clips[0]!.source.out.frames).toBe(20);
    expect(result.applied[0]).toMatchObject({
      op: "clip.trim",
      inverse: [{
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: -4, fps: "24/1" },
          snapPolicy: "none",
        },
      }],
      captionImpact: "none",
      warnings: [],
      affected: ["clp_aaaaaaaaaa"],
    });
    expect(result.applied[0]!.summary).toContain(
      "Trim tail of a.mov (clp_aaaaaaaaaa) by +4 frames (1/6 s)",
    );
    expect(result.diff.entries[0]).toMatchObject({
      op: "clip.trim",
      entityId: "clp_aaaaaaaaaa",
      change: "modified",
    });

    await valueOf(engine.execute(result.applied[0]!.inverse, context("rev_00002")));
    expect(withoutRevision(engine.currentProject)).toEqual(withoutRevision(original));
  });

  it("splits with incoming boundary state on the first clip and outgoing state on the second", async () => {
    const original = projectFixture();
    const clip = original.sequences[0]!.clips[0]!;
    clip.gapBefore = { frames: 2, fps: "24/1" };
    clip.transitionAfter = {
      id: "trn_aaaaaaaaaa",
      preset: "built-in-cut",
      duration: { frames: 2, fps: "24/1" },
    };
    clip.effects = [
      { id: "fx_aaaaaaaaaa", kind: "speed", params: { rate: "1/1" } },
    ];
    const engine = new OperationEngine(original, { idFactory });

    const result = await valueOf(engine.execute([
      { op: "clip.split", params: { clipId: clip.id, at: 10 } },
    ], context()));
    const [first, second] = engine.currentProject.sequences[0]!.clips;

    expect(first).toMatchObject({
      id: clip.id,
      source: { in: { frames: 0 }, out: { frames: 10 } },
      gapBefore: { frames: 2 },
      effects: clip.effects,
    });
    expect(first).not.toHaveProperty("transitionAfter");
    expect(second).toMatchObject({
      id: CLIP_ID,
      source: { in: { frames: 10 }, out: { frames: 24 } },
      transitionAfter: clip.transitionAfter,
      effects: [{ id: EFFECT_ID, kind: "speed", params: { rate: "1/1" } }],
    });
    expect(second).not.toHaveProperty("gapBefore");
    expect(second).not.toHaveProperty("overlapPrevious");
    expect(result.applied[0]!.summary).toContain("effects duplicated");
    expect(result.applied[0]!.affected).toEqual([
      clip.id,
      CLIP_ID,
      EFFECT_ID,
    ]);
    expect(result.diff.entries).toContainEqual(expect.objectContaining({
      entityId: EFFECT_ID,
      change: "added",
    }));
    expect(result.diff.entries.find(({ entityId }) => entityId === clip.id)?.fields)
      .toContainEqual({
        field: "transitionAfter",
        before: clip.transitionAfter,
      });
    expect(result.applied[0]!.inverse).toEqual([
      { op: "clip.join", params: { clipIds: [clip.id, CLIP_ID] } },
    ]);

    await valueOf(engine.execute(result.applied[0]!.inverse, context("rev_00002")));
    expect(withoutRevision(engine.currentProject)).toEqual(withoutRevision(original));
  });

  it("joins adjacent compatible source-contiguous clips and inverse-splits at captured boundaries", async () => {
    const original = projectFixture();
    original.sequences[0]!.clips[0]!.effects = [
      { id: "fx_aaaaaaaaaa", kind: "speed", params: { rate: "1/1" } },
    ];
    original.sequences[0]!.clips[1]!.effects = [
      { id: "fx_cccccccccc", kind: "speed", params: { rate: "1/1" } },
    ];
    original.sequences[0]!.clips[1]!.transitionAfter = {
      id: "trn_aaaaaaaaaa",
      preset: "built-in-cut",
      duration: { frames: 2, fps: "24/1" },
    };
    const engine = new OperationEngine(original, { idFactory });

    const result = await valueOf(engine.execute([
      {
        op: "clip.join",
        params: {
          clipIds: ["clp_aaaaaaaaaa", "clp_bbbbbbbbbb"],
        },
      },
    ], context()));

    expect(engine.currentProject.sequences[0]!.clips).toHaveLength(1);
    expect(engine.currentProject.sequences[0]!.clips[0]).toMatchObject({
      id: "clp_aaaaaaaaaa",
      source: {
        in: { frames: 0, fps: "24/1" },
        out: { frames: 48, fps: "24/1" },
      },
      transitionAfter: original.sequences[0]!.clips[1]!.transitionAfter,
    });
    expect(result.applied[0]!.inverse).toEqual([
      {
        op: "clip.split",
        params: {
          clipId: "clp_aaaaaaaaaa",
          at: 24,
          newClipId: "clp_bbbbbbbbbb",
          newEffectIds: ["fx_cccccccccc"],
        },
      },
    ]);
    expect(result.applied[0]!.affected).toEqual([
      "clp_aaaaaaaaaa",
      "clp_bbbbbbbbbb",
      "fx_cccccccccc",
    ]);
    expect(result.diff.entries).toContainEqual(expect.objectContaining({
      entityId: "fx_cccccccccc",
      change: "removed",
    }));
    expect(result.diff.entries.find(({ entityId }) => entityId === "clp_aaaaaaaaaa")?.fields)
      .toContainEqual({
        field: "transitionAfter",
        after: original.sequences[0]!.clips[1]!.transitionAfter,
      });

    await valueOf(engine.execute(result.applied[0]!.inverse, context("rev_00002")));
    const restored = engine.currentProject.sequences[0]!.clips;
    expect(restored.map(({ source }) => source)).toEqual(
      original.sequences[0]!.clips.map(({ source }) => source),
    );
    expect(restored.map(({ id }) => id)).toEqual([
      "clp_aaaaaaaaaa",
      "clp_bbbbbbbbbb",
    ]);
    expect(moduloGeneratedClipIds(engine.currentProject)).toEqual(
      moduloGeneratedClipIds(original),
    );
  });

  it("removes one clip and restores its complete payload at the captured index", async () => {
    const original = projectFixture();
    original.sequences[0]!.clips[0]!.audio = { gainDb: -3 };
    const engine = new OperationEngine(original, { idFactory });

    const removed = await valueOf(engine.execute([{
      op: "clip.remove",
      params: { clipId: "clp_aaaaaaaaaa" },
    }], context()));

    expect(engine.currentProject.sequences[0]!.clips.map(({ id }) => id)).toEqual([
      "clp_bbbbbbbbbb",
    ]);
    expect(removed.applied[0]!.inverse).toEqual([{
      op: "clip.restore",
      params: {
        sequenceId: "seq_aaaaaaaaaa",
        targetIndex: 0,
        clips: [original.sequences[0]!.clips[0]],
      },
    }]);

    await valueOf(engine.execute(removed.applied[0]!.inverse, context("rev_00002")));
    expect(withoutRevision(engine.currentProject)).toEqual(withoutRevision(original));
  });

  it("attaches non-blocking continuity guard warnings to the operation that moved a cut", async () => {
    const warning = {
      code: "clipped-phoneme-risk" as const,
      severity: "warning" as const,
      boundary: { beforeClip: "clp_aaaaaaaaaa", afterClip: CLIP_ID },
      evidence: "Cut lies inside the word hello.",
    };
    const engine = new OperationEngine(projectFixture(), {
      idFactory,
      continuityGuard: async ({ operation }) =>
        operation.op === "clip.split" ? [warning] : [],
    });

    const result = await valueOf(engine.execute([{
      op: "clip.split",
      params: { clipId: "clp_aaaaaaaaaa", at: 12 },
    }], context()));

    expect(result.applied[0]!.warnings).toEqual([warning]);
    expect(engine.currentProject.sequences[0]!.clips).toHaveLength(3);
  });

  it("does not block an edit when a continuity evidence provider fails", async () => {
    const engine = new OperationEngine(projectFixture(), {
      continuityGuard: async () => {
        throw new Error("stale peaks cache");
      },
    });

    const result = await valueOf(engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
        snapPolicy: "none",
      },
    }], context()));

    expect(result.applied[0]!.warnings).toEqual([]);
  });

  it.each([
    {
      name: "stale base",
      batch: [{ op: "clip.trim", params: {} }],
      ctx: context("rev_00000"),
      code: "E_OP_STALE_BASE",
    },
    {
      name: "unknown operation",
      batch: [{ op: "clip.teleport", params: {} }],
      ctx: context(),
      code: "E_OP_UNKNOWN",
    },
    {
      name: "schema-invalid operation",
      batch: [{ op: "clip.trim", params: { clipId: "bad" } }],
      ctx: context(),
      code: "E_OP_SCHEMA",
    },
  ] satisfies Array<{
    name: string;
    batch: OperationInput[];
    ctx: OperationContext;
    code: string;
  }>)("rejects $name", async ({ batch, ctx, code }) => {
    const original = projectFixture();
    const engine = new OperationEngine(original, { idFactory });
    const result = await engine.execute(batch, ctx);

    expect(result).toMatchObject({
      ok: false,
      error: { code, acceptedStateChanged: false },
    });
    expect(engine.currentProject).toBe(original);
  });

  it("rejects trim extension outside known asset bounds", async () => {
    const original = projectFixture();
    const engine = new OperationEngine(original, { idFactory });
    const result = await engine.execute([
      {
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "head",
          delta: { frames: -1, fps: "24/1" },
        },
      },
    ], context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_RANGE_OUT_OF_BOUNDS" },
    });
  });

  it("rejects trim delta rates that differ from the asset rate", async () => {
    const engine = new OperationEngine(projectFixture(), { idFactory });
    const result = await engine.execute([
      {
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: 1, fps: "30/1" },
        },
      },
    ], context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_RATE_MISMATCH" },
    });
  });

  it("clearly rejects deferred word anchors for split", async () => {
    const engine = new OperationEngine(projectFixture(), { idFactory });
    const result = await engine.execute([
      {
        op: "clip.split",
        params: {
          clipId: "clp_aaaaaaaaaa",
          at: "word:w000001",
        },
      },
    ], context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_SCHEMA" },
    });
    if (!result.ok) expect(result.error.message).toContain("deferred until transcripts");
  });

  it("rejects joins that would discard an internal boundary or differing clip state", async () => {
    const cases: GuyditorProject[] = [projectFixture(), projectFixture()];
    cases[0]!.sequences[0]!.clips[1]!.gapBefore = { frames: 1, fps: "24/1" };
    cases[1]!.sequences[0]!.clips[1]!.effects = [
      { id: "fx_aaaaaaaaaa", kind: "speed", params: { rate: "2/1" } },
    ];

    for (const project of cases) {
      const engine = new OperationEngine(project, { idFactory });
      const result = await engine.execute([
        {
          op: "clip.join",
          params: { clipIds: ["clp_aaaaaaaaaa", "clp_bbbbbbbbbb"] },
        },
      ], context());
      expect(result).toMatchObject({
        ok: false,
        error: { code: "E_OP_RANGE_OUT_OF_BOUNDS" },
      });
    }
  });

  it("dry-runs without changing the accepted model or allocating a transaction", async () => {
    const original = projectFixture();
    const engine = new OperationEngine(original, { idFactory });
    const result: OperationBatchResult = await valueOf(engine.execute([
      {
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: 1, fps: "24/1" },
        },
      },
    ], context("rev_00001", true)));

    expect(engine.currentProject).toBe(original);
    expect(result).not.toHaveProperty("transactionId");
  });

  it("commits one transaction record through the injected store seam", async () => {
    const original = projectFixture();
    let committed: GuyditorProject | undefined;
    let transaction: TransactionRecord | undefined;
    const engine = new OperationEngine(original, {
      idFactory,
      appVersion: "0.0.0-test",
      now: () => new Date("2026-07-18T12:00:00Z"),
      committer: {
        async commit(model, record) {
          committed = model;
          transaction = record;
          return { ok: true, value: model };
        },
      },
    });

    const result = await valueOf(engine.execute([
      {
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: 1, fps: "24/1" },
        },
      },
    ], context()));

    expect(committed?.revision).toBe("rev_00002");
    expect(transaction).toMatchObject({
      id: TXN_ID,
      baseRevision: "rev_00001",
      resultRevision: "rev_00002",
      operations: [{
        op: "clip.trim",
        inverse: {
          op: "clip.trim",
          params: {
            clipId: "clp_aaaaaaaaaa",
            edge: "tail",
            delta: { frames: -1, fps: "24/1" },
          },
        },
      }],
      instruction: { kind: "ui-direct" },
      actor: { kind: "human", id: "ui" },
      versions: { app: "0.0.0-test", schema: "guyditor/v1" },
      acceptance: {
        status: "accepted",
        by: "ui",
        at: "2026-07-18T12:00:00.000Z",
      },
      orphanedAnchors: [],
      addresses: [],
    });
    expect(result.transactionId).toBe(TXN_ID);
  });
});
