import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationEngine,
  ProjectStore,
  canonicalizeYaml,
  computeChangedRanges,
  createProject,
  parseProjectYaml,
} from "../index.js";
import type {
  IdPrefix,
  RevisionLock,
  Result,
  TransactionRecord,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const directories: string[] = [];
const NOW = new Date("2026-07-18T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "guyditor-history-"));
  directories.push(path);
  return path;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(`${settled.error.code}: ${settled.error.message}`);
  return settled.value;
}

function ids(): (prefix: IdPrefix) => string {
  const ordinals = new Map<IdPrefix, number>();
  return (prefix) => {
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    const character = String.fromCharCode("a".charCodeAt(0) + ordinal);
    return `${prefix}_${character.repeat(10)}`;
  };
}

async function editedStore(): Promise<{
  root: string;
  store: ProjectStore;
  engine: OperationEngine;
}> {
  const root = await directory();
  const idFactory = ids();
  const initial = projectFixture();
  const annotations = "format: guyditor.annotations/v1\nannotations: []\n";
  initial.sidecars[0]!.sha256 = createHash("sha256").update(annotations).digest("hex");
  const store = await valueOf(createProject(root, initial, {
    idFactory,
    now: () => NOW,
  }));
  await writeFile(join(root, "sidecars/annotations.yaml"), annotations, "utf8");
  const engine = new OperationEngine(store.currentProject, {
    committer: store,
    idFactory,
    now: () => NOW,
  });
  await valueOf(engine.execute([{
    op: "clip.trim",
    params: {
      clipId: "clp_aaaaaaaaaa",
      edge: "tail",
      delta: { frames: 4, fps: "24/1" },
      snapPolicy: "none",
    },
  }], {
    baseRevision: "rev_00001",
    origin: "ui",
    dryRun: false,
  }));
  return { root, store, engine };
}

function manualTransaction(): TransactionRecord {
  return {
    id: "txn_bbbbbbbbbb",
    baseRevision: "rev_00001",
    resultRevision: "rev_00002",
    operations: [{
      op: "annotation.resolve",
      params: { annotationId: "ann_aaaaaaaaaa" },
      summary: "Resolve annotation ann_aaaaaaaaaa",
    }],
    instruction: { kind: "ui-direct" },
    actor: { kind: "human", id: "ui" },
    versions: {
      app: "0.0.0-test",
      schema: "guyditor/v1",
      skills: [],
      presets: [],
      tools: [],
    },
    acceptance: {
      status: "accepted",
      by: "ui",
      at: NOW.toISOString(),
    },
    orphanedAnchors: [],
    addresses: ["ann_aaaaaaaaaa"],
  };
}

describe("revision restore", () => {
  it("restores a prior master as a new forward project.restore transaction", async () => {
    const { root, engine } = await editedStore();
    const targetText = await readFile(
      join(root, "history/revisions/rev_00001.yaml"),
      "utf8",
    );
    const target = parseProjectYaml(targetText);
    expect(target.ok).toBe(true);
    if (!target.ok) throw new Error(target.error.message);
    const lockFile = join(root, "history/revisions/rev_00001.lock.json");
    const lock = JSON.parse(await readFile(lockFile, "utf8")) as RevisionLock;
    lock.tools = [{ name: "ffmpeg", version: "6.1" }];
    await writeFile(lockFile, `${JSON.stringify(lock)}\n`, "utf8");

    const restored = await valueOf(engine.restoreRevision("rev_00001"));

    expect(restored.revision).toBe("rev_00003");
    expect(await readFile(join(root, "episode.guyditor.yaml"), "utf8"))
      .toBe(canonicalizeYaml({ ...target.value, revision: "rev_00003" }));
    await expect(readFile(join(root, "history/HEAD"), "utf8"))
      .resolves.toBe("rev_00003\n");
    const journal = (await readFile(join(root, "history/transactions.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as TransactionRecord);
    expect(journal.at(-1)).toMatchObject({
      baseRevision: "rev_00002",
      resultRevision: "rev_00003",
      operations: [{
        op: "project.restore",
        params: { target: "rev_00001" },
        inverse: { op: "project.restore", params: { target: "rev_00002" } },
      }],
      versions: { tools: [{ name: "ffmpeg", version: "6.1" }] },
    });
    const restoredLock = JSON.parse(await readFile(
      join(root, "history/revisions/rev_00003.lock.json"),
      "utf8",
    )) as RevisionLock;
    expect(restoredLock.tools).toEqual([{ name: "ffmpeg", version: "6.1" }]);
    await expect(engine.undo()).resolves.toMatchObject({
      ok: false,
      error: { code: "E_OP_UNDO_EMPTY", acceptedStateChanged: false },
    });
  });

  it("versions changed sidecars and restores target bytes and registered hashes", async () => {
    const root = await directory();
    const store = await valueOf(ProjectStore.createProject(root, {
      name: "Sidecar restore",
    }, {
      profilesDirectory: join(process.cwd(), "profiles"),
      idFactory: ids(),
      now: () => NOW,
      appVersion: "0.0.0-test",
    }));
    const annotationsPath = join(root, "sidecars/annotations.yaml");
    const original = await readFile(annotationsPath, "utf8");
    const changed = "format: guyditor.annotations/v1\nannotations:\n  - id: ann_aaaaaaaaaa\n";
    await writeFile(annotationsPath, changed, "utf8");
    const model = structuredClone(store.currentProject);
    model.revision = "rev_00002";
    model.sidecars[0]!.sha256 = createHash("sha256").update(changed).digest("hex");
    await valueOf(store.commit(model, manualTransaction()));

    await expect(readFile(
      join(root, "history/revisions/rev_00001.sidecars/annotations"),
      "utf8",
    )).resolves.toBe(original);
    await expect(readFile(
      join(root, "history/revisions/rev_00002.sidecars/annotations"),
      "utf8",
    )).resolves.toBe(changed);

    const restored = await valueOf(store.restore("rev_00001"));
    expect(await readFile(annotationsPath, "utf8")).toBe(original);
    expect(restored.sidecars[0]!.sha256)
      .toBe(createHash("sha256").update(original).digest("hex"));
  });
});

describe("revision comparison", () => {
  it("uses journal summaries for a lineal range and stable-ID structure across restore", async () => {
    const { store } = await editedStore();

    const lineal = await valueOf(store.compareRevisions("rev_00001", "rev_00002"));
    expect(lineal).toMatchObject({
      a: "rev_00001",
      b: "rev_00002",
      lineal: true,
      previews: [],
      summary: [expect.objectContaining({
        objectId: "clp_aaaaaaaaaa",
        transaction: "txn_bbbbbbbbbb",
        text: expect.stringContaining("Trim tail"),
      })],
    });
    expect(lineal.changedRanges).toEqual([expect.objectContaining({
      start: { frames: 0, fps: "24/1" },
      end: { frames: 24, fps: "24/1" },
    })]);

    await valueOf(store.restore("rev_00001"));
    const structural = await valueOf(store.compareRevisions("rev_00002", "rev_00003"));
    expect(structural).toMatchObject({
      lineal: false,
      previews: [],
      summary: [expect.objectContaining({
        objectId: "clp_aaaaaaaaaa",
        text: expect.stringContaining("source.out"),
      })],
    });
  });

  it("computes and merges changed ranges from scripted stable-ID edits", () => {
    const before = projectFixture();
    const third = structuredClone(before.sequences[0]!.clips[1]!);
    third.id = "clp_cccccccccc";
    third.source = {
      in: { frames: 48, fps: "24/1" },
      out: { frames: 72, fps: "24/1" },
    };
    third.gapBefore = { frames: 72, fps: "24/1" };
    before.sequences[0]!.clips.push(third);
    const after = structuredClone(before);
    after.sequences[0]!.clips[0]!.source.out.frames = 20;
    after.sequences[0]!.clips[2]!.source.out.frames = 68;

    const ranges = computeChangedRanges(before, after, [
      "clp_aaaaaaaaaa",
      "clp_cccccccccc",
    ]);

    expect(ranges).toEqual([
      {
        start: { frames: 0, fps: "24/1" },
        end: { frames: 24, fps: "24/1" },
        affectedObjects: ["clp_aaaaaaaaaa"],
      },
      {
        start: { frames: 116, fps: "24/1" },
        end: { frames: 144, fps: "24/1" },
        affectedObjects: ["clp_cccccccccc"],
      },
    ]);
  });

  it("computes item ranges from timeline anchors without cached resolution metadata", () => {
    const before = projectFixture();
    before.layers[0]!.items = [{
      id: "gfx_aaaaaaaaaa",
      asset: "ast_aaaaaaaaaa",
      at: "timeline:2@24/1",
      duration: { frames: 4, fps: "24/1" },
    }];
    const after = structuredClone(before);
    after.layers[0]!.items![0]!.at = "timeline:5@24/1";

    expect(computeChangedRanges(before, after, ["gfx_aaaaaaaaaa"])).toEqual([{
      start: { frames: 2, fps: "24/1" },
      end: { frames: 9, fps: "24/1" },
      affectedObjects: ["gfx_aaaaaaaaaa"],
    }]);
  });
});
