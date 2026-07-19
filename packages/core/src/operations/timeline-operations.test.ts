import { describe, expect, it } from "vitest";

import { OperationEngine } from "../index.js";
import type {
  GuyditorProject,
  IdPrefix,
  OperationInput,
  Result,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const GENERATED: Partial<Record<IdPrefix, readonly string[]>> = {
  clp: ["clp_cccccccccc", "clp_dddddddddd"],
  fx: ["fx_cccccccccc", "fx_dddddddddd"],
  lyr: ["lyr_cccccccccc", "lyr_dddddddddd"],
  trn: ["trn_cccccccccc", "trn_dddddddddd"],
  txn: ["txn_cccccccccc", "txn_dddddddddd", "txn_eeeeeeeeee"],
};

function ids(): (prefix: IdPrefix) => string {
  const offsets = new Map<IdPrefix, number>();
  return (prefix) => {
    const offset = offsets.get(prefix) ?? 0;
    offsets.set(prefix, offset + 1);
    return GENERATED[prefix]?.[offset] ?? `${prefix}_${"z".repeat(10)}`;
  };
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

async function roundTrip(
  project: GuyditorProject,
  operation: OperationInput,
): Promise<{ engine: OperationEngine; applied: Awaited<ReturnType<OperationEngine["execute"]>> }> {
  const engine = new OperationEngine(project, { idFactory: ids() });
  const applied = await engine.execute([operation], {
    baseRevision: project.revision,
    origin: "ui",
    dryRun: false,
  });
  expect(applied.ok).toBe(true);
  if (!applied.ok) return { engine, applied };
  await valueOf(engine.execute(applied.value.applied[0]!.inverse, {
    baseRevision: "rev_00002",
    origin: "ui",
    dryRun: false,
  }));
  expect(withoutRevision(engine.currentProject)).toEqual(withoutRevision(project));
  return { engine, applied };
}

function addSecondSequence(project: GuyditorProject): void {
  project.sequences.push({
    id: "seq_bbbbbbbbbb",
    name: "alternate",
    clips: [],
  });
  project.layers.push({
    id: "lyr_bbbbbbbbbb",
    kind: "video",
    name: "alternate video",
    order: 1,
    enabled: true,
    locked: false,
    sequence: "seq_bbbbbbbbbb",
  });
}

describe("FR-301 timeline operation catalog", () => {
  it("round-trips clip.remove through a captured clip.insert payload", async () => {
    const project = projectFixture();
    project.sequences[0]!.clips[0]!.audio = { gainDb: -3 };
    const { applied } = await roundTrip(project, {
      op: "clip.remove",
      params: { clipId: "clp_aaaaaaaaaa", closeGap: true },
    });
    if (!applied.ok) return;

    expect(applied.value.applied[0]).toMatchObject({
      summary: "Remove a.mov (clp_aaaaaaaaaa) (24 frames)",
      inverse: [{
        op: "clip.insert",
        params: {
          sequenceId: "seq_aaaaaaaaaa",
          index: 0,
          layerId: "lyr_aaaaaaaaaa",
          clipId: "clp_aaaaaaaaaa",
          source: {
            assetId: "ast_aaaaaaaaaa",
            in: { frames: 0, fps: "24/1" },
            out: { frames: 24, fps: "24/1" },
          },
        },
      }],
    });
  });

  it("normalizes legacy clip.remove callers to the required closeGap parameter", async () => {
    const project = projectFixture();
    const result = await valueOf(new OperationEngine(project, { idFactory: ids() }).execute([{
      op: "clip.remove",
      params: { clipId: "clp_aaaaaaaaaa" },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: true,
    }));
    expect(result.applied[0]!.params).toMatchObject({
      clipId: "clp_aaaaaaaaaa",
      closeGap: true,
    });
  });

  it("preserves removed duration as an explicit gap when closeGap is false", async () => {
    const project = projectFixture();
    project.sequences[0]!.clips[0]!.effects = [{
      id: "fx_cccccccccc",
      kind: "speed",
      params: { rate: "2/1" },
    }];
    const engine = new OperationEngine(project, { idFactory: ids() });
    const removed = await valueOf(engine.execute([{
      op: "clip.remove",
      params: { clipId: "clp_aaaaaaaaaa", closeGap: false },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.sequences[0]!.clips[0]).toMatchObject({
      id: "clp_bbbbbbbbbb",
      gapBefore: { frames: 12, fps: "24/1" },
    });
    await valueOf(engine.execute(removed.applied[0]!.inverse, {
      baseRevision: "rev_00002",
      origin: "ui",
      dryRun: false,
    }));
    expect(withoutRevision(engine.currentProject)).toEqual(withoutRevision(project));
  });

  it("round-trips clip.insert with a stable generated clip ID", async () => {
    const project = projectFixture();
    const { applied } = await roundTrip(project, {
      op: "clip.insert",
      params: {
        sequenceId: "seq_aaaaaaaaaa",
        index: 1,
        layerId: "lyr_aaaaaaaaaa",
        source: {
          assetId: "ast_aaaaaaaaaa",
          in: { frames: 48, fps: "24/1" },
          out: { frames: 72, fps: "24/1" },
        },
      },
    });
    if (!applied.ok) return;
    expect(applied.value.applied[0]).toMatchObject({
      params: { clipId: "clp_cccccccccc" },
      summary: "Insert a.mov range at position 1",
      inverse: [{ op: "clip.remove", params: { clipId: "clp_cccccccccc", closeGap: true } }],
    });
  });

  it("round-trips clip.move within a sequence and across sequence-bound video layers", async () => {
    const within = projectFixture();
    await roundTrip(within, {
      op: "clip.move",
      params: { clipId: "clp_bbbbbbbbbb", toIndex: 0 },
    });

    const across = projectFixture();
    addSecondSequence(across);
    const { applied } = await roundTrip(across, {
      op: "clip.move",
      params: {
        clipId: "clp_bbbbbbbbbb",
        toSequenceId: "seq_bbbbbbbbbb",
        toLayerId: "lyr_bbbbbbbbbb",
        toIndex: 0,
      },
    });
    if (!applied.ok) return;
    expect(applied.value.applied[0]).toMatchObject({
      summary: "Move a.mov (clp_bbbbbbbbbb) to alternate video position 0",
      inverse: [{
        op: "clip.move",
        params: {
          clipId: "clp_bbbbbbbbbb",
          toSequenceId: "seq_aaaaaaaaaa",
          toLayerId: "lyr_aaaaaaaaaa",
          toIndex: 1,
        },
      }],
    });
  });

  it("rejects clip.move to layers that are absent, non-video, or not bound to its target sequence", async () => {
    const project = projectFixture();
    addSecondSequence(project);
    project.layers.push({
      id: "lyr_cccccccccc",
      kind: "audio",
      name: "music",
      order: 2,
      enabled: true,
      locked: false,
      items: [],
    });
    const cases: OperationInput[] = [
      {
        op: "clip.move",
        params: { clipId: "clp_aaaaaaaaaa", toLayerId: "lyr_dddddddddd", toIndex: 0 },
      },
      {
        op: "clip.move",
        params: { clipId: "clp_aaaaaaaaaa", toLayerId: "lyr_cccccccccc", toIndex: 0 },
      },
      {
        op: "clip.move",
        params: {
          clipId: "clp_aaaaaaaaaa",
          toSequenceId: "seq_bbbbbbbbbb",
          toLayerId: "lyr_aaaaaaaaaa",
          toIndex: 0,
        },
      },
    ];

    for (const operation of cases) {
      const engine = new OperationEngine(project, { idFactory: ids() });
      const result = await engine.execute([operation], {
        baseRevision: project.revision,
        origin: "ui",
        dryRun: false,
      });
      expect(result).toMatchObject({ ok: false, error: { acceptedStateChanged: false } });
    }
  });

  it("round-trips clip.duplicate including effect and transition payloads", async () => {
    const project = projectFixture();
    project.sequences[0]!.clips[0]!.effects = [
      { id: "fx_aaaaaaaaaa", kind: "speed", params: { rate: "1/1" } },
    ];
    project.sequences[0]!.clips[0]!.transitionAfter = {
      id: "trn_aaaaaaaaaa",
      preset: "cut",
      duration: { frames: 0, fps: "24/1" },
    };
    const { applied } = await roundTrip(project, {
      op: "clip.duplicate",
      params: { clipId: "clp_aaaaaaaaaa", toIndex: 2 },
    });
    if (!applied.ok) return;
    expect(applied.value.applied[0]).toMatchObject({
      params: {
        duplicateClipId: "clp_cccccccccc",
        duplicateEffectIds: ["fx_cccccccccc"],
        duplicateTransitionId: "trn_cccccccccc",
      },
      inverse: [{ op: "clip.remove", params: { clipId: "clp_cccccccccc", closeGap: true } }],
    });
  });

  it("round-trips explicit gaps and overlaps through their prior values", async () => {
    await roundTrip(projectFixture(), {
      op: "clip.gap.set",
      params: { clipId: "clp_bbbbbbbbbb", leadingGap: { frames: 3, fps: "24/1" } },
    });
    await roundTrip(projectFixture(), {
      op: "clip.overlap.set",
      params: { clipId: "clp_bbbbbbbbbb", overlapWithPrevious: { frames: 3, fps: "24/1" } },
    });
  });

  it("round-trips layer add/remove/reorder and state toggles", async () => {
    await roundTrip(projectFixture(), {
      op: "layer.add",
      params: { kind: "audio", name: "voice", index: 1 },
    });

    const removable = projectFixture();
    removable.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "audio",
      name: "voice",
      order: 1,
      enabled: false,
      locked: true,
      items: [],
    });
    const removed = await roundTrip(removable, {
      op: "layer.remove",
      params: { layerId: "lyr_bbbbbbbbbb" },
    });
    if (removed.applied.ok) {
      expect(removed.applied.value.applied[0]!.inverse).toEqual([{
        op: "layer.add",
        params: {
          kind: "audio",
          name: "voice",
          index: 1,
          layerId: "lyr_bbbbbbbbbb",
          restore: removable.layers[1],
        },
      }]);
    }

    const reordered = projectFixture();
    reordered.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "audio",
      name: "voice",
      order: 1,
      enabled: true,
      locked: false,
      items: [],
    });
    await roundTrip(reordered, {
      op: "layer.reorder",
      params: { layerId: "lyr_bbbbbbbbbb", toIndex: 0 },
    });
    for (const op of ["layer.disable", "layer.lock"] as const) {
      await roundTrip(projectFixture(), {
        op,
        params: { layerId: "lyr_aaaaaaaaaa" },
      });
    }
    const disabled = projectFixture();
    disabled.layers[0]!.enabled = false;
    await roundTrip(disabled, {
      op: "layer.enable",
      params: { layerId: "lyr_aaaaaaaaaa" },
    });
    const locked = projectFixture();
    locked.layers[0]!.locked = true;
    await roundTrip(locked, {
      op: "layer.unlock",
      params: { layerId: "lyr_aaaaaaaaaa" },
    });
  });

  it("preserves sparse layer order values and dependent references through inverses", async () => {
    const sparse = projectFixture();
    sparse.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "audio",
      name: "voice",
      order: 10,
      enabled: true,
      locked: false,
      items: [],
    });
    await roundTrip(sparse, {
      op: "layer.add",
      params: { kind: "music", name: "score", index: 1 },
    });
    await roundTrip(sparse, {
      op: "layer.reorder",
      params: { layerId: "lyr_bbbbbbbbbb", toIndex: 0 },
    });

    const referenced = projectFixture();
    await roundTrip(referenced, {
      op: "layer.remove",
      params: { layerId: "lyr_aaaaaaaaaa" },
    });
  });

  it("round-trips clip audio gain and fades", async () => {
    await roundTrip(projectFixture(), {
      op: "clip.audio.gain.set",
      params: { clipId: "clp_aaaaaaaaaa", gainDb: -4.5 },
    });
    await roundTrip(projectFixture(), {
      op: "clip.audio.fade.set",
      params: {
        clipId: "clp_aaaaaaaaaa",
        fadeIn: { t: { frames: 2, fps: "24/1" }, curve: "linear" },
        fadeOut: { t: { frames: 3, fps: "24/1" }, curve: "equal-power" },
      },
    });
  });
});

