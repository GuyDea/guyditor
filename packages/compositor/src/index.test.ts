import { describe, expect, it } from "vitest";

import { OperationEngine } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import * as packageModule from "./index.js";
import {
  CompositorModel,
  PRESENTER_ARRANGEMENTS,
} from "./index.js";

describe("@guyditor/compositor", () => {
  it("loads the @guyditor/compositor package entry point", () => {
    expect(packageModule).toBeDefined();
  });

  it("ships the five FR-501 role recipes in bottom-to-top order", () => {
    expect(PRESENTER_ARRANGEMENTS.map(({ name, roles }) => ({
      name,
      roles: roles.map(({ role }) => role),
    }))).toEqual([
      { name: "presenter_over_background", roles: ["background", "presenter"] },
      { name: "presenter_over_screen", roles: ["screen", "presenter"] },
      { name: "presenter_front_of_animation", roles: ["animation", "presenter"] },
      { name: "presenter_sandwich", roles: ["background", "presenter", "foreground"] },
      { name: "presenter_side_by_side", roles: ["background", "content", "presenter"] },
    ]);
    expect(PRESENTER_ARRANGEMENTS.every(({ id, version }) =>
      /^pre_[a-z2-7]{10}$/u.test(id) && version === 1)).toBe(true);
  });

  it("applies presenter_sandwich as one invertible composition.arrange transaction", async () => {
    const project = projectFixture();
    project.layers.push(
      {
        id: "lyr_bbbbbbbbbb",
        kind: "image",
        name: "bars",
        order: 20,
        enabled: true,
        locked: false,
        items: [],
      },
      {
        id: "lyr_cccccccccc",
        kind: "image",
        name: "foreground",
        order: -10,
        enabled: true,
        locked: false,
        items: [],
      },
    );
    const compositor = new CompositorModel();
    const engine = new OperationEngine(project, {
      operationDispatcher: compositor.dispatchOperation,
    });
    const arranged = await engine.execute([{
      op: "composition.arrange",
      params: {
        sequenceId: "seq_aaaaaaaaaa",
        arrangementRef: "presenter_sandwich",
        assignments: {
          background: "lyr_bbbbbbbbbb",
          presenter: "lyr_aaaaaaaaaa",
          foreground: "lyr_cccccccccc",
        },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });
    expect(arranged.ok).toBe(true);
    if (!arranged.ok) return;
    expect(engine.currentProject.layers.slice().sort((a, b) => a.order - b.order)
      .map(({ id }) => id)).toEqual([
      "lyr_bbbbbbbbbb",
      "lyr_aaaaaaaaaa",
      "lyr_cccccccccc",
    ]);
    expect(arranged.value.applied[0]).toMatchObject({
      summary: "Arranged presenter_sandwich: background=lyr_bbbbbbbbbb, presenter=lyr_aaaaaaaaaa, foreground=lyr_cccccccccc",
    });
    expect(arranged.value.riskClass).toBe("normal");

    const inverse = arranged.value.applied[0]!.inverse;
    const restored = await engine.execute(inverse, {
      baseRevision: engine.currentProject.revision,
      origin: "ui",
      dryRun: false,
    });
    expect(restored.ok).toBe(true);
    expect(engine.currentProject.layers).toEqual(project.layers);
  });

  it("dispatches the low-risk key QC operation to the analysis callback", async () => {
    const requests: string[] = [];
    const compositor = new CompositorModel({
      onKeyQcRun: ({ clipId }) => { requests.push(clipId); },
    });
    const project = projectFixture();
    const engine = new OperationEngine(project, {
      operationDispatcher: compositor.dispatchOperation,
    });
    const queued = await engine.execute([{
      op: "key.qc.run",
      params: { clipId: "clp_aaaaaaaaaa", shotBoundaries: [12] },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });
    expect(queued).toMatchObject({
      ok: true,
      value: { riskClass: "low", applied: [{ affected: ["clp_aaaaaaaaaa"], inverse: [] }] },
    });
    expect(requests).toEqual(["clp_aaaaaaaaaa"]);
  });

  it("dispatches capability-gated neural matte generation without mutating the project", async () => {
    const requests: string[] = [];
    const compositor = new CompositorModel({
      onMatteGenerate: ({ clipId, neural }) => { requests.push(`${clipId}:${neural.model}`); },
    });
    const project = projectFixture();
    const engine = new OperationEngine(project, { operationDispatcher: compositor.dispatchOperation });
    const queued = await engine.execute([{
      op: "key.matte.generate",
      params: {
        clipId: "clp_aaaaaaaaaa",
        neural: {
          model: "rvm_mobilenetv3",
          downsampleRatio: 0.5,
          stabilization: { enabled: true, alphaMin: 0.35, motionGain: 4, minSpeckleArea: 0.00001 },
        },
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: false });
    expect(queued).toMatchObject({
      ok: true,
      value: { riskClass: "low", applied: [{ affected: ["clp_aaaaaaaaaa"], inverse: [] }] },
    });
    expect(requests).toEqual(["clp_aaaaaaaaaa:rvm_mobilenetv3"]);
    expect(engine.currentProject.assets).toEqual(project.assets);
  });
});
