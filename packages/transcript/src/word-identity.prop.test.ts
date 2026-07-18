import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  OperationEngine,
  formatWordId,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  OperationInput,
  SidecarRef,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import {
  createTranscriptWorkspace,
} from "./operations.js";
import { serializeTranscriptSidecar } from "./sidecar.js";
import type {
  SampleTime,
  TranscriptSidecar,
  TranscriptWord,
} from "./types.js";

const RUNS = 500;
const SEED = 2_004_204;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

type ActionKind = "correct" | "split" | "merge" | "insert" | "delete";

interface Action {
  kind: ActionKind;
  selector: number;
  token: string;
}

interface MemoryTranscript {
  engine: OperationEngine;
  project: GuyditorProject;
  sidecar: TranscriptSidecar;
}

interface TimingSnapshot {
  start: SampleTime;
  end: SampleTime;
  deleted: boolean;
}

function suffix(value: number): string {
  let remaining = value;
  let encoded = "";
  do {
    encoded = BASE32[remaining % BASE32.length]! + encoded;
    remaining = Math.floor(remaining / BASE32.length);
  } while (remaining > 0);
  return encoded.padStart(10, "a").slice(-10);
}

function sidecarFixture(): TranscriptSidecar {
  const words: Record<string, TranscriptWord> = {};
  for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
    const start = ordinal * 1_000;
    words[formatWordId(ordinal)] = {
      text: `word${String(ordinal)}`,
      punctBefore: "",
      punctAfter: "",
      start: { samples: start, rate: 1_000 },
      end: { samples: start + 200, rate: 1_000 },
      confidence: 1,
      alignment: "asr",
      state: "active",
      origin: "asr",
    };
  }
  return {
    schema: "guyditor.transcript/v1",
    assetId: "ast_aaaaaaaaaa",
    audio: { rate: 1_000, channels: 1, streamIndex: 0 },
    language: "en",
    languageProbability: 1,
    provenance: {
      engine: { name: "test", version: "1", model: "fixture" },
      alignment: null,
      createdAt: "2026-07-18T12:00:00Z",
      jobId: "job_aaaaaaaaaa",
    },
    speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker 1" }],
    segments: [{
      id: "seg_aaaaaaaaaa",
      speaker: "spk_aaaaaaaaaa",
      language: null,
      start: { samples: 0, rate: 1_000 },
      end: { samples: 10_000, rate: 1_000 },
      words: Object.keys(words),
    }],
    words,
  };
}

function memoryTranscript(): MemoryTranscript {
  const sidecar = sidecarFixture();
  const serialized = serializeTranscriptSidecar(sidecar);
  const reference: SidecarRef = {
    name: "transcript-ast_aaaaaaaaaa",
    path: "sidecars/transcripts/ast_aaaaaaaaaa.transcript.json",
    schema: "guyditor.transcript/v1",
    sha256: createHash("sha256").update(serialized).digest("hex"),
    inputs: [{ asset: "ast_aaaaaaaaaa", sha256: "a".repeat(64) }],
  };
  const project = projectFixture();
  project.transcript.nextWordOrdinal = 6;
  project.sidecars.push(reference);
  let segmentOrdinal = 1;
  const workspace = createTranscriptWorkspace(
    [sidecar],
    [reference],
    () => {
      segmentOrdinal += 1;
      return `seg_${suffix(segmentOrdinal)}`;
    },
  );
  return {
    project,
    sidecar,
    engine: new OperationEngine(project, {
      idFactory: () => "txn_aaaaaaaaaa",
      operationDispatcher: workspace.dispatcher,
    }),
  };
}

function activeWordIds(sidecar: TranscriptSidecar): string[] {
  return sidecar.segments.flatMap(({ words }) => words).filter((wordId) =>
    sidecar.words[wordId]?.state === "active");
}

function insertablePositions(sidecar: TranscriptSidecar): Array<{
  segmentId: string;
  afterWordId: string;
}> {
  return sidecar.segments.flatMap((segment) => {
    const active = segment.words.filter((wordId) => sidecar.words[wordId]?.state === "active");
    return active.flatMap((wordId, index) => {
      const left = sidecar.words[wordId]!.end.samples;
      const nextId = active[index + 1];
      const right = nextId === undefined
        ? segment.end.samples
        : sidecar.words[nextId]!.start.samples;
      return left < right ? [{ segmentId: segment.id, afterWordId: wordId }] : [];
    });
  });
}

function operationFor(sidecar: TranscriptSidecar, action: Action): OperationInput | undefined {
  const active = activeWordIds(sidecar);
  if (action.kind === "correct") {
    const wordId = active[action.selector % active.length]!;
    return active.length === 0
      ? undefined
      : { op: "transcript.word.correct", params: { wordId, text: action.token } };
  }
  if (action.kind === "delete") {
    return active.length === 0
      ? undefined
      : {
          op: "transcript.word.delete",
          params: { wordIds: [active[action.selector % active.length]!] },
        };
  }
  if (action.kind === "insert") {
    const positions = insertablePositions(sidecar);
    const position = positions[action.selector % positions.length];
    return position === undefined
      ? undefined
      : {
          op: "transcript.word.insert",
          params: { ...position, tokens: [action.token] },
        };
  }
  if (action.kind === "split") {
    const candidates = sidecar.segments.filter(({ words }) => words.length >= 2);
    const segment = candidates[action.selector % candidates.length];
    if (segment === undefined) return undefined;
    const boundary = 1 + action.selector % (segment.words.length - 1);
    return {
      op: "transcript.segment.split",
      params: { segmentId: segment.id, beforeWordId: segment.words[boundary]! },
    };
  }
  if (sidecar.segments.length < 2) return undefined;
  const index = action.selector % (sidecar.segments.length - 1);
  return {
    op: "transcript.segment.merge",
    params: {
      segmentIds: [sidecar.segments[index]!.id, sidecar.segments[index + 1]!.id],
    },
  };
}

