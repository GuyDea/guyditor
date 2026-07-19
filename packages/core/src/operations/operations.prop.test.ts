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

function id(prefix: "clp" | "fx" | "lyr" | "seq" | "trn", index: number): string {
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
  kind: OperationKind,
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
  project.layers.push({
    id: id("lyr", 1),
    kind: "audio",
    name: "empty audio",
    order: 1,
    enabled: true,
    locked: false,
    items: [],
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
  const clipId = id("clp", index);
  if (kind === "trim") {
    return {
      project,
      operation: {
        op: "clip.trim",
        params: {
          clipId,
          edge: rawAmount % 2 === 0 ? "head" : "tail",
          delta: { frames: amount, fps: "24/1" },
          snapPolicy: "none",
        },
      },
    };
  }
  if (kind === "split") {
    return { project, operation: { op: "clip.split", params: { clipId, at: amount } } };
  }
  if (kind === "remove") {
    return {
      project,
      operation: { op: "clip.remove", params: { clipId, closeGap: true } },
    };
  }
  if (kind === "insert") {
    return {
      project,
      operation: {
        op: "clip.insert",
        params: {
          sequenceId: project.sequences[0]!.id,
          index,
          layerId: project.layers[0]!.id,
          source: {
            assetId: project.assets[0]!.id,
            in: { frames: 9_000, fps: "24/1" },
            out: { frames: 9_024, fps: "24/1" },
          },
        },
      },
    };
  }
  if (kind === "move" || kind === "moveAcross") {
    if (kind === "moveAcross") {
      project.sequences.push({ id: id("seq", 1), name: "alternate", clips: [] });
      project.layers.push({
        id: id("lyr", 2),
        kind: "video",
        name: "alternate video",
        order: 2,
        enabled: true,
        locked: false,
        sequence: id("seq", 1),
      });
    }
    return {
      project,
      operation: {
        op: "clip.move",
        params: kind === "move"
          ? { clipId, toIndex: rawAmount % lengths.length }
          : {
              clipId,
              toSequenceId: id("seq", 1),
              toLayerId: id("lyr", 2),
              toIndex: 0,
            },
      },
    };
  }
  if (kind === "duplicate") {
    return {
      project,
      operation: {
        op: "clip.duplicate",
        params: { clipId, toIndex: rawAmount % (lengths.length + 1) },
      },
    };
  }
  if (kind === "gap") {
    return {
      project,
      operation: {
        op: "clip.gap.set",
        params: { clipId, leadingGap: { frames: amount, fps: "24/1" } },
      },
    };
  }
  if (kind === "overlap") {
    const overlapIndex = 1 + rawIndex % (lengths.length - 1);
    return {
      project,
      operation: {
        op: "clip.overlap.set",
        params: {
          clipId: id("clp", overlapIndex),
          overlapWithPrevious: {
            frames: 1 + rawAmount % Math.min(lengths[overlapIndex - 1]!, lengths[overlapIndex]!),
            fps: "24/1",
          },
        },
      },
    };
  }
  if (kind === "layerAdd") {
    return {
      project,
      operation: { op: "layer.add", params: { kind: "music", name: "music", index: 1 } },
    };
  }
  if (kind === "layerRemove") {
    return {
      project,
      operation: { op: "layer.remove", params: { layerId: id("lyr", 1) } },
    };
  }
  if (kind === "layerReorder") {
    return {
      project,
      operation: { op: "layer.reorder", params: { layerId: id("lyr", 1), toIndex: 0 } },
    };
  }
  if (["layerEnable", "layerDisable", "layerLock", "layerUnlock"].includes(kind)) {
    if (kind === "layerEnable") project.layers[1]!.enabled = false;
    if (kind === "layerUnlock") project.layers[1]!.locked = true;
    const action = kind.slice("layer".length).toLowerCase();
    return {
      project,
      operation: { op: `layer.${action}`, params: { layerId: id("lyr", 1) } },
    };
  }
  if (kind === "gain") {
    return {
      project,
      operation: { op: "clip.audio.gain.set", params: { clipId, gainDb: -amount } },
    };
  }
  if (kind === "fade") {
    return {
      project,
      operation: {
        op: "clip.audio.fade.set",
        params: {
          clipId,
          fadeIn: { t: { frames: amount, fps: "24/1" }, curve: "linear" },
          fadeOut: { t: { frames: amount, fps: "24/1" }, curve: "equal-power" },
        },
      },
    };
  }
  const boundaryIndex = rawIndex % (lengths.length - 1);
  const before = project.sequences[0]!.clips[boundaryIndex]!;
  const after = project.sequences[0]!.clips[boundaryIndex + 1]!;
  if (kind === "transitionRemove") {
    before.transitionAfter = {
      id: id("trn", 0),
      preset: "crossfade",
      duration: { frames: 1, fps: "24/1" },
    };
    return {
      project,
      operation: { op: "transition.remove", params: { transitionId: id("trn", 0) } },
    };
  }
  return {
    project,
    operation: {
      op: "transition.set",
      params: {
        boundary: { beforeClipId: before.id, afterClipId: after.id },
        kind: "crossfade",
        duration: { frames: 1, fps: "24/1" },
      },
    },
  };
}

type OperationKind =
  | "trim" | "split" | "join" | "remove" | "insert" | "move" | "moveAcross"
  | "duplicate" | "gap" | "overlap" | "layerAdd" | "layerRemove" | "layerReorder"
  | "layerEnable" | "layerDisable" | "layerLock" | "layerUnlock" | "gain" | "fade"
  | "transitionSet" | "transitionRemove";

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .tuple(
    fc.array(fc.integer({ min: 2, max: 120 }), { minLength: 2, maxLength: 8 }),
    fc.integer({ min: 0, max: 100 }),
    fc.boolean(),
    fc.constantFrom<OperationKind>(
      "trim",
      "split",
      "join",
      "remove",
      "insert",
      "move",
      "moveAcross",
      "duplicate",
      "gap",
      "overlap",
      "layerAdd",
      "layerRemove",
      "layerReorder",
      "layerEnable",
      "layerDisable",
      "layerLock",
      "layerUnlock",
      "gain",
      "fade",
      "transitionSet",
      "transitionRemove",
    ),
    fc.nat(),
    fc.nat(),
  )
  .map((values) => scenario(...values));

function deterministicId(prefix: IdPrefix): string {
  if (prefix === "clp") return "clp_zzzzzzzzzz";
  if (prefix === "fx") return "fx_zzzzzzzzzz";
  if (prefix === "lyr") return "lyr_zzzzzzzzzz";
  if (prefix === "trn") return "trn_zzzzzzzzzz";
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
