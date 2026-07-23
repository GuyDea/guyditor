import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import {
  JobQueue,
  makeGuyditorError,
  openProject,
  parseProjectYaml,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  JsonValue,
} from "../../core/src/index.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { createStoreZip, readStoreZip } from "./backup-zip.js";

export const DEFAULT_BACKUP_CONFIG_YAML = [
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
].join("\n");

export type BackupTargetKind = "local-path" | "rclone-remote";

export interface BackupTarget {
  name: string;
  kind: BackupTargetKind;
  path?: string;
  remote?: string;
  rcloneBinary?: string;
}

export interface BackupConfig {
  format: "guyditor-backup-config/v1";
  targets: BackupTarget[];
  schedule: {
    onAcceptedRevision: boolean;
    debounceMinutes: number;
    intervalHours: number;
    onQuit: boolean;
  };
  include: { renders: boolean; auditLogs: boolean; environment: boolean };
  retention: { keepLast: number; keepDaily: number; keepWeekly: number };
  verify: {
    afterEveryRun: boolean;
    mode: "sample" | "full";
    samplePercent: number;
    minSample: number;
    fullEveryDays: number;
  };
}

export type BackupManifestRole =
  | "master"
  | "sidecar"
  | "history"
  | "proposal"
  | "source"
  | "generated"
  | "preset"
  | "render"
  | "audit"
  | "environment"
  | "archive-manifest"
  | "config";

export interface BackupManifestEntry {
  path: string;
  originalPath?: string;
  role: BackupManifestRole;
  sha256: string;
  size: number;
  mtime: string;
}

export interface BackupManifest {
  format: "guyditor-backup/v1";
  backupId: string;
  projectId: string | null;
  projectRevision: string | null;
  createdAt: string;
  appVersion: string;
  toolVersions: Record<string, string>;
  target: { name: string; kind: BackupTargetKind };
  reason: "scheduled" | "manual" | "pre-migration" | "quit";
  entries: BackupManifestEntry[];
  stats: { files: number; bytes: number; newObjects: number; newBytes: number };
}

export interface VerificationReport {
  backupId: string;
  mode: "sample" | "full";
  seed: string;
  checked: number;
  totalEntries: number;
  failures: Array<{ path: string; expected: string; actual: string }>;
  completedAt: string;
}

export interface RestoreTestReport extends VerificationReport {
  validationErrors: string[];
  revisionChainOk: boolean;
}

export type EnvironmentEntryRole =
  | "skill"
  | "preset"
  | "brand"
  | "platform-profile"
  | "settings"
  | "adapter-config";

export interface EnvironmentBundleManifest {
  format: "guyditor-env/v1";
  bundleId: string;
  createdAt: string;
  appVersion: string;
  entries: Array<{
    path: string;
    sha256: string;
    size: number;
    role: EnvironmentEntryRole;
  }>;
  secretsExcluded: true;
  secretPlaceholders: Array<{ adapterId: string; credentialKeys: string[] }>;
}

export interface EnvironmentImportReport {
  importedRoles: EnvironmentEntryRole[];
  flaggedPathSettings: string[];
  secretPlaceholders: Array<{ adapterId: string; credentialKeys: string[] }>;
  backupDirectory?: string;
}

export interface BackupListEntry {
  backupId: string;
  manifest: BackupManifest;
  damaged: boolean;
}

interface BackupServiceOptions {
  appVersion: string;
  now?: () => Date;
  secretValues?: () => Promise<readonly string[]>;
  toolVersions?: Record<string, string>;
  userDirectory: string;
  rcloneRunner?: (binary: string, args: readonly string[]) => Promise<void>;
}

interface Candidate {
  sourcePath: string;
  backupPath: string;
  originalPath?: string;
  role: BackupManifestRole;
  expectedHash?: string;
  affectedAssetId?: string;
  content?: Buffer;
}

interface EnvironmentCandidate {
  sourcePath: string;
  path: string;
  role: EnvironmentEntryRole;
  content: Buffer;
}

interface RestoreOptions {
  userDirectory?: string;
}

interface RestoreTestOptions {
  knownProjectDirectory: string;
  scratchRoot?: string;
  keepScratch?: boolean;
}

interface BackupSchedulerOptions {
  debounceMilliseconds?: number;
  intervalMilliseconds?: number;
}

interface VerificationSampling {
  samplePercent: number;
  minSample: number;
}

interface LocatedManifest {
  root: string;
  path: string;
  manifest: BackupManifest;
}

const execFileAsync = promisify(execFile);

function backupId(): string {
  return `bak_${randomBytes(5).toString("hex")}`;
}

