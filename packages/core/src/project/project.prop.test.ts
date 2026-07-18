import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  canonicalizeYaml,
  parseProjectYaml,
} from "../index.js";
import type {
  Asset,
  Clip,
  GuyditorProject,
  IdPrefix,
  Layer,
  Result,
  Sequence,
  SidecarRef,
} from "../index.js";

const HASH = "a".repeat(64);
const PROPERTY_SEEDS = {
  idempotence: 1_003_001,
  determinism: 1_003_002,
  roundTrip: 1_003_003,
} as const;

interface ClipSpec {
  assetIndex: number;
  boundary: "none" | "gap" | "overlap" | "transition";
  sourceIn: number;
  sourceLength: number;
  effect: boolean;
}

interface ProjectSpec {
  assetKinds: Array<"video" | "generated">;
  beatCount: number;
  clipSpecs: ClipSpec[][];
  placedItem: boolean;
  reverseRegistries: boolean;
  skillCount: number;
}

function valueOf<T>(result: Result<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function suffix(ordinal: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let value = ordinal;
  let encoded = "";
  do {
    encoded = `${alphabet[value & 31]}${encoded}`;
    value = Math.floor(value / 32);
  } while (value > 0);
  return `${"a".repeat(10)}${encoded}`.slice(-10);
}

function id(prefix: IdPrefix, ordinal: number): string {
  return `${prefix}_${suffix(ordinal)}`;
}

function reverse<T>(values: readonly T[]): T[] {
  return [...values].reverse();
}

function registryOrder(project: GuyditorProject): GuyditorProject {
  const sorted = structuredClone(project);
  sorted.assets.sort((left, right) => left.id.localeCompare(right.id));
  sorted.beats.sort((left, right) => left.id.localeCompare(right.id));
  sorted.captions.sort((left, right) => left.id.localeCompare(right.id));
  sorted.deliverables.sort((left, right) => left.id.localeCompare(right.id));
  sorted.presets.sort((left, right) => left.id.localeCompare(right.id));
  sorted.skills.sort((left, right) => left.id.localeCompare(right.id));
  sorted.sidecars.sort((left, right) => left.name.localeCompare(right.name));
  return sorted;
}

function permuteRegistries(project: GuyditorProject): GuyditorProject {
  return {
    ...structuredClone(project),
    assets: reverse(project.assets),
    beats: reverse(project.beats),
    captions: reverse(project.captions),
    deliverables: reverse(project.deliverables),
    presets: reverse(project.presets),
    skills: reverse(project.skills),
    sidecars: reverse(project.sidecars),
  };
}

function projectFromSpec(spec: ProjectSpec): GuyditorProject {
  const assets: Asset[] = spec.assetKinds.map((kind, index) => ({
    id: id("ast", index),
    kind,
    path: `media/${String(index)}.mov`,
    sha256: HASH,
    probe: { fps: "24/1" },
    ...(kind === "generated"
      ? { provenance: { sidecar: `provenance-${String(index)}` } }
      : {}),
  }));

  let clipOrdinal = 0;
  let effectOrdinal = 0;
  let transitionOrdinal = 0;
  const sequences: Sequence[] = spec.clipSpecs.map((sequenceSpecs, sequenceIndex) => {
    const clips: Clip[] = [];
    for (const [clipIndex, clipSpec] of sequenceSpecs.entries()) {
      const clip: Clip = {
        id: id("clp", clipOrdinal),
        asset: assets[clipSpec.assetIndex % assets.length]!.id,
        source: {
          in: { frames: clipSpec.sourceIn, fps: "24/1" },
          out: {
            frames: clipSpec.sourceIn + clipSpec.sourceLength,
            fps: "24/1",
          },
        },
      };
      clipOrdinal += 1;

      if (clipIndex > 0) {
        if (clipSpec.boundary === "gap") {
          clip.gapBefore = { frames: 2, fps: "24/1" };
        } else if (clipSpec.boundary === "overlap") {
          clip.overlapPrevious = { frames: 2, fps: "24/1" };
        } else if (clipSpec.boundary === "transition") {
          clips[clipIndex - 1]!.transitionAfter = {
            id: id("trn", transitionOrdinal),
            preset: "built-in-cut",
            duration: { frames: 2, fps: "24/1" },
          };
          transitionOrdinal += 1;
        }
      }

      if (clipSpec.effect) {
        clip.effects = [
          {
            id: id("fx", effectOrdinal),
            kind: "speed",
            params: { rate: "1/1" },
          },
        ];
        effectOrdinal += 1;
      }
      clips.push(clip);
    }

    return {
      id: id("seq", sequenceIndex),
      name: `sequence-${String(sequenceIndex)}`,
      clips,
    };
  });

  const layers: Layer[] = sequences.map((sequence, index) => ({
    id: id("lyr", index),
    kind: "video",
    name: `layer-${String(index)}`,
    order: index,
    enabled: true,
    locked: false,
    sequence: sequence.id,
  }));
  if (spec.placedItem) {
    layers.push({
      id: id("lyr", sequences.length),
      kind: "image",
      name: "overlay",
      order: sequences.length,
      enabled: true,
      locked: false,
      items: [
        {
          id: id("gfx", 0),
          asset: assets[0]!.id,
          at: "word:w000000",
          duration: { frames: 12, fps: "24/1" },
        },
      ],
    });
  }

  const generatedSidecars: SidecarRef[] = assets.flatMap((asset, index) =>
    asset.kind === "generated"
      ? [
          {
            name: `provenance-${String(index)}`,
            path: `sidecars/provenance/${asset.id}.json`,
            schema: "guyditor.provenance/v1",
            sha256: HASH,
            inputs: [{ asset: asset.id, sha256: HASH }],
          },
        ]
      : [],
  );
  const sidecars: SidecarRef[] = [
    {
      name: "annotations",
      path: "sidecars/annotations.yaml",
      schema: "guyditor.annotations/v1",
      sha256: HASH,
      inputs: [{ asset: assets[0]!.id, sha256: HASH }],
    },
    ...generatedSidecars,
  ];

  const project: GuyditorProject = {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: {
      id: id("prj", 0),
      name: "Property project",
      created: "2026-07-18T12:00:00Z",
    },
    settings: {
      timeline: { fps: "24/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: id("dlv", 0),
    },
    transcript: { nextWordOrdinal: 1 },
    assets,
    beats: Array.from({ length: spec.beatCount }, (_, index) => ({
      id: id("beat", index),
      name: `beat-${String(index)}`,
      anchor: "word:w000000",
    })),
    sequences,
    layers,
    captions: [
      {
        id: id("cts", 0),
        name: "captions",
        sourceLayerIds: [layers[0]!.id],
        preset: { presetId: id("pre", 0), version: 1 },
        enabled: true,
      },
    ],
    annotations: {
      sidecar: "annotations",
      summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 },
    },
    deliverables: sequences.map((sequence, index) => ({
      id: id("dlv", index),
      kind: index === 0 ? "longform" : "short",
      name: `deliverable-${String(index)}`,
      profile: "test@1.0.0",
      sequenceId: sequence.id,
      status: "draft",
    })),
    presets: [
      {
        id: id("pre", 0),
        name: "captions",
        kind: "caption",
        version: 1,
        path: `presets/${id("pre", 0)}@1.yaml`,
        sha256: HASH,
      },
    ],
    skills: Array.from({ length: spec.skillCount }, (_, index) => ({
      id: id("skl", index),
      name: `skill-${String(index)}`,
      version: `1.0.${String(index)}`,
      path: `skills/${String(index)}/`,
      contentHash: HASH,
    })),
    sidecars,
  };

  return spec.reverseRegistries ? permuteRegistries(project) : project;
}

const clipSpecArbitrary: fc.Arbitrary<ClipSpec> = fc.record({
  assetIndex: fc.integer({ min: 0, max: 7 }),
  boundary: fc.constantFrom("none", "gap", "overlap", "transition"),
  sourceIn: fc.integer({ min: 0, max: 10_000 }),
  sourceLength: fc.integer({ min: 1, max: 2_000 }),
  effect: fc.boolean(),
});

const validProjectArbitrary: fc.Arbitrary<GuyditorProject> = fc
  .record({
    assetKinds: fc.array(fc.constantFrom("video", "generated"), {
      minLength: 1,
      maxLength: 8,
    }),
    beatCount: fc.integer({ min: 0, max: 4 }),
    clipSpecs: fc.array(fc.array(clipSpecArbitrary, { maxLength: 10 }), {
      minLength: 1,
      maxLength: 3,
    }),
    placedItem: fc.boolean(),
    reverseRegistries: fc.boolean(),
    skillCount: fc.integer({ min: 1, max: 3 }),
  })
  .map(projectFromSpec);

function parameters(seed: number) {
  return { numRuns: 500, seed, verbose: true } as const;
}

describe("canonical project properties", () => {
  it(
    `is byte-idempotent (seed ${String(PROPERTY_SEEDS.idempotence)})`,
    () => {
      fc.assert(
        fc.property(validProjectArbitrary, (project) => {
          const first = canonicalizeYaml(project);
          const parsed = valueOf(parseProjectYaml(first));
          expect(canonicalizeYaml(parsed)).toBe(first);
        }),
        parameters(PROPERTY_SEEDS.idempotence),
      );
    },
    20_000,
  );

  it(
    `is deterministic across registry permutations (seed ${String(PROPERTY_SEEDS.determinism)})`,
    () => {
      fc.assert(
        fc.property(validProjectArbitrary, (project) => {
          expect(canonicalizeYaml(permuteRegistries(project))).toBe(
            canonicalizeYaml(project),
          );
        }),
        parameters(PROPERTY_SEEDS.determinism),
      );
    },
    20_000,
  );

  it(
    `round-trips modulo registry order (seed ${String(PROPERTY_SEEDS.roundTrip)})`,
    () => {
      fc.assert(
        fc.property(validProjectArbitrary, (project) => {
          const parsed = valueOf(parseProjectYaml(canonicalizeYaml(project)));
          expect(parsed).toEqual(registryOrder(project));
        }),
        parameters(PROPERTY_SEEDS.roundTrip),
      );
    },
    20_000,
  );
});
