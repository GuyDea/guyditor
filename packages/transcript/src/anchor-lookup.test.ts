import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AnchorResolverRegistry,
  createProject,
  resolveAnchor,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import {
  createTranscriptWordLookup,
  registerTranscriptWordLookup,
} from "./anchor-lookup.js";
import { TranscriptEngine } from "./engine.js";
import { serializeTranscriptSidecar } from "./sidecar.js";
import type { TranscriptSidecar } from "./types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function hash(sidecar: TranscriptSidecar): string {
  return createHash("sha256").update(serializeTranscriptSidecar(sidecar)).digest("hex");
}

function oneWordSidecar(state: "active" | "deleted"): TranscriptSidecar {
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
    speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker" }],
    segments: [{
      id: "seg_aaaaaaaaaa",
      speaker: "spk_aaaaaaaaaa",
      language: null,
      start: { samples: 0, rate: 1_000 },
      end: { samples: 1_000, rate: 1_000 },
      words: ["w000001"],
    }],
    words: {
      w000001: {
        text: "one",
        punctBefore: "",
        punctAfter: "",
        start: { samples: 100, rate: 1_000 },
        end: { samples: 200, rate: 1_000 },
        confidence: 1,
        alignment: "asr",
        state,
        origin: "asr",
      },
    },
  };
}

describe("transcript WordLookup registration", () => {
  it("adapts the existing tombstone fallback and neighboring text for resolveAnchor", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-anchor-lookup-"));
    directories.push(root);
    const model = projectFixture();
    model.beats.push({
      id: "beat_aaaaaaaaaa",
      name: "word anchor",
      anchor: "word:w000002",
    });
    model.assets[0]!.audio = [{
      index: 0,
      codec: "pcm_s16le",
      sampleRate: 1_000,
      channels: 1,
      layout: "mono",
    }];
    const store = await valueOf(createProject(root, model));
    const engine = new TranscriptEngine({
      idFactory(prefix) {
        if (prefix === "seg") return "seg_aaaaaaaaaa";
        if (prefix === "spk") return "spk_aaaaaaaaaa";
        return "txn_aaaaaaaaaa";
      },
      now: () => new Date("2026-07-18T12:00:00Z"),
    });
    await valueOf(engine.createFromTranscription(store, "ast_aaaaaaaaaa", {
      language: "en",
      languageProbability: 1,
      jobId: "job_aaaaaaaaaa",
      engine: { name: "test", version: "1", model: "fixture" },
      segments: [{
        index: 0,
        start: { samples: 0, rate: 1_000 },
        end: { samples: 1_000, rate: 1_000 },
        text: "one two three",
        avgLogprob: 0,
        noSpeechProb: 0,
        words: [
          { text: "one", start: { samples: 100, rate: 1_000 }, end: { samples: 200, rate: 1_000 }, probability: 1 },
          { text: "two", start: { samples: 300, rate: 1_000 }, end: { samples: 400, rate: 1_000 }, probability: 1 },
          { text: "three", start: { samples: 500, rate: 1_000 }, end: { samples: 600, rate: 1_000 }, probability: 1 },
        ],
      }],
    }));
    await valueOf(engine.execute(store, [{
      op: "transcript.word.delete",
      params: { wordIds: ["w000002"] },
    }]));

    const registry = new AnchorResolverRegistry();
    registerTranscriptWordLookup(registry, store);
    const resolution = await valueOf(resolveAnchor(
      store.currentProject,
      "word:w000002",
      "seq_aaaaaaaaaa",
      registry.dependencies(),
    ));
    expect(resolution).toMatchObject({
      status: "resolved",
      approximate: true,
      source: {
        assetId: "ast_aaaaaaaaaa",
        time: { frames: 2, fps: "24/1" },
      },
    });
    const located = await registry.dependencies().wordLookup!.resolveWord(
      store.currentProject,
      "w000002",
    );
    expect(located).toMatchObject({
      ok: true,
      value: {
        wordId: "w000001",
        context: { wordsBefore: [], wordsAfter: ["three"] },
      },
    });

    const orphaned = await valueOf(engine.execute(store, [{
      op: "transcript.word.delete",
      params: { wordIds: ["w000001", "w000003"] },
    }]));
    expect(orphaned.diff.orphanedAnchors).toEqual([{
      owner: "beat_aaaaaaaaaa",
      anchor: "word:w000002",
      anchorPath: "/anchor",
      reason: "word-deleted",
    }]);
    expect(store.currentProject.beats[0]).toMatchObject({
      anchorMetadata: {
        "/anchor": {
          lastResolved: {
            revision: "rev_00003",
            context: { wordsBefore: [], wordsAfter: ["three"] },
          },
        },
      },
    });
  });

  it("selects the sidecar version registered by each projected model hash", async () => {
    const active = oneWordSidecar("active");
    const deleted = oneWordSidecar("deleted");
    const before: GuyditorProject = projectFixture();
    before.sidecars.push({
      name: "transcript-ast_aaaaaaaaaa",
      path: "sidecars/transcripts/ast_aaaaaaaaaa.transcript.json",
      schema: "guyditor.transcript/v1",
      sha256: hash(active),
      inputs: [{ asset: "ast_aaaaaaaaaa", sha256: "a".repeat(64) }],
    });
    const after = structuredClone(before);
    after.sidecars.at(-1)!.sha256 = hash(deleted);
    const lookup = createTranscriptWordLookup([active, deleted]);

    expect(await lookup.resolveWord(before, "w000001")).toMatchObject({
      ok: true,
      value: { wordId: "w000001", approximate: false },
    });
    expect(await lookup.resolveWord(after, "w000001")).toEqual({
      ok: true,
      value: undefined,
    });
  });
});
