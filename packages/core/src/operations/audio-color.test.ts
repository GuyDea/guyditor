import { describe, expect, it } from "vitest";

import {
  OperationEngine,
  canonicalizeYaml,
  parseProjectYaml,
} from "../index.js";
import type {
  AudioChain,
  GuyditorProject,
  OperationInput,
  Result,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const HASH = "b".repeat(64);

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

function valueOfSync<Value>(result: Result<Value>): Value {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

function engineFor(project: GuyditorProject): OperationEngine {
  let ordinal = 0;
  return new OperationEngine(project, {
    idFactory: (prefix) => `${prefix}_${ordinal++ === 0 ? "c" : "d"}ccccccccc`,
  });
}

const CHAIN = {
  nodes: [
    { type: "channelSelect", enabled: true, mapping: "mix" },
    { type: "noiseReduction", enabled: false, strengthDb: 12 },
    { type: "gain", enabled: true, gainDb: 2.5 },
    { type: "eq", enabled: true, bands: [{ freqHz: 120, gainDb: -2, q: 0.7 }] },
    {
      type: "compression",
      enabled: true,
      thresholdDb: -18,
      ratio: 3,
      attackMs: 10,
      releaseMs: 120,
      makeupDb: 1,
    },
    { type: "limiting", enabled: true, ceilingDb: -1 },
  ],
} as const;

describe("FR-308 audio post operations", () => {
  it("sets canonical clip/layer chains and master targets, then round-trips YAML and inverse ops", async () => {
    const project = projectFixture();
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "music",
      name: "Score",
      order: 1,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    });
    const engine = engineFor(project);
    const operations: OperationInput[] = [
      { op: "clip.audio.offset.set", params: { clipId: "clp_aaaaaaaaaa", offset: { samples: -240, rate: 48_000 } } },
      { op: "clip.audio.channels.set", params: { clipId: "clp_aaaaaaaaaa", mapping: "mix" } },
      { op: "clip.audio.chain.set", params: { clipId: "clp_aaaaaaaaaa", chain: CHAIN } },
      { op: "clip.audio.chain.set", params: { layerId: "lyr_bbbbbbbbbb", chain: CHAIN } },
      { op: "sequence.audio.master.set", params: { sequenceId: "seq_aaaaaaaaaa", targetLufs: -16, truePeakDb: -1.5 } },
    ];

    const applied = await valueOf(engine.execute(operations, {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    }));

    expect(engine.currentProject.sequences[0]!.clips[0]!.audio).toMatchObject({
      offset: { samples: -240, rate: 48_000 },
      channels: "mix",
      chain: CHAIN,
    });
    expect(engine.currentProject.layers[1]).toMatchObject({ audio: { chain: CHAIN } });
    expect(engine.currentProject.sequences[0]!.audio).toEqual({ targetLufs: -16, truePeakDb: -1.5 });
    expect(applied.applied.map(({ op }) => op)).toEqual(operations.map(({ op }) => op));
    expect(valueOfSync(parseProjectYaml(canonicalizeYaml(engine.currentProject))))
      .toEqual(engine.currentProject);

    await valueOf(engine.execute(applied.applied.flatMap(({ inverse }) => inverse).reverse(), {
      baseRevision: engine.currentProject.revision,
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.sequences[0]!.clips[0]!.audio).toBeUndefined();
    expect(engine.currentProject.layers[1]!.audio).toBeUndefined();
    expect(engine.currentProject.sequences[0]!.audio).toBeUndefined();
  });

  it("rejects a chain whose serialized nodes are not in the fixed canonical order", async () => {
    const engine = engineFor(projectFixture());
    const result = await engine.execute([{
      op: "clip.audio.chain.set",
      params: {
        clipId: "clp_aaaaaaaaaa",
        chain: { nodes: [CHAIN.nodes[2], CHAIN.nodes[0], ...CHAIN.nodes.slice(1, 2), ...CHAIN.nodes.slice(3)] },
      },
    }], { baseRevision: "rev_00001", origin: "ui", dryRun: false });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_AUDIO_CHAIN_ORDER" },
    });

    const invalidProject = projectFixture();
    invalidProject.sequences[0]!.clips[0]!.audio = {
      chain: {
        nodes: [
          CHAIN.nodes[2],
          CHAIN.nodes[0],
          CHAIN.nodes[1],
          ...CHAIN.nodes.slice(3),
        ] as unknown as AudioChain["nodes"],
      },
    };
    expect(parseProjectYaml(canonicalizeYaml(invalidProject))).toMatchObject({ ok: false });
  });
});

