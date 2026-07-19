import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalizeYaml,
  createProject,
  openProject,
} from "../index.js";
import type {
  GuyditorProject,
  ProjectStore,
  Result,
  TransactionRecord,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "guyditor-store-"));
  directories.push(path);
  return path;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function transaction(
  baseRevision = "rev_00001",
  resultRevision = "rev_00002",
): TransactionRecord {
  return {
    id: "txn_aaaaaaaaaa",
    baseRevision,
    resultRevision,
    operations: [
      {
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: 1, fps: "24/1" },
        },
        summary: "Trim tail of a.mov (clp_aaaaaaaaaa) by +1 frame (1/24 s)",
        inverse: {
          op: "clip.trim",
          params: {
            clipId: "clp_aaaaaaaaaa",
            edge: "tail",
            delta: { frames: -1, fps: "24/1" },
          },
        },
      },
    ],
    instruction: { kind: "ui-direct" },
    actor: { kind: "human", id: "ui" },
    versions: {
      app: "0.0.0-test",
      schema: "guyditor/v1",
      skills: [{ id: "skl_aaaaaaaaaa", version: "1.0.0" }],
      presets: [{ id: "pre_aaaaaaaaaa", version: 1 }],
      tools: [],
    },
    acceptance: {
      status: "accepted",
      by: "ui",
      at: "2026-07-18T12:00:00.000Z",
    },
    orphanedAnchors: [],
    addresses: [],
  };
}

function committedModel(): GuyditorProject {
  const model = structuredClone(projectFixture());
  model.revision = "rev_00002";
  model.sequences[0]!.clips[0]!.source.out.frames = 23;
  model.templates = {
    tpl_a2c3d4e5f6: { version: "1.0.0", contentHash: "b".repeat(64) },
  };
  return model;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortedJson(child)]),
  );
}

async function allPaths(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const child = join(relative, entry.name);
    paths.push(child);
    if (entry.isDirectory()) paths.push(...await allPaths(root, child));
  }
  return paths;
}

