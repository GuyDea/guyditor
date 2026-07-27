import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  AnchorResolverRegistry,
  OperationEngine,
  createProject,
  validateProjectAnchors,
} from "../index.js";
import type {
  AnchorLastResolved,
  IdPrefix,
  Result,
  WordLookup,
  WordLookupResolution,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function idFactory(prefix: IdPrefix): string {
  return prefix === "txn" ? "txn_aaaaaaaaaa" : `${prefix}_zzzzzzzzzz`;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function fixedLookup(overrides: Partial<WordLookupResolution> = {}): WordLookup {
  return {
    resolveWord(_project, wordId) {
      return Promise.resolve({
        ok: true,
        value: wordId === "w000042"
          ? {
              wordId,
              assetId: "ast_aaaaaaaaaa",
              start: { frames: 20, fps: "24/1" },
              end: { frames: 21, fps: "24/1" },
              approximate: false,
              context: {
                wordsBefore: ["one", "two", "three", "four", "five", "six"],
                wordsAfter: ["seven", "eight", "nine", "ten", "eleven", "twelve"],
              },
              ...overrides,
            }
          : undefined,
      });
    },
  };
}

function registry(wordLookup: WordLookup = fixedLookup()): AnchorResolverRegistry {
  const resolvers = new AnchorResolverRegistry();
  resolvers.registerWordLookup(wordLookup);
  resolvers.registerAnnotationResolver({
    resolveAnnotation(_project, annotationId) {
      return Promise.resolve({
        ok: true,
        value: annotationId === "ann_aaaaaaaaaa"
          ? { status: "resolved", timeline: { frames: 7, fps: "24/1" } }
          : undefined,
      });
    },
  });
  return resolvers;
}

describe("anchor.rebind", () => {
  it("rebinds a selected owner path and its inverse restores anchor metadata", async () => {
    const project = projectFixture();
    const lastResolved: AnchorLastResolved = {
      timeline: { frames: 20, fps: "24/1" },
      revision: "rev_00001",
      context: { wordsBefore: ["before"], wordsAfter: ["after"] },
    };
    project.beats.push({
      id: "beat_aaaaaaaaaa",
      name: "hook",
      anchor: "word:w000042",
      anchorMetadata: { "/anchor": { lastResolved } },
    });
    const engine = new OperationEngine(project, { idFactory });

    const result = await valueOf(engine.execute([{
      op: "anchor.rebind",
      params: {
        owner: "beat_aaaaaaaaaa",
        anchorPath: "/anchor",
        newAnchor: "timeline:3@24/1",
      },
    }], { baseRevision: "rev_00001", origin: "ui", dryRun: false }));

    expect(engine.currentProject.beats[0]).toMatchObject({
      anchor: "timeline:3@24/1",
    });
    expect(engine.currentProject.beats[0]).not.toHaveProperty("anchorMetadata");
    expect(result.riskClass).toBe("normal");
    expect(result.applied[0]?.inverse).toEqual([{
      op: "anchor.rebind",
      params: {
        owner: "beat_aaaaaaaaaa",
        anchorPath: "/anchor",
        newAnchor: "word:w000042",
        lastResolved,
      },
    }]);

    await valueOf(engine.execute(result.applied[0]!.inverse, {
      baseRevision: "rev_00002",
      origin: "ui",
      dryRun: false,
    }));
    expect(engine.currentProject.beats[0]).toMatchObject({
      anchor: "word:w000042",
      anchorMetadata: { "/anchor": { lastResolved } },
    });
  });

  it("rebinds placed-item at and until selectors", async () => {
    const project = projectFixture();
    project.layers[0]!.items = [{
      id: "gfx_aaaaaaaaaa",
      at: "timeline:1@24/1",
      duration: { until: "timeline:4@24/1" },
    }];
    const engine = new OperationEngine(project, { idFactory });
    await valueOf(engine.execute([
      {
        op: "anchor.rebind",
        params: {
          owner: "gfx_aaaaaaaaaa",
          anchorPath: "/at",
          newAnchor: "timeline:2@24/1",
        },
      },
      {
        op: "anchor.rebind",
        params: {
          owner: "gfx_aaaaaaaaaa",
          anchorPath: "/duration/until",
          newAnchor: "timeline:5@24/1",
        },
      },
    ], { baseRevision: "rev_00001", origin: "ui", dryRun: false }));

    expect(engine.currentProject.layers[0]!.items?.[0]).toMatchObject({
      at: "timeline:2@24/1",
      duration: { until: "timeline:5@24/1" },
    });
  });

  it.each([
    ["/at", "timeline:seq_bbbbbbbbbb@2"],
    ["/duration/until", "timeline:seq_bbbbbbbbbb@5"],
  ] as const)("rejects ownership-violating placed-item rebinds at %s without changing accepted state", async (
    anchorPath,
    newAnchor,
  ) => {
    const project = projectFixture();
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "sibling",
      clips: [],
    });
    project.layers[0]!.items = [{
      id: "gfx_aaaaaaaaaa",
      sequenceId: "seq_aaaaaaaaaa",
      at: "timeline:seq_aaaaaaaaaa@1",
      duration: { until: "timeline:seq_aaaaaaaaaa@4" },
    }];
    const accepted = structuredClone(project);
    const engine = new OperationEngine(project, { idFactory });

    const result = await engine.execute([{
      op: "anchor.rebind",
      params: {
        owner: "gfx_aaaaaaaaaa",
        anchorPath,
        newAnchor,
      },
    }], { baseRevision: "rev_00001", origin: "ui", dryRun: false });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_GRAPHIC_SEQUENCE_CONFLICT",
        acceptedStateChanged: false,
      },
    });
    expect(engine.currentProject).toEqual(accepted);
  });
});