describe("FR-309 music ducking operations", () => {
  it("round-trips looping with crossfade and semantic timing anchors", async () => {
    const project = projectFixture();
    const engine = engineFor(project);
    const applied = await valueOf(engine.execute([{
      op: "clip.loop.set",
      params: {
        clipId: "clp_aaaaaaaaaa",
        loop: true,
        loopCrossfade: { t: { frames: 3, fps: "24/1" } },
      },
    }, {
      op: "clip.anchor.set",
      params: { clipId: "clp_aaaaaaaaaa", anchor: "timeline:24@24/1" },
    }], { baseRevision: project.revision, origin: "ui", dryRun: false }));

    expect(engine.currentProject.sequences[0]!.clips[0]).toMatchObject({
      loop: { enabled: true, crossfade: { frames: 3, fps: "24/1" } },
      anchor: "timeline:24@24/1",
    });
    await valueOf(engine.execute(applied.applied.flatMap(({ inverse }) => inverse).reverse(), {
      baseRevision: engine.currentProject.revision,
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.sequences[0]!.clips[0]!.loop).toBeUndefined();
    expect(engine.currentProject.sequences[0]!.clips[0]!.anchor).toBeUndefined();
  });

  it("stores only ducking config/manual anchor overrides and restores them through inverse operations", async () => {
    const project = projectFixture();
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "music",
      name: "Score",
      order: 1,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    });
    const engine = engineFor(project);
    const set = await valueOf(engine.execute([{
      op: "layer.ducking.set",
      params: {
        layerId: "lyr_bbbbbbbbbb",
        config: {
          enabled: true,
          mode: "auto",
          duckDb: -12,
          attackMs: 150,
          releaseMs: 400,
          holdMs: 250,
          minGapMs: 700,
        },
      },
    }, {
      op: "layer.ducking.override",
      params: {
        layerId: "lyr_bbbbbbbbbb",
        points: [{ at: "timeline:24@24/1", gainDb: -8 }],
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: false }));

    expect(engine.currentProject.layers[1]!.ducking).toEqual({
      enabled: true,
      mode: "auto",
      duckDb: -12,
      attackMs: 150,
      releaseMs: 400,
      holdMs: 250,
      minGapMs: 700,
      overrides: [{ at: "timeline:24@24/1", gainDb: -8 }],
    });
    expect(JSON.stringify(engine.currentProject.layers[1]!.ducking)).not.toContain("envelope");

    await valueOf(engine.execute(set.applied.flatMap(({ inverse }) => inverse).reverse(), {
      baseRevision: engine.currentProject.revision,
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.layers[1]!.ducking).toBeUndefined();
  });
});

describe("FR-307 image finishing operations", () => {
  it("applies concrete basic corrections and a pinned versioned look, preserving the pin in YAML", async () => {
    const project = projectFixture();
    project.presets.push({
      id: "pre_bbbbbbbbbb",
      name: "Warm documentary",
      kind: "look",
      version: 3,
      path: "builtin:look-warm-documentary@3",
      sha256: HASH,
    });
    const engine = engineFor(project);

    await valueOf(engine.execute([{
      op: "clip.color.set",
      params: {
        clipId: "clp_aaaaaaaaaa",
        exposureEv: 0.5,
        contrast: 1.1,
        whiteBalance: { tempK: 5_400, tint: 0.05 },
        saturation: 0.9,
      },
    }, {
      op: "clip.look.apply",
      params: {
        clipId: "clp_aaaaaaaaaa",
        presetId: "pre_bbbbbbbbbb",
        presetVersion: 3,
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: false }));

    expect(engine.currentProject.sequences[0]!.clips[0]!.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "color",
        params: { exposure: 0.5, contrast: 1.1, temperatureK: 5_400, tint: 0.05, saturation: 0.9 },
      }),
      expect.objectContaining({
        kind: "look",
        params: expect.objectContaining({
          presetId: "pre_bbbbbbbbbb",
          presetVersion: 3,
          temperatureK: 6_200,
        }),
      }),
    ]));
    const yaml = canonicalizeYaml(engine.currentProject);
    expect(yaml).toContain("pre_bbbbbbbbbb");
    expect(yaml).toContain("presetVersion: 3");
    expect(valueOfSync(parseProjectYaml(yaml))).toEqual(engine.currentProject);
  });
});