describe("ProjectStore", () => {
  it("creates the project skeleton and initial accepted revision", async () => {
    const root = await directory();
    const store: ProjectStore = await valueOf(createProject(root, projectFixture(), {
      appVersion: "0.0.0-test",
    }));

    expect(store.currentProject).toEqual(projectFixture());
    await expect(readFile(join(root, "episode.guyditor.yaml"), "utf8"))
      .resolves.toBe(canonicalizeYaml(projectFixture()));
    await expect(readFile(join(root, "history/HEAD"), "utf8"))
      .resolves.toBe("rev_00001\n");
    const creationJournal = await readFile(
      join(root, "history/transactions.jsonl"),
      "utf8",
    );
    expect(creationJournal.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(creationJournal) as Record<string, unknown>).toMatchObject({
      baseRevision: "rev_00000",
      resultRevision: "rev_00001",
      operations: [{ op: "project.create", summary: "Create project Fixture" }],
    });
    await expect(readFile(join(root, ".gitignore"), "utf8"))
      .resolves.toBe(".guyditor/\nproposals/*/previews/\nmedia/\n");

    const paths = await allPaths(root);
    for (const expected of [
      "sidecars",
      "proposals",
      "history/revisions",
      "history/proposals",
      "media/generated",
      "presets",
      "skills",
      ".guyditor/cache",
      "history/revisions/rev_00001.yaml",
      "history/revisions/rev_00001.lock.json",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it("commits master, snapshot, lock, journal line, and HEAD with no temp residue", async () => {
    const root = await directory();
    const store = await valueOf(createProject(root, projectFixture(), {
      appVersion: "0.0.0-test",
    }));
    const model = committedModel();

    expect(await valueOf(store.commit(model, transaction()))).toEqual(model);

    const canonical = canonicalizeYaml(model);
    await expect(readFile(join(root, "episode.guyditor.yaml"), "utf8"))
      .resolves.toBe(canonical);
    await expect(readFile(join(root, "history/revisions/rev_00002.yaml"), "utf8"))
      .resolves.toBe(canonical);
    await expect(readFile(join(root, "history/HEAD"), "utf8"))
      .resolves.toBe("rev_00002\n");

    const lockText = await readFile(
      join(root, "history/revisions/rev_00002.lock.json"),
      "utf8",
    );
    const lock = JSON.parse(lockText) as Record<string, unknown>;
    expect(lock).toMatchObject({
      revision: "rev_00002",
      masterSha256: createHash("sha256").update(canonical).digest("hex"),
      assets: [{ id: "ast_aaaaaaaaaa", path: "media/a.mov", sha256: "a".repeat(64) }],
      sidecars: [{ name: "annotations", schema: "guyditor.annotations/v1", sha256: "a".repeat(64) }],
      presets: [{ id: "pre_aaaaaaaaaa", version: 1, sha256: "a".repeat(64) }],
      skills: [{ id: "skl_aaaaaaaaaa", version: "1.0.0", contentHash: "a".repeat(64) }],
      profiles: [{ id: "youtube", version: "1.0.0" }],
      templates: [{
        id: "tpl_a2c3d4e5f6",
        version: "1.0.0",
        contentHash: "b".repeat(64),
      }],
      tools: [{ name: "guyditor", version: "0.0.0-test" }],
    });
    expect(lockText).toBe(`${JSON.stringify(sortedJson(lock))}\n`);

    const journal = await readFile(join(root, "history/transactions.jsonl"), "utf8");
    const lines = journal.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const parsed: unknown = JSON.parse(lines[1]!);
    expect(parsed).toEqual(transaction());
    expect(lines[1]).toBe(JSON.stringify(sortedJson(parsed)));
    expect((await allPaths(root)).some((path) => path.includes(".tmp-"))).toBe(false);

    const reopened = await valueOf(openProject(root, { appVersion: "0.0.0-test" }));
    expect(reopened.currentProject).toEqual(model);
  });

  it("rejects a stale transaction without changing accepted files", async () => {
    const root = await directory();
    const store = await valueOf(createProject(root, projectFixture()));
    const before = await readFile(join(root, "episode.guyditor.yaml"), "utf8");
    const beforeJournal = await readFile(
      join(root, "history/transactions.jsonl"),
      "utf8",
    );
    const result = await store.commit(
      committedModel(),
      transaction("rev_00000", "rev_00001"),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_STALE_BASE", acceptedStateChanged: false },
    });
    await expect(readFile(join(root, "episode.guyditor.yaml"), "utf8"))
      .resolves.toBe(before);
    await expect(readFile(join(root, "history/transactions.jsonl"), "utf8"))
      .resolves.toBe(beforeJournal);
  });

  it("serializes concurrent commits so only one transaction can advance a base revision", async () => {
    const root = await directory();
    const store = await valueOf(createProject(root, projectFixture()));
    const firstModel = committedModel();
    const secondModel = committedModel();
    secondModel.sequences[0]!.clips[0]!.source.out.frames = 22;
    const firstTransaction = transaction();
    const secondTransaction = transaction();
    secondTransaction.id = "txn_bbbbbbbbbb";

    const results = await Promise.all([
      store.commit(firstModel, firstTransaction),
      store.commit(secondModel, secondTransaction),
    ]);

    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toMatchObject([{
      ok: false,
      error: { code: "E_OP_STALE_BASE" },
    }]);
    const journalLines = (await readFile(
      join(root, "history/transactions.jsonl"),
      "utf8",
    )).trim().split("\n");
    expect(journalLines).toHaveLength(2);
  });

  it("re-derives missing master, snapshot, and lock artifacts on open", async () => {
    const snapshotRoot = await directory();
    const snapshotStore = await valueOf(createProject(snapshotRoot, projectFixture(), {
      appVersion: "0.0.0-test",
    }));
    await valueOf(snapshotStore.commit(committedModel(), transaction()));
    await writeFile(join(snapshotRoot, "history/HEAD"), "rev_00001\n", "utf8");
    await unlink(join(snapshotRoot, "episode.guyditor.yaml"));
    await unlink(join(snapshotRoot, "history/revisions/rev_00002.lock.json"));

    const fromSnapshot = await valueOf(openProject(snapshotRoot, {
      appVersion: "0.0.0-test",
    }));
    expect(fromSnapshot.currentProject).toEqual(committedModel());
    await expect(readFile(join(snapshotRoot, "episode.guyditor.yaml"), "utf8"))
      .resolves.toBe(canonicalizeYaml(committedModel()));
    await expect(readFile(join(snapshotRoot, "history/HEAD"), "utf8"))
      .resolves.toBe("rev_00002\n");

    const masterRoot = await directory();
    const masterStore = await valueOf(createProject(masterRoot, projectFixture(), {
      appVersion: "0.0.0-test",
    }));
    await valueOf(masterStore.commit(committedModel(), transaction()));
    await unlink(join(masterRoot, "history/revisions/rev_00002.yaml"));
    await unlink(join(masterRoot, "history/revisions/rev_00002.lock.json"));

    const fromMaster = await valueOf(openProject(masterRoot, {
      appVersion: "0.0.0-test",
    }));
    expect(fromMaster.currentProject).toEqual(committedModel());
    await expect(readFile(join(masterRoot, "history/revisions/rev_00002.yaml"), "utf8"))
      .resolves.toBe(canonicalizeYaml(committedModel()));
  });

  it("honors a valid hand-edited master without rewriting its accepted snapshot", async () => {
    const root = await directory();
    await valueOf(createProject(root, projectFixture()));
    const snapshotBefore = await readFile(
      join(root, "history/revisions/rev_00001.yaml"),
      "utf8",
    );
    const edited = projectFixture();
    edited.project.name = "Hand-edited title";
    await writeFile(
      join(root, "episode.guyditor.yaml"),
      canonicalizeYaml(edited),
      "utf8",
    );

    const reopened = await valueOf(openProject(root));
    expect(reopened.currentProject).toEqual(edited);
    await expect(readFile(join(root, "history/revisions/rev_00001.yaml"), "utf8"))
      .resolves.toBe(snapshotBefore);
  });
});
