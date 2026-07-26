import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  createProject,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import {
  BackupService,
  DEFAULT_BACKUP_CONFIG_YAML,
} from "./backup.js";
import type {
  BackupConfig,
  BackupTarget,
} from "./backup.js";

const roots: string[] = [];
const queues: JobQueue[] = [];
const WORKSPACE_DOCUMENT = Buffer.from(
  "format: guyditor.workspace/v1\nactiveDeliverableId: dlv_aaaaaaaaaa\n",
);

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function config(target: BackupTarget): BackupConfig {
  return {
    format: "guyditor-backup-config/v1",
    targets: [target],
    schedule: {
      onAcceptedRevision: true,
      debounceMinutes: 10,
      intervalHours: 24,
      onQuit: true,
    },
    include: { renders: false, auditLogs: true, environment: true },
    retention: { keepLast: 10, keepDaily: 14, keepWeekly: 12 },
    verify: {
      afterEveryRun: true,
      mode: "sample",
      samplePercent: 1,
      minSample: 20,
      fullEveryDays: 30,
    },
  };
}

async function fixture(): Promise<{
  projectDir: string;
  secret: string;
  service: BackupService;
  target: BackupTarget;
  targetDir: string;
  userDir: string;
}> {
  const root = await temporaryRoot("guyditor-backup-");
  const projectDir = join(root, "project");
  const targetDir = join(root, "target");
  const userDir = join(root, "user");
  const source = Buffer.from("immutable source media");
  const generated = Buffer.from("accepted generated asset");
  const project: GuyditorProject = projectFixture();
  project.assets[0]!.sha256 = sha256(source);
  project.assets[0]!.bytes = source.length;
  project.assets.push({
    id: "ast_bbbbbbbbbb",
    kind: "image",
    path: "media/generated/accepted.bin",
    sha256: sha256(generated),
    bytes: generated.length,
    probe: {},
  });
  await valueOf(createProject(projectDir, project, { appVersion: "4.0.0-test" }));
  await writeFile(join(projectDir, "workspace.guyditor.yaml"), WORKSPACE_DOCUMENT);
  await mkdir(join(projectDir, "media/generated"), { recursive: true });
  await writeFile(join(projectDir, "media/a.mov"), source);
  await writeFile(join(projectDir, "media/generated/accepted.bin"), generated);
  await mkdir(join(projectDir, "presets/caption"), { recursive: true });
  await mkdir(join(projectDir, "skills/brand-voice/1.0.0"), { recursive: true });
  await mkdir(join(projectDir, "sidecars/custom"), { recursive: true });
  await mkdir(join(projectDir, "archive/previews/ast_aaaaaaaaaa"), { recursive: true });
  await mkdir(join(projectDir, ".guyditor/cache/proxies"), { recursive: true });
  await writeFile(join(projectDir, "presets/caption/creator.yaml"), "preset: creator\n");
  await writeFile(join(projectDir, "skills/brand-voice/1.0.0/SKILL.md"), "# Voice\n");
  await writeFile(join(projectDir, "sidecars/custom/notes.json"), "{}\n");
  await writeFile(join(projectDir, "archive/archive.manifest.json"), "{\"format\":\"guyditor-archive/v1\"}\n");
  await writeFile(join(projectDir, "archive/previews/ast_aaaaaaaaaa/poster.jpg"), "preview");
  await writeFile(join(projectDir, ".guyditor/cache/proxies/disposable.mp4"), "never back this up");

  await mkdir(join(userDir, "skills/global-brand/1.0.0"), { recursive: true });
  await mkdir(join(userDir, "presets/caption"), { recursive: true });
  await mkdir(join(userDir, "templates/custom"), { recursive: true });
  await mkdir(join(userDir, "profiles/youtube"), { recursive: true });
  await mkdir(join(userDir, "adapters/adp_klingaaaaa"), { recursive: true });
  await mkdir(join(userDir, "audit"), { recursive: true });
  await mkdir(join(userDir, "state"), { recursive: true });
  await writeFile(join(userDir, "skills/global-brand/1.0.0/SKILL.md"), "# Global brand\n");
  await writeFile(join(userDir, "presets/caption/global.yaml"), "preset: global\n");
  await writeFile(join(userDir, "templates/custom/template.yaml"), "template: custom\n");
  await writeFile(join(userDir, "profiles/youtube/override.yaml"), "profile: youtube\n");
  await writeFile(join(userDir, "settings.json"), `${JSON.stringify({ scratchPath: "/old-machine/scratch" })}\n`);
  await writeFile(join(userDir, "adapters/adp_klingaaaaa/manifest.json"), `${JSON.stringify({
    format: "guyditor-adapter-config/v1",
    adapterId: "adp_klingaaaaa",
    config: { apiKeyRef: "apiKey", model: "kling-video-o1" },
  })}\n`);
  await writeFile(join(userDir, "audit/session.jsonl"), "{\"type\":\"session\"}\n");
  const secret = "fake-keychain-secret-AC012";
  await writeFile(join(userDir, "state/credentials.json"), `${JSON.stringify({
    adp_klingaaaaa: { apiKey: secret },
  })}\n`);
  const target: BackupTarget = { name: "local", kind: "local-path", path: targetDir };
  await BackupService.writeConfig(projectDir, config(target));
  return {
    projectDir,
    secret,
    service: new BackupService({
      appVersion: "4.0.0-test",
      now: () => new Date("2026-07-23T10:00:00.000Z"),
      secretValues: () => Promise.resolve([secret]),
      toolVersions: { ffmpeg: "7.1", schema: "guyditor/v1" },
      userDirectory: userDir,
    }),
    target,
    targetDir,
    userDir,
  };
}

