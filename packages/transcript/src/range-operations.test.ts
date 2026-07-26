import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  IdPrefix,
  ProjectStore,
  Result,
  TransactionRecord,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";

import { createTranscriptWordLookup } from "./anchor-lookup.js";
import { TranscriptEngine } from "./engine.js";
import { parseTranscriptSidecar } from "./sidecar.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) {
    throw new Error(`${settled.error.code}: ${settled.error.message}`);
  }
  return settled.value;
}

function model(): GuyditorProject {
  const project = projectFixture();
  project.assets[0]!.probe.duration = { frames: 120, fps: "24/1" };
  project.assets[0]!.audio = [{
    index: 0,
    codec: "pcm_s16le",
    sampleRate: 48_000,
    channels: 1,
    layout: "mono",
  }];
  project.sequences[0]!.clips = [{
    id: "clp_aaaaaaaaaa",
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: 0, fps: "24/1" },
      out: { frames: 120, fps: "24/1" },
    },
  }];
  project.captions = [];
  delete project.deliverables[0]!.captionsTrackId;
  return project;
}

const generated = new Map<IdPrefix | "seg" | "spk", readonly string[]>([
  ["ast", []],
  ["clp", ["clp_cccccccccc", "clp_dddddddddd", "clp_eeeeeeeeee", "clp_ffffffffff"]],
  ["seq", ["seq_bbbbbbbbbb"]],
  ["lyr", ["lyr_bbbbbbbbbb"]],
  ["trn", []],
  ["cts", ["cts_bbbbbbbbbb"]],
  ["ann", []],
  ["dlv", ["dlv_bbbbbbbbbb", "dlv_cccccccccc"]],
  ["pre", []],
  ["tpl", []],
  ["skl", []],
  ["beat", []],
  ["mrk", []],
  ["tak", []],
  ["ses", []],
  ["job", []],
  ["txn", [
    "txn_bbbbbbbbbb",
    "txn_cccccccccc",
    "txn_dddddddddd",
    "txn_eeeeeeeeee",
    "txn_ffffffffff",
    "txn_gggggggggg",
  ]],
  ["prp", []],
  ["adp", []],
  ["prj", []],
  ["fx", ["fx_bbbbbbbbbb", "fx_cccccccccc", "fx_dddddddddd"]],
  ["gfx", []],
  ["msk", []],
  ["kfr", []],
  ["avr", []],
  ["seg", ["seg_aaaaaaaaaa"]],
  ["spk", ["spk_aaaaaaaaaa"]],
]);

function ids() {
  const counters = new Map<IdPrefix | "seg" | "spk", number>();
  return (prefix: IdPrefix | "seg" | "spk"): string => {
    const index = counters.get(prefix) ?? 0;
    counters.set(prefix, index + 1);
    const id = generated.get(prefix)?.[index];
    if (id === undefined) throw new Error(`Unexpected ${prefix} ID allocation ${String(index)}.`);
    return id;
  };
}

async function fixture(): Promise<{
  store: ProjectStore;
  engine: TranscriptEngine;
}> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-range-ops-"));
  roots.push(root);
  const store = await valueOf(createProject(root, model()));
  const idFactory = ids();
  const engine = new TranscriptEngine({
    idFactory,
    now: () => new Date("2026-07-19T00:00:00Z"),
  });
  await valueOf(engine.createFromTranscription(store, "ast_aaaaaaaaaa", {
    language: "en",
    languageProbability: 1,
    jobId: "job_aaaaaaaaaa",
    engine: { name: "test", version: "1", model: "fixture" },
    segments: [{
      index: 0,
      start: { samples: 0, rate: 48_000 },
      end: { samples: 240_000, rate: 48_000 },
      text: "one two three four",
      avgLogprob: 0,
      noSpeechProb: 0,
      words: [
        { text: "one", start: { samples: 24_000, rate: 48_000 }, end: { samples: 48_000, rate: 48_000 }, probability: 1 },
        { text: "two", start: { samples: 72_000, rate: 48_000 }, end: { samples: 96_000, rate: 48_000 }, probability: 1 },
        { text: "three", start: { samples: 120_000, rate: 48_000 }, end: { samples: 144_000, rate: 48_000 }, probability: 1 },
        { text: "four", start: { samples: 168_000, rate: 48_000 }, end: { samples: 192_000, rate: 48_000 }, probability: 1 },
      ],
    }],
  }));
  return { store, engine };
}

