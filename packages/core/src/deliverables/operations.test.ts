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

  it("stores a shot framing override in the master and records framing divergence", async () => {
    const derived = valueOf(await applyDeliverableOperation(
      projectFixture(), deriveInput(), idFactory,
    )).model;
    const engine = new OperationEngine(derived, { idFactory });
    const operation = {
      op: "deliverable.framing.override",
      params: {
        deliverableId: DERIVED_IDS.deliverableId,
        override: {
          id: "fov_aaaaaaaaaa",
          decisionId: "fd_0001",
          crop: { keyframes: [{
            at: { frames: 4, fps: "24/1" },
            rect: { x: 0.25, y: 0, w: 0.31640625, h: 1 },
          }] },
          note: "Keep the presenter on the left third",
        },
      },
    };
    const applied = await engine.execute([operation], {
      baseRevision: derived.revision,
      origin: "ui",
      dryRun: false,
      divergence: "framing",
    });
    expect(applied.ok).toBe(true);
    expect(engine.currentProject.deliverables.at(-1)).toMatchObject({
      framingOverrides: [{ id: "fov_aaaaaaaaaa", decisionId: "fd_0001" }],
      divergences: [{ class: "framing", transactionIds: ["txn_bbbbbbbbbb"] }],
    });
  });

  it("retains a creator crop override when a stale short is re-derived", async () => {
    const derived = valueOf(await applyDeliverableOperation(
      projectFixture(), deriveInput(), idFactory,
    )).model;
    derived.deliverables.at(-1)!.status = "stale";
    const engine = new OperationEngine(derived, { idFactory });
    valueOf(await engine.execute([{
      op: "deliverable.framing.override",
      params: {
        deliverableId: DERIVED_IDS.deliverableId,
        override: {
          id: "fov_aaaaaaaaaa",
          decisionId: "fd_0001",
          crop: { keyframes: [{
            at: { frames: 4, fps: "24/1" },
            rect: { x: 0.25, y: 0, w: 0.31640625, h: 1 },
          }] },
        },
      },
    }], { baseRevision: derived.revision, origin: "ui", dryRun: false, divergence: "framing" }));
    const short = engine.currentProject.deliverables.at(-1)!;
    const sequence = engine.currentProject.sequences.find(({ id }) => id === short.sequenceId)!;
    const refreshed = valueOf(await applyDeliverableOperation(engine.currentProject, {
      op: "deliverable.refresh",
      params: {
        deliverableId: short.id,
        clips: sequence.clips,
        dependencies: short.dependencies,
      },
    }, idFactory)).model;

    expect(refreshed.deliverables.at(-1)).toMatchObject({
      status: "in-review",
      framingOverrides: [{ id: "fov_aaaaaaaaaa", decisionId: "fd_0001" }],
    });
  });

  it("records low-risk metadata edits and approves publish artifacts at the result revision", async () => {
    const project = projectFixture();
    const engine = new OperationEngine(project, { idFactory });
    const metadata = {
      format: "guyditor-publish/v1",
      deliverableId: "dlv_aaaaaaaaaa",
      profile: "youtube@1.0.0",
      language: "en",
      title: "Exact cuts",
      description: "A deterministic editing workflow.",
      tags: ["editing"],
      hashtags: ["#editing"],
      status: "draft",
    } as const;
    const dryRun = await engine.execute([{
      op: "deliverable.metadata.set",
      params: { deliverableId: "dlv_aaaaaaaaaa", metadata },
    }], { baseRevision: project.revision, origin: "ui", dryRun: true });
    expect(dryRun).toMatchObject({ ok: true, value: { riskClass: "low" } });

    const saved = await engine.execute([{
      op: "deliverable.metadata.set",
      params: { deliverableId: "dlv_aaaaaaaaaa", metadata },
    }, {
      op: "deliverable.chapters.set",
      params: {
        deliverableId: "dlv_aaaaaaaaaa",
        chapters: {
          format: "guyditor-chapters/v1",
          deliverableId: "dlv_aaaaaaaaaa",
          derivedAtRevision: "rev_00001",
          status: "draft",
          chapters: [
            { beatId: "beat_aaaaaaaaaa", title: "Intro", startSeconds: 0 },
            { beatId: "beat_bbbbbbbbbb", title: "Middle", startSeconds: 30 },
            { beatId: "beat_cccccccccc", title: "End", startSeconds: 60 },
          ],
          textSha256: "b".repeat(64),
        },
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: false });
    expect(saved.ok).toBe(true);
    expect(engine.currentProject.deliverables[0]?.publish).toMatchObject({
      metadata,
      chapters: { status: "draft", textSha256: "b".repeat(64) },
    });

    const approved = await engine.execute([{
      op: "deliverable.publish.approve",
      params: { deliverableId: "dlv_aaaaaaaaaa", targets: ["metadata", "chapters"] },
    }], {
      baseRevision: engine.currentProject.revision,
      origin: "ui",
      dryRun: false,
    });
    expect(approved.ok).toBe(true);
    expect(engine.currentProject.deliverables[0]?.publish).toMatchObject({
      metadata: { status: "approved", approvedRevision: "rev_00003" },
      chapters: { status: "approved", approvedRevision: "rev_00003" },
    });
  });

  it("selects a thumbnail through a reversible creator operation", async () => {
    const project = projectFixture();
    const first = valueOf(await applyDeliverableOperation(project, {
      op: "deliverable.thumbnail.select",
      params: { deliverableId: "dlv_aaaaaaaaaa", composition: "hero" },
    }, idFactory));
    expect(first.model.deliverables[0]?.publish?.selectedThumbnail).toBe("hero");
    expect(first.inverse).toEqual([{
      op: "deliverable.thumbnail.select",
      params: { deliverableId: "dlv_aaaaaaaaaa", composition: null },
    }]);
  });

  it("registers hashed publish files in deterministic path order", async () => {
    const engine = new OperationEngine(projectFixture(), { idFactory });
    const saved = await engine.execute([{
      op: "deliverable.publish.files.set",
      params: {
        deliverableId: "dlv_aaaaaaaaaa",
        files: [
          { path: "publish/dlv_aaaaaaaaaa/transcript.txt", sha256: "b".repeat(64) },
          { path: "publish/dlv_aaaaaaaaaa/metadata.yaml", sha256: "a".repeat(64) },
        ],
      },
    }], { baseRevision: "rev_00001", origin: "ui", dryRun: false });

    expect(saved).toMatchObject({ ok: true, value: { riskClass: "low" } });
    expect(engine.currentProject.deliverables[0]!.publishFiles).toEqual([
      { path: "publish/dlv_aaaaaaaaaa/metadata.yaml", sha256: "a".repeat(64) },
      { path: "publish/dlv_aaaaaaaaaa/transcript.txt", sha256: "b".repeat(64) },
    ]);
  });
});
