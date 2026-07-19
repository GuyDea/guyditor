import { describe, expect, it } from "vitest";

import { OperationEngine, canonicalizeYaml } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { CompositorModel, pipPlaceOperation } from "./index.js";

const ids = ["kfr_aaaaaaaaaa", "avr_aaaaaaaaaa"] as const;

function harness() {
  const project = projectFixture();
  const compositor = new CompositorModel({ idFactory: () => ids[0] });
  return {
    project,
    engine: new OperationEngine(project, { operationDispatcher: compositor.dispatchOperation }),
  };
}

describe("PiP semantic operations", () => {
  it("uses one canonical placement operation for drag and agent edits", async () => {
    const operation = pipPlaceOperation("lyr_aaaaaaaaaa", {
      anchor: "bottom_right", width: "24%", margin: "4%",
    });
    const ui = harness();
    const agent = harness();
    const uiResult = await ui.engine.execute([operation], {
      baseRevision: ui.project.revision, origin: "ui", dryRun: true,
    });
    const agentResult = await agent.engine.execute([operation], {
      baseRevision: agent.project.revision, origin: "agent", dryRun: true,
    });
    expect(uiResult).toEqual(agentResult);
    expect(uiResult).toMatchObject({
      ok: true,
      value: { applied: [{ summary: "Place layer bottom_right, width 24%, margin 4%" }] },
    });
  });

  it("applies style, place, and a pinned word-anchored motion preset invertibly", async () => {
    const { project, engine } = harness();
    const result = await engine.execute([
      pipPlaceOperation("lyr_aaaaaaaaaa", {
        anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9",
      }),
      {
        op: "pip.style.set",
        params: {
          layerId: "lyr_aaaaaaaaaa",
          style: {
            mask: { shape: "rounded", cornerRadius: 0.08 },
            border: { widthPx: 4, color: "#FFFFFF", opacity: 1 },
          },
        },
      },
      {
        op: "pip.preset.apply",
        params: {
          layerId: "lyr_aaaaaaaaaa",
          keyframeId: "kfr_aaaaaaaaaa",
          at: "word:w000123",
          placement: { anchor: "bottom_left", width: "24%", margin: "4%" },
          presetId: "pre_pipsmoothm",
          version: 1,
          durationFrames: 18,
        },
      },
    ], { baseRevision: project.revision, origin: "ui", dryRun: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(engine.currentProject.layers[0]!.pip).toMatchObject({
      placement: { base: { anchor: "bottom_right", width: "24%", margin: "4%" } },
      style: { mask: { shape: "rounded" } },
      keyframes: [{
        id: "kfr_aaaaaaaaaa",
        at: "word:w000123",
        transition: { preset: "pre_pipsmoothm", durationFrames: 18 },
      }],
    });
    expect(engine.currentProject.presets).toContainEqual(expect.objectContaining({
      id: "pre_pipsmoothm", version: 1, kind: "motion",
    }));
    expect(canonicalizeYaml(engine.currentProject)).not.toMatch(/coordinates|rects:|atOutputFrame/u);

    const inverses = result.value.applied.flatMap(({ inverse }) => inverse).reverse();
    const undone = await engine.execute(inverses, {
      baseRevision: engine.currentProject.revision, origin: "ui", dryRun: false,
    });
    expect(undone.ok).toBe(true);
    expect(engine.currentProject.layers[0]!.pip).toBeUndefined();
    expect(engine.currentProject.presets).toEqual(project.presets);
  });

  it("marks reviewable avoid regions and rejects locked layers", async () => {
    const { project, engine } = harness();
    const marked = await engine.execute([{
      op: "region.mark",
      params: {
        region: {
          id: "avr_aaaaaaaaaa", source: "marked", hardness: "hard",
          rect: { x: 0.2, y: 0.3, w: 0.3, h: 0.2 },
          frames: { from: 10, to: 30 },
        },
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: false });
    expect(marked.ok).toBe(true);
    expect(engine.currentProject.avoidRegions).toEqual([
      expect.objectContaining({ id: "avr_aaaaaaaaaa", source: "marked" }),
    ]);

    const locked = projectFixture();
    locked.layers[0]!.locked = true;
    const lockedEngine = new OperationEngine(locked, {
      operationDispatcher: new CompositorModel().dispatchOperation,
    });
    expect(await lockedEngine.execute([
      pipPlaceOperation("lyr_aaaaaaaaaa", { anchor: "center", width: "50%" }),
    ], { baseRevision: locked.revision, origin: "ui", dryRun: true })).toMatchObject({
      ok: false, error: { code: "E_OP_LAYER_LOCKED" },
    });
  });
});