describe("commit-time orphan bookkeeping", () => {
  it("records resolved-to-orphaned transitions in the journal and owner metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-anchor-journal-"));
    directories.push(root);
    const project = projectFixture();
    project.beats.push({
      id: "beat_aaaaaaaaaa",
      name: "hook",
      anchor: "word:w000042",
    });
    const store = await valueOf(createProject(root, project));
    const engine = new OperationEngine(store.currentProject, {
      idFactory,
      committer: store,
      anchorResolvers: registry(),
      now: () => new Date("2026-07-18T12:00:00Z"),
    });

    const preview = await valueOf(engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 5, fps: "24/1" },
      },
    }], { baseRevision: "rev_00001", origin: "ui", dryRun: true }));
    expect(preview.diff.orphanedAnchors).toEqual([expect.objectContaining({
      owner: "beat_aaaaaaaaaa",
      reason: "word-not-in-edit",
    })]);
    expect(engine.currentProject.beats[0]).not.toHaveProperty("anchorMetadata");

    const result = await valueOf(engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 5, fps: "24/1" },
      },
    }], { baseRevision: "rev_00001", origin: "ui", dryRun: false }));

    expect(result.diff.orphanedAnchors).toEqual([{
      owner: "beat_aaaaaaaaaa",
      anchor: "word:w000042",
      anchorPath: "/anchor",
      reason: "word-not-in-edit",
    }]);
    expect(engine.currentProject.beats[0]).toMatchObject({
      anchorMetadata: {
        "/anchor": {
          lastResolved: {
            timeline: { frames: 20, fps: "24/1" },
            revision: "rev_00001",
            context: {
              wordsBefore: ["two", "three", "four", "five", "six"],
              wordsAfter: ["seven", "eight", "nine", "ten", "eleven"],
            },
          },
        },
      },
    });

    const journal = await readFile(join(root, "history/transactions.jsonl"), "utf8");
    const committed = JSON.parse(journal.trimEnd().split("\n").at(-1)!) as {
      orphanedAnchors: unknown;
    };
    expect(committed.orphanedAnchors).toEqual([{
      owner: "beat_aaaaaaaaaa",
      anchor: "word:w000042",
    }]);
  });

  it("reports current orphans as structured validation warnings", async () => {
    const project = projectFixture();
    project.beats.push({
      id: "beat_aaaaaaaaaa",
      name: "lost",
      anchor: "word:w000042",
    });
    const report = await valueOf(validateProjectAnchors(project, undefined, {
      wordLookup: fixedLookup({ assetId: "ast_bbbbbbbbbb" }),
    }));
    expect(report.issues).toEqual([expect.objectContaining({
      code: "W_ANCHOR_ORPHANED",
      severity: "warning",
      path: "/beats/beat_aaaaaaaaaa/anchor",
      affected: ["beat_aaaaaaaaaa"],
    })]);
    expect(report.orphanedAnchors).toEqual([expect.objectContaining({
      owner: "beat_aaaaaaaaaa",
      anchorPath: "/anchor",
      anchor: "word:w000042",
      reason: "word-not-in-edit",
    })]);
  });

  it("enumerates beat, clip, placed-item at, and placed-item until anchors", async () => {
    const project = projectFixture();
    project.beats.push({
      id: "beat_aaaaaaaaaa",
      name: "lost beat",
      anchor: "timeline:49@24/1",
    });
    project.sequences[0]!.clips[0]!.anchor = "clip:clp_zzzzzzzzzz@0";
    project.layers[0]!.items = [{
      id: "gfx_aaaaaaaaaa",
      at: "ann:ann_aaaaaaaaaa",
      duration: { until: "word:w000042" },
    }];

    const report = await valueOf(validateProjectAnchors(project, undefined, {}));
    expect(report.orphanedAnchors.map(({ owner, anchorPath, reason }) => ({
      owner,
      anchorPath,
      reason,
    }))).toEqual([
      {
        owner: "beat_aaaaaaaaaa",
        anchorPath: "/anchor",
        reason: "beyond-timeline",
      },
      {
        owner: "clp_aaaaaaaaaa",
        anchorPath: "/anchor",
        reason: "clip-deleted",
      },
      {
        owner: "gfx_aaaaaaaaaa",
        anchorPath: "/at",
        reason: "ann-orphaned",
      },
      {
        owner: "gfx_aaaaaaaaaa",
        anchorPath: "/duration/until",
        reason: "word-deleted",
      },
    ]);
    expect(report.issues.every(({ severity }) => severity === "warning")).toBe(true);
  });
});

