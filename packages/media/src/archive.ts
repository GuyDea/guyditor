import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  makeGuyditorError,
  makeId,
  parseProjectYaml,
} from "../../core/src/index.js";
import type { Asset, GuyditorProject } from "../../core/src/index.js";

import type { BackupTarget } from "./backup.js";

export interface ArchiveEntry {
  assetId: string;
  originalPath: string;
  sha256: string;
  size: number;
  target: string;
  archivePath: string;
  offlinedAt: string;
  state: "offline" | "restored";
}

export interface ArchiveManifest {
  format: "guyditor-archive/v1";
  archiveId: string;
  projectId: string;
  entries: ArchiveEntry[];
}

export interface ArchivePlanEntry {
  assetId: string;
  originalPath: string;
  sourcePath: string;
  sha256: string;
  size: number;
  archivePath: string;
  kind: Asset["kind"];
}

export interface ArchivePlan {
  projectId: string;
  projectDir: string;
  target: string;
  entries: ArchivePlanEntry[];
  totalBytes: number;
}

interface ArchiveServiceOptions {
  targets: BackupTarget[];
  userDirectory?: string;
  now?: () => Date;
  previewGenerator?: (input: {
    asset: Asset;
    source: string;
    destination: string;
  }) => Promise<void>;
  backupTrigger?: (projectDir: string, reason: "archive-updated") => Promise<void>;
  relink?: (assetId: string, path: string, sha256: string) => Promise<void>;
  rcloneRunner?: (binary: string, args: readonly string[]) => Promise<void>;
}

interface ArchiveRestoreOptions {
  destinations?: Record<string, string>;
}

const execFileAsync = promisify(execFile);

