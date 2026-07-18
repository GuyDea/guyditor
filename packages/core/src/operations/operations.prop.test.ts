import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  OperationEngine,
  canonicalizeYaml,
} from "../index.js";
import type {
  GuyditorProject,
  IdPrefix,
  OperationInput,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const RUNS = 500;
const SEED = 1_012_001;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

interface Scenario {
  project: GuyditorProject;
  operation: OperationInput;
}

interface ChangedLine {
  side: "before" | "after";
  index: number;
  text: string;
}

function suffix(index: number): string {
  return `${"a".repeat(9)}${ALPHABET[index % ALPHABET.length]}`;
}

function id(prefix: "clp" | "fx", index: number): string {
  return `${prefix}_${suffix(index)}`;
}

function lineChanges(before: string, after: string): ChangedLine[] {
  const left = before.trimEnd().split("\n");
  const right = after.trimEnd().split("\n");
  const lengths = Array.from(
    { length: left.length + 1 },
    () => Array<number>(right.length + 1).fill(0),
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      lengths[leftIndex]![rightIndex] = left[leftIndex] === right[rightIndex]
        ? 1 + lengths[leftIndex + 1]![rightIndex + 1]!
        : Math.max(
            lengths[leftIndex + 1]![rightIndex]!,
            lengths[leftIndex]![rightIndex + 1]!,
          );
    }
  }

  const changed: ChangedLine[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (
      leftIndex < left.length &&
      rightIndex < right.length &&
      left[leftIndex] === right[rightIndex]
    ) {
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      rightIndex >= right.length ||
      (leftIndex < left.length &&
        lengths[leftIndex + 1]![rightIndex]! >= lengths[leftIndex]![rightIndex + 1]!)
    ) {
      changed.push({ side: "before", index: leftIndex, text: left[leftIndex]! });
      leftIndex += 1;
    } else {
      changed.push({ side: "after", index: rightIndex, text: right[rightIndex]! });
      rightIndex += 1;
    }
  }
  return changed;
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function blockExtent(lines: readonly string[], entityId: string): Set<number> {
  const idIndex = lines.findIndex((line) =>
    line.includes(`id: ${entityId}`) || line.includes(`id: "${entityId}"`),
  );
  if (idIndex === -1) return new Set();
  if (lines[idIndex]!.includes("{ ")) return new Set([idIndex]);

  const idIndent = indentation(lines[idIndex]!);
  const start = idIndex > 0 && lines[idIndex - 1]!.trim() === "-"
    ? idIndex - 1
    : idIndex;
  let end = idIndex + 1;
  while (
    end < lines.length &&
    (lines[end]!.trim() === "" || indentation(lines[end]!) >= idIndent)
  ) {
    end += 1;
  }
  // Anonymous list markers are indistinguishable to a line-level LCS. When an
  // entity is inserted, the added marker may align immediately after its block
  // rather than before it, so include that structural boundary in the extent.
  if (end < lines.length && lines[end]!.trim() === "-") end += 1;
  return new Set(Array.from({ length: end - start }, (_, offset) => start + offset));
}

function touchedLines(yaml: string, entityIds: readonly string[]): Set<number> {
  const lines = yaml.trimEnd().split("\n");
  const touched = new Set<number>();
  for (const entityId of entityIds) {
    for (const line of blockExtent(lines, entityId)) touched.add(line);
  }
  return touched;
}

function scenario(
  lengths: readonly number[],
  sourceStart: number,
  withEffects: boolean,
  kind: "trim" | "split" | "join",
  rawIndex: number,
  rawAmount: number,
): Scenario {
  const project = projectFixture();
  project.assets[0]!.probe.duration = { frames: 10_000, fps: "24/1" };
  let cursor = sourceStart;
  project.sequences[0]!.clips = lengths.map((length, index) => {
    const sourceIn = cursor;
    cursor += length;
    return {
      id: id("clp", index),
      asset: "ast_aaaaaaaaaa",
      source: {
        in: { frames: sourceIn, fps: "24/1" },
        out: { frames: cursor, fps: "24/1" },
      },
      ...(withEffects
        ? {
            effects: [{
              id: id("fx", index),
              kind: "speed",
              params: { rate: "1/1" },
            }],
          }
        : {}),
    };
  });

  if (kind === "join") {
    const index = rawIndex % (lengths.length - 1);
    return {
      project,
      operation: {
        op: "clip.join",
        params: {
          clipIds: [id("clp", index), id("clp", index + 1)],
        },
      },
    };
  }
  const index = rawIndex % lengths.length;
  const amount = 1 + rawAmount % (lengths[index]! - 1);
  return {
    project,
    operation: kind === "trim"
      ? {
          op: "clip.trim",
          params: {
            clipId: id("clp", index),
            edge: rawAmount % 2 === 0 ? "head" : "tail",
            delta: { frames: amount, fps: "24/1" },
            snapPolicy: "none",
          },
        }
      : {
          op: "clip.split",
          params: { clipId: id("clp", index), at: amount },
        },
  };
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .tuple(
    fc.array(fc.integer({ min: 2, max: 120 }), { minLength: 2, maxLength: 8 }),
    fc.integer({ min: 0, max: 100 }),
    fc.boolean(),
    fc.constantFrom("trim", "split", "join"),
    fc.nat(),
    fc.nat(),
  )
  .map((values) => scenario(...values));

function deterministicId(prefix: IdPrefix): string {
  if (prefix === "clp") return "clp_zzzzzzzzzz";
  if (prefix === "fx") return "fx_zzzzzzzzzz";
  return "txn_zzzzzzzzzz";
}

describe("P-D1 operation diff ownership", () => {
  it(
    `touches only canonical YAML blocks owned by affected entities (seed ${String(SEED)})`,
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArbitrary, async ({ project, operation }) => {
          const before = canonicalizeYaml(project);
          const engine = new OperationEngine(project, { idFactory: deterministicId });
          const result = await engine.execute([operation], {
            baseRevision: project.revision,
            origin: "ui",
            dryRun: false,
          });
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const comparableAfter = {
            ...engine.currentProject,
            revision: project.revision,
          };
          const after = canonicalizeYaml(comparableAfter);
          const beforeTouched = touchedLines(before, result.value.applied[0]!.affected);
          const afterTouched = touchedLines(after, result.value.applied[0]!.affected);
          const unexpected = lineChanges(before, after).filter((change) =>
            change.side === "before"
              ? !beforeTouched.has(change.index)
              : !afterTouched.has(change.index),
          );
          expect(unexpected).toEqual([]);
        }),
        { numRuns: RUNS, seed: SEED, verbose: true },
      );
    },
    30_000,
  );
});
