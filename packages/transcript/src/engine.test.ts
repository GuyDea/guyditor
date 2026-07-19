import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProject,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  ProjectStore,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import * as transcriptPackage from "./index.js";

interface CreatedTranscript {
  sidecar: unknown;
  transactionId?: string;
}

interface TranscriptEngineInstance {
  createFromTranscription(
    project: ProjectStore,
    assetId: string,
    result: unknown,
  ): Promise<Result<CreatedTranscript>>;
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

async function makeStore(): Promise<ProjectStore> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-transcript-"));
  directories.push(root);
  const model: GuyditorProject = projectFixture();
  model.transcript.nextWordOrdinal = 12;
  model.assets[0]!.audio = [{
    index: 1,
    codec: "pcm_s16le",
    sampleRate: 48_000,
    channels: 2,
    layout: "stereo",
  }];
  const created = await createProject(root, model, { appVersion: "0.0.0-test" });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function idFactory(prefix: "seg" | "spk" | "txn"): string {
  if (prefix === "seg") return "seg_aaaaaaaaaa";
  if (prefix === "spk") return "spk_aaaaaaaaaa";
  return "txn_aaaaaaaaaa";
}

describe("TranscriptEngine.createFromTranscription", () => {
  it("creates and registers one canonical sidecar in the ordinal transaction", async () => {
    const Constructor = (transcriptPackage as unknown as {
      TranscriptEngine?: TranscriptEngineConstructor;
    }).TranscriptEngine;
    expect(typeof Constructor).toBe("function");
    if (Constructor === undefined) return;
    const store = await makeStore();
    const engine = new Constructor({
      idFactory,
      now: () => new Date("2026-07-18T12:00:00Z"),
    });

    const result = await engine.createFromTranscription(
      store,
      "ast_aaaaaaaaaa",
      {
        language: "en",
        languageProbability: 0.99,
        jobId: "job_aaaaaaaaaa",
        engine: { name: "faster-whisper", version: "1.1.0", model: "large-v3" },
        segments: [{
          index: 0,
          start: 0.1,
          end: { samples: 16_000, rate: 16_000 },
          text: "“Hello, world!",
          avgLogprob: -0.1,
          noSpeechProb: 0.01,
          words: [
            {
              text: " “Hello,",
              start: 0.1,
              end: 0.4,
              probability: 0.9,
            },
            {
              text: " world!",
              start: { samples: 8_000, rate: 16_000 },
              end: { samples: 14_400, rate: 16_000 },
              probability: 0.8,
            },
          ],
        }],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transactionId).toBe("txn_aaaaaaaaaa");
    expect(store.currentProject.revision).toBe("rev_00002");
    expect(store.currentProject.transcript.nextWordOrdinal).toBe(14);
    const reference = store.currentProject.sidecars.find(
      ({ schema }) => schema === "guyditor.transcript/v1",
    );
    expect(reference).toMatchObject({
      name: "transcript-ast_aaaaaaaaaa",
      path: "sidecars/transcripts/ast_aaaaaaaaaa.transcript.json",
      schema: "guyditor.transcript/v1",
      generatedBy: {
        tool: "mlworker/faster-whisper",
        version: "1.1.0",
        job: "job_aaaaaaaaaa",
      },
      inputs: [{ asset: "ast_aaaaaaaaaa", sha256: "a".repeat(64) }],
    });
    expect(reference).toBeDefined();
    if (reference === undefined) return;
    const sidecarText = await readFile(join(store.root, reference.path), "utf8");
    expect(reference.sha256).toBe(createHash("sha256").update(sidecarText).digest("hex"));
    const sidecar = JSON.parse(sidecarText) as {
      segments: Array<{ words: string[] }>;
      words: Record<string, {
        text: string;
        punctBefore: string;
        punctAfter: string;
        start: { samples: number; rate: number };
        end: { samples: number; rate: number };
      }>;
    };
    expect(sidecar.segments[0]?.words).toEqual(["w000012", "w000013"]);
    expect(sidecar.words["w000012"]).toMatchObject({
      text: "Hello",
      punctBefore: "“",
      punctAfter: ",",
      start: { samples: 4_800, rate: 48_000 },
      end: { samples: 19_200, rate: 48_000 },
    });
    expect(sidecar.words["w000013"]).toMatchObject({
      text: "world",
      punctBefore: "",
      punctAfter: "!",
      start: { samples: 24_000, rate: 48_000 },
      end: { samples: 43_200, rate: 48_000 },
    });

    const journal = await readFile(join(store.root, "history/transactions.jsonl"), "utf8");
    const transaction = JSON.parse(journal.trimEnd().split("\n")[1]!) as {
      operations: Array<{ op: string; summary: string }>;
    };
    expect(transaction.operations).toEqual([expect.objectContaining({
      op: "transcript.create",
      summary: "Register canonical transcript for ast_aaaaaaaaaa",
    })]);
  });

  it("rounds float-second half-sample ties toward the earlier native sample", async () => {
    const Constructor = (transcriptPackage as unknown as {
      TranscriptEngine?: TranscriptEngineConstructor;
    }).TranscriptEngine;
    expect(typeof Constructor).toBe("function");
    if (Constructor === undefined) return;
    const store = await makeStore();
    const engine = new Constructor({ idFactory });
    const result = await engine.createFromTranscription(store, "ast_aaaaaaaaaa", {
      language: "en",
      languageProbability: 1,
      jobId: "job_aaaaaaaaaa",
      engine: { name: "test", version: "1", model: "fixture" },
      segments: [{
        index: 0,
        start: 0,
        end: 1.5 / 48_000,
        text: "tie",
        avgLogprob: 0,
        noSpeechProb: 0,
        words: [{
          text: "tie",
          start: 0.5 / 48_000,
          end: 1.5 / 48_000,
          probability: 1,
        }],
      }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sidecar = result.value.sidecar as {
      words: Record<string, {
        start: { samples: number; rate: number };
        end: { samples: number; rate: number };
      }>;
    };
    expect(sidecar.words["w000012"]).toMatchObject({
      start: { samples: 0, rate: 48_000 },
      end: { samples: 1, rate: 48_000 },
    });
  });
});

describe("TranscriptEngine.importSubtitles", () => {
  it("ingests an SRT asset and registers a provisional imported transcript atomically", async () => {
    const store = await makeStore();
    const source = join(store.root, "captions.srt");
    await writeFile(source, "1\n00:00:00,000 --> 00:00:01,000\nHello captions.\n", "utf8");
    const engine = new transcriptPackage.TranscriptEngine({
      project: store,
      now: () => new Date("2026-07-19T10:00:00.000Z"),
      idFactory: (prefix) => {
        if (prefix === "ast") return "ast_bbbbbbbbbb";
        if (prefix === "job") return "job_bbbbbbbbbb";
        if (prefix === "txn") return "txn_bbbbbbbbbb";
        if (prefix === "seg") return "seg_bbbbbbbbbb";
        if (prefix === "spk") return "spk_bbbbbbbbbb";
        return `${prefix}_bbbbbbbbbb`;
      },
    });

    const result = await engine.importSubtitles(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      assetId: "ast_bbbbbbbbbb",
      provisional: true,
      transactionId: "txn_bbbbbbbbbb",
      sidecar: { provisional: true, assetId: "ast_bbbbbbbbbb" },
    });
    expect(store.currentProject.assets).toContainEqual(expect.objectContaining({
      id: "ast_bbbbbbbbbb",
      kind: "subtitle",
      path: source,
    }));
    expect(store.currentProject.transcript.nextWordOrdinal).toBe(14);
    expect(store.currentProject.sidecars).toContainEqual(expect.objectContaining({
      name: "transcript-ast_bbbbbbbbbb",
      schema: "guyditor.transcript/v1",
    }));
    const persisted = JSON.parse(await readFile(
      join(store.root, "sidecars/transcripts/ast_bbbbbbbbbb.transcript.json"),
      "utf8",
    )) as { provisional?: boolean };
    expect(persisted.provisional).toBe(true);
  });
});