function snapshot(sidecar: TranscriptSidecar): Map<string, TimingSnapshot> {
  return new Map(Object.entries(sidecar.words).map(([wordId, word]) => [
    wordId,
    {
      start: structuredClone(word.start),
      end: structuredClone(word.end),
      deleted: word.state === "deleted",
    },
  ]));
}

function expectIdentityProperties(
  sidecar: TranscriptSidecar,
  before: ReadonlyMap<string, TimingSnapshot>,
  nextBefore: number,
  nextAfter: number,
): void {
  expect(nextAfter).toBeGreaterThanOrEqual(nextBefore);
  for (const [wordId, prior] of before) {
    const current = sidecar.words[wordId];
    expect(current, `${wordId} disappeared`).toBeDefined();
    expect(current?.start).toEqual(prior.start);
    expect(current?.end).toEqual(prior.end);
    if (prior.deleted) expect(current?.state).toBe("deleted");
  }
  const newIds = Object.keys(sidecar.words).filter((wordId) => !before.has(wordId));
  expect(newIds).toEqual(
    Array.from({ length: nextAfter - nextBefore }, (_, index) =>
      formatWordId(nextBefore + index)),
  );
}

const actionArbitrary: fc.Arbitrary<Action> = fc.record({
  kind: fc.constantFrom<ActionKind>("correct", "split", "merge", "insert", "delete"),
  selector: fc.nat(),
  token: fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), minLength: 1, maxLength: 8 }),
});

describe("FR-204 word-identity properties", () => {
  it(
    `P-W1/P-W2/P-W3 preserve ordinals and surviving source time over random edit sequences (seed ${String(SEED)})`,
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(actionArbitrary, { minLength: 1, maxLength: 15 }),
          async (actions) => {
            const memory = memoryTranscript();
            for (const action of actions) {
              const operation = operationFor(memory.sidecar, action);
              if (operation === undefined) continue;
              const before = snapshot(memory.sidecar);
              const nextBefore = memory.engine.currentProject.transcript.nextWordOrdinal;
              const result = await memory.engine.execute([operation], {
                baseRevision: memory.engine.currentProject.revision,
                origin: "ui",
                dryRun: false,
              });
              if (!result.ok) {
                throw new Error(`${operation.op}: ${result.error.code}: ${result.error.message}`);
              }
              const nextAfter = memory.engine.currentProject.transcript.nextWordOrdinal;
              expectIdentityProperties(memory.sidecar, before, nextBefore, nextAfter);
            }
          },
        ),
        { numRuns: RUNS, seed: SEED, verbose: true },
      );
    },
    30_000,
  );

  it(
    `P-W4 keeps source-time order and changes at most k + 1 serialized lines (seed ${String(SEED + 1)})`,
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom<ActionKind>("correct", "insert", "delete"),
          fc.nat(),
          fc.array(fc.string({
            unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"),
            minLength: 1,
            maxLength: 8,
          }), { minLength: 1, maxLength: 3 }),
          async (kind, selector, tokens) => {
            const memory = memoryTranscript();
            const baseOperation = operationFor(memory.sidecar, {
              kind,
              selector,
              token: tokens[0]!,
            });
            const active = activeWordIds(memory.sidecar);
            const operation = baseOperation === undefined
              ? undefined
              : kind === "insert"
                ? { ...baseOperation, params: { ...baseOperation.params, tokens } }
                : kind === "delete"
                  ? {
                      ...baseOperation,
                      params: {
                        wordIds: Array.from(
                          { length: Math.min(tokens.length, active.length) },
                          (_, offset) => active[(selector + offset) % active.length]!,
                        ),
                      },
                    }
                  : baseOperation;
            expect(operation).toBeDefined();
            if (operation === undefined) return;
            const before = serializeTranscriptSidecar(memory.sidecar);
            const result = await memory.engine.execute([operation], {
              baseRevision: memory.engine.currentProject.revision,
              origin: "ui",
              dryRun: false,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const after = serializeTranscriptSidecar(memory.sidecar);
            const changed = lineChangeCounts(before, after);
            const touchedWords = kind === "correct"
              ? 1
              : kind === "insert"
                ? tokens.length
                : (operation.params["wordIds"] as string[]).length;
            expect(Math.max(changed.before, changed.after))
              .toBeLessThanOrEqual(touchedWords + 1);

            const orderedIds = wordRecordIds(after);
            const expectedIds = Object.entries(memory.sidecar.words)
              .sort(([leftId, left], [rightId, right]) =>
                left.start.samples - right.start.samples ||
                left.end.samples - right.end.samples ||
                leftId.localeCompare(rightId))
              .map(([wordId]) => wordId);
            expect(orderedIds).toEqual(expectedIds);
          },
        ),
        { numRuns: RUNS, seed: SEED + 1, verbose: true },
      );
    },
    30_000,
  );
});

function wordRecordIds(serialized: string): string[] {
  return serialized.split("\n").flatMap((line) => {
    const match = /^    ,?"(w[0-9]{6})":/u.exec(line);
    return match === null ? [] : [match[1]!];
  });
}

function lineChangeCounts(before: string, after: string): {
  before: number;
  after: number;
} {
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
  const common = lengths[0]![0]!;
  return { before: left.length - common, after: right.length - common };
}
