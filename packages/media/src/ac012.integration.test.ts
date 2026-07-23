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
  OperationEngine,
  createProject,
  openProject,
} from "../../core/src/index.js";
import type { Result } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import {
  EphemeralCredentialStore,
  restoredAdapterCredentialStates,
} from "../../agent/src/index.js";
import { BackupService } from "./backup.js";
import type { BackupConfig, BackupTarget } from "./backup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

describe("AC-012 survive machine loss", () => {
  it("backs up, verifies, restores cleanly without credentials, and continues editing", async () => {
    const oldMachine = await root("guyditor-ac012-old-");
    const newMachine = await root("guyditor-ac012-new-");
    const projectDir = join(oldMachine, "project");
    const userDir = join(oldMachine, "user-data");
    const targetDir = join(oldMachine, "removable-backup");
    const restoredProject = join(newMachine, "project");
    const restoredUser = join(newMachine, "user-data");
    const source = Buffer.from("AC-012 source");
    const project = projectFixture();
    project.assets[0]!.sha256 = createHash("sha256").update(source).digest("hex");
    project.assets[0]!.bytes = source.length;
    await valueOf(createProject(projectDir, project, { appVersion: "4.0.0-test" }));
    await mkdir(join(projectDir, "media"), { recursive: true });
    await writeFile(join(projectDir, "media/a.mov"), source);
    await mkdir(join(userDir, "skills/brand/1.0.0"), { recursive: true });
    await mkdir(join(userDir, "presets/caption"), { recursive: true });
    await mkdir(join(userDir, "adapters/adp_klingaaaaa"), { recursive: true });
    await writeFile(join(userDir, "skills/brand/1.0.0/SKILL.md"), "# Brand voice\n");
    await writeFile(join(userDir, "presets/caption/brand.yaml"), "preset: brand\n");
    await writeFile(join(userDir, "adapters/adp_klingaaaaa/manifest.json"), `${JSON.stringify({
      adapterId: "adp_klingaaaaa",
      config: { apiKeyRef: "apiKey", model: "kling-video-o1" },
    })}\n`);
    const credentials = new EphemeralCredentialStore();
    const secret = "fake-keychain-only-secret";
    await credentials.set("adp_klingaaaaa", "apiKey", secret);
    const target: BackupTarget = { name: "removable", kind: "local-path", path: targetDir };
    const backupConfig: BackupConfig = {
      format: "guyditor-backup-config/v1",
      targets: [target],
      schedule: { onAcceptedRevision: true, debounceMinutes: 10, intervalHours: 24, onQuit: true },
      include: { renders: false, auditLogs: false, environment: true },
      retention: { keepLast: 10, keepDaily: 14, keepWeekly: 12 },
      verify: { afterEveryRun: true, mode: "sample", samplePercent: 1, minSample: 20, fullEveryDays: 30 },
    };
    await BackupService.writeConfig(projectDir, backupConfig);
    const service = new BackupService({
      appVersion: "4.0.0-test",
      secretValues: () => credentials.values(),
      userDirectory: userDir,
    });

    const manifest = await service.run(projectDir, "removable", "manual");
    const verified = await service.verify(target, manifest.backupId, "full");
    const restored = await service.restore(target, manifest.backupId, restoredProject, {
      userDirectory: restoredUser,
    });
    const restoredCredentials = new EphemeralCredentialStore();
    const adapterStates = await restoredAdapterCredentialStates(restoredUser, restoredCredentials);
    const store = await valueOf(openProject(restoredProject, { appVersion: "4.0.0-test" }));
    const engine = new OperationEngine(store.currentProject, {
      appVersion: "4.0.0-test",
      committer: store,
      idFactory: (prefix) => prefix === "txn" ? "txn_bbbbbbbbbb" : `${prefix}_bbbbbbbbbb`,
    });
    const edited = await valueOf(engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: -1, fps: "24/1" },
        snapPolicy: "none",
      },
    }], {
      baseRevision: store.currentProject.revision,
      origin: "ui",
      dryRun: false,
    }));

    expect(verified.failures).toEqual([]);
    expect(restored).toMatchObject({ revisionChainOk: true, validationErrors: [] });
    await expect(readFile(join(restoredUser, "skills/brand/1.0.0/SKILL.md"), "utf8"))
      .resolves.toBe("# Brand voice\n");
    await expect(readFile(join(restoredUser, "presets/caption/brand.yaml"), "utf8"))
      .resolves.toBe("preset: brand\n");
    expect(adapterStates).toEqual([{
      adapterId: "adp_klingaaaaa",
      credentialKeys: ["apiKey"],
      state: "needs-credentials",
    }]);
    expect(await restoredCredentials.get("adp_klingaaaaa", "apiKey")).toBeUndefined();
    expect(edited.transactionId).toBe("txn_bbbbbbbbbb");
    expect(engine.currentProject.revision).toBe("rev_00002");
    const restoredFiles = await readdir(restoredUser, { recursive: true });
    const restoredBytes = await Promise.all(restoredFiles.map(async (file) => {
      try {
        return await readFile(join(restoredUser, file));
      } catch {
        return Buffer.alloc(0);
      }
    }));
    expect(Buffer.concat(restoredBytes).includes(Buffer.from(secret))).toBe(false);
  });
});
