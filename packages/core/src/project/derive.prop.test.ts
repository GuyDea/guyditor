import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { deriveTimeline } from "../index.js";
import type { Clip, GuyditorProject } from "../index.js";
import { projectFixture } from "./test-fixtures.js";

const RUNS = 500;
const SEED = 1_005_001;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

type Boundary = "none" | "gap" | "overlap" | "transition";
interface ClipSpec {
  frames: number;
  boundary: Boundary;
  boundaryFrames: number;
}

function roundedFrame(numerator: bigint, denominator: bigint): number {
  const floor = numerator / denominator;
  const remainder = numerator % denominator;
  return Number(remainder * 2n <= denominator ? floor : floor + 1n);
}

function clipId(index: number): string {
  return ["clp", `${"a".repeat(9)}${ID_ALPHABET[index]}`].join("_");
}

function fromSpecs(specs: readonly ClipSpec[]): GuyditorProject {
  const project = projectFixture();
  project.settings.timeline.fps = "24/1";
  project.assets[0]!.probe = {
    duration: { frames: 100_000, fps: "30/1" },
    fps: "30/1",
  };
  const clips: Clip[] = specs.map((spec, index) => ({
    id: clipId(index),
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: index * 1_000, fps: "30/1" },
      out: { frames: index * 1_000 + spec.frames, fps: "30/1" },
    },
  }));

  for (let index = 1; index < specs.length; index += 1) {
    const spec = specs[index]!;
    const time = { frames: spec.boundaryFrames, fps: "24/1" } as const;
    if (spec.boundary === "gap") clips[index]!.gapBefore = time;
    if (spec.boundary === "overlap") clips[index]!.overlapPrevious = time;
    if (spec.boundary === "transition") {
      clips[index - 1]!.transitionAfter = {
        id: ["trn", `${"a".repeat(9)}${ID_ALPHABET[index]}`].join("_"),
        preset: "built-in-cut",
        duration: time,
      };
    }
  }
  project.sequences[0]!.clips = clips;
  return project;
}

const specsArbitrary = fc.array(
  fc.record({
    frames: fc.integer({ min: 30, max: 300 }),
    boundary: fc.constantFrom<Boundary>("none", "gap", "overlap", "transition"),
    boundaryFrames: fc.integer({ min: 0, max: 12 }),
  }),
  { minLength: 1, maxLength: 20 },
);

describe("P-T5 derived timeline positions", () => {
  it(
    `matches an independent BigInt prefix-sum oracle (seed ${String(SEED)})`,
    () => {
      fc.assert(
        fc.property(specsArbitrary, (specs) => {
          const project = fromSpecs(specs);
          const result = deriveTimeline(project, "seq_aaaaaaaaaa");
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          let numerator = 0n;
          const denominator = 120n;
          const starts: number[] = [];
          for (const [index, spec] of specs.entries()) {
            if (index > 0) {
              const boundary = BigInt(spec.boundaryFrames) * 5n;
              if (spec.boundary === "gap") numerator += boundary;
              if (spec.boundary === "overlap" || spec.boundary === "transition") {
                numerator -= boundary;
              }
            }
            starts.push(roundedFrame(numerator * 24n, denominator));
            numerator += BigInt(spec.frames) * 4n;
          }

          expect(result.value.clips.map((clip) => clip.start.frames)).toEqual(starts);
        }),
        { numRuns: RUNS, seed: SEED, verbose: true },
      );
    },
    20_000,
  );

  it(
    "inserting or removing a clip changes no stored field of another clip",
    () => {
      fc.assert(
        fc.property(specsArbitrary, fc.nat(), (specs, rawIndex) => {
          const project = fromSpecs(specs);
          const before = new Map(
            project.sequences[0]!.clips.map((clip) => [clip.id, structuredClone(clip)]),
          );
          const insertionIndex = rawIndex % (specs.length + 1);
          const inserted = structuredClone(project);
          inserted.sequences[0]!.clips.splice(insertionIndex, 0, {
            id: "clp_zzzzzzzzzz",
            asset: "ast_aaaaaaaaaa",
            source: {
              in: { frames: 90_000, fps: "30/1" },
              out: { frames: 90_030, fps: "30/1" },
            },
          });
          for (const clip of inserted.sequences[0]!.clips) {
            if (clip.id !== "clp_zzzzzzzzzz") expect(clip).toEqual(before.get(clip.id));
          }

          const removed = structuredClone(project);
          const removalIndex = rawIndex % specs.length;
          const [removedClip] = removed.sequences[0]!.clips.splice(removalIndex, 1);
          for (const clip of removed.sequences[0]!.clips) {
            expect(clip).toEqual(before.get(clip.id));
          }
          expect(removedClip).toEqual(before.get(project.sequences[0]!.clips[removalIndex]!.id));
        }),
        { numRuns: RUNS, seed: SEED + 1, verbose: true },
      );
    },
    20_000,
  );
});
