import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "../../core/src/index.js";
import type { Result } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import {
  StorageAccountant,
  createStoragePreflight,
} from "./storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function storageFixture(
  options: { workspaceAsset?: boolean } = {},
): Promise<{
  accountant: StorageAccountant;
  externalSource: string;
  projectDir: string;
  userDir: string;
  workspaceBytes: number;
}> {
  const root = await temporaryRoot("guyditor-storage-");
  const userDir = join(root, "user");
  const projectDir = join(root, "project");
  const externalSource = join(root, "external.mov");
  const workspaceDocument =
    "format: guyditor.workspace/v1\nactiveDeliverableId: dlv_aaaaaaaaaa\n";
  const project = projectFixture();
  project.assets[0]!.path = externalSource;
  project.assets[0]!.bytes = 13;
  if (options.workspaceAsset === true) {
    project.assets.push({
      id: "ast_bbbbbbbbbb",
      kind: "image",
      path: "workspace.guyditor.yaml",
      sha256: createHash("sha256").update(workspaceDocument).digest("hex"),
      bytes: Buffer.byteLength(workspaceDocument),
      probe: {},
    });
  }
  await writeFile(externalSource, Buffer.alloc(13));
  await valueOf(createProject(projectDir, project));
  await writeFile(join(projectDir, "workspace.guyditor.yaml"), workspaceDocument);
  await mkdir(join(projectDir, "media/generated"), { recursive: true });
  await mkdir(join(projectDir, ".guyditor/cache/proxies"), { recursive: true });
  await mkdir(join(projectDir, ".guyditor/cache/analysis"), { recursive: true });
  await mkdir(join(projectDir, ".guyditor/archive-staging"), { recursive: true });
  await mkdir(join(projectDir, "exports"), { recursive: true });
  await mkdir(join(userDir, "audit"), { recursive: true });
  await writeFile(join(projectDir, "media/generated/frozen.bin"), Buffer.alloc(17));
  await writeFile(join(projectDir, ".guyditor/cache/proxies/orphan.bin"), Buffer.alloc(19));
  await writeFile(join(projectDir, ".guyditor/cache/analysis/rev_00001.json"), Buffer.alloc(23));
  await writeFile(join(projectDir, ".guyditor/archive-staging/source.part"), Buffer.alloc(29));
  await writeFile(join(projectDir, "exports/final.mp4"), Buffer.alloc(31));
  await writeFile(join(userDir, "audit/session.jsonl"), Buffer.alloc(37));
  return {
    accountant: new StorageAccountant({ userDirectory: userDir }),
    externalSource,
    projectDir,
    userDir,
    workspaceBytes: Buffer.byteLength(workspaceDocument),
  };
}

