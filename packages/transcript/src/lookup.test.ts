import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "../../core/src/index.js";
import type {
  GuyditorProject,
  OperationInput,
  ProjectStore,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import type { WordLocation, WordResolution } from "./types.js";
import * as transcriptPackage from "./index.js";

interface TranscriptEngineInstance {
  createFromTranscription(project: ProjectStore, assetId: string, result: unknown): Promise<Result<unknown>>;
  execute(project: ProjectStore, operations: OperationInput[]): Promise<Result<unknown>>;
}

interface TranscriptEngineConstructor {
  new(options?: {
    idFactory?: (prefix: "seg" | "spk" | "txn") => string;
    now?: () => Date;
  }): TranscriptEngineInstance;
}

interface LookupApi {
  findWord(project: ProjectStore, wordId: string): Promise<Result<WordLocation | undefined>>;
  resolveWord(project: ProjectStore, wordId: string): Promise<Result<WordResolution | undefined>>;
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function deterministicIds(): (prefix: "seg" | "spk" | "txn") => string {
  let segment = 0;
  let speaker = 0;
  return (prefix) => {
    if (prefix === "seg") {
      segment += 1;
      return `seg_${segment === 1 ? "aaaaaaaaaa" : "bbbbbbbbbb"}`;
    }
    if (prefix === "spk") {
      speaker += 1;
      return `spk_${speaker === 1 ? "aaaaaaaaaa" : "bbbbbbbbbb"}`;
    }
    return "txn_aaaaaaaaaa";
  };
}

async function transcriptProject(): Promise<{
  engine: TranscriptEngineInstance;
  store: ProjectStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-lookup-"));
  directories.push(root);
  const model: GuyditorProject = projectFixture();
  model.assets[0]!.audio = [{
    index: 0,
    codec: "pcm_s16le",
    sampleRate: 1_000,
    channels: 1,
    layout: "mono",
  }];
  const created = await createProject(root, model);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error.message);
  const Constructor = (transcriptPackage as unknown as {
    TranscriptEngine?: TranscriptEngineConstructor;
  }).TranscriptEngine;
  expect(typeof Constructor).toBe("function");
  if (Constructor === undefined) throw new Error("TranscriptEngine is missing.");
  const engine = new Constructor({
    idFactory: deterministicIds(),
    now: () => new Date("2026-07-18T12:00:00Z"),
  });
  const transcript = await engine.createFromTranscription(created.value, "ast_aaaaaaaaaa", {
    language: "en",
    languageProbability: 1,
    jobId: "job_aaaaaaaaaa",
    engine: { name: "test", version: "1", model: "fixture" },
    segments: [{
      index: 0,
      start: { samples: 0, rate: 1_000 },
      end: { samples: 3_000, rate: 1_000 },
      text: "one two three",
      avgLogprob: 0,
      noSpeechProb: 0,
      words: [
        { text: "one", start: { samples: 100, rate: 1_000 }, end: { samples: 200, rate: 1_000 }, probability: 1 },
        { text: "two", start: { samples: 300, rate: 1_000 }, end: { samples: 400, rate: 1_000 }, probability: 1 },
        { text: "three", start: { samples: 500, rate: 1_000 }, end: { samples: 600, rate: 1_000 }, probability: 1 },
      ],
    }],
  });
  expect(transcript.ok).toBe(true);
  return { engine, store: created.value };
}

async function mutate(
  engine: TranscriptEngineInstance,
  store: ProjectStore,
  operation: OperationInput,
): Promise<void> {
  const result = await engine.execute(store, [operation]);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
}

describe("project-global word lookup and tombstone fallback", () => {
  it("finds active and deleted words across canonical sidecars", async () => {
    const api = transcriptPackage as unknown as Partial<LookupApi>;
    expect(typeof api.findWord).toBe("function");
    if (api.findWord === undefined) return;
    const { engine, store } = await transcriptProject();
    await mutate(engine, store, {
      op: "transcript.word.delete",
      params: { wordIds: ["w000002"] },
    });

    const found = await api.findWord(store, "w000002");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toMatchObject({
      assetId: "ast_aaaaaaaaaa",
      segmentId: "seg_aaaaaaaaaa",
      wordId: "w000002",
      word: { state: "deleted", text: "two" },
    });
  });

  it("follows replacedBy transitively to the first active descendant", async () => {
    const api = transcriptPackage as unknown as Partial<LookupApi>;
    expect(typeof api.resolveWord).toBe("function");
    if (api.resolveWord === undefined) return;
    const { engine, store } = await transcriptProject();
    await mutate(engine, store, {
      op: "transcript.word.replace",
      params: { wordIds: ["w000001"], tokens: ["alpha", "beta"] },
    });
    await mutate(engine, store, {
      op: "transcript.word.replace",
      params: { wordIds: ["w000004"], tokens: ["alpha-prime"] },
    });

    const resolved = await api.resolveWord(store, "w000001");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toMatchObject({
      requestedWordId: "w000001",
      wordId: "w000006",
      approximate: false,
      word: { state: "active", text: "alpha-prime" },
    });
  });

  it("falls back to the deterministic nearest active same-segment midpoint within 2000 ms", async () => {
    const api = transcriptPackage as unknown as Partial<LookupApi>;
    expect(typeof api.resolveWord).toBe("function");
    if (api.resolveWord === undefined) return;
    const { engine, store } = await transcriptProject();
    await mutate(engine, store, {
      op: "transcript.word.delete",
      params: { wordIds: ["w000002"] },
    });

    const resolved = await api.resolveWord(store, "w000002");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toMatchObject({
      requestedWordId: "w000002",
      wordId: "w000001",
      approximate: true,
      word: { state: "active" },
    });
  });
});
