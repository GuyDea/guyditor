import { describe, expect, it } from "vitest";

import {
  failure,
  makeGuyditorError,
  OperationEngine,
  success,
} from "../index.js";
import type {
  IdPrefix,
  OperationCommitter,
  Result,
  TransactionRecord,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const TEMPLATE_ID = "tpl_a2c3d4e5f6";
const TEMPLATE_HASH = "b".repeat(64);

const descriptor = {
  schema: "guyditor/template/v1" as const,
  id: TEMPLATE_ID,
  name: "Brand lower third",
  kind: "lower_third" as const,
  version: "1.0.0",
  engine: "overlay/v1" as const,
  duration: {
    mode: "fixed" as const,
    default: { frames: 90, fps: "24/1" },
  },
  params: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
      title: { type: "string", maxLength: 60 },
      accent: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    },
  },
  contentHash: TEMPLATE_HASH,
};

function ids(prefix: IdPrefix): string {
  const values: Partial<Record<IdPrefix, string>> = {
    gfx: "gfx_bbbbbbbbbb",
    lyr: "lyr_bbbbbbbbbb",
    txn: "txn_bbbbbbbbbb",
  };
  return values[prefix] ?? `${prefix}_cccccccccc`;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function grandfatheredGraphicProject() {
  const project = projectFixture();
  project.sequences.push({
    id: "seq_bbbbbbbbbb",
    name: "sibling",
    clips: [],
  });
  project.templates = {
    [TEMPLATE_ID]: { version: descriptor.version, contentHash: descriptor.contentHash },
  };
  const graphic = {
    id: "gfx_bbbbbbbbbb",
    template: TEMPLATE_ID,
    at: "timeline:seq_aaaaaaaaaa@4",
    duration: { until: "timeline:seq_bbbbbbbbbb@12" },
    params: { title: "Grandfathered" },
    seed: 7,
    layout: { align: "safe-title-left" },
  };
  project.layers.push({
    id: "lyr_bbbbbbbbbb",
    kind: "animation",
    name: "Graphics",
    order: 1,
    enabled: true,
    locked: false,
    items: [graphic],
  });
  return { project, graphic };
}

function explicitUnresolvedGraphicProject() {
  const project = projectFixture();
  project.templates = {
    [TEMPLATE_ID]: { version: descriptor.version, contentHash: descriptor.contentHash },
  };
  const graphic = {
    id: "gfx_bbbbbbbbbb",
    sequenceId: "seq_aaaaaaaaaa",
    template: TEMPLATE_ID,
    at: "clip:clp_dddddddddd@0",
    duration: { frames: 12, fps: "24/1" },
    params: { title: "Unresolved" },
    seed: 7,
  };
  project.layers.push({
    id: "lyr_bbbbbbbbbb",
    kind: "animation",
    name: "Graphics",
    order: 1,
    enabled: true,
    locked: false,
    items: [graphic],
  });
  return { project, graphic };
}

function templateProvider() {
  return {
    latest: () => Promise.resolve(success(descriptor)),
    get: () => Promise.resolve(success(descriptor)),
  };
}

function transactionCommitter(): {
  committer: OperationCommitter;
  transactions: TransactionRecord[];
} {
  const transactions: TransactionRecord[] = [];
  return {
    transactions,
    committer: {
      async commit(model, transaction) {
        transactions.push(structuredClone(transaction));
        return success(model);
      },
      async readTransaction(id) {
        const transaction = transactions.find((candidate) => candidate.id === id);
        return transaction === undefined
          ? failure(makeGuyditorError(
              "E_PROJECT_TRANSACTION",
              `Transaction ${id} was not found.`,
              { affected: [id] },
            ))
          : success(structuredClone(transaction));
      },
    },
  };
}

function spareGraphicLayer() {
  return {
    id: "lyr_cccccccccc",
    kind: "animation" as const,
    name: "Spare graphics",
    order: 2,
    enabled: true,
    locked: false,
    items: [],
  };
}

async function historicalGraphicConflict() {
  const project = projectFixture();
  project.sequences.push({
    id: "seq_bbbbbbbbbb",
    name: "sibling",
    clips: [],
  });
  project.templates = {
    [TEMPLATE_ID]: { version: descriptor.version, contentHash: descriptor.contentHash },
  };
  const graphic = {
    id: "gfx_bbbbbbbbbb",
    template: TEMPLATE_ID,
    at: "timeline:seq_aaaaaaaaaa@4",
    duration: { frames: 12, fps: "24/1" },
    params: { title: "Initially valid" },
    seed: 7,
  };
  project.layers.push({
    id: "lyr_bbbbbbbbbb",
    kind: "animation",
    name: "Graphics",
    order: 1,
    enabled: true,
    locked: false,
    items: [graphic],
  });
  const { committer } = transactionCommitter();
  const engine = new OperationEngine(project, {
    committer,
    templateProvider: templateProvider(),
  });
  const reanchored = await valueOf(engine.execute([{
    op: "graphic.anchor.set",
    params: {
      graphicId: graphic.id,
      anchor: "word:w000001",
    },
  }], {
    baseRevision: project.revision,
    origin: "ui",
    dryRun: false,
    recordUndo: false,
  }));
  await valueOf(engine.execute([{
    op: "graphic.retime",
    params: {
      graphicId: graphic.id,
      duration: { until: "timeline:seq_bbbbbbbbbb@12" },
    },
  }], {
    baseRevision: engine.currentProject.revision,
    origin: "ui",
    dryRun: false,
    recordUndo: false,
  }));
  return {
    accepted: structuredClone(engine.currentProject),
    committer,
    reanchored,
  };
}

describe("FR-600/601 graphic operation catalog", () => {
  it("keeps an unreviewed authored template out of accepted graphic placements", async () => {
    const project = projectFixture();
    const engine = new OperationEngine(project, {
      templateProvider: {
        latest: () => Promise.resolve(success({ ...descriptor, reviewState: "draft" as const })),
        get: () => Promise.resolve(success({ ...descriptor, reviewState: "draft" as const })),
      },
    });

    await expect(engine.execute([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        anchor: "timeline:seq_aaaaaaaaaa@4",
        duration: { frames: 48, fps: "24/1" },
        params: { title: "Unreviewed", accent: "#ff5a1f" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "E_TEMPLATE_UNREVIEWED", acceptedStateChanged: false },
    });
  });

  it("pins the latest template on first use and stores a seeded gfx PlacedItem", async () => {
    const project = projectFixture();
    const provider = {
      latest: () => Promise.resolve(success(descriptor)),
      get: () => Promise.resolve(success(descriptor)),
    };
    const engine = new OperationEngine(project, {
      idFactory: ids,
      templateProvider: provider,
      seedFactory: () => 0x1234_5678,
    });

    const applied = await valueOf(engine.execute([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        anchor: "timeline:seq_aaaaaaaaaa@4",
        duration: { frames: 48, fps: "24/1" },
        params: { title: "Deterministic graphics", accent: "#ff5a1f" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));

    expect(engine.currentProject.templates).toEqual({
      [TEMPLATE_ID]: { version: "1.0.0", contentHash: TEMPLATE_HASH },
    });
    expect(engine.currentProject.layers.at(-1)).toMatchObject({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      items: [{
        id: "gfx_bbbbbbbbbb",
        template: TEMPLATE_ID,
        at: "timeline:seq_aaaaaaaaaa@4",
        duration: { frames: 48, fps: "24/1" },
        params: { title: "Deterministic graphics", accent: "#ff5a1f" },
        seed: 0x1234_5678,
      }],
    });
    expect(applied.applied[0]).toMatchObject({
      op: "graphic.add",
      params: { graphicId: "gfx_bbbbbbbbbb", layerId: "lyr_bbbbbbbbbb", seed: 0x1234_5678 },
      summary: "Add Brand lower third ‘Deterministic graphics’ at timeline:seq_aaaaaaaaaa@4",
    });
  });

  it("stores explicit sequence ownership and preserves it through redo and remove undo", async () => {
    const project = projectFixture();
    const provider = {
      latest: () => Promise.resolve(success(descriptor)),
      get: () => Promise.resolve(success(descriptor)),
    };
    const engine = new OperationEngine(project, {
      idFactory: ids,
      templateProvider: provider,
      seedFactory: () => 7,
    });

    const added = await valueOf(engine.execute([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        sequenceId: "seq_aaaaaaaaaa",
        anchor: "word:w000001",
        duration: { frames: 12, fps: "24/1" },
        params: { title: "Scoped" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));

    expect(engine.currentProject.layers.at(-1)?.items?.[0]).toMatchObject({
      id: "gfx_bbbbbbbbbb",
      sequenceId: "seq_aaaaaaaaaa",
    });
    expect(added.applied[0]).toBeDefined();
    await valueOf(engine.undo());
    expect(engine.currentProject.layers.at(-1)?.items).toEqual([]);
    await valueOf(engine.redo());
    expect(engine.currentProject.layers.at(-1)?.items?.[0]).toMatchObject({
      id: "gfx_bbbbbbbbbb",
      sequenceId: "seq_aaaaaaaaaa",
    });
    const scopedGraphic = structuredClone(engine.currentProject.layers.at(-1)!.items![0]!);

    const removed = await valueOf(engine.execute([{
      op: "graphic.remove",
      params: { graphicId: "gfx_bbbbbbbbbb" },
    }], {
      baseRevision: engine.currentProject.revision,
      origin: "ui",
      dryRun: false,
    }));
    expect(removed.applied[0]?.inverse).toMatchObject([{
      op: "graphic.add",
      params: {
        sequenceId: "seq_aaaaaaaaaa",
        restoreIndex: 0,
        restore: scopedGraphic,
      },
    }]);
  });

  it("rejects a newly added graphic whose anchor conflicts with or cannot resolve for explicit ownership", async () => {
    const project = projectFixture();
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "sibling",
      clips: [],
    });
    const provider = {
      latest: () => Promise.resolve(success(descriptor)),
      get: () => Promise.resolve(success(descriptor)),
    };
    const engine = new OperationEngine(project, {
      templateProvider: provider,
      seedFactory: () => 7,
    });
    const accepted = structuredClone(project);

    await expect(engine.execute([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        graphicId: "gfx_bbbbbbbbbb",
        sequenceId: "seq_aaaaaaaaaa",
        anchor: "timeline:seq_bbbbbbbbbb@4",
        duration: { frames: 12, fps: "24/1" },
        params: { title: "Conflicting" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "E_GRAPHIC_SEQUENCE_CONFLICT",
        acceptedStateChanged: false,
      },
    });

    await expect(engine.execute([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        graphicId: "gfx_bbbbbbbbbb",
        sequenceId: "seq_aaaaaaaaaa",
        anchor: "clip:clp_dddddddddd@0",
        duration: { frames: 12, fps: "24/1" },
        params: { title: "Unresolved" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "E_GRAPHIC_SEQUENCE_CONFLICT",
        affected: ["gfx_bbbbbbbbbb", "seq_aaaaaaaaaa"],
        acceptedStateChanged: false,
      },
    });
    expect(engine.currentProject).toEqual(accepted);
  });

  it("rejects a newly added legacy-shaped graphic with contradictory inferred scopes", async () => {
    const project = projectFixture();
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "sibling",
      clips: [],
    });
    const provider = {
      latest: () => Promise.resolve(success(descriptor)),
      get: () => Promise.resolve(success(descriptor)),
    };
    const engine = new OperationEngine(project, {
      templateProvider: provider,
      seedFactory: () => 7,
    });
    const accepted = structuredClone(project);

    await expect(engine.execute([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        graphicId: "gfx_bbbbbbbbbb",
        anchor: "timeline:seq_aaaaaaaaaa@4",
        duration: { until: "timeline:seq_bbbbbbbbbb@12" },
        params: { title: "Ambiguous" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "E_GRAPHIC_SEQUENCE_CONFLICT",
        affected: [
          "gfx_bbbbbbbbbb",
          "seq_aaaaaaaaaa",
          "seq_bbbbbbbbbb",
        ],
        acceptedStateChanged: false,
      },
    });
    expect(engine.currentProject).toEqual(accepted);
  });

  it("restores the exact captured grandfathered graphic through its remove inverse", async () => {
    const { project, graphic } = grandfatheredGraphicProject();
    const graphicLayer = project.layers.find(({ id }) => id === "lyr_bbbbbbbbbb")!;
    graphicLayer.items!.push({
      id: "gfx_cccccccccc",
      template: TEMPLATE_ID,
      at: "timeline:seq_aaaaaaaaaa@20",
      duration: { frames: 12, fps: "24/1" },
      params: { title: "Sibling" },
      seed: 8,
    });
    const originalItems = structuredClone(graphicLayer.items!);
    const engine = new OperationEngine(project, {
      templateProvider: templateProvider(),
    });

    const removed = await valueOf(engine.execute([{
      op: "graphic.remove",
      params: { graphicId: graphic.id },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.layers.at(-1)!.items).toEqual(originalItems.slice(1));

    await valueOf(engine.undo());

    expect(removed.applied[0]!.inverse).toEqual([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        layerId: "lyr_bbbbbbbbbb",
        graphicId: graphic.id,
        anchor: graphic.at,
        duration: graphic.duration,
        params: graphic.params,
        seed: graphic.seed,
        restoreIndex: 0,
        restore: graphic,
      },
    }]);
    expect(engine.currentProject.layers.find(({ id }) => id === "lyr_bbbbbbbbbb")!.items)
      .toEqual(originalItems);
  });

  it.each([
    ["unowned contradictory", grandfatheredGraphicProject],
    ["explicit-owner unresolved", explicitUnresolvedGraphicProject],
  ] as const)("rejects direct %s captured restoration without engine authorization", async (
    _kind,
    fixture,
  ) => {
    const { project, graphic } = fixture();
    const engine = new OperationEngine(project, { templateProvider: templateProvider() });
    const removed = await valueOf(engine.execute([{
      op: "graphic.remove",
      params: { graphicId: graphic.id },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));
    const accepted = structuredClone(engine.currentProject);

    await expect(engine.execute(removed.applied[0]!.inverse, {
      baseRevision: engine.currentProject.revision,
      origin: "ui",
      dryRun: false,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "E_OP_CAPTURE_MISMATCH",
        affected: [graphic.id],
        acceptedStateChanged: false,
      },
    });
    expect(engine.currentProject).toEqual(accepted);
  });

  it("restores a captured explicit-owner graphic with a legacy unresolved anchor", async () => {
    const { project, graphic } = explicitUnresolvedGraphicProject();
    const engine = new OperationEngine(project, { templateProvider: templateProvider() });
    await valueOf(engine.execute([{
      op: "graphic.remove",
      params: { graphicId: graphic.id },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));

    await valueOf(engine.undo());
    expect(engine.currentProject.layers.at(-1)!.items).toEqual([graphic]);
  });

  it("authorizes an exact recorded graphic inverse on a fresh engine", async () => {
    const { project, graphic } = grandfatheredGraphicProject();
    const { committer } = transactionCommitter();
    const removing = new OperationEngine(project, {
      committer,
      idFactory: ids,
      templateProvider: templateProvider(),
    });
    const removed = await valueOf(removing.execute([{
      op: "graphic.remove",
      params: { graphicId: graphic.id },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
      recordUndo: false,
    }));
    const fresh = new OperationEngine(removing.currentProject, {
      committer,
      idFactory: ids,
      templateProvider: templateProvider(),
    });

    await valueOf(fresh.execute(removed.applied[0]!.inverse, {
      baseRevision: fresh.currentProject.revision,
      origin: "ui",
      dryRun: false,
      undoOf: removed.transactionId!,
      recordUndo: false,
    }));
    expect(fresh.currentProject.layers.at(-1)!.items).toEqual([graphic]);
  });

  it("restores a captured grandfathered graphic through historical revert", async () => {
    const { project, graphic } = grandfatheredGraphicProject();
    const { committer } = transactionCommitter();
    const removing = new OperationEngine(project, {
      committer,
      templateProvider: templateProvider(),
    });
    const removed = await valueOf(removing.execute([{
      op: "graphic.remove",
      params: { graphicId: graphic.id },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
      recordUndo: false,
    }));
    await valueOf(removing.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
      },
    }], {
      baseRevision: removing.currentProject.revision,
      origin: "system",
      dryRun: false,
      recordUndo: false,
    }));
    const fresh = new OperationEngine(removing.currentProject, {
      committer,
      templateProvider: templateProvider(),
    });

    await valueOf(fresh.revertTransaction(removed.transactionId!));

    expect(fresh.currentProject.layers.at(-1)!.items).toEqual([graphic]);
  });

  it.each(["layout", "addressing", "layer", "undoOf"] as const)(
    "rejects %s tampering against a recorded graphic inverse",
    async (tamper) => {
      const { project, graphic } = grandfatheredGraphicProject();
      project.layers.push(spareGraphicLayer());
      const { committer } = transactionCommitter();
      const removing = new OperationEngine(project, {
        committer,
        idFactory: ids,
        templateProvider: templateProvider(),
      });
      const removed = await valueOf(removing.execute([{
        op: "graphic.remove",
        params: { graphicId: graphic.id },
      }], {
        baseRevision: project.revision,
        origin: "ui",
        dryRun: false,
        recordUndo: false,
      }));
      const fresh = new OperationEngine(removing.currentProject, {
        committer,
        idFactory: ids,
        templateProvider: templateProvider(),
      });
      const requested = structuredClone(removed.applied[0]!.inverse);
      if (tamper === "layout") {
        const restore = requested[0]!.params["restore"] as Record<string, unknown>;
        restore["layout"] = { align: "tampered" };
      } else if (tamper === "addressing") {
        const anchor = "timeline:seq_bbbbbbbbbb@4";
        requested[0]!.params["anchor"] = anchor;
        const restore = requested[0]!.params["restore"] as Record<string, unknown>;
        restore["at"] = anchor;
      } else if (tamper === "layer") {
        requested[0]!.params["layerId"] = "lyr_cccccccccc";
      }
      const accepted = structuredClone(fresh.currentProject);

      await expect(fresh.execute(requested, {
        baseRevision: fresh.currentProject.revision,
        origin: "ui",
        dryRun: false,
        undoOf: tamper === "undoOf" ? "txn_aaaaaaaaaa" : removed.transactionId!,
        recordUndo: false,
      })).resolves.toMatchObject({
        ok: false,
        error: {
          code: "E_OP_UNDO_STALE",
          acceptedStateChanged: false,
        },
      });
      expect(fresh.currentProject).toEqual(accepted);
    },
  );

  it("protects trusted in-memory undo from mutations to the returned inverse", async () => {
    const { project, graphic } = grandfatheredGraphicProject();
    project.layers.push(spareGraphicLayer());
    const engine = new OperationEngine(project, {
      idFactory: ids,
      templateProvider: templateProvider(),
    });
    const removed = await valueOf(engine.execute([{
      op: "graphic.remove",
      params: { graphicId: graphic.id },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));
    const exposed = removed.applied[0]!.inverse[0]!;
    exposed.params["layerId"] = "lyr_cccccccccc";
    const exposedRestore = exposed.params["restore"] as Record<string, unknown>;
    exposedRestore["layout"] = { align: "tampered" };

    await valueOf(engine.undo());
    expect(engine.currentProject.layers.find(({ id }) => id === "lyr_bbbbbbbbbb")!.items)
      .toEqual([graphic]);
    expect(engine.currentProject.layers.find(({ id }) => id === "lyr_cccccccccc")!.items)
      .toEqual([]);
  });

  it("undoes a retime repair back to an unowned grandfathered conflict", async () => {
    const { project, graphic } = grandfatheredGraphicProject();
    const engine = new OperationEngine(project, { templateProvider: templateProvider() });

    await valueOf(engine.execute([{
      op: "graphic.retime",
      params: {
        graphicId: graphic.id,
        duration: { until: "timeline:seq_aaaaaaaaaa@12" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));
    await valueOf(engine.undo());

    expect(engine.currentProject.layers.at(-1)!.items).toMatchObject([graphic]);
  });

  it("authorizes a recorded reanchor repair inverse on a fresh engine", async () => {
    const { project, graphic } = explicitUnresolvedGraphicProject();
    const { committer } = transactionCommitter();
    const repairing = new OperationEngine(project, {
      committer,
      idFactory: ids,
      templateProvider: templateProvider(),
    });
    const repaired = await valueOf(repairing.execute([{
      op: "graphic.anchor.set",
      params: {
        graphicId: graphic.id,
        anchor: "timeline:seq_aaaaaaaaaa@4",
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
      recordUndo: false,
    }));
    const fresh = new OperationEngine(repairing.currentProject, {
      committer,
      idFactory: ids,
      templateProvider: templateProvider(),
    });
    await valueOf(fresh.execute(repaired.applied[0]!.inverse, {
      baseRevision: fresh.currentProject.revision,
      origin: "ui",
      dryRun: false,
      undoOf: repaired.transactionId!,
      recordUndo: false,
    }));

    expect(fresh.currentProject.layers.at(-1)!.items).toMatchObject([graphic]);
  });

  it("rejects an exact recorded graphic inverse after its result revision", async () => {
    const { accepted, committer, reanchored } = await historicalGraphicConflict();
    const fresh = new OperationEngine(accepted, {
      committer,
      templateProvider: templateProvider(),
    });

    await expect(fresh.execute(reanchored.applied[0]!.inverse, {
      baseRevision: fresh.currentProject.revision,
      origin: "ui",
      dryRun: false,
      undoOf: reanchored.transactionId!,
      recordUndo: false,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "E_OP_UNDO_STALE",
        acceptedStateChanged: false,
      },
    });
    expect(fresh.currentProject).toEqual(accepted);
  });

  it("rejects a historical graphic revert that contradicts newer addressing", async () => {
    const { accepted, committer, reanchored } = await historicalGraphicConflict();
    const fresh = new OperationEngine(accepted, {
      committer,
      templateProvider: templateProvider(),
    });

    await expect(fresh.revertTransaction(reanchored.transactionId!)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "E_OP_REVERT_CONFLICT",
        acceptedStateChanged: false,
      },
    });
    expect(fresh.currentProject).toEqual(accepted);
  });

  it("rejects missing sequence ownership and sequence-owned placement layers", async () => {
    const project = projectFixture();
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Scoped graphics",
      order: 1,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    });
    const provider = {
      latest: () => Promise.resolve(success(descriptor)),
      get: () => Promise.resolve(success(descriptor)),
    };
    const missing = new OperationEngine(project, { templateProvider: provider });
    await expect(missing.execute([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        sequenceId: "seq_bbbbbbbbbb",
        anchor: "word:w000001",
        duration: { frames: 12, fps: "24/1" },
        params: { title: "Missing" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "E_OP_NOT_FOUND" },
    });

    const ownedLayer = new OperationEngine(project, { templateProvider: provider });
    await expect(ownedLayer.execute([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        sequenceId: "seq_aaaaaaaaaa",
        layerId: "lyr_bbbbbbbbbb",
        anchor: "word:w000001",
        duration: { frames: 12, fps: "24/1" },
        params: { title: "Do not detach" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "E_GRAPHIC_LAYER_SCOPE" },
    });
  });

  it("rejects reanchor and retime edits that conflict with explicit sequence ownership", async () => {
    const project = projectFixture();
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "short",
      clips: [{
        id: "clp_cccccccccc",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 0, fps: "24/1" },
          out: { frames: 12, fps: "24/1" },
        },
      }],
    });
    project.templates = {
      [TEMPLATE_ID]: { version: descriptor.version, contentHash: descriptor.contentHash },
    };
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Graphics",
      order: 1,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_bbbbbbbbbb",
        sequenceId: "seq_aaaaaaaaaa",
        template: TEMPLATE_ID,
        at: "word:w000001",
        duration: { frames: 12, fps: "24/1" },
        params: { title: "Scoped" },
        seed: 7,
      }],
    });
    const provider = {
      latest: () => Promise.resolve(success(descriptor)),
      get: () => Promise.resolve(success(descriptor)),
    };
    const engine = new OperationEngine(project, { templateProvider: provider });

    for (const operation of [{
      op: "graphic.anchor.set",
      params: {
        graphicId: "gfx_bbbbbbbbbb",
        anchor: "timeline:seq_bbbbbbbbbb@4",
      },
    }, {
      op: "graphic.retime",
      params: {
        graphicId: "gfx_bbbbbbbbbb",
        duration: { until: "timeline:seq_bbbbbbbbbb@12" },
      },
    }, {
      op: "graphic.anchor.set",
      params: {
        graphicId: "gfx_bbbbbbbbbb",
        anchor: "clip:clp_dddddddddd@0",
      },
    }]) {
      await expect(engine.execute([operation], {
        baseRevision: project.revision,
        origin: "ui",
        dryRun: false,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: "E_GRAPHIC_SEQUENCE_CONFLICT" },
      });
    }
  });

  it.each([
    ["graphic.anchor.set", {
      graphicId: "gfx_bbbbbbbbbb",
      anchor: "timeline:seq_bbbbbbbbbb@4",
    }],
    ["graphic.retime", {
      graphicId: "gfx_bbbbbbbbbb",
      duration: { until: "timeline:seq_bbbbbbbbbb@12" },
    }],
  ] as const)("rejects %s when it creates contradictory inferred scopes on a legacy item", async (
    op,
    params,
  ) => {
    const project = projectFixture();
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "sibling",
      clips: [],
    });
    project.templates = {
      [TEMPLATE_ID]: { version: descriptor.version, contentHash: descriptor.contentHash },
    };
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Graphics",
      order: 1,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_bbbbbbbbbb",
        template: TEMPLATE_ID,
        at: "timeline:seq_aaaaaaaaaa@4",
        duration: { until: "timeline:seq_aaaaaaaaaa@12" },
        params: { title: "Legacy" },
        seed: 7,
      }],
    });
    const provider = {
      latest: () => Promise.resolve(success(descriptor)),
      get: () => Promise.resolve(success(descriptor)),
    };
    const engine = new OperationEngine(project, { templateProvider: provider });
    const accepted = structuredClone(project);

    await expect(engine.execute([{ op, params }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "E_GRAPHIC_SEQUENCE_CONFLICT",
        affected: [
          "gfx_bbbbbbbbbb",
          "seq_aaaaaaaaaa",
          "seq_bbbbbbbbbb",
        ],
        acceptedStateChanged: false,
      },
    });
    expect(engine.currentProject).toEqual(accepted);
  });

  it("applies RFC 7386 parameter patches and records a reversible semantic update", async () => {
    const project = projectFixture();
    project.templates = {
      [TEMPLATE_ID]: { version: descriptor.version, contentHash: descriptor.contentHash },
    };
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Graphics",
      order: 1,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_bbbbbbbbbb",
        template: TEMPLATE_ID,
        at: "timeline:seq_aaaaaaaaaa@4",
        duration: { frames: 48, fps: "24/1" },
        params: { title: "Before", accent: "#ff5a1f" },
        seed: 7,
      }],
    });
    const provider = {
      latest: () => Promise.resolve(success(descriptor)),
      get: () => Promise.resolve(success(descriptor)),
    };
    const engine = new OperationEngine(project, { templateProvider: provider });

    const changed = await valueOf(engine.execute([{
      op: "graphic.param.set",
      params: { graphicId: "gfx_bbbbbbbbbb", patch: { title: "After", accent: null } },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));

    expect(engine.currentProject.layers[1]!.items![0]!.params).toEqual({ title: "After" });
    expect(changed.applied[0]).toMatchObject({
      summary: "Update Brand lower third ‘After’",
      inverse: [{
        op: "graphic.param.set",
        params: {
          graphicId: "gfx_bbbbbbbbbb",
          patch: { title: "Before", accent: "#ff5a1f" },
        },
      }],
    });

    await valueOf(engine.execute(changed.applied[0]!.inverse, {
      baseRevision: "rev_00002",
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.layers[1]!.items![0]!.params).toEqual({
      title: "Before",
      accent: "#ff5a1f",
    });
  });

  it("reanchors, retimes, and removes an instance through reversible catalog operations", async () => {
    const project = projectFixture();
    project.templates = {
      [TEMPLATE_ID]: { version: descriptor.version, contentHash: descriptor.contentHash },
    };
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Graphics",
      order: 1,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_bbbbbbbbbb",
        template: TEMPLATE_ID,
        at: "word:w000001",
        duration: "intrinsic",
        params: { title: "Anchored" },
        seed: 9,
      }],
    });
    const provider = {
      latest: () => Promise.resolve(success(descriptor)),
      get: () => Promise.resolve(success(descriptor)),
    };
    const engine = new OperationEngine(project, { templateProvider: provider });

    const updated = await valueOf(engine.execute([
      {
        op: "graphic.anchor.set",
        params: { graphicId: "gfx_bbbbbbbbbb", anchor: "clip:clp_aaaaaaaaaa@3" },
      },
      {
        op: "graphic.retime",
        params: {
          graphicId: "gfx_bbbbbbbbbb",
          duration: { until: "timeline:seq_aaaaaaaaaa@20" },
        },
      },
    ], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.layers[1]!.items![0]).toMatchObject({
      at: "clip:clp_aaaaaaaaaa@3",
      duration: { until: "timeline:seq_aaaaaaaaaa@20" },
    });
    expect(updated.applied.map(({ summary }) => summary)).toEqual([
      "Move Brand lower third to clip:clp_aaaaaaaaaa@3",
      "Retime Brand lower third",
    ]);
    const removedGraphic = structuredClone(engine.currentProject.layers[1]!.items![0]!);

    const removed = await valueOf(engine.execute([{
      op: "graphic.remove",
      params: { graphicId: "gfx_bbbbbbbbbb" },
    }], {
      baseRevision: "rev_00002",
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.layers[1]!.items).toEqual([]);
    expect(removed.applied[0]!.inverse).toEqual([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        layerId: "lyr_bbbbbbbbbb",
        graphicId: "gfx_bbbbbbbbbb",
        anchor: "clip:clp_aaaaaaaaaa@3",
        duration: { until: "timeline:seq_aaaaaaaaaa@20" },
        params: { title: "Anchored" },
        seed: 9,
        restoreIndex: 0,
        restore: removedGraphic,
      },
    }]);
    await valueOf(engine.undo());
    expect(engine.currentProject.layers[1]!.items![0]).toEqual(removedGraphic);
  });

  it("isolates an approved project from installed upgrades until consequential template.pin", async () => {
    const project = projectFixture();
    project.deliverables[0]!.status = "approved";
    project.deliverables[0]!.approvedRevision = project.revision;
    project.templates = {
      [TEMPLATE_ID]: { version: descriptor.version, contentHash: descriptor.contentHash },
    };
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Graphics",
      order: 1,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_bbbbbbbbbb",
        template: TEMPLATE_ID,
        at: "timeline:seq_aaaaaaaaaa@4",
        duration: { frames: 12, fps: "24/1" },
        params: { title: "Pinned" },
        seed: 11,
      }],
    });
    const upgraded = {
      ...descriptor,
      version: "2.0.0",
      contentHash: "c".repeat(64),
    };
    const provider = {
      latest: () => Promise.resolve(success(upgraded)),
      get: (_templateId: string, version: string) =>
        Promise.resolve(success(version === "2.0.0" ? upgraded : descriptor)),
    };
    const engine = new OperationEngine(project, { templateProvider: provider });

    const added = await valueOf(engine.execute([{
      op: "graphic.add",
      params: {
        templateId: TEMPLATE_ID,
        layerId: "lyr_bbbbbbbbbb",
        graphicId: "gfx_cccccccccc",
        anchor: "timeline:seq_aaaaaaaaaa@18",
        duration: { frames: 12, fps: "24/1" },
        params: { title: "Still v1" },
        seed: 12,
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));
    expect(added.riskClass).toBe("normal");
    expect(engine.currentProject.templates![TEMPLATE_ID]).toEqual({
      version: "1.0.0",
      contentHash: TEMPLATE_HASH,
    });

    const pinned = await valueOf(engine.execute([{
      op: "template.pin",
      params: { templateId: TEMPLATE_ID, version: "2.0.0" },
    }], {
      baseRevision: "rev_00002",
      origin: "ui",
      dryRun: false,
    }));
    expect(pinned.riskClass).toBe("consequential");
    expect(pinned.applied[0]).toMatchObject({
      summary: "Upgrade Brand lower third from 1.0.0 to 2.0.0 (2 instances)",
      affected: ["gfx_bbbbbbbbbb", "gfx_cccccccccc"],
      inverse: [{
        op: "template.pin",
        params: { templateId: TEMPLATE_ID, version: "1.0.0" },
      }],
    });
    expect(engine.currentProject.templates![TEMPLATE_ID]).toEqual({
      version: "2.0.0",
      contentHash: upgraded.contentHash,
    });
  });

  it("validates and installs template packages through the catalog without mutating on dry-run", async () => {
    const calls: Array<{ builtinName?: string; dryRun: boolean }> = [];
    const provider = {
      latest: () => Promise.resolve(success(descriptor)),
      get: () => Promise.resolve(success(descriptor)),
      install: (
        request: { builtinName?: string },
        options: { dryRun: boolean },
      ) => {
        calls.push({
          ...(request.builtinName === undefined ? {} : { builtinName: request.builtinName }),
          dryRun: options.dryRun,
        });
        return Promise.resolve(success(descriptor));
      },
    };
    const engine = new OperationEngine(projectFixture(), { templateProvider: provider });
    const operation = {
      op: "template.install",
      params: { builtinName: "lower-third" },
    };

    const preview = await valueOf(engine.execute([operation], {
      baseRevision: "rev_00001",
      origin: "ui",
      dryRun: true,
    }));
    expect(preview.riskClass).toBe("low");
    expect(engine.currentProject.revision).toBe("rev_00001");

    const installed = await valueOf(engine.execute([operation], {
      baseRevision: "rev_00001",
      origin: "ui",
      dryRun: false,
    }));
    expect(calls).toEqual([
      { builtinName: "lower-third", dryRun: true },
      { builtinName: "lower-third", dryRun: false },
    ]);
    expect(installed.applied[0]).toMatchObject({
      summary: "Install Brand lower third 1.0.0",
      inverse: [{
        op: "template.uninstall",
        params: { templateId: TEMPLATE_ID, version: "1.0.0" },
      }],
    });
  });
});
