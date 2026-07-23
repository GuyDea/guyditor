import { describe, expect, it } from "vitest";

import {
  OperationEngine,
  validateProject,
} from "../index.js";
import type {
  GuyditorProject,
  IdPrefix,
  KeySettings,
  OperationInput,
  Result,
  Transform2D,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const TRANSFORM: Transform2D = {
  anchor: { x: 0.5, y: 0.5 },
  position: { x: 0.5, y: 0.5 },
  scale: { x: 0.75, y: 0.75 },
  rotationDeg: 2,
  crop: { x: 0.05, y: 0.1, w: 0.9, h: 0.8 },
};

const KEY: KeySettings = {
  schema: "guyditor/key@1",
  mode: "chroma",
  chroma: {
    keyColor: "#1FBF3A",
    tolerance: 0.35,
    softness: 0.12,
    preBlur: 1.5,
    edge: { erodePx: 1, featherPx: 2 },
    spill: { mode: "despill", strength: 0.6 },
  },
  masks: [],
};

function ids(): (prefix: IdPrefix) => string {
  const counts = new Map<IdPrefix, number>();
  return (prefix) => {
    const count = counts.get(prefix) ?? 0;
    counts.set(prefix, count + 1);
    return `${prefix}_${count === 0 ? "c" : "d".repeat(1)}${"c".repeat(9)}`;
  };
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function apply(project: GuyditorProject, operation: OperationInput) {
  const engine = new OperationEngine(project, { idFactory: ids() });
  const result = await valueOf(engine.execute([operation], {
    baseRevision: project.revision,
    origin: "ui",
    dryRun: false,
  }));
  return { engine, result };
}

describe("FR-500 layer composition model", () => {
  it("validates the closed blend enum, Transform2D, matte references, and adjustment layers", () => {
    const project = projectFixture();
    project.layers[0] = {
      ...project.layers[0]!,
      blend: "screen",
      opacity: 0.8,
      transform: TRANSFORM,
    };
    project.layers.push(
      {
        id: "lyr_bbbbbbbbbb",
        kind: "matte",
        name: "presenter matte",
        order: 1,
        enabled: true,
        locked: false,
        items: [],
      },
      {
        id: "lyr_cccccccccc",
        kind: "image",
        name: "presenter",
        order: 2,
        enabled: true,
        locked: false,
        items: [],
        matte: { layerId: "lyr_bbbbbbbbbb", source: "luma", invert: true },
      },
      {
        id: "lyr_dddddddddd",
        kind: "adjustment",
        name: "grade",
        order: 3,
        enabled: true,
        locked: false,
        adjustment: {
          exposure: 0.25,
          contrast: 1.1,
          temperatureK: 5600,
          tint: 0.05,
          saturation: 0.95,
        },
      },
    );

    expect(validateProject(project)).toMatchObject({ ok: true });

    const invalidBlend = structuredClone(project);
    invalidBlend.layers[0]!.blend = "color-dodge" as never;
    expect(validateProject(invalidBlend)).toMatchObject({
      ok: false,
      error: { code: "E_SCHEMA_INVALID" },
    });

    const invalidTransform = structuredClone(project);
    invalidTransform.layers[0]!.transform!.anchor.x = 1.1;
    expect(validateProject(invalidTransform)).toMatchObject({
      ok: false,
      error: { code: "E_SCHEMA_INVALID" },
    });

    const invalidAdjustment = structuredClone(project);
    invalidAdjustment.layers[3]!.items = [];
    expect(validateProject(invalidAdjustment)).toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_INVARIANT" },
    });
  });

  it.each([
    {
      operation: {
        op: "layer.set",
        params: {
          layerId: "lyr_aaaaaaaaaa",
          patch: { name: "Presenter", opacity: 0.7, blend: "screen" },
        },
      },
      expected: { name: "Presenter", opacity: 0.7, blend: "screen" },
      riskClass: "low",
    },
    {
      operation: {
        op: "layer.transform.set",
        params: { layerId: "lyr_aaaaaaaaaa", transform: TRANSFORM },
      },
      expected: { transform: TRANSFORM },
      riskClass: "normal",
    },
  ])("applies and inverts $operation.op", async ({ operation, expected, riskClass }) => {
    const project = projectFixture();
    const { engine, result } = await apply(project, operation);
    expect(engine.currentProject.layers[0]).toMatchObject(expected);
    expect(result).toMatchObject({ riskClass, applied: [{ inverse: expect.any(Array) }] });

    const inverse = result.applied[0]!.inverse;
    await valueOf(engine.execute(inverse, {
      baseRevision: engine.currentProject.revision,
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.layers[0]).toEqual(project.layers[0]);
  });

  it("attaches and detaches an explicit matte reference", async () => {
    const project = projectFixture();
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "matte",
      name: "matte",
      order: 1,
      enabled: true,
      locked: false,
      items: [],
    });
    const { engine, result } = await apply(project, {
      op: "layer.matte.set",
      params: {
        layerId: "lyr_aaaaaaaaaa",
        matte: { layerId: "lyr_bbbbbbbbbb", source: "alpha" },
      },
    });
    expect(engine.currentProject.layers[0]!.matte).toEqual({
      layerId: "lyr_bbbbbbbbbb",
      source: "alpha",
    });
    expect(result.applied[0]!.inverse).toEqual([{
      op: "layer.matte.set",
      params: { layerId: "lyr_aaaaaaaaaa", matte: null },
    }]);
  });

  it("creates an adjustment layer with neutral correction and no content", async () => {
    const project = projectFixture();
    const { engine, result } = await apply(project, {
      op: "layer.add",
      params: { kind: "adjustment", name: "grade", index: 1 },
    });

    expect(engine.currentProject.layers[1]).toEqual({
      id: "lyr_cccccccccc",
      kind: "adjustment",
      name: "grade",
      order: 1,
      enabled: true,
      locked: false,
      adjustment: { exposure: 0, contrast: 1, saturation: 1 },
    });
    expect(result).toMatchObject({
      riskClass: "normal",
      applied: [{ inverse: [{ op: "layer.remove" }] }],
    });
  });
});

