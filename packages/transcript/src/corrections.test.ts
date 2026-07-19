import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "../../core/src/index.js";
import type {
  GuyditorProject,
  OperationBatchResult,
  OperationInput,
  ProjectStore,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import type { TranscriptSidecar } from "./types.js";
import * as transcriptPackage from "./index.js";

interface TranscriptEngineInstance {
  createFromTranscription(
    project: ProjectStore,
    assetId: string,
    result: unknown,
  ): Promise<Result<unknown>>;
  execute(
    project: ProjectStore,
    operations: OperationInput[],
  ): Promise<Result<OperationBatchResult>>;
}

interface TranscriptEngineConstructor {
  new(options?: {
    idFactory?: (prefix: "seg" | "spk" | "txn") => string;
    now?: () => Date;
  }): TranscriptEngineInstance;
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function storeFixture(): Promise<ProjectStore> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-corrections-"));
  directories.push(root);
  const model: GuyditorProject = projectFixture();
  model.assets[0]!.audio = [{
    index: 0,
    codec: "pcm_s16le",
    sampleRate: 48_000,
    channels: 1,
    layout: "mono",
  }];
  const created = await createProject(root, model);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function sequentialIds(): (prefix: "seg" | "spk" | "txn") => string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let segment = 0;
  let speaker = 0;
  let transaction = 0;
  return (prefix) => {
    if (prefix === "seg") {
      segment += 1;
      return `seg_${alphabet[(segment - 1) % alphabet.length]!.repeat(10)}`;
    }
    if (prefix === "spk") {
      speaker += 1;
      return `spk_${alphabet[(speaker - 1) % alphabet.length]!.repeat(10)}`;
    }
    transaction += 1;
    return `${prefix}_${alphabet[(transaction - 1) % alphabet.length]!.repeat(10)}`;
  };
}

async function canonicalSidecar(store: ProjectStore): Promise<TranscriptSidecar> {
  const reference = store.currentProject.sidecars.find(
    ({ schema }) => schema === "guyditor.transcript/v1",
  );
  expect(reference).toBeDefined();
  if (reference === undefined) throw new Error("Transcript sidecar is missing.");
  return JSON.parse(await readFile(join(store.root, reference.path), "utf8")) as TranscriptSidecar;
}

async function apply(
  engine: TranscriptEngineInstance,
  store: ProjectStore,
  operation: OperationInput,
): Promise<OperationBatchResult> {
  const result = await engine.execute(store, [operation]);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.riskClass).toBe("low");
  expect(result.value.applied[0]?.summary).not.toBe("");
  expect(result.value.applied[0]?.inverse.length).toBeGreaterThan(0);
  return result.value;
}