function withoutRevision(project: GuyditorProject): GuyditorProject {
  return { ...project, revision: "rev_00000" };
}

function expectDerivativeProvenance(
  project: GuyditorProject,
  clipId: string,
  start: number,
  end: number,
): void {
  expect.soft(
    project.sequences.find(({ id }) => id === "seq_bbbbbbbbbb")?.clips,
  ).toEqual([{
    id: clipId,
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: start, fps: "24/1" },
      out: { frames: end, fps: "24/1" },
    },
  }]);
  expect.soft(
    project.deliverables.find(({ id }) => id === "dlv_bbbbbbbbbb")?.dependencies,
  ).toEqual([{
    derivativeClipId: clipId,
    source: {
      assetId: "ast_aaaaaaaaaa",
      range: {
        start: { frames: start, fps: "24/1" },
        end: { frames: end, fps: "24/1" },
      },
      words: { startWordId: "w000002", endWordId: "w000003" },
      longformClipId: "clp_aaaaaaaaaa",
    },
  }]);
}

describe("transcript range operations", () => {
  it("records range.remove as one semantic operation and its inverse restores the project", async () => {
    const { store, engine } = await fixture();
    const before = structuredClone(store.currentProject);

    const removed = await valueOf(engine.execute(store, [{
      op: "transcript.range.remove",
      params: {
        wordRange: { fromWord: "w000002", toWord: "w000002" },
        paddingMs: 0,
        snapPolicy: "none",
      },
    }]));

    expect(removed.applied).toHaveLength(1);
    expect(removed.applied[0]).toMatchObject({
      op: "transcript.range.remove",
      captionImpact: "shift",
    });
    expect(removed.applied[0]!.summary).toContain("Remove");
    expect(store.currentProject.sequences[0]!.clips.map(({ source }) => source)).toEqual([
      { in: { frames: 0, fps: "24/1" }, out: { frames: 36, fps: "24/1" } },
      { in: { frames: 48, fps: "24/1" }, out: { frames: 120, fps: "24/1" } },
    ]);

    const journal = (await readFile(join(store.root, "history/transactions.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as TransactionRecord);
    expect(journal.at(-1)!.operations).toHaveLength(1);
    expect(journal.at(-1)!.operations[0]!.op).toBe("transcript.range.remove");

    await valueOf(engine.execute(store, removed.applied[0]!.inverse));
    expect(withoutRevision(store.currentProject)).toEqual(withoutRevision(before));
  });

  it("marks range.retain consequential and keeps only the selected passages", async () => {
    const { store, engine } = await fixture();
    const before = structuredClone(store.currentProject);

    const retained = await valueOf(engine.execute(store, [{
      op: "transcript.range.retain",
      params: {
        scope: { sequenceId: "seq_aaaaaaaaaa" },
        wordRanges: [
          { fromWord: "w000001", toWord: "w000001" },
          { fromWord: "w000003", toWord: "w000003" },
        ],
      },
    }]));

    expect(retained.riskClass).toBe("consequential");
    expect(store.currentProject.sequences[0]!.clips.map(({ source }) => source)).toEqual([
      { in: { frames: 12, fps: "24/1" }, out: { frames: 24, fps: "24/1" } },
      { in: { frames: 60, fps: "24/1" }, out: { frames: 72, fps: "24/1" } },
    ]);
    await valueOf(engine.execute(store, retained.applied[0]!.inverse));
    expect(withoutRevision(store.currentProject)).toEqual(withoutRevision(before));
  });

  it("creates a source-traceable clip at the requested layer index", async () => {
    const { store, engine } = await fixture();
    const before = structuredClone(store.currentProject);

    const created = await valueOf(engine.execute(store, [{
      op: "transcript.range.createClip",
      params: {
        wordRange: { fromWord: "w000002", toWord: "w000003" },
        targetLayerId: "lyr_aaaaaaaaaa",
        targetIndex: 0,
      },
    }]));

    expect(store.currentProject.sequences[0]!.clips[0]).toMatchObject({
      asset: "ast_aaaaaaaaaa",
      source: {
        in: { frames: 36, fps: "24/1" },
        out: { frames: 72, fps: "24/1" },
      },
    });
    expect(created.applied[0]!.inverse).toEqual([{
      op: "clip.remove",
      params: { clipId: store.currentProject.sequences[0]!.clips[0]!.id },
    }]);
    await valueOf(engine.execute(store, created.applied[0]!.inverse));
    expect(withoutRevision(store.currentProject)).toEqual(withoutRevision(before));
  });

  it("creates a draft short candidate with an independently owned sequence", async () => {
    const { store, engine } = await fixture();
    const before = structuredClone(store.currentProject);
    const marked = await valueOf(engine.execute(store, [{
      op: "transcript.range.shortCandidate",
      params: {
        wordRange: { fromWord: "w000002", toWord: "w000003" },
        title: "A strong hook",
      },
    }]));

    expect(store.currentProject.deliverables.at(-1)).toMatchObject({
      id: "dlv_bbbbbbbbbb",
      kind: "short",
      name: "A strong hook",
      profile: "youtube-shorts@1.0.0",
      status: "draft",
      sequenceId: "seq_bbbbbbbbbb",
      captionsTrackId: "cts_bbbbbbbbbb",
      dependencies: [{
        derivativeClipId: "clp_cccccccccc",
        source: {
          assetId: "ast_aaaaaaaaaa",
          range: {
            start: { frames: 36, fps: "24/1" },
            end: { frames: 72, fps: "24/1" },
          },
          words: { startWordId: "w000002", endWordId: "w000003" },
          longformClipId: "clp_aaaaaaaaaa",
        },
      }],
    });
    expect(store.currentProject.sequences.at(-1)).toMatchObject({
      id: "seq_bbbbbbbbbb",
      clips: [{ id: "clp_cccccccccc", asset: "ast_aaaaaaaaaa" }],
    });
    expect(marked.riskClass).toBe("low");
    await valueOf(engine.execute(store, marked.applied[0]!.inverse));
    expect(withoutRevision(store.currentProject)).toEqual(withoutRevision(before));
  });

  it("removes a range from an explicitly targeted derivative without touching primary", async () => {
    const { store, engine } = await fixture();
    await valueOf(engine.execute(store, [{
      op: "transcript.range.shortCandidate",
      params: {
        wordRange: { fromWord: "w000002", toWord: "w000003" },
        title: "Targeted short",
      },
    }]));
    const primaryBefore = structuredClone(
      store.currentProject.sequences.find(({ id }) => id === "seq_aaaaaaaaaa"),
    );
    const cuts = { origin: "ui" as const, dryRun: false, divergence: "cuts" as const };

    const removed = await valueOf(engine.execute(
      store,
      [{
        op: "transcript.range.remove",
        params: {
          sequenceId: "seq_bbbbbbbbbb",
          wordRange: { fromWord: "w000002", toWord: "w000002" },
          paddingMs: 0,
          snapPolicy: "none",
        },
      }],
      cuts,
    ));
    const normalizedRemove = {
      op: removed.applied[0]!.op,
      params: removed.applied[0]!.params,
    };

    expect.soft(normalizedRemove).toMatchObject({
      op: "transcript.range.remove",
      params: {
        sequenceId: "seq_bbbbbbbbbb",
        compiledSplits: [{ newClipId: "clp_dddddddddd" }],
      },
    });
    expect.soft(
      store.currentProject.sequences.find(({ id }) => id === "seq_aaaaaaaaaa"),
    ).toEqual(primaryBefore);
    expectDerivativeProvenance(
      store.currentProject,
      "clp_dddddddddd",
      48,
      72,
    );

    await valueOf(engine.execute(store, removed.applied[0]!.inverse, cuts));

    expect.soft(
      store.currentProject.sequences.find(({ id }) => id === "seq_aaaaaaaaaa"),
    ).toEqual(primaryBefore);
    expectDerivativeProvenance(
      store.currentProject,
      "clp_cccccccccc",
      36,
      72,
    );

    await valueOf(engine.execute(store, [normalizedRemove], cuts));

    expect.soft(
      store.currentProject.sequences.find(({ id }) => id === "seq_aaaaaaaaaa"),
    ).toEqual(primaryBefore);
    expectDerivativeProvenance(
      store.currentProject,
      "clp_dddddddddd",
      48,
      72,
    );
  });

  it("rejects an explicitly targeted sequence that does not exist", async () => {
    const { store, engine } = await fixture();
    const before = structuredClone(store.currentProject);

    const result = await engine.execute(store, [{
      op: "transcript.range.remove",
      params: {
        sequenceId: "seq_cccccccccc",
        wordRange: { fromWord: "w000002", toWord: "w000002" },
        paddingMs: 0,
        snapPolicy: "none",
      },
    }]);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_OP_NOT_FOUND",
        message: "Sequence seq_cccccccccc does not exist.",
        affected: ["seq_cccccccccc"],
        acceptedStateChanged: false,
      },
    });
    expect(store.currentProject).toEqual(before);
  });

  it("reports an out-of-bounds range against the explicitly targeted sequence", async () => {
    const { store, engine } = await fixture();
    await valueOf(engine.execute(store, [{
      op: "transcript.range.shortCandidate",
      params: {
        wordRange: { fromWord: "w000002", toWord: "w000003" },
        title: "Targeted short",
      },
    }]));
    const before = structuredClone(store.currentProject);

    const result = await engine.execute(store, [{
      op: "transcript.range.remove",
      params: {
        sequenceId: "seq_bbbbbbbbbb",
        wordRange: { fromWord: "w000001", toWord: "w000001" },
        paddingMs: 0,
        snapPolicy: "none",
      },
    }]);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_OP_RANGE_OUT_OF_BOUNDS",
        message: "The word range has no editable instance in sequence seq_bbbbbbbbbb.",
        affected: [
          "ast_aaaaaaaaaa",
          "w000001",
          "w000001",
          "seq_bbbbbbbbbb",
        ],
        acceptedStateChanged: false,
      },
    });
    expect(store.currentProject).toEqual(before);
  });

  it("returns E_OP_NO_TRANSCRIPT instead of mutating a transcript-less sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-no-transcript-"));
    roots.push(root);
    const store = await valueOf(createProject(root, model()));
    const engine = new TranscriptEngine({ idFactory: ids() });

    const result = await engine.execute(store, [{
      op: "transcript.range.retain",
      params: {
        scope: { sequenceId: "seq_aaaaaaaaaa" },
        wordRanges: [{ fromWord: "w000001", toWord: "w000001" }],
      },
    }]);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_NO_TRANSCRIPT", acceptedStateChanged: false },
    });
    expect(store.currentProject.revision).toBe("rev_00001");
  });

  it("keeps word anchors synchronized after range.remove without a caption track", async () => {
    const { store, engine } = await fixture();
    await valueOf(engine.execute(store, [{
      op: "transcript.range.remove",
      params: {
        wordRange: { fromWord: "w000002", toWord: "w000002" },
        paddingMs: 0,
        snapPolicy: "none",
      },
    }]));
    const reference = store.currentProject.sidecars.find(
      ({ schema }) => schema === "guyditor.transcript/v1",
    );
    if (reference === undefined) throw new Error("Transcript reference is missing.");
    const content = await readFile(join(store.root, reference.path), "utf8");
    expect(createHash("sha256").update(content).digest("hex")).toBe(reference.sha256);
    const registry = new AnchorResolverRegistry();
    registry.registerWordLookup(createTranscriptWordLookup([parseTranscriptSidecar(content)]));

    const resolved = await valueOf(resolveAnchor(
      store.currentProject,
      "word:w000003",
      "seq_aaaaaaaaaa",
      registry.dependencies(),
    ));

    expect(resolved).toMatchObject({
      status: "resolved",
      timeline: { frames: 48, fps: "24/1" },
      source: {
        assetId: "ast_aaaaaaaaaa",
        time: { frames: 60, fps: "24/1" },
      },
    });
  });
});
