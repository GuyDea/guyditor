import { makeGuyditorError, makeId, parseProjectYaml } from "../../core/src/index.js";
import type { JobRecord } from "../../core/src/index.js";
import type { GuyditorProject } from "../../core/src/index.js";
import type { Dirent } from "node:fs";
import {
  appendFile,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type StorageCategory =
  | "sources"
  | "generated"
  | "project-state"
  | "proxies"
  | "caches"
  | "renders"
  | "archives"
  | "jobs-db"
  | "audit";

export interface StorageCategorySummary {
  bytes: number;
  files: number;
  reclaimable: boolean;
}

export interface StorageReport {
  scannedAt: string;
  projectDir: string;
  volumeFreeBytes: number;
  volumeCapacityBytes: number;
  categories: Record<StorageCategory, StorageCategorySummary>;
  externalSources: Array<{
    assetId: string;
    path: string;
    bytes: number;
    volumeFreeBytes: number;
  }>;
  orphans: Array<{ path: string; bytes: number }>;
}

export interface GlobalStorageReport {
  scannedAt: string;
  projects: StorageReport[];
  categories: Record<StorageCategory, StorageCategorySummary>;
  externalSources: { bytes: number; files: number };
}

export type RenderResolution = "2160p" | "1440p" | "1080p" | "vertical-1080p" | "720p";

export type EstimatableOperation =
  | {
      kind: "proxy";
      assets: Array<{ durationSeconds: number; videoKbps: number }>;
    }
  | { kind: "analysis"; durationMinutes: number }
  | {
      kind: "render";
      durationSeconds: number;
      audioKbps: number;
      videoKbps?: number;
      resolution?: RenderResolution;
    }
  | {
      kind: "backup";
      objects: Array<{ sha256: string; size: number }>;
      existingObjectHashes: string[];
    }
  | {
      kind: "archive-offline";
      files: Array<{ size: number }>;
      manifestOverheadBytes?: number;
    };

export interface StorageEstimate {
  category: StorageCategory;
  bytes: number;
  basis: string;
}

export interface CleanupPlan {
  planId: string;
  createdAt: string;
  items: Array<{
    path: string;
    category: StorageCategory;
    bytes: number;
    regenerable: true;
  }>;
  totalBytes: number;
}

export interface JobRef {
  jobId: string;
}

interface StorageAccountantOptions {
  now?: () => Date;
  restoreTestRoot?: string;
  userDirectory?: string;
}

interface FileEntry {
  path: string;
  bytes: number;
  mtime: string;
}

const CATEGORY_NAMES: readonly StorageCategory[] = [
  "sources",
  "generated",
  "project-state",
  "proxies",
  "caches",
  "renders",
  "archives",
  "jobs-db",
  "audit",
];

const RECLAIMABLE = new Set<StorageCategory>(["proxies", "caches", "jobs-db"]);
const TEN_GIB = 10 * 1024 * 1024 * 1024;
const CRF_VIDEO_KBPS: Record<RenderResolution, number> = {
  "2160p": 45_000,
  "1440p": 24_000,
  "1080p": 12_000,
  "vertical-1080p": 12_000,
  "720p": 7_500,
};

function emptyCategories(): Record<StorageCategory, StorageCategorySummary> {
  return Object.fromEntries(CATEGORY_NAMES.map((category) => [category, {
    bytes: 0,
    files: 0,
    reclaimable: RECLAIMABLE.has(category),
  }])) as Record<StorageCategory, StorageCategorySummary>;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function walkFiles(root: string): Promise<FileEntry[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: FileEntry[] = [];
  for (const entry of entries) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(child));
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const metadata = await lstat(child);
    files.push({ path: child, bytes: metadata.size, mtime: metadata.mtime.toISOString() });
  }
  return files;
}