describe("FR-310 transition operation catalog", () => {
  it("round-trips transition.set and transition.remove with intent", async () => {
    const setProject = projectFixture();
    const set = await roundTrip(setProject, {
      op: "transition.set",
      params: {
        boundary: {
          beforeClipId: "clp_aaaaaaaaaa",
          afterClipId: "clp_bbbbbbbbbb",
        },
        kind: "crossfade",
        duration: { frames: 3, fps: "24/1" },
        intent: "soften the edit",
      },
    });
    if (set.applied.ok) {
      expect(set.applied.value.applied[0]).toMatchObject({
        params: { transitionId: "trn_cccccccccc" },
        summary: "Set crossfade (3 frames) between clp_aaaaaaaaaa and clp_bbbbbbbbbb",
        inverse: [{ op: "transition.remove", params: { transitionId: "trn_cccccccccc" } }],
      });
    }

    const removeProject = projectFixture();
    removeProject.sequences[0]!.clips[0]!.transitionAfter = {
      id: "trn_aaaaaaaaaa",
      preset: "pre_bbbbbbbbbb",
      duration: { frames: 2, fps: "24/1" },
      intent: "approved house style",
    };
    removeProject.presets.push({
      id: "pre_bbbbbbbbbb",
      name: "house dissolve",
      kind: "transition",
      version: 1,
      path: "presets/pre_bbbbbbbbbb@1.yaml",
      sha256: "b".repeat(64),
    });
    await roundTrip(removeProject, {
      op: "transition.remove",
      params: { transitionId: "trn_aaaaaaaaaa" },
    });
  });

  it("keeps approved preset agent transitions normal and escalates all others", async () => {
    const project = projectFixture();
    project.presets.push({
      id: "pre_bbbbbbbbbb",
      name: "house dissolve",
      kind: "transition",
      version: 1,
      path: "presets/pre_bbbbbbbbbb@1.yaml",
      sha256: "b".repeat(64),
    });
    project.presets.push({
      id: "pre_cccccccccc",
      name: "unapproved dissolve",
      kind: "transition",
      version: 1,
      path: "presets/pre_cccccccccc@1.yaml",
      sha256: "c".repeat(64),
    });
    const run = async (kind: "cut" | "preset", presetId?: string) => {
      const engine = new OperationEngine(project, {
        idFactory: ids(),
        approvedTransitionPresets: ["pre_bbbbbbbbbb"],
      });
      return valueOf(engine.execute([{
        op: "transition.set",
        params: {
          boundary: {
            beforeClipId: "clp_aaaaaaaaaa",
            afterClipId: "clp_bbbbbbbbbb",
          },
          kind,
          ...(presetId === undefined ? {} : { presetId }),
          duration: { frames: kind === "cut" ? 0 : 2, fps: "24/1" },
        },
      }], {
        baseRevision: project.revision,
        origin: "agent",
        dryRun: true,
      }));
    };

    expect((await run("preset", "pre_bbbbbbbbbb")).riskClass).toBe("normal");
    expect((await run("preset", "pre_cccccccccc")).riskClass).toBe("consequential");
    expect((await run("cut")).riskClass).toBe("consequential");
  });
});