async function allFiles(root: string, relativePath = ""): Promise<string[]> {
  const entries = await readdir(join(root, relativePath), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const child = join(relativePath, entry.name);
    if (entry.isDirectory()) result.push(...await allFiles(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

describe("BackupService", () => {
  it("ships the binding backup.guyditor.yaml template verbatim", () => {
    expect(DEFAULT_BACKUP_CONFIG_YAML).toBe([
      "# <project>/backup.guyditor.yaml",
      "format: guyditor-backup-config/v1",
      "targets:",
      "  - name: nas",
      "    kind: local-path",
      "    path: /mnt/nas/guyditor-backups",
      "  - name: offsite",
      "    kind: rclone-remote",
      "    remote: b2crypt:guyditor",
      "schedule:",
      "  onAcceptedRevision: true      # debounced run after each accepted transaction",
      "  debounceMinutes: 10",
      "  intervalHours: 24             # periodic full pass even without edits",
      "  onQuit: true",
      "include: { renders: false, auditLogs: true, environment: true }",
      "retention: { keepLast: 10, keepDaily: 14, keepWeekly: 12 }",
      "verify: { afterEveryRun: true, mode: sample, samplePercent: 1, minSample: 20, fullEveryDays: 30 }",
      "",
    ].join("\n"));
  });

  it("writes the binding default configuration without reformatting it", async () => {
    const root = await temporaryRoot("guyditor-backup-config-");

    await BackupService.writeDefaultConfig(root);

    await expect(readFile(join(root, "backup.guyditor.yaml"), "utf8"))
      .resolves.toBe(DEFAULT_BACKUP_CONFIG_YAML);
  });

  it("creates deduplicated load-bearing sets, verifies hashes, and excludes derived state and secrets", async () => {
    const { projectDir, secret, service, target, targetDir } = await fixture();

    const first = await service.run(projectDir, "local", "manual");
    const second = await service.run(projectDir, "local", "manual");
    const report = await service.verify(target, first.backupId, "full");

    expect(first.format).toBe("guyditor-backup/v1");
    expect(first.entries.map(({ role }) => role)).toEqual(expect.arrayContaining([
      "master",
      "sidecar",
      "history",
      "source",
      "generated",
      "preset",
      "archive-manifest",
      "config",
      "environment",
      "audit",
    ]));
    expect(first.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "workspace.guyditor.yaml",
        role: "workspace",
      }),
    ]));
    expect(first.entries.some(({ path }) => path.includes(".guyditor/cache"))).toBe(false);
    expect(first.entries.some(({ path }) => path.includes("jobs.sqlite"))).toBe(false);
    expect(first.stats.newObjects).toBeGreaterThan(0);
    expect(second.stats.newObjects).toBe(0);
    expect(report).toMatchObject({
      backupId: first.backupId,
      mode: "full",
      checked: first.entries.length,
      totalEntries: first.entries.length,
      failures: [],
    });
    const backupFiles = await allFiles(join(targetDir, "guyditor-backup"));
    const contents = await Promise.all(backupFiles.map((file) =>
      readFile(join(targetDir, "guyditor-backup", file))));
    expect(Buffer.concat(contents).includes(Buffer.from(secret))).toBe(false);
  });

  it("always verifies workspace state in sampled verification", async () => {
    const { projectDir, service, target, targetDir } = await fixture();
    const manifest = await service.run(projectDir, "local", "manual");
    const workspace = manifest.entries.find(({ role }) => role === "workspace");
    expect(workspace).toMatchObject({
      path: "workspace.guyditor.yaml",
      role: "workspace",
    });
    if (workspace === undefined) throw new Error("workspace entry missing");
    await writeFile(join(
      targetDir,
      "guyditor-backup/objects",
      workspace.sha256.slice(0, 2),
      workspace.sha256,
    ), "tampered");

    await expect(service.verify(target, manifest.backupId, "sample", {
      samplePercent: 0,
      minSample: 0,
    })).rejects.toMatchObject({
      code: "E_BACKUP_VERIFY_MISMATCH",
      affected: ["workspace.guyditor.yaml"],
    });
  });

  it("backs up legacy projects without optional workspace state", async () => {
    const { projectDir, service } = await fixture();
    await rm(join(projectDir, "workspace.guyditor.yaml"));

    const manifest = await service.run(projectDir, "local", "manual");

    expect(manifest.entries.some(({ role }) => role === "workspace")).toBe(false);
    expect(manifest.entries.some(({ path }) => path === "workspace.guyditor.yaml")).toBe(false);
  });

  it("marks a run damaged when full verification finds a changed object", async () => {
    const { projectDir, service, target, targetDir } = await fixture();
    const manifest = await service.run(projectDir, "local", "manual");
    const entry = manifest.entries[0]!;
    await writeFile(join(
      targetDir,
      "guyditor-backup/objects",
      entry.sha256.slice(0, 2),
      entry.sha256,
    ), "tampered");

    await expect(service.verify(target, manifest.backupId, "full")).rejects.toMatchObject({
      code: "E_BACKUP_VERIFY_MISMATCH",
      retry: "unsafe",
    });
    await expect(service.listBackups(target)).resolves.toEqual([
      expect.objectContaining({ backupId: manifest.backupId, damaged: true }),
    ]);
  });

  it("restores to an isolated scratch directory and removes it after validation", async () => {
    const { projectDir, service, target } = await fixture();
    const manifest = await service.run(projectDir, "local", "manual");
    const scratchRoot = await temporaryRoot("guyditor-restore-tests-");

    const restored = await service.restoreTest(target, manifest.backupId, {
      knownProjectDirectory: projectDir,
      scratchRoot,
    });
    expect(restored).toMatchObject({
      revisionChainOk: true,
      validationErrors: [],
      failures: [],
    });
    await expect(readdir(scratchRoot)).resolves.toEqual([]);

    const destination = join(scratchRoot, manifest.backupId);
    await service.restoreTest(target, manifest.backupId, {
      knownProjectDirectory: projectDir,
      scratchRoot,
      keepScratch: true,
    });
    expect(await readFile(join(destination, "workspace.guyditor.yaml")))
      .toEqual(WORKSPACE_DOCUMENT);
    await rm(destination, { recursive: true, force: true });
    await expect(readdir(scratchRoot)).resolves.toEqual([]);
    await expect(service.restoreTest(target, manifest.backupId, {
      knownProjectDirectory: projectDir,
      scratchRoot: join(projectDir, ".guyditor/restore-test"),
    })).rejects.toMatchObject({ code: "E_RESTORE_PATH_REFUSED" });
  });

  it("exports and imports a real environment zip with pre-import protection and path review", async () => {
    const { service, userDir } = await fixture();
    const transfer = join(await temporaryRoot("guyditor-env-transfer-"), "environment.zip");
    const freshUser = join(await temporaryRoot("guyditor-env-fresh-"), "user");
    await mkdir(join(freshUser, "presets/caption"), { recursive: true });
    await writeFile(join(freshUser, "presets/caption/global.yaml"), "old preset\n");

    const bundle = await service.exportEnvironment(transfer);
    const report = await service.importEnvironment(bundle, freshUser);

    expect((await readFile(bundle)).subarray(0, 2).toString("ascii")).toBe("PK");
    expect(report.importedRoles).toEqual(expect.arrayContaining([
      "skill", "preset", "brand", "platform-profile", "settings", "adapter-config",
    ]));
    expect(report.flaggedPathSettings).toContain("/scratchPath");
    expect(report.secretPlaceholders).toEqual([{
      adapterId: "adp_klingaaaaa",
      credentialKeys: ["apiKey"],
    }]);
    await expect(readFile(join(freshUser, "skills/global-brand/1.0.0/SKILL.md"), "utf8"))
      .resolves.toBe("# Global brand\n");
    const preImports = (await readdir(freshUser)).filter((name) => name.startsWith("pre-import-"));
    expect(preImports).toHaveLength(1);
    await expect(readFile(join(freshUser, preImports[0]!, "presets/caption/global.yaml"), "utf8"))
      .resolves.toBe("old preset\n");
    expect(userDir).not.toBe(freshUser);
  });

  it("enqueues one coalesced visible backup and verification chain per target", async () => {
    const { projectDir, service } = await fixture();
    const { queue } = JobQueue.open(":memory:", { concurrency: 1 });
    queues.push(queue);
    service.registerJobExecutors(queue);

    const first = await service.schedule(projectDir, queue, "scheduled");
    const second = await service.schedule(projectDir, queue, "scheduled");

    expect(first).toHaveLength(1);
    expect(second[0]!.jobId).toBe(first[0]!.jobId);
    expect(queue.get(first[0]!.jobId)?.kind).toBe("backup.run");
    expect(second[0]!.verificationJobId).toBe(first[0]!.verificationJobId);
    expect(queue.get(first[0]!.verificationJobId!)?.kind).toBe("backup.verify");
    expect(queue.get(first[0]!.verificationJobId!)?.dependsOn).toEqual([first[0]!.jobId]);
  });

  it("debounces accepted revisions and exposes periodic and quit scheduling hooks", async () => {
    const { projectDir, service } = await fixture();
    const { queue } = JobQueue.open(":memory:", { concurrency: 1 });
    queues.push(queue);
    service.registerJobExecutors(queue);
    const scheduler = await service.createScheduler(projectDir, queue, {
      debounceMilliseconds: 5,
      intervalMilliseconds: 60_000,
    });

    scheduler.acceptedRevision();
    scheduler.acceptedRevision();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(queue.list({ kind: "backup.run" })).toHaveLength(1);
    await scheduler.quit();
    expect(queue.list({ kind: "backup.run" }).length).toBeGreaterThanOrEqual(1);
    scheduler.close();
  });
});