describe("StorageAccountant", () => {
  it("classifies every managed byte and reports external sources and orphans", async () => {
    const { accountant, externalSource, projectDir, workspaceBytes } = await storageFixture();

    const report = await accountant.scan(projectDir);
    await rm(join(projectDir, "workspace.guyditor.yaml"));
    const legacyReport = await accountant.scan(projectDir);

    expect(report.projectDir).toBe(projectDir);
    expect(report.volumeFreeBytes).toBeGreaterThan(0);
    expect(report.categories.generated).toMatchObject({ bytes: 17, reclaimable: false });
    expect(report.categories.proxies).toMatchObject({ bytes: 19, files: 1, reclaimable: true });
    expect(report.categories.caches).toMatchObject({ bytes: 23, files: 1, reclaimable: true });
    expect(report.categories.renders).toMatchObject({ bytes: 31, reclaimable: false });
    expect(report.categories.archives).toMatchObject({ bytes: 29, reclaimable: false });
    expect(report.categories.audit).toMatchObject({ bytes: 37, reclaimable: false });
    expect(report.categories["project-state"].bytes).toBeGreaterThan(0);
    expect(legacyReport.categories["project-state"].files)
      .toBe(report.categories["project-state"].files - 1);
    expect(legacyReport.categories["project-state"].bytes)
      .toBe(report.categories["project-state"].bytes - workspaceBytes);
    expect(report.externalSources).toEqual([expect.objectContaining({
      assetId: "ast_aaaaaaaaaa",
      path: externalSource,
      bytes: 13,
    })]);
    expect(report.orphans).toContainEqual({
      path: join(projectDir, ".guyditor/cache/proxies/orphan.bin"),
      bytes: 19,
    });
  });

  it("does not count workspace state again when an asset references its path", async () => {
    const { accountant, projectDir, workspaceBytes } = await storageFixture({
      workspaceAsset: true,
    });

    const report = await accountant.scan(projectDir);
    await rm(join(projectDir, "workspace.guyditor.yaml"));
    const missingWorkspaceReport = await accountant.scan(projectDir);

    expect(report.categories["project-state"].files)
      .toBe(missingWorkspaceReport.categories["project-state"].files + 1);
    expect(report.categories["project-state"].bytes)
      .toBe(missingWorkspaceReport.categories["project-state"].bytes + workspaceBytes);
    expect(report.categories.sources).toEqual(missingWorkspaceReport.categories.sources);
    expect(report.categories.generated).toEqual(missingWorkspaceReport.categories.generated);
    expect(report.externalSources.map(({ assetId, path, bytes }) => ({ assetId, path, bytes })))
      .toEqual(missingWorkspaceReport.externalSources
        .map(({ assetId, path, bytes }) => ({ assetId, path, bytes })));
  });

  it("deduplicates shared external media in global accounting", async () => {
    const { accountant, externalSource, projectDir } = await storageFixture();
    const secondProject = join(await temporaryRoot("guyditor-storage-second-"), "project");
    const project = projectFixture();
    project.project.id = "prj_bbbbbbbbbb";
    project.assets[0]!.path = externalSource;
    project.assets[0]!.bytes = 13;
    await valueOf(createProject(secondProject, project));

    const report = await accountant.scanGlobal([projectDir, secondProject]);

    expect(report.projects).toHaveLength(2);
    expect(report.externalSources).toMatchObject({ bytes: 13, files: 1 });
    expect(report.categories.audit.bytes).toBe(37);
  });

  it("uses the binding formulas for projections", async () => {
    const { accountant } = await storageFixture();

    await expect(accountant.estimate({
      kind: "proxy",
      assets: [{ durationSeconds: 10, videoKbps: 2_500 }],
    })).resolves.toEqual({
      category: "proxies",
      bytes: 3_285_000,
      basis: "10s × (2500+128)kbps × 125",
    });
    await expect(accountant.estimate({
      kind: "analysis",
      durationMinutes: 2,
    })).resolves.toEqual({
      category: "caches",
      bytes: 512_000,
      basis: "2min × 250 KiB",
    });
    await expect(accountant.estimate({
      kind: "render",
      durationSeconds: 10,
      audioKbps: 192,
      resolution: "1080p",
    })).resolves.toMatchObject({
      category: "renders",
      bytes: 15_240_000,
    });
    await expect(accountant.estimate({
      kind: "backup",
      objects: [
        { sha256: "a".repeat(64), size: 10 },
        { sha256: "b".repeat(64), size: 20 },
      ],
      existingObjectHashes: ["a".repeat(64)],
    })).resolves.toMatchObject({ category: "archives", bytes: 20 });
    await expect(accountant.estimate({
      kind: "archive-offline",
      files: [{ size: 12 }, { size: 30 }],
      manifestOverheadBytes: 8,
    })).resolves.toMatchObject({ category: "archives", bytes: 50 });
  });

  it("only deletes planned disposable files and records the cleanup", async () => {
    const { accountant, projectDir } = await storageFixture();
    const protectedPath = join(projectDir, "media/generated/frozen.bin");
    const plan = await accountant.planCleanup(projectDir, ["proxies", "caches"]);

    expect(plan.items).toHaveLength(2);
    expect(plan.items.every(({ regenerable }) => regenerable)).toBe(true);
    expect(() => accountant.planCleanup(projectDir, ["sources"]))
      .rejects.toMatchObject({ code: "E_CLEANUP_CATEGORY_REFUSED" });
    const job = await accountant.executeCleanup(projectDir, plan);

    expect(job.jobId).toMatch(/^job_/u);
    await expect(stat(protectedPath)).resolves.toBeDefined();
    await expect(readFile(join(projectDir, ".guyditor/cleanup.log"), "utf8"))
      .resolves.toContain(`${plan.planId} 42 bytes 2 items`);
  });

  it("refuses a planned cache symlink that resolves outside the allowlist", async () => {
    const { accountant, projectDir } = await storageFixture();
    const outside = join(await temporaryRoot("guyditor-cleanup-outside-"), "keep.bin");
    const link = join(projectDir, ".guyditor/cache/analysis/escape.bin");
    await writeFile(outside, "keep");
    await symlink(outside, link);
    const plan = await accountant.planCleanup(projectDir, ["caches"]);

    await expect(accountant.executeCleanup(projectDir, plan)).rejects.toMatchObject({
      code: "E_CLEANUP_PATH_REFUSED",
      acceptedStateChanged: false,
    });
    await expect(readFile(outside, "utf8")).resolves.toBe("keep");
  });

  it("builds a queue preflight that blocks media-scale work without headroom", async () => {
    const { accountant, projectDir } = await storageFixture();
    const preflight = createStoragePreflight(accountant, {
      capacity: async () => ({ freeBytes: 100, totalBytes: 1_000 }),
      projectDir,
    });

    await expect(preflight({
      kind: "render.export",
      operation: { kind: "render", durationSeconds: 1, audioKbps: 128, videoKbps: 1 },
      reclaimableBytes: 42,
    })).rejects.toMatchObject({
      code: "E_STORAGE_INSUFFICIENT",
      retry: "safe",
      suggestion: expect.stringContaining("42"),
    });
  });
});