describe("timeline boundary exclusivity", () => {
  const cases = [
    { existing: "gap", requested: "overlap" },
    { existing: "gap", requested: "transition" },
    { existing: "overlap", requested: "gap" },
    { existing: "overlap", requested: "transition" },
    { existing: "transition", requested: "gap" },
    { existing: "transition", requested: "overlap" },
  ] as const;

  it.each(cases)("rejects $requested when the boundary already has $existing", async ({ existing, requested }) => {
    const project = projectFixture();
    const [before, after] = project.sequences[0]!.clips;
    if (existing === "gap") after!.gapBefore = { frames: 1, fps: "24/1" };
    if (existing === "overlap") after!.overlapPrevious = { frames: 1, fps: "24/1" };
    if (existing === "transition") {
      before!.transitionAfter = {
        id: "trn_aaaaaaaaaa",
        preset: "crossfade",
        duration: { frames: 1, fps: "24/1" },
      };
    }
    const operation: OperationInput = requested === "gap"
      ? {
          op: "clip.gap.set",
          params: { clipId: after!.id, leadingGap: { frames: 2, fps: "24/1" } },
        }
      : requested === "overlap"
        ? {
            op: "clip.overlap.set",
            params: { clipId: after!.id, overlapWithPrevious: { frames: 2, fps: "24/1" } },
          }
        : {
            op: "transition.set",
            params: {
              boundary: { beforeClipId: before!.id, afterClipId: after!.id },
              kind: "crossfade",
              duration: { frames: 2, fps: "24/1" },
            },
          };
    const engine = new OperationEngine(project, { idFactory: ids() });
    const result = await engine.execute([operation], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_BOUNDARY_CONFLICT", acceptedStateChanged: false },
    });
  });

  it.each(["gap", "overlap", "transition"] as const)("accepts an exclusive $requested boundary", async (requested) => {
    const project = projectFixture();
    const operation: OperationInput = requested === "gap"
      ? {
          op: "clip.gap.set",
          params: {
            clipId: "clp_bbbbbbbbbb",
            leadingGap: { frames: 2, fps: "24/1" },
          },
        }
      : requested === "overlap"
        ? {
            op: "clip.overlap.set",
            params: {
              clipId: "clp_bbbbbbbbbb",
              overlapWithPrevious: { frames: 2, fps: "24/1" },
            },
          }
        : {
            op: "transition.set",
            params: {
              boundary: {
                beforeClipId: "clp_aaaaaaaaaa",
                afterClipId: "clp_bbbbbbbbbb",
              },
              kind: "crossfade",
              duration: { frames: 2, fps: "24/1" },
            },
          };
    const result = await new OperationEngine(project, { idFactory: ids() }).execute([operation], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: true,
    });
    expect(result.ok).toBe(true);
  });

  it.each(["overlap", "transition"] as const)("rejects a $requested that produces negative timeline time", async (requested) => {
    const project = projectFixture();
    const operation: OperationInput = requested === "overlap"
      ? {
          op: "clip.overlap.set",
          params: {
            clipId: "clp_bbbbbbbbbb",
            overlapWithPrevious: { frames: 25, fps: "24/1" },
          },
        }
      : {
          op: "transition.set",
          params: {
            boundary: {
              beforeClipId: "clp_aaaaaaaaaa",
              afterClipId: "clp_bbbbbbbbbb",
            },
            kind: "crossfade",
            duration: { frames: 25, fps: "24/1" },
          },
        };
    const result = await new OperationEngine(project, { idFactory: ids() }).execute([operation], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_TIMELINE_BOUNDARY", acceptedStateChanged: false },
    });
  });
});

