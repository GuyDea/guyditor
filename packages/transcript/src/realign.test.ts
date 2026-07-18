import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  createProject,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  OperationBatchResult,
  ProjectStore,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import type {
  TranscribeResult,
  TranscriptSidecar,
} from "./types.js";
import * as transcriptPackage from "./index.js";

interface RealignRequest {
  assetId: string;
  wordRange?: { fromWord: string; toWord: string };
}

interface EngineOptions {
  idFactory?: (prefix: "seg" | "spk" | "txn") => string;
  now?: () => Date;
  alignmentJobs?: {
    queue: JobQueue;
    hasAlignCapability: () => boolean;
    audioPath: (assetId: string) => string;
    model?: string;
  };
}

interface EngineInstance {
  createFromTranscription(
    project: ProjectStore,
    assetId: string,
    result: TranscribeResult,
  ): Promise<Result<{ sidecar: TranscriptSidecar; alignmentJobId?: string }>>;
  realign(
    project: ProjectStore,
    request: RealignRequest,
  ): Promise<Result<OperationBatchResult>>;
}

interface EngineConstructor {
  new(options?: EngineOptions): EngineInstance;
}

const directories: string[] = [];
const queues: JobQueue[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function constructor(): EngineConstructor {
  const value = (transcriptPackage as unknown as {
    TranscriptEngine?: EngineConstructor;
  }).TranscriptEngine;
  expect(typeof value).toBe("function");
  if (value === undefined) throw new Error("TranscriptEngine is not exported.");
  return value;
}

function idFactory(prefix: "seg" | "spk" | "txn"): string {
  if (prefix === "seg") return "seg_aaaaaaaaaa";
  if (prefix === "spk") return "spk_aaaaaaaaaa";
  return "txn_aaaaaaaaaa";
}

async function makeStore(): Promise<ProjectStore> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-realign-"));
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

function transcription(probabilities: readonly number[]): TranscribeResult {
  const words = ["one", "two", "three"];
  return {
    language: "en",
    languageProbability: 1,
    jobId: "job_aaaaaaaaaa",
    engine: { name: "test-asr", version: "1", model: "fixture" },
    segments: [{
      index: 0,
      start: { samples: 0, rate: 16_000 },
      end: { samples: 16_000, rate: 16_000 },
      text: words.join(" "),
      avgLogprob: 0,
      noSpeechProb: 0,
      words: words.map((text, index) => ({
        text,
        start: { samples: 1_000 + index * 4_000, rate: 16_000 },
        end: { samples: 3_000 + index * 4_000, rate: 16_000 },
        probability: probabilities[index] ?? 1,
      })),
    }],
  };
}

async function sidecar(store: ProjectStore): Promise<TranscriptSidecar> {
  const reference = store.currentProject.sidecars.find(
    ({ schema }) => schema === "guyditor.transcript/v1",
  );
  if (reference === undefined) throw new Error("Transcript sidecar is missing.");
  return JSON.parse(await readFile(join(store.root, reference.path), "utf8")) as TranscriptSidecar;
}

async function sidecarText(store: ProjectStore): Promise<string> {
  const reference = store.currentProject.sidecars.find(
    ({ schema }) => schema === "guyditor.transcript/v1",
  );
  if (reference === undefined) throw new Error("Transcript sidecar is missing.");
  return readFile(join(store.root, reference.path), "utf8");
}

describe("transcript.realign", () => {
  it("applies queued timing updates and provenance in one ordinal-preserving transaction", async () => {
    const queue = JobQueue.open(":memory:").queue;
    queues.push(queue);
    let workerPayload: unknown;
    queue.registerExecutor("align", async (job, { reportProgress }) => {
      workerPayload = structuredClone(job.payload);
      reportProgress(0.5);
      return {
        tokens: [
          {
            segmentIndex: 0,
            tokenIndex: 0,
            start: { samples: 1_200, rate: 16_000 },
            end: { samples: 2_800, rate: 16_000 },
            score: 0.8,
            aligned: true,
          },
          {
            segmentIndex: 0,
            tokenIndex: 1,
            start: { samples: 5_200, rate: 16_000 },
            end: { samples: 6_800, rate: 16_000 },
            score: 0,
            aligned: false,
          },
          {
            segmentIndex: 0,
            tokenIndex: 2,
            start: { samples: 9_200, rate: 16_000 },
            end: { samples: 10_800, rate: 16_000 },
            score: 0.34,
            aligned: true,
          },
        ],
        engine: {
          name: "torchaudio-wav2vec2-ctc-forced-align",
          version: "2.10.0+cpu",
          model: "wav2vec2-base-960h",
        },
      };
    });
    const store = await makeStore();
    const engine = new (constructor())({
      idFactory,
      now: () => new Date("2026-07-18T12:00:00Z"),
      alignmentJobs: {
        queue,
        hasAlignCapability: () => true,
        audioPath: (assetId) => `/cache/${assetId}.16k.wav`,
      },
    });
    const created = await engine.createFromTranscription(
      store,
      "ast_aaaaaaaaaa",
      transcription([0.9, 0.8, 0.7]),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await sidecar(store);
    const beforeText = await sidecarText(store);
    const wordIds = Object.keys(before.words);
    const segmentWords = [...before.segments[0]!.words];

    const result = await engine.realign(store, {
      assetId: "ast_aaaaaaaaaa",
      wordRange: { fromWord: "w000001", toWord: "w000003" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.riskClass).toBe("normal");
    expect(result.value.applied).toHaveLength(1);
    expect(result.value.applied[0]?.op).toBe("transcript.realign");
    expect(workerPayload).toMatchObject({
      audioPath: "/cache/ast_aaaaaaaaaa.16k.wav",
      language: "en",
      model: "wav2vec2-base-960h",
      segments: [{
        index: 0,
        start: { samples: 1_000, rate: 16_000 },
        end: { samples: 11_000, rate: 16_000 },
        tokens: ["one", "two", "three"],
      }],
    });
    const after = await sidecar(store);
    expect(Object.keys(after.words)).toEqual(wordIds);
    expect(after.segments[0]?.words).toEqual(segmentWords);
    expect(after.words["w000001"]).toMatchObject({
      start: { samples: 3_600, rate: 48_000 },
      end: { samples: 8_400, rate: 48_000 },
      alignment: "ctc",
    });
    expect(after.words["w000001"]?.confidence).toBeCloseTo(0.72);
    expect(after.words["w000002"]).toMatchObject({
      start: { samples: 15_600, rate: 48_000 },
      end: { samples: 20_400, rate: 48_000 },
      confidence: 0.8,
      alignment: "interpolated",
    });
    expect(after.words["w000003"]).toEqual(before.words["w000003"]);
    const afterText = await sidecarText(store);
    const afterLines = afterText.split("\n");
    const changedLines = beforeText.split("\n").filter(
      (line, index) => line !== afterLines[index],
    );
    expect(changedLines).toHaveLength(3);
    expect(after.provenance.alignment).toEqual({
      name: "torchaudio-wav2vec2-ctc-forced-align",
      version: "2.10.0+cpu",
      model: "wav2vec2-base-960h",
    });
    const journal = await readFile(join(store.root, "history/transactions.jsonl"), "utf8");
    const transaction = JSON.parse(journal.trimEnd().split("\n").at(-1)!) as {
      operations: Array<{ op: string; params: Record<string, unknown> }>;
    };
    expect(transaction.operations).toHaveLength(1);
    expect(transaction.operations[0]).toMatchObject({
      op: "transcript.realign",
      params: {
        assetId: "ast_aaaaaaaaaa",
        updates: [
          { wordId: "w000001", alignment: "ctc" },
          { wordId: "w000002", alignment: "interpolated" },
        ],
      },
    });
  });

  it("auto-enqueues but does not apply alignment when any ASR confidence is below 0.35", async () => {
    const queue = JobQueue.open(":memory:").queue;
    queues.push(queue);
    const store = await makeStore();
    const engine = new (constructor())({
      idFactory,
      alignmentJobs: {
        queue,
        hasAlignCapability: () => true,
        audioPath: (assetId) => `/cache/${assetId}.16k.wav`,
      },
    });

    const created = await engine.createFromTranscription(
      store,
      "ast_aaaaaaaaaa",
      transcription([0.9, 0.349, 0.7]),
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.alignmentJobId).toMatch(/^job_/);
    const job = queue.get(created.value.alignmentJobId!);
    expect(job).toMatchObject({
      kind: "align",
      state: "queued",
      payload: {
        audioPath: "/cache/ast_aaaaaaaaaa.16k.wav",
        language: "en",
        model: "wav2vec2-base-960h",
        segments: [{ tokens: ["one", "two", "three"] }],
      },
    });
    const canonical = await sidecar(store);
    expect(canonical.provenance.alignment).toBeNull();
    expect(Object.values(canonical.words).every(({ alignment }) => alignment === "asr")).toBe(true);
  });

  it("does not enqueue at the inclusive 0.35 confidence boundary", async () => {
    const queue = JobQueue.open(":memory:").queue;
    queues.push(queue);
    const store = await makeStore();
    const engine = new (constructor())({
      idFactory,
      alignmentJobs: {
        queue,
        hasAlignCapability: () => true,
        audioPath: () => "/cache/audio.16k.wav",
      },
    });
    const created = await engine.createFromTranscription(
      store,
      "ast_aaaaaaaaaa",
      transcription([0.9, 0.35, 0.7]),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.alignmentJobId).toBeUndefined();
    expect(queue.list({ kind: "align" })).toHaveLength(0);
  });
});