function environmentId(): string {
  return `env_${randomBytes(5).toString("hex")}`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function posixPath(value: string): string {
  return value.split(sep).join("/");
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function safeRelative(value: string): boolean {
  const resolved = resolve("/safe", value);
  return inside("/safe", resolved) && value !== "" && !isAbsolute(value);
}

async function walk(root: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
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

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicBuffer(path: string, content: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}-${randomBytes(4).toString("hex")}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicCopy(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${String(process.pid)}-${randomBytes(4).toString("hex")}`;
  try {
    await copyFile(source, temporary);
    const handle = await open(temporary, "r");
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function backupError(
  code: `E_${Uppercase<string>}`,
  message: string,
  options: { affected?: string[]; retry?: "safe" | "unsafe" | "none"; suggestion?: string } = {},
): ReturnType<typeof makeGuyditorError> {
  return makeGuyditorError(code, message, options);
}

function configFrom(value: unknown): BackupConfig {
  if (!isRecord(value) || value["format"] !== "guyditor-backup-config/v1" ||
      !Array.isArray(value["targets"]) || !isRecord(value["schedule"]) ||
      !isRecord(value["include"]) || !isRecord(value["retention"]) || !isRecord(value["verify"])) {
    throw backupError("E_BACKUP_CONFIG_INVALID", "backup.guyditor.yaml is not a v1 backup configuration.");
  }
  return value as unknown as BackupConfig;
}

function sortedJson(value: unknown): string {
  const sort = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(sort);
    if (!isRecord(current)) return current;
    return Object.fromEntries(Object.entries(current)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sort(child)]));
  };
  return `${JSON.stringify(sort(value))}\n`;
}

function sanitizeAdapterValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAdapterValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (/(?:secret|password|token|api.?key)/iu.test(key) && !/(?:ref|reference)$/iu.test(key)) return [];
    return [[key, sanitizeAdapterValue(child)]];
  }));
}

function credentialReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(credentialReferences);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    /(?:ref|reference)$/iu.test(key) && typeof child === "string"
      ? [child]
      : credentialReferences(child));
}

function absoluteSettingPointers(value: unknown, pointer = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((child, index) =>
    absoluteSettingPointers(child, `${pointer}/${String(index)}`));
  if (!isRecord(value)) return typeof value === "string" && isAbsolute(value) ? [pointer || "/"] : [];
  return Object.entries(value).flatMap(([key, child]) =>
    absoluteSettingPointers(child, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`));
}

function targetNeeds(target: BackupTarget): void {
  if (target.name.length === 0 ||
      target.kind === "local-path" && (target.path === undefined || !isAbsolute(target.path)) ||
      target.kind === "rclone-remote" && (target.remote === undefined || !target.remote.includes(":"))) {
    throw backupError("E_BACKUP_CONFIG_INVALID", `Backup target ${target.name || "<unnamed>"} is incomplete.`);
  }
}

async function projectDocument(projectDir: string): Promise<GuyditorProject> {
  const parsed = parseProjectYaml(await readFile(join(projectDir, "episode.guyditor.yaml"), "utf8"));
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

async function addTree(
  candidates: Map<string, Candidate>,
  projectDir: string,
  relativeRoot: string,
  role: BackupManifestRole,
): Promise<void> {
  for (const file of await walk(join(projectDir, relativeRoot))) {
    const backupPath = posixPath(relative(projectDir, file));
    candidates.set(backupPath, { sourcePath: file, backupPath, role });
  }
}

function roleForEnvironment(relativePath: string): EnvironmentEntryRole {
  if (relativePath === "settings.json") return "settings";
  if (relativePath.startsWith("adapters/")) return "adapter-config";
  if (relativePath.startsWith("profiles/")) return "platform-profile";
  if (relativePath.startsWith("skills/") && /brand/iu.test(relativePath)) return "brand";
  if (relativePath.startsWith("skills/")) return "skill";
  return "preset";
}

async function collectEnvironment(userDirectory: string): Promise<EnvironmentCandidate[]> {
  const relativeFiles = [
    ...(await walk(join(userDirectory, "skills"))).map((path) => posixPath(relative(userDirectory, path))),
    ...(await walk(join(userDirectory, "presets"))).map((path) => posixPath(relative(userDirectory, path))),
    ...(await walk(join(userDirectory, "templates"))).map((path) => posixPath(relative(userDirectory, path))),
    ...(await walk(join(userDirectory, "profiles"))).map((path) => posixPath(relative(userDirectory, path))),
    ...(await walk(join(userDirectory, "adapters"))).map((path) => posixPath(relative(userDirectory, path))),
  ];
  try {
    await access(join(userDirectory, "settings.json"));
    relativeFiles.push("settings.json");
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
  const unique = [...new Set(relativeFiles)].sort();
  return Promise.all(unique.map(async (path) => {
    const sourcePath = join(userDirectory, path);
    const raw = await readFile(sourcePath);
    const content = path.startsWith("adapters/") && path.endsWith(".json")
      ? Buffer.from(sortedJson(sanitizeAdapterValue(JSON.parse(raw.toString("utf8")) as unknown)))
      : raw;
    return { sourcePath, path, role: roleForEnvironment(path), content };
  }));
}

async function environmentPlaceholders(
  environment: readonly EnvironmentCandidate[],
): Promise<EnvironmentBundleManifest["secretPlaceholders"]> {
  const placeholders = new Map<string, Set<string>>();
  for (const entry of environment.filter(({ role }) => role === "adapter-config")) {
    const parsed = JSON.parse(entry.content.toString("utf8")) as unknown;
    if (!isRecord(parsed)) continue;
    const adapterId = typeof parsed["adapterId"] === "string"
      ? parsed["adapterId"]
      : entry.path.split("/")[1];
    if (adapterId === undefined) continue;
    const keys = credentialReferences(parsed);
    if (!placeholders.has(adapterId)) placeholders.set(adapterId, new Set());
    for (const key of keys) placeholders.get(adapterId)!.add(key);
  }
  return [...placeholders].map(([adapterId, keys]) => ({
    adapterId,
    credentialKeys: [...keys].sort(),
  })).sort((left, right) => left.adapterId.localeCompare(right.adapterId));
}

export class BackupService {
  readonly #appVersion: string;
  readonly #now: () => Date;
  readonly #rcloneRunner: (binary: string, args: readonly string[]) => Promise<void>;
  readonly #secretValues: () => Promise<readonly string[]>;
  readonly #toolVersions: Record<string, string>;
  readonly #userDirectory: string;

  public constructor(options: BackupServiceOptions) {
    this.#appVersion = options.appVersion;
    this.#now = options.now ?? (() => new Date());
    this.#secretValues = options.secretValues ?? (() => Promise.resolve([]));
    this.#toolVersions = structuredClone(options.toolVersions ?? {});
    this.#userDirectory = resolve(options.userDirectory);
    this.#rcloneRunner = options.rcloneRunner ?? (async (binary, args) => {
      await execFileAsync(binary, [...args], { windowsHide: true });
    });
  }

  public static async writeConfig(projectDir: string, config: BackupConfig): Promise<void> {
    await atomicBuffer(
      join(projectDir, "backup.guyditor.yaml"),
      stringifyYaml(config, { lineWidth: 0 }),
    );
  }

  public static async writeDefaultConfig(projectDir: string): Promise<void> {
    await atomicBuffer(join(projectDir, "backup.guyditor.yaml"), DEFAULT_BACKUP_CONFIG_YAML);
  }

  public async readConfig(projectDir: string): Promise<BackupConfig> {
    return configFrom(parseYaml(await readFile(join(projectDir, "backup.guyditor.yaml"), "utf8")) as unknown);
  }

  async #targetRoot(target: BackupTarget): Promise<string> {
    targetNeeds(target);
    return target.kind === "local-path"
      ? resolve(target.path!)
      : join(this.#userDirectory, "backup-staging", target.name);
  }

  async #probe(target: BackupTarget): Promise<string> {
    const root = await this.#targetRoot(target);
    try {
      await mkdir(root, { recursive: true });
      const probe = join(root, `.guyditor-probe-${randomBytes(4).toString("hex")}`);
      const expected = randomBytes(16);
      await writeFile(probe, expected);
      const actual = await readFile(probe);
      await unlink(probe);
      if (!actual.equals(expected)) throw new Error("probe read did not match write");
      return root;
    } catch (error: unknown) {
      throw backupError(
        "E_BACKUP_TARGET_UNAVAILABLE",
        `Backup target ${target.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { retry: "safe", suggestion: "Attach or mount the configured backup target and retry." },
      );
    }
  }

  async #collect(projectDir: string, config: BackupConfig): Promise<Candidate[]> {
    const root = resolve(projectDir);
    const project = await projectDocument(root);
    const candidates = new Map<string, Candidate>();
    candidates.set("episode.guyditor.yaml", {
      sourcePath: join(root, "episode.guyditor.yaml"),
      backupPath: "episode.guyditor.yaml",
      role: "master",
    });
    candidates.set("backup.guyditor.yaml", {
      sourcePath: join(root, "backup.guyditor.yaml"),
      backupPath: "backup.guyditor.yaml",
      role: "config",
    });
    await addTree(candidates, root, "sidecars", "sidecar");
    await addTree(candidates, root, "history", "history");
    await addTree(candidates, root, "proposals", "proposal");
    await addTree(candidates, root, "presets", "preset");
    await addTree(candidates, root, "skills", "preset");
    await addTree(candidates, root, "archive", "archive-manifest");

    for (const asset of project.assets) {
      const sourcePath = resolve(root, asset.path);
      let path = posixPath(relative(root, sourcePath));
      let originalPath: string | undefined;
      if (!inside(root, sourcePath)) {
        path = `ext/${asset.sha256.slice(0, 8)}/${basename(sourcePath)}`;
        originalPath = sourcePath;
      }
      candidates.set(path, {
        sourcePath,
        backupPath: path,
        ...(originalPath === undefined ? {} : { originalPath }),
        role: asset.kind === "generated" || inside(resolve(root, "media/generated"), sourcePath)
          ? "generated"
          : "source",
        expectedHash: asset.sha256,
        affectedAssetId: asset.id,
      });
    }
    if (config.include.renders) {
      await addTree(candidates, root, "exports", "render");
      await addTree(candidates, root, "renders", "render");
      await addTree(candidates, root, "upload-kits", "render");
    }
    if (config.include.environment) {
      for (const entry of await collectEnvironment(this.#userDirectory)) {
        candidates.set(`environment/${entry.path}`, {
          sourcePath: entry.sourcePath,
          backupPath: `environment/${entry.path}`,
          role: "environment",
          content: entry.content,
        });
      }
    }
    if (config.include.auditLogs) {
      for (const sourcePath of await walk(join(this.#userDirectory, "audit"))) {
        const path = `environment/${posixPath(relative(this.#userDirectory, sourcePath))}`;
        candidates.set(path, { sourcePath, backupPath: path, role: "audit" });
      }
    }
    return [...candidates.values()].sort((left, right) => left.backupPath.localeCompare(right.backupPath));
  }

  async #writeCandidateObject(
    backupRoot: string,
    candidate: Candidate,
    secrets: readonly string[],
  ): Promise<{ entry: BackupManifestEntry; isNew: boolean }> {
    const metadata = await stat(candidate.sourcePath);
    const content = candidate.content;
    const hash = content === undefined ? await hashFile(candidate.sourcePath) : hashBuffer(content);
    if (candidate.expectedHash !== undefined && hash !== candidate.expectedHash) {
      throw backupError(
        "E_BACKUP_VERIFY_MISMATCH",
        `Asset ${candidate.affectedAssetId ?? candidate.backupPath} changed after ingest.`,
        { affected: candidate.affectedAssetId === undefined ? [] : [candidate.affectedAssetId], retry: "none" },
      );
    }
    if (secrets.some((secret) => secret.length > 0 &&
        (content ?? Buffer.alloc(0)).includes(Buffer.from(secret)))) {
      throw backupError("E_BACKUP_SECRET_DETECTED", `Secret material was found in ${candidate.backupPath}.`);
    }
    const objectPath = join(backupRoot, "objects", hash.slice(0, 2), hash);
    let isNew = false;
    try {
      await access(objectPath);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      isNew = true;
      if (content === undefined) await atomicCopy(candidate.sourcePath, objectPath);
      else await atomicBuffer(objectPath, content);
    }
    if (secrets.length > 0 && content === undefined) {
      const source = await readFile(candidate.sourcePath);
      if (secrets.some((secret) => secret.length > 0 && source.includes(Buffer.from(secret)))) {
        if (isNew) await rm(objectPath, { force: true });
        throw backupError("E_BACKUP_SECRET_DETECTED", `Secret material was found in ${candidate.backupPath}.`);
      }
    }
    return {
      entry: {
        path: candidate.backupPath,
        ...(candidate.originalPath === undefined ? {} : { originalPath: candidate.originalPath }),
        role: candidate.role,
        sha256: hash,
        size: content?.length ?? metadata.size,
        mtime: metadata.mtime.toISOString(),
      },
      isNew,
    };
  }

  async #run(
    projectDir: string,
    targetName: string,
    reason: BackupManifest["reason"],
    performVerification: boolean,
  ): Promise<BackupManifest> {
    const config = await this.readConfig(projectDir);
    const target = config.targets.find(({ name }) => name === targetName);
    if (target === undefined) throw backupError("E_BACKUP_CONFIG_INVALID", `Target ${targetName} is not configured.`);
    const targetRoot = await this.#probe(target);
    const backupRoot = join(targetRoot, "guyditor-backup");
    const candidates = await this.#collect(projectDir, config);
    const secrets = await this.#secretValues();
    const written = [] as Array<{ entry: BackupManifestEntry; isNew: boolean }>;
    for (const candidate of candidates) {
      written.push(await this.#writeCandidateObject(backupRoot, candidate, secrets));
    }
    const project = await projectDocument(projectDir);
    const id = backupId();
    const entries = written.map(({ entry }) => entry);
    const manifest: BackupManifest = {
      format: "guyditor-backup/v1",
      backupId: id,
      projectId: project.project.id,
      projectRevision: project.revision,
      createdAt: this.#now().toISOString(),
      appVersion: this.#appVersion,
      toolVersions: structuredClone(this.#toolVersions),
      target: { name: target.name, kind: target.kind },
      reason,
      entries,
      stats: {
        files: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        newObjects: written.filter(({ isNew }) => isNew).length,
        newBytes: written.filter(({ isNew }) => isNew).reduce((sum, { entry }) => sum + entry.size, 0),
      },
    };
    const manifestPath = join(
      backupRoot,
      "projects",
      project.project.id,
      "runs",
      `${id}.manifest.json`,
    );
    await atomicBuffer(manifestPath, sortedJson(manifest));
    if (config.include.environment) {
      await atomicBuffer(join(backupRoot, "environment/runs", `${id}.manifest.json`), sortedJson(manifest));
    }
    if (target.kind === "rclone-remote") {
      await this.#rcloneRunner(target.rcloneBinary ?? "rclone", [
        "sync", targetRoot, target.remote!, "--checksum",
      ]);
    }
    if (performVerification && config.verify.afterEveryRun) {
      const mode = await this.#verificationMode(target, config.verify);
      await this.verify(target, id, mode, config.verify);
    }
    await this.#applyRetention(backupRoot, project.project.id, config.retention);
    return manifest;
  }

  public async run(
    projectDir: string,
    targetName: string,
    reason: BackupManifest["reason"],
  ): Promise<BackupManifest> {
    return this.#run(projectDir, targetName, reason, true);
  }

  async #verificationMode(
    target: BackupTarget,
    policy: BackupConfig["verify"],
  ): Promise<"sample" | "full"> {
    if (policy.mode === "full") return "full";
    const root = join(await this.#targetRoot(target), "guyditor-backup", "verification");
    const cutoff = this.#now().getTime() - Math.max(0, policy.fullEveryDays) * 86_400_000;
    for (const path of await walk(root)) {
      if (!path.endsWith(".full.report.json")) continue;
      try {
        const report = JSON.parse(await readFile(path, "utf8")) as VerificationReport;
        if (Date.parse(report.completedAt) >= cutoff && report.failures.length === 0) return "sample";
      } catch {
        // Invalid reports cannot prove that a recent full verification succeeded.
      }
    }
    return "full";
  }

  async #applyRetention(
    backupRoot: string,
    projectId: string,
    retention: BackupConfig["retention"],
  ): Promise<void> {
    const runsRoot = join(backupRoot, "projects", projectId, "runs");
    const paths = (await readdir(runsRoot)).filter((name) => name.endsWith(".manifest.json"));
    const records = await Promise.all(paths.map(async (name) => ({
      name,
      manifest: JSON.parse(await readFile(join(runsRoot, name), "utf8")) as BackupManifest,
    })));
    records.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
    const keep = new Set(records.slice(0, Math.max(1, retention.keepLast)).map(({ name }) => name));
    const daily = new Set<string>();
    const weekly = new Set<string>();
    for (const record of records) {
      const date = new Date(record.manifest.createdAt);
      const day = record.manifest.createdAt.slice(0, 10);
      if (daily.size < retention.keepDaily && !daily.has(day)) {
        daily.add(day);
        keep.add(record.name);
      }
      const weekStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      weekStart.setUTCDate(weekStart.getUTCDate() - (weekStart.getUTCDay() + 6) % 7);
      const week = weekStart.toISOString().slice(0, 10);
      if (weekly.size < retention.keepWeekly && !weekly.has(week)) {
        weekly.add(week);
        keep.add(record.name);
      }
    }
    for (const { name, manifest } of records) {
      if (keep.has(name)) continue;
      await rm(join(runsRoot, name), { force: true });
      await rm(join(runsRoot, `${name}.damaged`), { force: true });
      await rm(join(backupRoot, "environment/runs", `${manifest.backupId}.manifest.json`), { force: true });
    }
    const retained = await this.#allManifests(backupRoot);
    const referenced = new Set(retained.flatMap(({ entries }) => entries.map(({ sha256 }) => sha256)));
    for (const object of await walk(join(backupRoot, "objects"))) {
      if (!referenced.has(basename(object))) await rm(object, { force: true });
    }
  }

  async #allManifests(backupRoot: string): Promise<BackupManifest[]> {
    const paths = (await walk(join(backupRoot, "projects")))
      .filter((path) => path.endsWith(".manifest.json"));
    return Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as BackupManifest));
  }

  async #manifest(target: BackupTarget, id: string): Promise<LocatedManifest> {
    const targetRoot = await this.#targetRoot(target);
    const root = join(targetRoot, "guyditor-backup");
    const path = (await walk(join(root, "projects"))).find((candidate) =>
      candidate.endsWith(`/${id}.manifest.json`));
    if (path === undefined) throw backupError("E_BACKUP_NOT_FOUND", `Backup ${id} was not found.`);
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed["format"] !== "guyditor-backup/v1" || !Array.isArray(parsed["entries"])) {
      throw backupError("E_BACKUP_VERIFY_MISMATCH", `Backup manifest ${id} is invalid.`, { retry: "unsafe" });
    }
    return { root, path, manifest: parsed as unknown as BackupManifest };
  }

  public async verify(
    target: BackupTarget,
    id: string,
    mode: "sample" | "full",
    sampling: VerificationSampling = { samplePercent: 1, minSample: 20 },
  ): Promise<VerificationReport> {
    const located = await this.#manifest(target, id);
    if (target.kind === "rclone-remote") {
      const staging = await this.#targetRoot(target);
      await this.#rcloneRunner(target.rcloneBinary ?? "rclone", [
        "check", staging, target.remote!, "--checksum", "--one-way",
      ]);
    }
    const entries = located.manifest.entries;
    const seed = createHash("sha256").update(`${id}:${mode}`).digest("hex").slice(0, 16);
    let selected = entries;
    if (mode === "sample") {
      const desired = Math.min(entries.length, Math.max(
        sampling.minSample,
        Math.ceil(entries.length * sampling.samplePercent / 100),
      ));
      const forced = entries.filter((entry) =>
        entry.role === "master" || entry.role === "archive-manifest" ||
        entry.path === "history/transactions.jsonl" ||
        /history\/revisions\/rev_\d+\.yaml$/u.test(entry.path));
      const ranked = [...entries].sort((left, right) =>
        hashBuffer(Buffer.from(`${seed}:${left.path}`)).localeCompare(hashBuffer(Buffer.from(`${seed}:${right.path}`))));
      selected = [...new Map([...forced, ...ranked].map((entry) => [entry.path, entry])).values()]
        .slice(0, Math.max(desired, forced.length));
    }
    const failures: VerificationReport["failures"] = [];
    for (const entry of selected) {
      const objectPath = join(located.root, "objects", entry.sha256.slice(0, 2), entry.sha256);
      let actual = "missing";
      try {
        actual = await hashFile(objectPath);
      } catch (error: unknown) {
        if (!isMissing(error)) throw error;
      }
      if (actual !== entry.sha256) failures.push({ path: entry.path, expected: entry.sha256, actual });
    }
    const report: VerificationReport = {
      backupId: id,
      mode,
      seed,
      checked: selected.length,
      totalEntries: entries.length,
      failures,
      completedAt: this.#now().toISOString(),
    };
    await atomicBuffer(
      join(located.root, "verification", `${id}.${mode}.report.json`),
      sortedJson(report),
    );
    if (failures.length > 0) {
      await atomicBuffer(`${located.path}.damaged`, sortedJson(report));
      throw backupError(
        "E_BACKUP_VERIFY_MISMATCH",
        `Backup ${id} failed verification for ${String(failures.length)} entries.`,
        { affected: failures.map(({ path }) => path), retry: "unsafe" },
      );
    }
    await rm(`${located.path}.damaged`, { force: true });
    return report;
  }

  public async listBackups(target: BackupTarget): Promise<BackupListEntry[]> {
    const root = join(await this.#targetRoot(target), "guyditor-backup");
    const paths = (await walk(join(root, "projects")))
      .filter((path) => path.endsWith(".manifest.json"));
    const entries = await Promise.all(paths.map(async (path) => ({
      manifest: JSON.parse(await readFile(path, "utf8")) as BackupManifest,
      damaged: await access(`${path}.damaged`).then(() => true).catch(() => false),
    })));
    return entries.map(({ manifest, damaged }) => ({ backupId: manifest.backupId, manifest, damaged }))
      .sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
  }

  async #materialize(
    located: LocatedManifest,
    destination: string,
    userDirectory?: string,
  ): Promise<void> {
    for (const entry of located.manifest.entries) {
      let target: string | undefined;
      if (entry.path.startsWith("environment/")) {
        if (userDirectory === undefined) continue;
        const relativePath = entry.path.slice("environment/".length);
        if (!safeRelative(relativePath)) throw backupError("E_RESTORE_INTEGRITY_FAILED", `Unsafe environment path ${entry.path}.`);
        target = join(userDirectory, relativePath);
      } else if (entry.originalPath !== undefined && entry.role === "source") {
        target = join(destination, "restored-sources", basename(entry.path));
      } else {
        if (!safeRelative(entry.path)) throw backupError("E_RESTORE_INTEGRITY_FAILED", `Unsafe project path ${entry.path}.`);
        target = join(destination, entry.path);
      }
      const objectPath = join(located.root, "objects", entry.sha256.slice(0, 2), entry.sha256);
      await atomicCopy(objectPath, target);
      const actual = await hashFile(target);
      if (actual !== entry.sha256) {
        await rm(target, { force: true });
        throw backupError(
          "E_RESTORE_INTEGRITY_FAILED",
          `Restored entry ${entry.path} failed SHA-256 verification.`,
          { affected: [entry.path], retry: "unsafe" },
        );
      }
    }
  }

  async #validateRestore(destination: string, manifest: BackupManifest): Promise<{
    validationErrors: string[];
    revisionChainOk: boolean;
  }> {
    const validationErrors: string[] = [];
    const opened = await openProject(destination, { appVersion: this.#appVersion });
    if (!opened.ok) validationErrors.push(opened.error.message);
    let revisionChainOk = false;
    try {
      const head = (await readFile(join(destination, "history/HEAD"), "utf8")).trim();
      const journal = (await readFile(join(destination, "history/transactions.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { resultRevision?: string });
      revisionChainOk = head === manifest.projectRevision && journal.at(-1)?.resultRevision === head;
    } catch {
      revisionChainOk = false;
    }
    if (!revisionChainOk) validationErrors.push("Revision chain does not end at the manifest projectRevision.");
    return { validationErrors, revisionChainOk };
  }

  public async restore(
    target: BackupTarget,
    id: string,
    destination: string,
    options: RestoreOptions = {},
  ): Promise<RestoreTestReport> {
    const existing = await readdir(destination).catch((error: unknown) => {
      if (isMissing(error)) return [] as string[];
      throw error;
    });
    if (existing.length > 0) throw backupError("E_RESTORE_DESTINATION_NOT_EMPTY", "Restore destination must be empty.");
    await mkdir(destination, { recursive: true });
    try {
      const verification = await this.verify(target, id, "full");
      const located = await this.#manifest(target, id);
      await this.#materialize(located, destination, options.userDirectory);
      await Promise.all([
        "sidecars",
        "proposals",
        "history/revisions",
        "history/proposals",
        "media/generated",
        "media/pickups",
        "presets",
        "skills",
        ".guyditor/cache",
      ].map((relativePath) => mkdir(join(destination, relativePath), { recursive: true })));
      const validation = await this.#validateRestore(destination, located.manifest);
      if (validation.validationErrors.length > 0) {
        throw backupError(
          "E_RESTORE_INTEGRITY_FAILED",
          validation.validationErrors.join(" "),
          { retry: "unsafe" },
        );
      }
      return { ...verification, ...validation };
    } catch (error: unknown) {
      const quarantine = `${destination}.quarantine-${id}`;
      await rename(destination, quarantine).catch(() => undefined);
      throw error;
    }
  }

  public async restoreTest(
    target: BackupTarget,
    id: string,
    options: RestoreTestOptions,
  ): Promise<RestoreTestReport> {
    const scratchRoot = resolve(options.scratchRoot ?? join(tmpdir(), "guyditor-restore-test"));
    const projectRoot = resolve(options.knownProjectDirectory);
    if (inside(projectRoot, scratchRoot)) {
      throw backupError("E_RESTORE_PATH_REFUSED", "Restore-test scratch space must be outside the live project.");
    }
    const destination = join(scratchRoot, id);
    await rm(destination, { recursive: true, force: true });
    try {
      return await this.restore(target, id, destination);
    } finally {
      if (options.keepScratch !== true) await rm(destination, { recursive: true, force: true });
    }
  }

  public async exportEnvironment(destinationFile: string): Promise<string> {
    const environment = await collectEnvironment(this.#userDirectory);
    const entries = environment.map((entry) => ({
      path: entry.path,
      sha256: hashBuffer(entry.content),
      size: entry.content.length,
      role: entry.role,
    }));
    const manifest: EnvironmentBundleManifest = {
      format: "guyditor-env/v1",
      bundleId: environmentId(),
      createdAt: this.#now().toISOString(),
      appVersion: this.#appVersion,
      entries,
      secretsExcluded: true,
      secretPlaceholders: await environmentPlaceholders(environment),
    };
    const archive = createStoreZip([
      { name: "manifest.json", data: Buffer.from(sortedJson(manifest)) },
      ...environment.map((entry) => ({ name: entry.path, data: entry.content })),
    ]);
    await atomicBuffer(destinationFile, archive);
    return destinationFile;
  }

  public async importEnvironment(
    bundleFile: string,
    destinationUserDirectory: string,
  ): Promise<EnvironmentImportReport> {
    let archive: Map<string, Buffer>;
    try {
      archive = readStoreZip(await readFile(bundleFile));
    } catch (error: unknown) {
      throw backupError("E_ENV_BUNDLE_INVALID", error instanceof Error ? error.message : String(error));
    }
    const manifestBytes = archive.get("manifest.json");
    const parsed = manifestBytes === undefined ? undefined : JSON.parse(manifestBytes.toString("utf8")) as unknown;
    if (!isRecord(parsed) || parsed["format"] !== "guyditor-env/v1" ||
        parsed["secretsExcluded"] !== true || !Array.isArray(parsed["entries"]) ||
        !Array.isArray(parsed["secretPlaceholders"])) {
      throw backupError("E_ENV_BUNDLE_INVALID", "Environment bundle manifest is invalid or permits secrets.");
    }
    const manifest = parsed as unknown as EnvironmentBundleManifest;
    for (const entry of manifest.entries) {
      const content = archive.get(entry.path);
      if (content === undefined || hashBuffer(content) !== entry.sha256 || content.length !== entry.size ||
          !safeRelative(entry.path)) {
        throw backupError("E_ENV_BUNDLE_INVALID", `Environment entry ${entry.path} failed integrity validation.`);
      }
    }
    const destination = resolve(destinationUserDirectory);
    const preImport = join(destination, `pre-import-${this.#now().toISOString().replaceAll(":", "-")}`);
    let backedUp = false;
    for (const entry of manifest.entries) {
      const target = join(destination, entry.path);
      try {
        await access(target);
        await atomicCopy(target, join(preImport, entry.path));
        backedUp = true;
      } catch (error: unknown) {
        if (!isMissing(error)) throw error;
      }
      await atomicBuffer(target, archive.get(entry.path)!);
    }
    const settings = manifest.entries.find(({ role }) => role === "settings");
    const flaggedPathSettings = settings === undefined
      ? []
      : absoluteSettingPointers(JSON.parse(archive.get(settings.path)!.toString("utf8")) as unknown);
    const importedRoles = new Set(manifest.entries.map(({ role }) => role));
    if (importedRoles.has("brand")) importedRoles.add("skill");
    return {
      importedRoles: [...importedRoles].sort(),
      flaggedPathSettings,
      secretPlaceholders: structuredClone(manifest.secretPlaceholders),
      ...(backedUp ? { backupDirectory: preImport } : {}),
    };
  }

  public registerJobExecutors(queue: JobQueue): void {
    queue.registerExecutor("backup.run", async (job) => {
      if (!isRecord(job.payload) || typeof job.payload["projectDir"] !== "string" ||
          typeof job.payload["targetName"] !== "string" ||
          (job.payload["reason"] !== "scheduled" && job.payload["reason"] !== "manual" &&
           job.payload["reason"] !== "pre-migration" && job.payload["reason"] !== "quit")) {
        throw backupError("E_BACKUP_CONFIG_INVALID", `Backup job ${job.jobId} has invalid payload.`);
      }
      const manifest = await this.#run(
        job.payload["projectDir"],
        job.payload["targetName"],
        job.payload["reason"],
        false,
      );
      return JSON.parse(JSON.stringify(manifest)) as JsonValue;
    });
    queue.registerExecutor("backup.verify", async (job) => {
      if (!isRecord(job.payload) || typeof job.payload["projectDir"] !== "string" ||
          typeof job.payload["targetName"] !== "string" ||
          typeof job.payload["runJobId"] !== "string" ||
          (job.payload["mode"] !== "sample" && job.payload["mode"] !== "full")) {
        throw backupError("E_BACKUP_CONFIG_INVALID", `Backup verification job ${job.jobId} has invalid payload.`);
      }
      const projectDir = job.payload["projectDir"];
      const targetName = job.payload["targetName"];
      const runJobId = job.payload["runJobId"];
      const mode = job.payload["mode"];
      const dependency = queue.get(runJobId);
      if (dependency === undefined || !isRecord(dependency.payload) ||
          typeof dependency.payload["backupId"] !== "string") {
        throw backupError("E_BACKUP_NOT_FOUND", `Backup result for ${runJobId} was not found.`);
      }
      const config = await this.readConfig(projectDir);
      const target = config.targets.find(({ name }) => name === targetName);
      if (target === undefined) {
        throw backupError("E_BACKUP_CONFIG_INVALID", `Target ${targetName} is not configured.`);
      }
      const report = await this.verify(
        target,
        dependency.payload["backupId"],
        mode,
        config.verify,
      );
      return JSON.parse(JSON.stringify(report)) as JsonValue;
    });
  }

  public async schedule(
    projectDir: string,
    queue: JobQueue,
    reason: "scheduled" | "quit",
  ): Promise<Array<{ jobId: string; verificationJobId?: string }>> {
    const config = await this.readConfig(projectDir);
    return Promise.all(config.targets.map(async (target) => {
      const existing = queue.list({ kind: "backup.run", state: ["queued", "running"] })
        .find((job) => isRecord(job.payload) &&
          job.payload["projectDir"] === projectDir && job.payload["targetName"] === target.name);
      const run = existing ?? queue.enqueue({
        kind: "backup.run",
        title: `Back up to ${target.name}`,
        payload: { projectDir, targetName: target.name, reason },
        cancellable: true,
      });
      if (!config.verify.afterEveryRun) return { jobId: run.jobId };
      const existingVerification = queue.list({ kind: "backup.verify", state: ["queued", "running"] })
        .find((job) => isRecord(job.payload) && job.payload["runJobId"] === run.jobId);
      const verification = existingVerification ?? queue.enqueue({
        kind: "backup.verify",
        title: `Verify backup on ${target.name}`,
        payload: {
          projectDir,
          targetName: target.name,
          runJobId: run.jobId,
          mode: await this.#verificationMode(target, config.verify),
        },
        cancellable: true,
        dependsOn: [run.jobId],
      });
      return { jobId: run.jobId, verificationJobId: verification.jobId };
    }));
  }

  public async createScheduler(
    projectDir: string,
    queue: JobQueue,
    options: BackupSchedulerOptions = {},
  ): Promise<BackupScheduler> {
    const config = await this.readConfig(projectDir);
    return new BackupScheduler(this, resolve(projectDir), queue, config, options);
  }
}

export class BackupScheduler {
  readonly #config: BackupConfig;
  readonly #debounceMilliseconds: number;
  readonly #intervalMilliseconds: number;
  readonly #projectDir: string;
  readonly #queue: JobQueue;
  readonly #service: BackupService;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;

  public constructor(
    service: BackupService,
    projectDir: string,
    queue: JobQueue,
    config: BackupConfig,
    options: BackupSchedulerOptions,
  ) {
    this.#service = service;
    this.#projectDir = projectDir;
    this.#queue = queue;
    this.#config = config;
    this.#debounceMilliseconds = options.debounceMilliseconds ?? config.schedule.debounceMinutes * 60_000;
    this.#intervalMilliseconds = options.intervalMilliseconds ?? config.schedule.intervalHours * 3_600_000;
    if (this.#intervalMilliseconds > 0) {
      this.#interval = setInterval(() => {
        void this.#service.schedule(this.#projectDir, this.#queue, "scheduled");
      }, this.#intervalMilliseconds);
      if (typeof this.#interval === "object" && "unref" in this.#interval) this.#interval.unref();
    }
  }

  public acceptedRevision(): void {
    if (!this.#config.schedule.onAcceptedRevision) return;
    if (this.#debounce !== undefined) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = undefined;
      void this.#service.schedule(this.#projectDir, this.#queue, "scheduled");
    }, Math.max(0, this.#debounceMilliseconds));
    if (typeof this.#debounce === "object" && "unref" in this.#debounce) this.#debounce.unref();
  }

  public async quit(): Promise<void> {
    if (!this.#config.schedule.onQuit) return;
    const jobs = await this.#service.schedule(this.#projectDir, this.#queue, "quit");
    await Promise.all(jobs.map(async ({ jobId, verificationJobId }) => {
      const completionJobId = verificationJobId ?? jobId;
      for (let attempt = 0; attempt < 6_000; attempt += 1) {
        const job = this.#queue.get(completionJobId);
        if (job?.state === "done") return;
        if (job?.state === "failed" || job?.state === "cancelled") {
          throw job.error ?? new Error(`Quit backup ${completionJobId} did not complete.`);
        }
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      throw new Error(`Quit backup ${completionJobId} timed out.`);
    }));
  }

  public close(): void {
    if (this.#debounce !== undefined) clearTimeout(this.#debounce);
    if (this.#interval !== undefined) clearInterval(this.#interval);
    this.#debounce = undefined;
    this.#interval = undefined;
  }
}
