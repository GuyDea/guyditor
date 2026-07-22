import { describe, expect, it } from "vitest";

import type { IdPrefix, Result, TransactionRecord } from "../index.js";
import {
  OperationEngine,
  applyDeliverableOperation,
  validateProject,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const DERIVED_IDS = {
  deliverableId: "dlv_bbbbbbbbbb",
  sequenceId: "seq_bbbbbbbbbb",
  layerId: "lyr_bbbbbbbbbb",
  captionsTrackId: "cts_bbbbbbbbbb",
  clipIds: ["clp_cccccccccc"],
};

function idFactory(prefix: IdPrefix): string {
  const ids: Partial<Record<IdPrefix, string>> = {
    dlv: DERIVED_IDS.deliverableId,
    seq: DERIVED_IDS.sequenceId,
    lyr: DERIVED_IDS.layerId,
    cts: DERIVED_IDS.captionsTrackId,
    clp: DERIVED_IDS.clipIds[0],
    txn: "txn_bbbbbbbbbb",
  };
  return ids[prefix] ?? `${prefix}_bbbbbbbbbb`;
}

function deriveInput() {
  return {
    op: "deliverable.derive",
    params: {
      kind: "short",
      name: "Hook cut",
      profile: "youtube-shorts@1.0.0",
      from: { words: { startWordId: "w000010", endWordId: "w000019" } },
      resolvedSources: [{
        assetId: "ast_aaaaaaaaaa",
        range: {
          start: { frames: 4, fps: "24/1" },
          end: { frames: 20, fps: "24/1" },
        },
        words: { startWordId: "w000010", endWordId: "w000019" },
        longformClipId: "clp_aaaaaaaaaa",
      }],
      created: DERIVED_IDS,
    },
  };
}

function valueOf<Value>(result: Result<Value>): Value {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("deliverable lifecycle and derivative independence", () => {
  it("requires exactly one long-form deliverable and exclusive sequence ownership", () => {
    const duplicateLongform = projectFixture();
    duplicateLongform.deliverables.push({
      ...structuredClone(duplicateLongform.deliverables[0]!),
      id: "dlv_bbbbbbbbbb",
    });
    expect(validateProject(duplicateLongform)).toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_INVARIANT", affected: ["dlv_aaaaaaaaaa", "dlv_bbbbbbbbbb"] },
    });

    const sharedSequence = projectFixture();
    sharedSequence.deliverables.push({
      id: "dlv_bbbbbbbbbb",
      kind: "short",
      name: "Shared",
      profile: "youtube-shorts@1.0.0",
      sequenceId: "seq_aaaaaaaaaa",
      status: "draft",
    });
    expect(validateProject(sharedSequence)).toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_INVARIANT", affected: ["dlv_aaaaaaaaaa", "dlv_bbbbbbbbbb"] },
    });
  });

  it("derives an independent short sequence with exact clip dependencies", async () => {
    const project = projectFixture();
    const applied = valueOf(await applyDeliverableOperation(project, deriveInput(), idFactory));
    const short = applied.model.deliverables.find(({ id }) => id === DERIVED_IDS.deliverableId);
    const sequence = applied.model.sequences.find(({ id }) => id === DERIVED_IDS.sequenceId);

    expect(short).toEqual(expect.objectContaining({
      id: DERIVED_IDS.deliverableId,
      kind: "short",
      status: "draft",
      profile: "youtube-shorts@1.0.0",
      sequenceId: DERIVED_IDS.sequenceId,
      captionsTrackId: DERIVED_IDS.captionsTrackId,
      dependencies: [{
        derivativeClipId: DERIVED_IDS.clipIds[0],
        source: {
          assetId: "ast_aaaaaaaaaa",
          range: {
            start: { frames: 4, fps: "24/1" },
            end: { frames: 20, fps: "24/1" },
          },
          words: { startWordId: "w000010", endWordId: "w000019" },
          longformClipId: "clp_aaaaaaaaaa",
        },
      }],
    }));
    expect(sequence?.clips).toEqual([{
      id: DERIVED_IDS.clipIds[0],
      asset: "ast_aaaaaaaaaa",
      source: {
        in: { frames: 4, fps: "24/1" },
        out: { frames: 20, fps: "24/1" },
      },
    }]);
    expect(sequence).not.toBe(project.sequences[0]);
    expect(applied.model.sequences[0]).toEqual(project.sequences[0]);
  });

  it("copies the complete long-form layer stack and remaps internal references", async () => {
    const project = projectFixture();
    project.layers.push({
      id: "lyr_cccccccccc",
      kind: "matte",
      name: "Presenter matte",
      order: -1,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    });
    project.layers[0]!.matte = {
      layerId: "lyr_cccccccccc",
      source: "alpha",
    };
    const input = deriveInput();
    const applied = valueOf(await applyDeliverableOperation(project, {
      ...input,
      params: {
        ...input.params,
        created: {
          ...DERIVED_IDS,
          additionalLayerIds: ["lyr_dddddddddd"],
        },
      },
    }, idFactory));
    const copied = applied.model.layers.filter(({ sequence }) =>
      sequence === DERIVED_IDS.sequenceId);

    expect(copied).toHaveLength(2);
    expect(copied).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: DERIVED_IDS.layerId,
        matte: { layerId: "lyr_dddddddddd", source: "alpha" },
      }),
      expect.objectContaining({ id: "lyr_dddddddddd", kind: "matte" }),
    ]));
    expect(applied.model.captions.at(-1)?.sourceLayerIds).toEqual([DERIVED_IDS.layerId]);
    expect(project.layers).toHaveLength(2);
  });

  it("enforces draft to in-review to approved and records the approval result revision", async () => {
    let project = valueOf(await applyDeliverableOperation(projectFixture(), deriveInput(), idFactory)).model;
    project = valueOf(await applyDeliverableOperation(project, {
      op: "deliverable.status.set",
      params: { deliverableId: DERIVED_IDS.deliverableId, status: "in-review" },
    }, idFactory)).model;
    const approved = valueOf(await applyDeliverableOperation(project, {
      op: "deliverable.approve",
      params: { deliverableId: DERIVED_IDS.deliverableId },
    }, idFactory)).model;

    expect(approved.deliverables.at(-1)).toMatchObject({
      status: "approved",
      approvedRevision: "rev_00002",
    });
    const invalid = await applyDeliverableOperation(approved, {
      op: "deliverable.status.set",
      params: { deliverableId: DERIVED_IDS.deliverableId, status: "in-review" },
    }, idFactory);
    expect(invalid).toMatchObject({ ok: false, error: { code: "E_DELIVERABLE_STATUS" } });
  });

  it("requires proposals for derive and refresh operations", async () => {
    const project = projectFixture();
    const engine = new OperationEngine(project, { idFactory });

    await expect(engine.execute([deriveInput()], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "E_OP_PROPOSAL_REQUIRED", acceptedStateChanged: false },
    });
  });

  it("rejects unclassified derivative edits and journals classified divergence", async () => {
    const derived = valueOf(await applyDeliverableOperation(projectFixture(), deriveInput(), idFactory)).model;
    let transaction: TransactionRecord | undefined;
    const committer = {
      commit: (model: typeof derived, record: TransactionRecord) => {
        transaction = record;
        return Promise.resolve({ ok: true as const, value: model });
      },
    };
    const unclassified = new OperationEngine(derived, { idFactory, committer });
    const rejected = await unclassified.execute([{
      op: "clip.trim",
      params: {
        clipId: DERIVED_IDS.clipIds[0],
        edge: "tail",
        delta: { frames: 2, fps: "24/1" },
      },
    }], { baseRevision: derived.revision, origin: "ui", dryRun: false });
    expect(rejected).toMatchObject({ ok: false, error: { code: "E_DIVERGENCE_REQUIRED" } });

    const classified = new OperationEngine(derived, { idFactory, committer });
    const accepted = await classified.execute([{
      op: "clip.trim",
      params: {
        clipId: DERIVED_IDS.clipIds[0],
        edge: "tail",
        delta: { frames: 2, fps: "24/1" },
      },
    }], {
      baseRevision: derived.revision,
      origin: "ui",
      dryRun: false,
      divergence: "cuts",
    });
    expect(accepted.ok).toBe(true);
    expect(transaction?.divergence).toBe("cuts");
    expect(classified.currentProject.deliverables.at(-1)?.divergences).toEqual([{
      class: "cuts",
      transactionIds: ["txn_bbbbbbbbbb"],
    }]);
    expect(classified.currentProject.deliverables.at(-1)?.dependencies?.[0]?.source.range.end)
      .toEqual({ frames: 18, fps: "24/1" });
  });

  it("follows split provenance and marks inserted derivative clips local", async () => {
    const derived = valueOf(await applyDeliverableOperation(projectFixture(), deriveInput(), idFactory)).model;
    const splitEngine = new OperationEngine(derived, { idFactory });
    const split = await splitEngine.execute([{
      op: "clip.split",
      params: { clipId: DERIVED_IDS.clipIds[0], at: 8, newClipId: "clp_dddddddddd" },
    }], {
      baseRevision: derived.revision,
      origin: "ui",
      dryRun: false,
      divergence: "cuts",
    });
    expect(split.ok).toBe(true);
    expect(splitEngine.currentProject.deliverables.at(-1)?.dependencies).toEqual([
      expect.objectContaining({
        derivativeClipId: DERIVED_IDS.clipIds[0],
        source: expect.objectContaining({ range: {
          start: { frames: 4, fps: "24/1" },
          end: { frames: 12, fps: "24/1" },
        } }),
      }),
      expect.objectContaining({
        derivativeClipId: "clp_dddddddddd",
        source: expect.objectContaining({ range: {
          start: { frames: 12, fps: "24/1" },
          end: { frames: 20, fps: "24/1" },
        } }),
      }),
    ]);

    const insertEngine = new OperationEngine(derived, { idFactory });
    const inserted = await insertEngine.execute([{
      op: "clip.insert",
      params: {
        sequenceId: DERIVED_IDS.sequenceId,
        layerId: DERIVED_IDS.layerId,
        index: 1,
        clipId: "clp_eeeeeeeeee",
        source: {
          assetId: "ast_aaaaaaaaaa",
          in: { frames: 30, fps: "24/1" },
          out: { frames: 36, fps: "24/1" },
        },
      },
    }], {
      baseRevision: derived.revision,
      origin: "ui",
      dryRun: false,
      divergence: "cta",
    });
    expect(inserted.ok).toBe(true);
    expect(insertEngine.currentProject.sequences.at(-1)?.clips.at(-1)?.origin).toBe("local");
    expect(insertEngine.currentProject.deliverables.at(-1)?.dependencies).toHaveLength(1);
  });
});