describe("locked-layer semantic validation", () => {
  const clipOperations: OperationInput[] = [
    {
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
      },
    },
    { op: "clip.split", params: { clipId: "clp_aaaaaaaaaa", at: 12 } },
    {
      op: "clip.join",
      params: { clipIds: ["clp_aaaaaaaaaa", "clp_bbbbbbbbbb"] },
    },
    {
      op: "clip.remove",
      params: { clipId: "clp_aaaaaaaaaa", closeGap: true },
    },
    {
      op: "clip.restore",
      params: {
        sequenceId: "seq_aaaaaaaaaa",
        targetIndex: 0,
        clips: [{
          id: "clp_cccccccccc",
          asset: "ast_aaaaaaaaaa",
          source: {
            in: { frames: 48, fps: "24/1" },
            out: { frames: 72, fps: "24/1" },
          },
        }],
      },
    },
    {
      op: "clip.insert",
      params: {
        sequenceId: "seq_aaaaaaaaaa",
        index: 0,
        layerId: "lyr_aaaaaaaaaa",
        source: {
          assetId: "ast_aaaaaaaaaa",
          in: { frames: 48, fps: "24/1" },
          out: { frames: 72, fps: "24/1" },
        },
      },
    },
    { op: "clip.move", params: { clipId: "clp_bbbbbbbbbb", toIndex: 0 } },
    { op: "clip.duplicate", params: { clipId: "clp_aaaaaaaaaa", toIndex: 1 } },
    {
      op: "clip.gap.set",
      params: { clipId: "clp_bbbbbbbbbb", leadingGap: { frames: 1, fps: "24/1" } },
    },
    {
      op: "clip.overlap.set",
      params: {
        clipId: "clp_bbbbbbbbbb",
        overlapWithPrevious: { frames: 1, fps: "24/1" },
      },
    },
    {
      op: "clip.audio.gain.set",
      params: { clipId: "clp_aaaaaaaaaa", gainDb: -3 },
    },
    {
      op: "clip.audio.fade.set",
      params: {
        clipId: "clp_aaaaaaaaaa",
        fadeIn: { t: { frames: 1, fps: "24/1" }, curve: "linear" },
        fadeOut: { t: { frames: 1, fps: "24/1" }, curve: "linear" },
      },
    },
  ];

  it.each(clipOperations)("rejects $op on a locked sequence layer", async (operation) => {
    const project = projectFixture();
    project.layers[0]!.locked = true;
    const result = await new OperationEngine(project, { idFactory: ids() }).execute([operation], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_LAYER_LOCKED", acceptedStateChanged: false },
    });
  });
});