describe("OperationEngine.resolveNavigation", () => {
  it.each([
    [{ kind: "frame", frames: 25, fps: "50/1" }, 12],
    [{ kind: "timecode", tc: "00:00:01:00" }, 24],
    [{ kind: "clip", clipId: "clp_aaaaaaaaaa", edge: "start" }, 0],
    [{ kind: "clip", clipId: "clp_aaaaaaaaaa", edge: "end" }, 24],
    [{ kind: "word", wordId: "w000042" }, 20],
    [{ kind: "annotation", annotationId: "ann_aaaaaaaaaa" }, 7],
    [{ kind: "beat", beatId: "beat_aaaaaaaaaa" }, 6],
  ] as const)("resolves %o", async (target, expectedFrame) => {
    const project = projectFixture();
    project.beats.push({
      id: "beat_aaaaaaaaaa",
      name: "hook",
      anchor: "timeline:6@24/1",
    });
    const engine = new OperationEngine(project, { anchorResolvers: registry() });
    expect(await valueOf(engine.resolveNavigation(project, target))).toEqual({
      sequenceId: "seq_aaaaaaaaaa",
      frame: { frames: expectedFrame, fps: "24/1" },
    });
  });

  it("snaps a clip end only after deriving its exact prefix duration", async () => {
    const project = projectFixture();
    project.settings.timeline.fps = "3/1";
    project.assets[0]!.probe = {
      duration: { frames: 10, fps: "5/1" },
      fps: "5/1",
    };
    project.sequences[0]!.clips = [
      {
        id: "clp_aaaaaaaaaa",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 0, fps: "5/1" },
          out: { frames: 1, fps: "5/1" },
        },
      },
      {
        id: "clp_bbbbbbbbbb",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 1, fps: "5/1" },
          out: { frames: 2, fps: "5/1" },
        },
      },
    ];
    const engine = new OperationEngine(project);

    expect(await valueOf(engine.resolveNavigation(project, {
      kind: "clip",
      clipId: "clp_bbbbbbbbbb",
      edge: "end",
    }))).toEqual({
      sequenceId: "seq_aaaaaaaaaa",
      frame: { frames: 1, fps: "3/1" },
    });
  });
});