function archiveError(
  code: `E_${Uppercase<string>}`,
  message: string,
  options: { affected?: string[]; retry?: "safe" | "unsafe" | "none"; suggestion?: string } = {},
): ReturnType<typeof makeGuyditorError> {
  return makeGuyditorError(code, message, options);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}-${randomBytes(4).toString("hex")}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function copyVerified(source: string, destination: string, expectedHash: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${String(process.pid)}-${randomBytes(4).toString("hex")}`;
  try {
    await copyFile(source, temporary);
    const actual = await hashFile(temporary);
    if (actual !== expectedHash) {
      throw archiveError(
        "E_ARCHIVE_HASH_MISMATCH",
        `Copied archive object ${basename(source)} failed SHA-256 verification.`,
        { retry: "unsafe" },
      );
    }
    const handle = await open(temporary, "r");
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readProject(projectDir: string): Promise<GuyditorProject> {
  const parsed = parseProjectYaml(await readFile(join(projectDir, "episode.guyditor.yaml"), "utf8"));
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

async function readManifest(projectDir: string): Promise<ArchiveManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(
      join(projectDir, "archive/archive.manifest.json"),
      "utf8",
    )) as ArchiveManifest;
    if (parsed.format !== "guyditor-archive/v1" || !Array.isArray(parsed.entries)) {
      throw new Error("archive manifest has an unsupported format");
    }
    return parsed;
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function sortedManifest(manifest: ArchiveManifest): string {
  return `${JSON.stringify({
    archiveId: manifest.archiveId,
    entries: [...manifest.entries].sort((left, right) => left.assetId.localeCompare(right.assetId)),
    format: manifest.format,
    projectId: manifest.projectId,
  })}\n`;
}

async function fallbackPreviews(input: {
  asset: Asset;
  destination: string;
}): Promise<void> {
  await mkdir(input.destination, { recursive: true });
  const minimalJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await Promise.all([
    atomicWrite(join(input.destination, "poster.jpg"), minimalJpeg.toString("latin1")),
    atomicWrite(join(input.destination, "filmstrip.jpg"), minimalJpeg.toString("latin1")),
    ...(input.asset.kind === "audio"
      ? [atomicWrite(join(input.destination, "waveform.png"), "retained-waveform\n")]
      : []),
  ]);
}

export class ArchiveService {
  readonly #backupTrigger: (projectDir: string, reason: "archive-updated") => Promise<void>;
  readonly #now: () => Date;
  readonly #previewGenerator: NonNullable<ArchiveServiceOptions["previewGenerator"]>;
  readonly #relink: ArchiveServiceOptions["relink"];
  readonly #rcloneRunner: NonNullable<ArchiveServiceOptions["rcloneRunner"]>;
  readonly #targets: Map<string, BackupTarget>;
  readonly #userDirectory: string;

  public constructor(options: ArchiveServiceOptions) {
    this.#targets = new Map(options.targets.map((target) => [target.name, target]));
    this.#userDirectory = resolve(options.userDirectory ?? join(process.cwd(), ".guyditor"));
    this.#now = options.now ?? (() => new Date());
    this.#previewGenerator = options.previewGenerator ?? fallbackPreviews;
    this.#backupTrigger = options.backupTrigger ?? (() => Promise.resolve());
    this.#relink = options.relink;
    this.#rcloneRunner = options.rcloneRunner ?? (async (binary, args) => {
      await execFileAsync(binary, [...args], { windowsHide: true });
    });
  }

  async #targetRoot(targetName: string): Promise<{ root: string; target: BackupTarget }> {
    const target = this.#targets.get(targetName);
    if (target === undefined) {
      throw archiveError("E_ARCHIVE_TARGET_UNAVAILABLE", `Archive target ${targetName} is not configured.`, {
        retry: "safe",
      });
    }
    const root = target.kind === "local-path"
      ? target.path
      : join(this.#userDirectory, "archive-staging", target.name);
    if (root === undefined || target.kind === "local-path" && !isAbsolute(root) ||
        target.kind === "rclone-remote" && target.remote === undefined) {
      throw archiveError("E_ARCHIVE_TARGET_UNAVAILABLE", `Archive target ${targetName} is incomplete.`, {
        retry: "safe",
      });
    }
    return { root: resolve(root), target };
  }

  public async planOffline(
    projectDir: string,
    targetName: string,
    selected: readonly string[] | "auto",
  ): Promise<ArchivePlan> {
    if (!this.#targets.has(targetName)) {
      throw archiveError("E_ARCHIVE_TARGET_UNAVAILABLE", `Archive target ${targetName} is not configured.`, {
        retry: "safe",
      });
    }
    const root = resolve(projectDir);
    const project = await readProject(root);
    const ids = selected === "auto" ? undefined : new Set(selected);
    const entries: ArchivePlanEntry[] = [];
    for (const asset of project.assets) {
      if (ids !== undefined && !ids.has(asset.id)) continue;
      if (asset.kind === "subtitle" || asset.sha256.length !== 64) continue;
      const sourcePath = resolve(root, asset.path);
      let metadata;
      try {
        metadata = await stat(sourcePath);
      } catch (error: unknown) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (!metadata.isFile()) continue;
      entries.push({
        assetId: asset.id,
        originalPath: asset.path,
        sourcePath,
        sha256: asset.sha256,
        size: metadata.size,
        archivePath: `guyditor-archive/${project.project.id}/${asset.id}/${basename(sourcePath)}`,
        kind: asset.kind,
      });
    }
    if (ids !== undefined) {
      const missing = [...ids].filter((id) => !entries.some(({ assetId }) => assetId === id));
      if (missing.length > 0) {
        throw archiveError("E_ARCHIVE_ASSET_INELIGIBLE", `Assets ${missing.join(", ")} cannot be archived.`, {
          affected: missing,
        });
      }
    }
    return {
      projectId: project.project.id,
      projectDir: root,
      target: targetName,
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    };
  }

  public async offline(projectDir: string, plan: ArchivePlan): Promise<{ jobId: string }> {
    const root = resolve(projectDir);
    if (root !== plan.projectDir) throw archiveError("E_ARCHIVE_PLAN_STALE", "Archive plan belongs to another project.");
    const project = await readProject(root);
    for (const entry of plan.entries) {
      const actual = await hashFile(entry.sourcePath);
      if (actual !== entry.sha256) {
        throw archiveError(
          "E_ARCHIVE_HASH_MISMATCH",
          `Asset ${entry.assetId} changed after ingest; nothing was copied.`,
          { affected: [entry.assetId], retry: "none" },
        );
      }
    }
    for (const entry of plan.entries) {
      const asset = project.assets.find(({ id }) => id === entry.assetId)!;
      await this.#previewGenerator({
        asset,
        source: entry.sourcePath,
        destination: join(root, "archive/previews", entry.assetId),
      });
    }
    const { root: targetRoot, target } = await this.#targetRoot(plan.target);
    for (const entry of plan.entries) {
      await copyVerified(entry.sourcePath, join(targetRoot, entry.archivePath), entry.sha256);
    }
    if (target.kind === "rclone-remote") {
      await this.#rcloneRunner(target.rcloneBinary ?? "rclone", [
        "sync", targetRoot, target.remote!, "--checksum",
      ]).catch((error: unknown) => {
        throw archiveError(
          "E_ARCHIVE_TARGET_UNAVAILABLE",
          `Archive target ${target.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          { retry: "safe" },
        );
      });
    }
    const previous = await readManifest(root);
    const byAsset = new Map((previous?.entries ?? []).map((entry) => [entry.assetId, entry]));
    const offlinedAt = this.#now().toISOString();
    for (const entry of plan.entries) {
      byAsset.set(entry.assetId, {
        assetId: entry.assetId,
        originalPath: entry.originalPath,
        sha256: entry.sha256,
        size: entry.size,
        target: plan.target,
        archivePath: entry.archivePath,
        offlinedAt,
        state: "offline",
      });
    }
    const manifest: ArchiveManifest = {
      format: "guyditor-archive/v1",
      archiveId: previous?.archiveId ?? `arc_${randomBytes(5).toString("hex")}`,
      projectId: plan.projectId,
      entries: [...byAsset.values()],
    };
    await atomicWrite(join(root, "archive/archive.manifest.json"), sortedManifest(manifest));
    for (const entry of plan.entries) await unlink(entry.sourcePath);
    await this.#backupTrigger(root, "archive-updated");
    return { jobId: makeId("job") };
  }

  public async restore(
    projectDir: string,
    assetIds: readonly string[],
    options: ArchiveRestoreOptions = {},
  ): Promise<{ jobId: string }> {
    const root = resolve(projectDir);
    const manifest = await readManifest(root);
    if (manifest === undefined) throw archiveError("E_ARCHIVE_MANIFEST_MISSING", "Project has no archive manifest.");
    for (const assetId of assetIds) {
      const entry = manifest.entries.find((candidate) => candidate.assetId === assetId);
      if (entry === undefined) {
        throw archiveError("E_ARCHIVE_ENTRY_MISSING", `Asset ${assetId} is not in the archive.`, { affected: [assetId] });
      }
      const { root: targetRoot, target } = await this.#targetRoot(entry.target);
      if (target.kind === "rclone-remote") {
        await this.#rcloneRunner(target.rcloneBinary ?? "rclone", [
          "copyto", `${target.remote!}/${entry.archivePath}`, join(targetRoot, entry.archivePath), "--checksum",
        ]).catch(() => {
          throw archiveError("E_ARCHIVE_TARGET_UNAVAILABLE", `Archive target ${target.name} is unavailable.`, {
            affected: [assetId], retry: "safe",
          });
        });
      }
      const source = join(targetRoot, entry.archivePath);
      try {
        await access(source);
      } catch (error: unknown) {
        throw archiveError(
          "E_ARCHIVE_TARGET_UNAVAILABLE",
          `Archived bytes for ${assetId} are unavailable: ${error instanceof Error ? error.message : String(error)}`,
          { affected: [assetId], retry: "safe" },
        );
      }
      const original = resolve(root, entry.originalPath);
      const destination = resolve(options.destinations?.[assetId] ?? original);
      await copyVerified(source, destination, entry.sha256).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error) throw error;
        throw archiveError("E_ARCHIVE_HASH_MISMATCH", `Archive restore for ${assetId} failed hash verification.`, {
          affected: [assetId], retry: "unsafe",
        });
      });
      if (destination !== original) {
        if (this.#relink === undefined) {
          await rm(destination, { force: true });
          throw archiveError("E_ARCHIVE_RELINK_REQUIRED", `Asset ${assetId} needs the relink service.`);
        }
        await this.#relink(assetId, destination, entry.sha256);
      }
      entry.state = "restored";
    }
    await atomicWrite(join(root, "archive/archive.manifest.json"), sortedManifest(manifest));
    return { jobId: makeId("job") };
  }

  public async assetStates(projectDir: string): Promise<Record<string, "offline" | "restored">> {
    const manifest = await readManifest(resolve(projectDir));
    return Object.fromEntries((manifest?.entries ?? []).map(({ assetId, state }) => [assetId, state]));
  }

  public async missingMediaAction(projectDir: string, assetId: string): Promise<{
    kind: "archive.restore";
    assetId: string;
    target: string;
  } | undefined> {
    const manifest = await readManifest(resolve(projectDir));
    const entry = manifest?.entries.find((candidate) =>
      candidate.assetId === assetId && candidate.state === "offline");
    return entry === undefined ? undefined : {
      kind: "archive.restore",
      assetId,
      target: entry.target,
    };
  }
}
