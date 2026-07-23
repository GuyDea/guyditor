import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "../../core/src/index.js";
import type { Result } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { ArchiveService } from "./archive.js";
import type { BackupTarget } from "./backup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "guyditor-archive-"));
  roots.push(value);
  return value;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function hash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<{
  backupReasons: string[];
  coldDir: string;
  projectDir: string;
  relinks: Array<{ assetId: string; path: string; sha256: string }>;
  service: ArchiveService;
  source: Buffer;
  sourcePath: string;
  target: BackupTarget;
}> {
  const sandbox = await root();
  const projectDir = join(sandbox, "project");
  const coldDir = join(sandbox, "cold");
  const source = Buffer.from("finished-project-heavy-source");
  const project = projectFixture();
  project.assets[0]!.sha256 = hash(source);
  project.assets[0]!.bytes = source.length;
  await valueOf(createProject(projectDir, project));
  const sourcePath = join(projectDir, "media/a.mov");
  await mkdir(join(projectDir, "media"), { recursive: true });
  await writeFile(sourcePath, source);
  const target: BackupTarget = { name: "cold", kind: "local-path", path: coldDir };
  const backupReasons: string[] = [];
  const relinks: Array<{ assetId: string; path: string; sha256: string }> = [];
  return {
    backupReasons,
    coldDir,
    projectDir,
    relinks,
    service: new ArchiveService({
      targets: [target],
      previewGenerator: async ({ destination }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "poster.jpg"), "poster");
        await writeFile(join(destination, "filmstrip.jpg"), "filmstrip");
        await writeFile(join(destination, "waveform.png"), "waveform");
      },
      backupTrigger: (_projectDir, reason) => {
        backupReasons.push(reason);
        return Promise.resolve();
      },
      relink: (assetId, path, sha256) => {
        relinks.push({ assetId, path, sha256 });
        return Promise.resolve();
      },
    }),
    source,
    sourcePath,
    target,
  };
}

describe("ArchiveService", () => {
  it("copies, verifies, writes retained previews and manifest, then deletes local media", async () => {
    const { backupReasons, coldDir, projectDir, service, source, sourcePath } = await fixture();
    const masterBefore = await readFile(join(projectDir, "episode.guyditor.yaml"));
    const plan = await service.planOffline(projectDir, "cold", ["ast_aaaaaaaaaa"]);

    const result = await service.offline(projectDir, plan);

    expect(result.jobId).toMatch(/^job_/u);
    await expect(access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(
      coldDir,
      "guyditor-archive/prj_aaaaaaaaaa/ast_aaaaaaaaaa/a.mov",
    ))).resolves.toEqual(source);
    await expect(readFile(join(projectDir, "episode.guyditor.yaml")))
      .resolves.toEqual(masterBefore);
    await expect(stat(join(projectDir, "archive/previews/ast_aaaaaaaaaa/poster.jpg")))
      .resolves.toBeDefined();
    await expect(stat(join(projectDir, "archive/previews/ast_aaaaaaaaaa/filmstrip.jpg")))
      .resolves.toBeDefined();
    const manifest = JSON.parse(await readFile(
      join(projectDir, "archive/archive.manifest.json"),
      "utf8",
    )) as { entries: Array<{ state: string; sha256: string }> };
    expect(manifest.entries).toEqual([
      expect.objectContaining({ state: "offline", sha256: hash(source) }),
    ]);
    expect(backupReasons).toEqual(["archive-updated"]);
    await expect(service.assetStates(projectDir)).resolves.toEqual({
      ast_aaaaaaaaaa: "offline",
    });
  });

  it("aborts before copying or deleting when the ingest hash no longer matches", async () => {
    const { coldDir, projectDir, service, sourcePath } = await fixture();
    await writeFile(sourcePath, "corrupted after ingest");
    const plan = await service.planOffline(projectDir, "cold", ["ast_aaaaaaaaaa"]);

    await expect(service.offline(projectDir, plan)).rejects.toMatchObject({
      code: "E_ARCHIVE_HASH_MISMATCH",
      affected: ["ast_aaaaaaaaaa"],
    });
    await expect(stat(sourcePath)).resolves.toBeDefined();
    await expect(access(join(coldDir, "guyditor-archive"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores by hash to the original path and keeps the cold copy", async () => {
    const { coldDir, projectDir, service, source, sourcePath } = await fixture();
    await service.offline(projectDir, await service.planOffline(projectDir, "cold", "auto"));

    const result = await service.restore(projectDir, ["ast_aaaaaaaaaa"]);

    expect(result.jobId).toMatch(/^job_/u);
    await expect(readFile(sourcePath)).resolves.toEqual(source);
    await expect(stat(join(
      coldDir,
      "guyditor-archive/prj_aaaaaaaaaa/ast_aaaaaaaaaa/a.mov",
    ))).resolves.toBeDefined();
    await expect(service.assetStates(projectDir)).resolves.toEqual({
      ast_aaaaaaaaaa: "restored",
    });
  });

  it("restores to a chosen location through the relink hook and offers archive restore before manual relink", async () => {
    const { projectDir, relinks, service, source } = await fixture();
    await service.offline(projectDir, await service.planOffline(projectDir, "cold", "auto"));
    const alternate = join(await root(), "restored", "replacement.mov");

    expect(await service.missingMediaAction(projectDir, "ast_aaaaaaaaaa")).toEqual({
      kind: "archive.restore",
      assetId: "ast_aaaaaaaaaa",
      target: "cold",
    });
    await service.restore(projectDir, ["ast_aaaaaaaaaa"], {
      destinations: { ast_aaaaaaaaaa: alternate },
    });

    await expect(readFile(alternate)).resolves.toEqual(source);
    expect(relinks).toEqual([{
      assetId: "ast_aaaaaaaaaa",
      path: alternate,
      sha256: hash(source),
    }]);
  });
});
