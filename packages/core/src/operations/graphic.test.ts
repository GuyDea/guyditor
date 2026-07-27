import { describe, expect, it } from "vitest";

import { OperationEngine, success } from "../index.js";
import type { IdPrefix, Result } from "../index.js";
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
      params: { sequenceId: "seq_aaaaaaaaaa" },
    }]);
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
      },
    }]);
    await valueOf(engine.execute(removed.applied[0]!.inverse, {
      baseRevision: "rev_00003",
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.layers[1]!.items![0]!.id).toBe("gfx_bbbbbbbbbb");
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