describe("FR-502 key settings operations", () => {
  it("sets key parameters and adds, updates, and removes a garbage mask", async () => {
    const project = projectFixture();
    const { engine, result } = await apply(project, {
      op: "clip.key.set",
      params: { clipId: "clp_aaaaaaaaaa", settings: KEY },
    });
    expect(engine.currentProject.sequences[0]!.clips[0]!.effects).toContainEqual({
      id: "fx_cccccccccc",
      kind: "key",
      params: KEY,
    });
    expect(result.riskClass).toBe("normal");

    const mask = {
      id: "msk_aaaaaaaaaa",
      role: "garbage" as const,
      shape: "polygon" as const,
      points: [{ x: 0, y: 0 }, { x: 0.2, y: 0 }, { x: 0.2, y: 1 }],
      featherPx: 2,
    };
    const added = await valueOf(engine.execute([{
      op: "clip.key.mask.set",
      params: { clipId: "clp_aaaaaaaaaa", mask },
    }], {
      baseRevision: engine.currentProject.revision,
      origin: "ui",
      dryRun: false,
    }));
    const effect = engine.currentProject.sequences[0]!.clips[0]!.effects
      ?.find(({ kind }) => kind === "key");
    expect(effect?.params["masks"]).toEqual([mask]);
    expect(added.applied[0]!.inverse).toEqual([{
      op: "clip.key.mask.set",
      params: { clipId: "clp_aaaaaaaaaa", maskId: mask.id, mask: null },
    }]);

    await valueOf(engine.execute([{
      op: "clip.key.mask.set",
      params: { clipId: "clp_aaaaaaaaaa", maskId: mask.id, mask: null },
    }], {
      baseRevision: engine.currentProject.revision,
      origin: "ui",
      dryRun: false,
    }));
    expect(effect?.params["masks"]).not.toEqual([]);
    expect(engine.currentProject.sequences[0]!.clips[0]!.effects
      ?.find(({ kind }) => kind === "key")?.params["masks"]).toEqual([]);
  });

  it("rejects malformed key colors, nondominant despill colors, and locked-layer edits", async () => {
    const cases: Array<{ project: GuyditorProject; settings: KeySettings; code: string }> = [];
    const malformed = structuredClone(KEY);
    malformed.chroma!.keyColor = "green";
    cases.push({ project: projectFixture(), settings: malformed, code: "E_OP_SCHEMA" });
    const nondominant = structuredClone(KEY);
    nondominant.chroma!.keyColor = "#777777";
    cases.push({ project: projectFixture(), settings: nondominant, code: "E_KEY_UNSUPPORTED_COLOR" });
    const locked = projectFixture();
    locked.layers[0]!.locked = true;
    cases.push({ project: locked, settings: KEY, code: "E_OP_LAYER_LOCKED" });

    for (const testCase of cases) {
      const result = await new OperationEngine(testCase.project).execute([{
        op: "clip.key.set",
        params: { clipId: "clp_aaaaaaaaaa", settings: testCase.settings },
      }], {
        baseRevision: testCase.project.revision,
        origin: "ui",
        dryRun: true,
      });
      expect(result).toMatchObject({ ok: false, error: { code: testCase.code } });
    }
  });

  it("rejects an accepted neural key until its matte is a frozen generated asset", async () => {
    const project = projectFixture();
    const result = await new OperationEngine(project).execute([{
      op: "clip.key.set",
      params: {
        clipId: "clp_aaaaaaaaaa",
        settings: {
          schema: "guyditor/key@1",
          mode: "neural",
          neural: {
            model: "rvm_mobilenetv3",
            downsampleRatio: 0.5,
            stabilization: { enabled: true, alphaMin: 0.35, motionGain: 4, minSpeckleArea: 0.00001 },
          },
          masks: [],
        },
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: false });
    expect(result).toMatchObject({ ok: false, error: { code: "E_MATTE_UNFROZEN" } });
  });
});

describe("FR-306 static clip transforms", () => {
  it("stores one deterministic transform effect and inverts the changed fields", async () => {
    const project = projectFixture();
    const { engine, result } = await apply(project, {
      op: "clip.transform.set",
      params: {
        clipId: "clp_aaaaaaaaaa",
        crop: { l: 0.05, t: 0.1, r: 0.05, b: 0.1 },
        scale: 0.8,
        position: { x: 0.5, y: 0.45 },
        rotationDeg: 1.5,
        opacity: 0.9,
      },
    });

    expect(engine.currentProject.sequences[0]!.clips[0]!.effects).toContainEqual({
      id: "fx_cccccccccc",
      kind: "transform",
      params: {
        crop: { l: 0.05, t: 0.1, r: 0.05, b: 0.1 },
        scale: 0.8,
        position: { x: 0.5, y: 0.45 },
        rotationDeg: 1.5,
        opacity: 0.9,
      },
    });
    expect(result).toMatchObject({
      riskClass: "normal",
      applied: [{ inverse: [{ op: "clip.transform.set" }] }],
    });
  });
});