async function optionalFile(path: string): Promise<FileEntry[]> {
  try {
    const metadata = await stat(path);
    return metadata.isFile()
      ? [{ path, bytes: metadata.size, mtime: metadata.mtime.toISOString() }]
      : [];
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function addFiles(
  categories: Record<StorageCategory, StorageCategorySummary>,
  category: StorageCategory,
  files: readonly FileEntry[],
): void {
  categories[category].bytes += files.reduce((sum, file) => sum + file.bytes, 0);
  categories[category].files += files.length;
}

async function readProject(projectDir: string): Promise<GuyditorProject> {
  const parsed = parseProjectYaml(await readFile(join(projectDir, "episode.guyditor.yaml"), "utf8"));
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

async function volume(path: string): Promise<{ freeBytes: number; totalBytes: number }> {
  const value = await statfs(path);
  return {
    freeBytes: Number(value.bavail) * Number(value.bsize),
    totalBytes: Number(value.blocks) * Number(value.bsize),
  };
}

function fixed(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function cleanupError(
  code: `E_${Uppercase<string>}`,
  message: string,
  suggestion?: string,
): ReturnType<typeof makeGuyditorError> {
  return makeGuyditorError(code, message, {
    retry: "none",
    ...(suggestion === undefined ? {} : { suggestion }),
  });
}

export class StorageAccountant {
  readonly #now: () => Date;
  readonly #restoreTestRoot: string;
  readonly #userDirectory: string | undefined;

  public constructor(options: StorageAccountantOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#restoreTestRoot = resolve(options.restoreTestRoot ?? join(tmpdirPath(), "guyditor-restore-test"));
    this.#userDirectory = options.userDirectory === undefined
      ? undefined
      : resolve(options.userDirectory);
  }

  public async scan(projectDir: string): Promise<StorageReport> {
    const root = resolve(projectDir);
    const project = await readProject(root);
    const categories = emptyCategories();
    const projectState = [
      ...await optionalFile(join(root, "episode.guyditor.yaml")),
      ...await optionalFile(join(root, "backup.guyditor.yaml")),
      ...await walkFiles(join(root, "sidecars")),
      ...await walkFiles(join(root, "history")),
      ...await walkFiles(join(root, "proposals")),
      ...await walkFiles(join(root, "presets")),
      ...await walkFiles(join(root, "skills")),
      ...await walkFiles(join(root, "archive")),
    ];
    addFiles(categories, "project-state", projectState);
    addFiles(categories, "generated", await walkFiles(join(root, "media/generated")));

    const externalSources: StorageReport["externalSources"] = [];
    const generatedRoot = resolve(root, "media/generated");
    const seenSources = new Set<string>();
    for (const asset of project.assets) {
      const sourcePath = resolve(root, asset.path);
      if (inside(generatedRoot, sourcePath) || seenSources.has(sourcePath)) continue;
      const files = await optionalFile(sourcePath);
      if (files.length === 0) continue;
      seenSources.add(sourcePath);
      addFiles(categories, "sources", files);
      if (!inside(root, sourcePath)) {
        const sourceVolume = await volume(dirname(sourcePath));
        externalSources.push({
          assetId: asset.id,
          path: sourcePath,
          bytes: files[0]!.bytes,
          volumeFreeBytes: sourceVolume.freeBytes,
        });
      }
    }

    const proxyFiles = await walkFiles(join(root, ".guyditor/cache/proxies"));
    const cacheFiles = (await walkFiles(join(root, ".guyditor/cache")))
      .filter((file) => !inside(resolve(root, ".guyditor/cache/proxies"), file.path));
    addFiles(categories, "proxies", proxyFiles);
    addFiles(categories, "caches", cacheFiles);
    addFiles(categories, "renders", [
      ...await walkFiles(join(root, "exports")),
      ...await walkFiles(join(root, "renders")),
      ...await walkFiles(join(root, "upload-kits")),
    ]);
    addFiles(categories, "archives", await walkFiles(join(root, ".guyditor/archive-staging")));
    addFiles(categories, "jobs-db", [
      ...await optionalFile(join(root, ".guyditor/jobs.sqlite")),
      ...await optionalFile(join(root, ".guyditor/jobs.sqlite-wal")),
      ...await optionalFile(join(root, ".guyditor/jobs.sqlite-shm")),
    ]);
    if (this.#userDirectory !== undefined) {
      addFiles(categories, "audit", await walkFiles(join(this.#userDirectory, "audit")));
    }

    const liveTokens = new Set([
      project.revision,
      ...project.assets.flatMap((asset) => [asset.id, asset.sha256]),
    ]);
    const orphans = [...proxyFiles, ...cacheFiles]
      .filter((file) => ![...liveTokens].some((token) => file.path.includes(token)))
      .map(({ path, bytes }) => ({ path, bytes }));
    const projectVolume = await volume(root);
    return {
      scannedAt: this.#now().toISOString(),
      projectDir: root,
      volumeFreeBytes: projectVolume.freeBytes,
      volumeCapacityBytes: projectVolume.totalBytes,
      categories,
      externalSources,
      orphans,
    };
  }

  public async scanGlobal(projectDirs: readonly string[]): Promise<GlobalStorageReport> {
    const projects = await Promise.all(projectDirs.map((projectDir) => this.scan(projectDir)));
    const categories = emptyCategories();
    const external = new Map<string, number>();
    projects.forEach((project, index) => {
      for (const category of CATEGORY_NAMES) {
        if (category === "audit" && index > 0) continue;
        categories[category].bytes += project.categories[category].bytes;
        categories[category].files += project.categories[category].files;
      }
      for (const source of project.externalSources) external.set(source.path, source.bytes);
    });
    const duplicatedExternalBytes = projects.reduce((sum, project) =>
      sum + project.externalSources.reduce((projectSum, source) => projectSum + source.bytes, 0), 0) -
      [...external.values()].reduce((sum, bytes) => sum + bytes, 0);
    categories.sources.bytes -= duplicatedExternalBytes;
    categories.sources.files -= projects.reduce((sum, project) =>
      sum + project.externalSources.length, 0) - external.size;
    return {
      scannedAt: this.#now().toISOString(),
      projects,
      categories,
      externalSources: {
        bytes: [...external.values()].reduce((sum, bytes) => sum + bytes, 0),
        files: external.size,
      },
    };
  }

  public estimate(operation: EstimatableOperation): Promise<StorageEstimate> {
    if (operation.kind === "proxy") {
      const bytes = Math.round(operation.assets.reduce((sum, asset) =>
        sum + asset.durationSeconds * (asset.videoKbps + 128) * 125, 0));
      const basis = operation.assets.length === 1
        ? `${fixed(operation.assets[0]!.durationSeconds)}s × (${fixed(operation.assets[0]!.videoKbps)}+128)kbps × 125`
        : `${String(operation.assets.length)} assets using duration_s × (v_kbps+128) × 125`;
      return Promise.resolve({ category: "proxies", bytes, basis });
    }
    if (operation.kind === "analysis") {
      return Promise.resolve({
        category: "caches",
        bytes: Math.round(operation.durationMinutes * 250 * 1024),
        basis: `${fixed(operation.durationMinutes)}min × 250 KiB`,
      });
    }
    if (operation.kind === "render") {
      const videoKbps = operation.videoKbps ??
        (operation.resolution === undefined ? undefined : CRF_VIDEO_KBPS[operation.resolution]);
      if (videoKbps === undefined) throw new TypeError("Render estimate needs videoKbps or resolution.");
      return Promise.resolve({
        category: "renders",
        bytes: Math.round(operation.durationSeconds * (videoKbps + operation.audioKbps) * 125),
        basis: `${fixed(operation.durationSeconds)}s × (${fixed(videoKbps)}+${fixed(operation.audioKbps)})kbps × 125`,
      });
    }
    if (operation.kind === "backup") {
      const existing = new Set(operation.existingObjectHashes);
      const missing = operation.objects.filter(({ sha256 }) => !existing.has(sha256));
      return Promise.resolve({
        category: "archives",
        bytes: missing.reduce((sum, object) => sum + object.size, 0),
        basis: `${String(missing.length)}/${String(operation.objects.length)} content-addressed objects absent`,
      });
    }
    const overhead = operation.manifestOverheadBytes ?? 4096;
    return Promise.resolve({
      category: "archives",
      bytes: operation.files.reduce((sum, file) => sum + file.size, overhead),
      basis: `${String(operation.files.length)} exact source sizes + ${String(overhead)} manifest bytes`,
    });
  }

  public async planCleanup(
    projectDir: string,
    requested: readonly StorageCategory[],
  ): Promise<CleanupPlan> {
    const refused = requested.filter((category) => !RECLAIMABLE.has(category));
    if (refused.length > 0) {
      throw cleanupError(
        "E_CLEANUP_CATEGORY_REFUSED",
        `Cleanup is limited to disposable categories; refused ${refused.join(", ")}.`,
      );
    }
    const root = resolve(projectDir);
    const items: CleanupPlan["items"] = [];
    if (requested.includes("proxies")) {
      items.push(...(await walkFiles(join(root, ".guyditor/cache/proxies"))).map((file) => ({
        path: file.path,
        category: "proxies" as const,
        bytes: file.bytes,
        regenerable: true as const,
      })));
    }
    if (requested.includes("caches")) {
      const proxies = resolve(root, ".guyditor/cache/proxies");
      items.push(...(await walkFiles(join(root, ".guyditor/cache")))
        .filter((file) => !inside(proxies, file.path))
        .map((file) => ({
          path: file.path,
          category: "caches" as const,
          bytes: file.bytes,
          regenerable: true as const,
        })));
      items.push(...(await walkFiles(this.#restoreTestRoot)).map((file) => ({
        path: file.path,
        category: "caches" as const,
        bytes: file.bytes,
        regenerable: true as const,
      })));
    }
    if (requested.includes("jobs-db")) {
      const databasePath = join(root, ".guyditor/jobs.sqlite");
      if ((await optionalFile(databasePath)).length > 0) {
        items.push({ path: `${databasePath}#completed`, category: "jobs-db", bytes: 0, regenerable: true });
      }
    }
    items.sort((left, right) => left.path.localeCompare(right.path));
    return {
      planId: `cln_${makeId("job").slice(4)}`,
      createdAt: this.#now().toISOString(),
      items,
      totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    };
  }

  public async executeCleanup(projectDir: string, plan: CleanupPlan): Promise<JobRef> {
    const root = resolve(projectDir);
    const cacheRoot = resolve(root, ".guyditor/cache");
    const canonicalCache = await realpath(cacheRoot);
    let canonicalRestore: string | undefined;
    try {
      canonicalRestore = await realpath(this.#restoreTestRoot);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }

    for (const item of plan.items) {
      if (item.category === "jobs-db") continue;
      if (/(?:^|[\\/])(?:archive|pre-migration)(?:[\\/]|$)/u.test(item.path)) {
        throw cleanupError("E_CLEANUP_PATH_REFUSED", `Protected path ${item.path} cannot be cleaned.`);
      }
      const resolved = await realpath(item.path);
      if (!inside(canonicalCache, resolved) &&
          (canonicalRestore === undefined || !inside(canonicalRestore, resolved))) {
        throw cleanupError("E_CLEANUP_PATH_REFUSED", `${item.path} resolves outside a cleanup allowlist.`);
      }
      const metadata = await lstat(item.path);
      if (metadata.size !== item.bytes) {
        throw cleanupError("E_CLEANUP_PLAN_STALE", `${item.path} changed after cleanup planning.`);
      }
    }

    for (const item of plan.items) {
      if (item.category === "jobs-db") {
        const databasePath = item.path.slice(0, -"#completed".length);
        const database = new DatabaseSync(databasePath);
        try {
          database.prepare("DELETE FROM jobs WHERE state IN ('done', 'cancelled')").run();
        } finally {
          database.close();
        }
      } else {
        await unlink(item.path);
      }
    }
    await appendFile(
      join(root, ".guyditor/cleanup.log"),
      `${this.#now().toISOString()} ${plan.planId} ${String(plan.totalBytes)} bytes ${String(plan.items.length)} items\n`,
      "utf8",
    );
    return { jobId: makeId("job") };
  }
}

function tmpdirPath(): string {
  return process.env["TMPDIR"] ?? "/tmp";
}

export interface StoragePreflightRequest {
  kind: string;
  operation: EstimatableOperation;
  reclaimableBytes?: number;
}

interface StoragePreflightOptions {
  projectDir: string;
  capacity?: () => Promise<{ freeBytes: number; totalBytes: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preflightRequest(input: StoragePreflightRequest | JobRecord): StoragePreflightRequest | undefined {
  if ("operation" in input) return input;
  if (!isRecord(input.payload) || !isRecord(input.payload["operation"])) return undefined;
  return {
    kind: input.kind,
    operation: input.payload["operation"] as EstimatableOperation,
    ...(typeof input.payload["reclaimableBytes"] === "number"
      ? { reclaimableBytes: input.payload["reclaimableBytes"] }
      : {}),
  };
}

export function createStoragePreflight(
  accountant: StorageAccountant,
  options: StoragePreflightOptions,
): (input: StoragePreflightRequest | JobRecord) => Promise<void> {
  return async (input) => {
    const request = preflightRequest(input);
    if (request === undefined) return;
    const estimate = await accountant.estimate(request.operation);
    const capacity = await (options.capacity?.() ?? volume(options.projectDir));
    const headroom = Math.max(TEN_GIB, capacity.totalBytes * 0.05);
    if (capacity.freeBytes >= estimate.bytes + headroom) return;
    const reclaimable = request.reclaimableBytes ?? Object.values(
      (await accountant.scan(options.projectDir)).categories,
    ).filter(({ reclaimable: canReclaim }) => canReclaim)
      .reduce((sum, category) => sum + category.bytes, 0);
    throw makeGuyditorError(
      "E_STORAGE_INSUFFICIENT",
      `${request.kind} needs ${String(estimate.bytes)} bytes plus ${String(Math.ceil(headroom))} bytes of headroom.`,
      {
        retry: "safe",
        suggestion: `Clean up to ${String(reclaimable)} bytes of disposable cache or choose another volume.`,
      },
    );
  };
}