describe("§4.7 transcript correction operations", () => {
  it("applies every direct correction without implicit word timing changes", async () => {
    const Constructor = (transcriptPackage as unknown as {
      TranscriptEngine?: TranscriptEngineConstructor;
    }).TranscriptEngine;
    expect(typeof Constructor).toBe("function");
    if (Constructor === undefined) return;
    const store = await storeFixture();
    const engine = new Constructor({
      idFactory: sequentialIds(),
      now: () => new Date("2026-07-18T12:00:00Z"),
    });
    const created = await engine.createFromTranscription(store, "ast_aaaaaaaaaa", {
      language: "en",
      languageProbability: 1,
      jobId: "job_aaaaaaaaaa",
      engine: { name: "test", version: "1", model: "fixture" },
      segments: [{
        index: 0,
        start: { samples: 0, rate: 48_000 },
        end: { samples: 48_000, rate: 48_000 },
        text: "one two three",
        avgLogprob: 0,
        noSpeechProb: 0,
        words: [
          { text: "one", start: { samples: 4_800, rate: 48_000 }, end: { samples: 9_600, rate: 48_000 }, probability: 1 },
          { text: "two", start: { samples: 14_400, rate: 48_000 }, end: { samples: 19_200, rate: 48_000 }, probability: 1 },
          { text: "three", start: { samples: 24_000, rate: 48_000 }, end: { samples: 28_800, rate: 48_000 }, probability: 1 },
        ],
      }],
    });
    expect(created.ok).toBe(true);
    const original = await canonicalSidecar(store);
    const originalFirstTiming = {
      start: original.words["w000001"]!.start,
      end: original.words["w000001"]!.end,
    };

    await apply(engine, store, {
      op: "transcript.word.correct",
      params: { wordId: "w000001", text: "One", punctAfter: "," },
    });
    let sidecar = await canonicalSidecar(store);
    expect(sidecar.words["w000001"]).toMatchObject({
      text: "One",
      punctAfter: ",",
      origin: "correction",
      ...originalFirstTiming,
    });

    await apply(engine, store, {
      op: "transcript.word.insert",
      params: {
        segmentId: "seg_aaaaaaaaaa",
        afterWordId: "w000001",
        tokens: ["brave"],
      },
    });
    sidecar = await canonicalSidecar(store);
    expect(sidecar.words["w000004"]).toMatchObject({
      text: "brave",
      start: { samples: 9_600, rate: 48_000 },
      end: { samples: 14_400, rate: 48_000 },
      alignment: "interpolated",
      origin: "correction",
    });

    await apply(engine, store, {
      op: "transcript.word.delete",
      params: { wordIds: ["w000002"] },
    });
    sidecar = await canonicalSidecar(store);
    expect(sidecar.words["w000002"]).toMatchObject({ state: "deleted" });
    expect(sidecar.words["w000002"]).not.toHaveProperty("replacedBy");

    await apply(engine, store, {
      op: "transcript.segment.split",
      params: { segmentId: "seg_aaaaaaaaaa", beforeWordId: "w000003" },
    });
    sidecar = await canonicalSidecar(store);
    expect(sidecar.segments.map(({ id }) => id)).toEqual([
      "seg_aaaaaaaaaa",
      "seg_bbbbbbbbbb",
    ]);
    expect(sidecar.words["w000003"]?.start).toEqual({ samples: 24_000, rate: 48_000 });

    await apply(engine, store, {
      op: "transcript.segment.merge",
      params: { segmentIds: ["seg_aaaaaaaaaa", "seg_bbbbbbbbbb"] },
    });
    sidecar = await canonicalSidecar(store);
    expect(sidecar.segments).toHaveLength(1);
    expect(sidecar.segments[0]?.id).toBe("seg_aaaaaaaaaa");

    await apply(engine, store, {
      op: "transcript.speaker.assign",
      params: {
        speakerId: "spk_bbbbbbbbbb",
        segmentIds: ["seg_aaaaaaaaaa"],
      },
    });
    sidecar = await canonicalSidecar(store);
    expect(sidecar.speakers).toContainEqual({
      id: "spk_bbbbbbbbbb",
      label: "spk_bbbbbbbbbb",
    });
    expect(sidecar.segments[0]?.speaker).toBe("spk_bbbbbbbbbb");

    await apply(engine, store, {
      op: "transcript.word.retime",
      params: {
        wordId: "w000003",
        start: { samples: 25_000, rate: 48_000 },
        end: { samples: 30_000, rate: 48_000 },
      },
    });
    sidecar = await canonicalSidecar(store);
    expect(sidecar.words["w000003"]).toMatchObject({
      start: { samples: 25_000, rate: 48_000 },
      end: { samples: 30_000, rate: 48_000 },
      alignment: "manual",
    });

    const replacement = await apply(engine, store, {
      op: "transcript.word.replace",
      params: { wordIds: ["w000001"], tokens: ["hello", "there"] },
    });
    sidecar = await canonicalSidecar(store);
    expect(sidecar.words["w000001"]).toMatchObject({
      state: "deleted",
      replacedBy: ["w000005", "w000006"],
      ...originalFirstTiming,
    });
    expect(sidecar.words["w000005"]).toMatchObject({
      text: "hello",
      alignment: "interpolated",
    });
    expect(sidecar.words["w000006"]).toMatchObject({
      text: "there",
      alignment: "interpolated",
    });
    expect(store.currentProject.transcript.nextWordOrdinal).toBe(7);
    expect(sidecar.words["w000003"]).toMatchObject({
      start: { samples: 25_000, rate: 48_000 },
      end: { samples: 30_000, rate: 48_000 },
    });
    const replacementInverse = await engine.execute(
      store,
      replacement.applied[0]!.inverse,
    );
    expect(replacementInverse.ok).toBe(true);
  });

  it("assigns a speaker to a word range by splitting segment attribution only", async () => {
    const Constructor = (transcriptPackage as unknown as {
      TranscriptEngine?: TranscriptEngineConstructor;
    }).TranscriptEngine;
    expect(typeof Constructor).toBe("function");
    if (Constructor === undefined) return;
    const store = await storeFixture();
    const engine = new Constructor({ idFactory: sequentialIds() });
    const created = await engine.createFromTranscription(store, "ast_aaaaaaaaaa", {
      language: "en",
      languageProbability: 1,
      jobId: "job_aaaaaaaaaa",
      engine: { name: "test", version: "1", model: "fixture" },
      segments: [{
        index: 0,
        start: { samples: 0, rate: 48_000 },
        end: { samples: 48_000, rate: 48_000 },
        text: "one two three",
        avgLogprob: 0,
        noSpeechProb: 0,
        words: [
          { text: "one", start: { samples: 4_800, rate: 48_000 }, end: { samples: 9_600, rate: 48_000 }, probability: 1 },
          { text: "two", start: { samples: 14_400, rate: 48_000 }, end: { samples: 19_200, rate: 48_000 }, probability: 1 },
          { text: "three", start: { samples: 24_000, rate: 48_000 }, end: { samples: 28_800, rate: 48_000 }, probability: 1 },
        ],
      }],
    });
    expect(created.ok).toBe(true);
    const before = await canonicalSidecar(store);
    const timings = Object.fromEntries(Object.entries(before.words).map(([wordId, word]) => [
      wordId,
      { start: word.start, end: word.end },
    ]));

    await apply(engine, store, {
      op: "transcript.speaker.assign",
      params: {
        speakerId: "spk_bbbbbbbbbb",
        wordRange: { fromWord: "w000002", toWord: "w000002" },
      },
    });

    const sidecar = await canonicalSidecar(store);
    expect(sidecar.segments.map(({ id, speaker, words }) => ({ id, speaker, words })))
      .toEqual([
        { id: "seg_aaaaaaaaaa", speaker: "spk_aaaaaaaaaa", words: ["w000001"] },
        { id: "seg_bbbbbbbbbb", speaker: "spk_bbbbbbbbbb", words: ["w000002"] },
        { id: "seg_cccccccccc", speaker: "spk_aaaaaaaaaa", words: ["w000003"] },
      ]);
    expect(Object.fromEntries(Object.entries(sidecar.words).map(([wordId, word]) => [
      wordId,
      { start: word.start, end: word.end },
    ]))).toEqual(timings);
  });

  it("emits executable inverses for noncontiguous word tombstones", async () => {
    const Constructor = (transcriptPackage as unknown as {
      TranscriptEngine?: TranscriptEngineConstructor;
    }).TranscriptEngine;
    expect(typeof Constructor).toBe("function");
    if (Constructor === undefined) return;
    const store = await storeFixture();
    const engine = new Constructor({ idFactory: sequentialIds() });
    const created = await engine.createFromTranscription(store, "ast_aaaaaaaaaa", {
      language: "en",
      languageProbability: 1,
      jobId: "job_aaaaaaaaaa",
      engine: { name: "test", version: "1", model: "fixture" },
      segments: [{
        index: 0,
        start: { samples: 0, rate: 48_000 },
        end: { samples: 48_000, rate: 48_000 },
        text: "one two three",
        avgLogprob: 0,
        noSpeechProb: 0,
        words: [
          { text: "one", start: { samples: 4_800, rate: 48_000 }, end: { samples: 9_600, rate: 48_000 }, probability: 1 },
          { text: "two", start: { samples: 14_400, rate: 48_000 }, end: { samples: 19_200, rate: 48_000 }, probability: 1 },
          { text: "three", start: { samples: 24_000, rate: 48_000 }, end: { samples: 28_800, rate: 48_000 }, probability: 1 },
        ],
      }],
    });
    expect(created.ok).toBe(true);

    const deletion = await apply(engine, store, {
      op: "transcript.word.delete",
      params: { wordIds: ["w000001", "w000003"] },
    });
    expect(deletion.applied[0]?.inverse).toHaveLength(2);
    const restored = await engine.execute(store, deletion.applied[0]!.inverse);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const sidecar = await canonicalSidecar(store);
    expect(sidecar.words["w000001"]?.replacedBy).toEqual(["w000004"]);
    expect(sidecar.words["w000003"]?.replacedBy).toEqual(["w000005"]);
    expect(sidecar.words["w000004"]).toMatchObject({ text: "one", state: "active" });
    expect(sidecar.words["w000005"]).toMatchObject({ text: "three", state: "active" });
  });
});