describe("catalog risk classes", () => {
  it("uses exact static risks and escalates only non-empty layer removal", async () => {
    const execute = async (project: GuyditorProject, operation: OperationInput) =>
      valueOf(new OperationEngine(project, { idFactory: ids() }).execute([operation], {
        baseRevision: project.revision,
        origin: "ui",
        dryRun: true,
      }));

    expect((await execute(projectFixture(), {
      op: "clip.audio.gain.set",
      params: { clipId: "clp_aaaaaaaaaa", gainDb: -1 },
    })).riskClass).toBe("low");
    expect((await execute(projectFixture(), {
      op: "layer.disable",
      params: { layerId: "lyr_aaaaaaaaaa" },
    })).riskClass).toBe("low");
    expect((await execute(projectFixture(), {
      op: "clip.move",
      params: { clipId: "clp_bbbbbbbbbb", toIndex: 0 },
    })).riskClass).toBe("normal");

    const empty = projectFixture();
    empty.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "audio",
      name: "empty",
      order: 1,
      enabled: true,
      locked: false,
      items: [],
    });
    expect((await execute(empty, {
      op: "layer.remove",
      params: { layerId: "lyr_bbbbbbbbbb" },
    })).riskClass).toBe("low");

    const nonEmpty = projectFixture();
    addSecondSequence(nonEmpty);
    nonEmpty.sequences[1]!.clips.push({
      id: "clp_cccccccccc",
      asset: "ast_aaaaaaaaaa",
      source: {
        in: { frames: 48, fps: "24/1" },
        out: { frames: 72, fps: "24/1" },
      },
    });
    expect((await execute(nonEmpty, {
      op: "layer.remove",
      params: { layerId: "lyr_bbbbbbbbbb" },
    })).riskClass).toBe("consequential");
  });
});
