import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  JobQueue,
  createProject,
} from "../index.js";
import type {
  JobRecord,
  Result,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";
import {
  GUYDITOR_V2_MIGRATION_PATH,
  MigrationRegistry,
} from "./migration.js";
import type {
  MigrationContext,
  ProjectDocument,
  SchemaMigrator,
} from "./migration.js";

const roots: string[] = [];
const queues: JobQueue[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "guyditor-migration-"));
  roots.push(value);
  return value;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function terminal(queue: JobQueue, jobId: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = queue.get(jobId);
    if (job?.state === "done" || job?.state === "failed") return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Migration job ${jobId} did not finish.`);
}

function v2Migrator(): SchemaMigrator {
  return {
    ...GUYDITOR_V2_MIGRATION_PATH,
    describe: () => "Introduce the v2 editorial label and migration sidecar",
    async migrate(document: ProjectDocument, context: MigrationContext) {
      await context.readSidecar("sidecars/annotations.yaml");
      context.log("planned v1 to v2");
      return {
        document: {
          ...structuredClone(document),
          format: "guyditor/v2",
          project: { ...document.project, name: `${document.project.name} migrated` },
          sidecars: [
            ...document.sidecars,
            {
              name: "migration-v2",
              path: "sidecars/migration-v2.json",
              schema: "guyditor.migration-sample/v1",
              sha256: "pending",
              inputs: [],
            },
          ],
        },
        sidecarWrites: [{
          path: "sidecars/migration-v2.json",
          content: { format: "guyditor.migration-sample/v1", migrated: true },
          schema: "guyditor.migration-sample/v1",
        }],
        diff: [
          {
            kind: "structural",
            target: "/format",
            summary: "project format: guyditor/v1 renamed to guyditor/v2",
            before: "guyditor/v1",
            after: "guyditor/v2",
          },
          {
            kind: "semantic",
            target: "/project/name",
            summary: "project name: append reviewed migration label",
            before: document.project.name,
            after: `${document.project.name} migrated`,
          },
        ],
      };
    },
  };
}

async function project(): Promise<string> {
  const projectDir = join(await root(), "project");
  await valueOf(createProject(projectDir, projectFixture(), { appVersion: "4.0.0-test" }));
  await writeFile(join(projectDir, "sidecars/annotations.yaml"), "format: guyditor.annotations/v1\nannotations: []\n");
  return projectDir;
}

describe("MigrationRegistry", () => {
  it("plans an adjacent chain in memory with classified, reviewable changes and no writes", async () => {
    const projectDir = await project();
    const before = await readFile(join(projectDir, "episode.guyditor.yaml"), "utf8");
    const { queue } = JobQueue.open(":memory:");
    queues.push(queue);
    const registry = new MigrationRegistry({
      jobQueue: queue,
      backup: { runPreMigration: () => Promise.resolve({ backupId: "bak_verified", verified: true }) },
    });
    registry.register(v2Migrator());
    registry.registerValidator("guyditor/v2", () => []);

    const plan = await registry.plan(projectDir, "guyditor/v2");

    expect(plan).toMatchObject({
      fromFormat: "guyditor/v1",
      toFormat: "guyditor/v2",
      chain: [{
        from: "guyditor/v1",
        to: "guyditor/v2",
        description: "Introduce the v2 editorial label and migration sidecar",
      }],
      semanticChangeCount: 1,
    });
    expect(plan.diff).toEqual([
      expect.objectContaining({ kind: "structural", target: "/format" }),
      expect.objectContaining({ kind: "semantic", target: "/project/name" }),
    ]);
    await expect(readFile(join(projectDir, "episode.guyditor.yaml"), "utf8")).resolves.toBe(before);
    await expect(access(join(projectDir, "sidecars/migration-v2.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unacknowledged semantic targets before enqueuing", async () => {
    const projectDir = await project();
    const { queue } = JobQueue.open(":memory:");
    queues.push(queue);
    const registry = new MigrationRegistry({
      jobQueue: queue,
      backup: { runPreMigration: () => Promise.resolve({ backupId: "bak_verified", verified: true }) },
    });
    registry.register(v2Migrator());
    const plan = await registry.plan(projectDir, "guyditor/v2");

    await expect(registry.apply(projectDir, plan, {
      acknowledgedSemanticTargets: [],
    })).rejects.toMatchObject({
      code: "E_MIGRATION_SEMANTIC_UNCONFIRMED",
      affected: ["/project/name"],
    });
    expect(queue.list({ kind: "migration.apply" })).toEqual([]);
  });

  it("takes a verified backup and local snapshot, applies atomically, and journals project.migrate", async () => {
    const projectDir = await project();
    const backupCalls: string[] = [];
    const { queue } = JobQueue.open(":memory:");
    queues.push(queue);
    const registry = new MigrationRegistry({
      jobQueue: queue,
      now: () => new Date("2026-07-23T12:00:00.000Z"),
      backup: {
        runPreMigration(root) {
          backupCalls.push(root);
          return Promise.resolve({ backupId: "bak_verified", verified: true });
        },
      },
    });
    registry.register(v2Migrator());
    registry.registerValidator("guyditor/v2", () => []);
    const plan = await registry.plan(projectDir, "guyditor/v2");

    const reference = await registry.apply(projectDir, plan, {
      acknowledgedSemanticTargets: ["/project/name"],
    });
    const job = await terminal(queue, reference.jobId);

    expect(job.state).toBe("done");
    expect(backupCalls).toEqual([projectDir]);
    const migrated = parseYaml(await readFile(join(projectDir, "episode.guyditor.yaml"), "utf8")) as {
      format: string;
      revision: string;
      project: { name: string };
      sidecars: Array<{ path: string; sha256: string }>;
    };
    expect(migrated).toMatchObject({
      format: "guyditor/v2",
      revision: "rev_00002",
      project: { name: "Fixture migrated" },
    });
    expect(migrated.sidecars.find(({ path }) => path === "sidecars/migration-v2.json")?.sha256)
      .toMatch(/^[a-f0-9]{64}$/u);
    await expect(readFile(join(projectDir, "history/HEAD"), "utf8"))
      .resolves.toBe("rev_00002\n");
    const snapshots = await readdir(join(projectDir, "history/pre-migration"));
    expect(snapshots).toEqual(["guyditor-v1-to-guyditor-v2-2026-07-23T12-00-00.000Z"]);
    const journal = (await readFile(join(projectDir, "history/transactions.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as {
        operations: Array<{ op: string; params: Record<string, unknown> }>;
      });
    expect(journal.at(-1)?.operations).toEqual([
      expect.objectContaining({
        op: "project.migrate",
        params: expect.objectContaining({
          migrationId: plan.migrationId,
          semanticChangeCount: 1,
          diff: plan.diff,
        }),
      }),
    ]);
  });

  it("fails closed without a verified backup and leaves the project unchanged", async () => {
    const projectDir = await project();
    const before = await readFile(join(projectDir, "episode.guyditor.yaml",), "utf8");
    const { queue } = JobQueue.open(":memory:");
    queues.push(queue);
    const registry = new MigrationRegistry({
      jobQueue: queue,
      backup: { runPreMigration: () => Promise.resolve({ backupId: "bak_bad", verified: false }) },
    });
    registry.register(v2Migrator());
    registry.registerValidator("guyditor/v2", () => []);
    const plan = await registry.plan(projectDir, "guyditor/v2");

    const reference = await registry.apply(projectDir, plan, {
      acknowledgedSemanticTargets: ["/project/name"],
    });
    const job = await terminal(queue, reference.jobId);

    expect(job).toMatchObject({
      state: "failed",
      error: { code: "E_MIGRATION_BACKUP_MISSING", acceptedStateChanged: false },
    });
    await expect(readFile(join(projectDir, "episode.guyditor.yaml"), "utf8")).resolves.toBe(before);
  });

  it("rejects version skipping and content changes without a declared diff", async () => {
    const projectDir = await project();
    const { queue } = JobQueue.open(":memory:");
    queues.push(queue);
    const registry = new MigrationRegistry({
      jobQueue: queue,
      backup: { runPreMigration: () => Promise.resolve({ backupId: "bak_verified", verified: true }) },
    });
    expect(() => registry.register({
      from: "guyditor/v1",
      to: "guyditor/v3",
      describe: () => "skip",
      migrate: (document) => Promise.resolve({ document, sidecarWrites: [], diff: [] }),
    })).toThrow(/adjacent/iu);
    registry.register({
      ...GUYDITOR_V2_MIGRATION_PATH,
      describe: () => "silent mutation",
      migrate: (document) => Promise.resolve({
        document: { ...document, format: "guyditor/v2" },
        sidecarWrites: [],
        diff: [],
      }),
    });

    await expect(registry.plan(projectDir, "guyditor/v2")).rejects.toMatchObject({
      code: "E_MIGRATION_UNDECLARED_CHANGE",
    });
  });
});
