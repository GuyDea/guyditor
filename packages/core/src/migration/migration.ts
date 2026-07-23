import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { makeGuyditorError } from "../errors.js";
import { JobQueue } from "../jobs/queue.js";
import type { JobRef } from "./types.js";
import {
  canonicalizeYaml,
  formatRevision,
  makeId,
  parseRevision,
} from "../project/index.js";
import type { GuyditorProject, SidecarRef } from "../project/index.js";
import type { RevisionLock, TransactionRecord } from "../store/types.js";

export type ProjectDocument = Omit<GuyditorProject, "format"> & { format: string };

export interface MigrationContext {
  projectDir: string;
  readSidecar(relPath: string): Promise<unknown>;
  log(message: string): void;
}

export interface MigrationDiffEntry {
  kind: "structural" | "semantic";
  target: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  step?: { from: string; to: string };
}

export interface MigrationStepResult {
  document: ProjectDocument;
  sidecarWrites: Array<{ path: string; content: unknown; schema: string }>;
  diff: MigrationDiffEntry[];
}

export interface SchemaMigrator {
  from: string;
  to: string;
  describe(): string;
  migrate(document: ProjectDocument, context: MigrationContext): Promise<MigrationStepResult>;
}

export interface MigrationPlan {
  migrationId: string;
  fromFormat: string;
  toFormat: string;
  chain: Array<{ from: string; to: string; description: string }>;
  diff: MigrationDiffEntry[];
  semanticChangeCount: number;
}

export interface MigrationBackup {
  runPreMigration(projectDir: string): Promise<{ backupId: string; verified: boolean }>;
}

interface MigrationRegistryOptions {
  backup: MigrationBackup;
  jobQueue: JobQueue;
  now?: () => Date;
  appVersion?: string;
}

interface PreparedMigration {
  plan: MigrationPlan;
  original: ProjectDocument;
  result: MigrationStepResult;
  logs: string[];
}

type FormatValidator = (document: ProjectDocument) => string[];

export const GUYDITOR_V2_MIGRATION_PATH = Object.freeze({
  from: "guyditor/v1",
  to: "guyditor/v2",
});

function migrationError(
  code: `E_${Uppercase<string>}`,
  message: string,
  options: { affected?: string[]; retry?: "safe" | "unsafe" | "none"; suggestion?: string } = {},
): ReturnType<typeof makeGuyditorError> {
  return makeGuyditorError(code, message, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatVersion(format: string): number | undefined {
  const match = /^guyditor\/v(\d+)$/u.exec(format);
  return match === null ? undefined : Number(match[1]);
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function migrationId(): string {
  return `mig_${randomBytes(5).toString("hex")}`;
}

function canonicalJson(value: unknown): string {
  const sorted = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(sorted);
    if (!isRecord(current)) return current;
    return Object.fromEntries(Object.entries(current)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sorted(child)]));
  };
  return JSON.stringify(sorted(value));
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

function projectFrom(value: unknown): ProjectDocument {
  if (!isRecord(value) || typeof value["format"] !== "string" ||
      typeof value["revision"] !== "string" || !isRecord(value["project"]) ||
      !Array.isArray(value["assets"]) || !Array.isArray(value["sidecars"])) {
    throw migrationError("E_MIGRATION_PROJECT_INVALID", "Project master is not migration-compatible.");
  }
  return value as unknown as ProjectDocument;
}

function sidecarContent(path: string, content: unknown): string {
  return path.endsWith(".json") || path.endsWith(".jsonl")
    ? `${canonicalJson(content)}\n`
    : stringifyYaml(content, { lineWidth: 0, sortMapEntries: true });
}

function sidecarWithHash(
  sidecar: SidecarRef,
  writes: Map<string, { content: string; schema: string }>,
): SidecarRef {
  const write = writes.get(sidecar.path);
  return write === undefined ? structuredClone(sidecar) : {
    ...structuredClone(sidecar),
    schema: write.schema,
    sha256: createHash("sha256").update(write.content).digest("hex"),
  };
}

function revisionLock(
  document: ProjectDocument,
  master: string,
  appVersion: string,
): RevisionLock {
  const profiles = new Map(document.deliverables.map(({ profile }) => {
    const separator = profile.lastIndexOf("@");
    const id = separator < 0 ? profile : profile.slice(0, separator);
    const version = separator < 0 ? "unversioned" : profile.slice(separator + 1);
    return [`${id}@${version}`, { id, version }] as const;
  }));
  return {
    revision: document.revision,
    masterSha256: createHash("sha256").update(master).digest("hex"),
    assets: document.assets.map(({ id, path, sha256 }) => ({ id, path, sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    sidecars: document.sidecars.map(({ name, schema, sha256 }) => ({ name, schema, sha256 }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    presets: document.presets.map(({ id, version, sha256 }) => ({ id, version, sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    skills: document.skills.map(({ id, version, contentHash }) => ({ id, version, contentHash }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    profiles: [...profiles.values()].sort((left, right) => left.id.localeCompare(right.id)),
    templates: Object.entries(document.templates ?? {}).map(([id, value]) => ({ id, ...value }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tools: [{ name: "guyditor", version: appVersion }],
  };
}

function transaction(
  before: ProjectDocument,
  after: ProjectDocument,
  plan: MigrationPlan,
  now: string,
  appVersion: string,
): TransactionRecord {
  return {
    id: makeId("txn"),
    baseRevision: before.revision,
    resultRevision: after.revision,
    operations: [{
      op: "project.migrate",
      params: {
        migrationId: plan.migrationId,
        fromFormat: plan.fromFormat,
        toFormat: plan.toFormat,
        semanticChangeCount: plan.semanticChangeCount,
        diff: structuredClone(plan.diff),
      },
      summary: `Migrate project ${plan.fromFormat} to ${plan.toFormat}`,
      inverse: {
        op: "project.restore",
        params: { targetRevision: before.revision },
      },
    }],
    instruction: { kind: "ui-direct", text: "Confirmed schema migration" },
    actor: { kind: "tool", id: "migration" },
    versions: {
      app: appVersion,
      schema: plan.toFormat,
      skills: after.skills.map(({ id, version }) => ({ id, version })),
      presets: after.presets.map(({ id, version }) => ({ id, version })),
      tools: [{ name: "guyditor", version: appVersion }],
    },
    acceptance: { status: "accepted", by: "ui", at: now },
    reason: `Reviewed ${String(plan.diff.length)} migration changes`,
    orphanedAnchors: [],
    addresses: [],
  };
}

export class MigrationRegistry {
  readonly #appVersion: string;
  readonly #backup: MigrationBackup;
  readonly #jobQueue: JobQueue;
  readonly #migrators = new Map<string, SchemaMigrator>();
  readonly #now: () => Date;
  readonly #prepared = new Map<string, PreparedMigration>();
  readonly #validators = new Map<string, FormatValidator>();

  public constructor(options: MigrationRegistryOptions) {
    this.#appVersion = options.appVersion ?? "0.0.0";
    this.#backup = options.backup;
    this.#jobQueue = options.jobQueue;
    this.#now = options.now ?? (() => new Date());
    this.#jobQueue.registerExecutor("migration.apply", async (job) => {
      if (!isRecord(job.payload) || typeof job.payload["migrationId"] !== "string" ||
          typeof job.payload["projectDir"] !== "string") {
        throw migrationError("E_MIGRATION_PLAN_INVALID", `Migration job ${job.jobId} is malformed.`);
      }
      const prepared = this.#prepared.get(job.payload["migrationId"]);
      if (prepared === undefined) {
        throw migrationError("E_MIGRATION_PLAN_INVALID", `Migration ${job.payload["migrationId"]} is no longer prepared.`);
      }
      await this.#applyPrepared(job.payload["projectDir"], prepared);
      return { migrationId: prepared.plan.migrationId, toFormat: prepared.plan.toFormat };
    });
  }

  public register(migrator: SchemaMigrator): void {
    const from = formatVersion(migrator.from);
    const to = formatVersion(migrator.to);
    if (from === undefined || to === undefined || to !== from + 1) {
      throw new TypeError(`Migration ${migrator.from} to ${migrator.to} must cover adjacent guyditor versions.`);
    }
    if (this.#migrators.has(migrator.from)) {
      throw new Error(`A migration from ${migrator.from} is already registered.`);
    }
    this.#migrators.set(migrator.from, migrator);
  }

  public registerValidator(format: string, validator: FormatValidator): void {
    this.#validators.set(format, validator);
  }

  public async plan(projectDir: string, targetFormat: string): Promise<MigrationPlan> {
    const root = resolve(projectDir);
    let document = projectFrom(parseYaml(await readFile(join(root, "episode.guyditor.yaml"), "utf8")) as unknown);
    const original = structuredClone(document);
    const chain: MigrationPlan["chain"] = [];
    const diff: MigrationDiffEntry[] = [];
    const writes = new Map<string, MigrationStepResult["sidecarWrites"][number]>();
    const logs: string[] = [];
    const context: MigrationContext = {
      projectDir: root,
      async readSidecar(relPath) {
        const path = resolve(root, relPath);
        if (!inside(root, path)) throw migrationError("E_MIGRATION_SIDECAR_PATH", `Sidecar path ${relPath} escapes the project.`);
        const source = await readFile(path, "utf8");
        return relPath.endsWith(".json") ? JSON.parse(source) as unknown : parseYaml(source) as unknown;
      },
      log(message) {
        logs.push(message);
      },
    };
    while (document.format !== targetFormat) {
      const migrator = this.#migrators.get(document.format);
      if (migrator === undefined) {
        throw migrationError(
          "E_MIGRATION_PATH_MISSING",
          `No adjacent migration step is registered from ${document.format} toward ${targetFormat}.`,
        );
      }
      const before = canonicalJson(document);
      const result = await migrator.migrate(structuredClone(document), context);
      if (result.document.format !== migrator.to) {
        throw migrationError("E_MIGRATION_STEP_INVALID", `${migrator.from} migrator did not produce ${migrator.to}.`);
      }
      const changed = canonicalJson(result.document) !== before || result.sidecarWrites.length > 0;
      if (changed && result.diff.length === 0) {
        throw migrationError(
          "E_MIGRATION_UNDECLARED_CHANGE",
          `${migrator.from} to ${migrator.to} changed content without a classified diff.`,
        );
      }
      for (const entry of result.diff) {
        if (entry.summary.trim().length === 0 || entry.target.trim().length === 0) {
          throw migrationError("E_MIGRATION_DIFF_INVALID", `${migrator.from} to ${migrator.to} has an unreadable diff entry.`);
        }
        diff.push({ ...structuredClone(entry), step: { from: migrator.from, to: migrator.to } });
      }
      for (const write of result.sidecarWrites) writes.set(write.path, structuredClone(write));
      chain.push({ from: migrator.from, to: migrator.to, description: migrator.describe() });
      document = structuredClone(result.document);
      const current = formatVersion(document.format);
      const target = formatVersion(targetFormat);
      if (current === undefined || target === undefined || current > target) {
        throw migrationError("E_MIGRATION_PATH_INVALID", `Migration chain passed target ${targetFormat}.`);
      }
    }
    const plan: MigrationPlan = {
      migrationId: migrationId(),
      fromFormat: original.format,
      toFormat: targetFormat,
      chain,
      diff,
      semanticChangeCount: diff.filter(({ kind }) => kind === "semantic").length,
    };
    this.#prepared.set(plan.migrationId, {
      plan: structuredClone(plan),
      original,
      result: { document, sidecarWrites: [...writes.values()], diff },
      logs,
    });
    return structuredClone(plan);
  }

  public async apply(
    projectDir: string,
    plan: MigrationPlan,
    confirmations: { acknowledgedSemanticTargets: string[] },
  ): Promise<JobRef> {
    const prepared = this.#prepared.get(plan.migrationId);
    if (prepared === undefined || canonicalJson(prepared.plan) !== canonicalJson(plan) ||
        resolve(projectDir) === "") {
      throw migrationError("E_MIGRATION_PLAN_INVALID", `Migration plan ${plan.migrationId} is unknown or changed.`);
    }
    const acknowledged = new Set(confirmations.acknowledgedSemanticTargets);
    const missing = plan.diff.filter(({ kind, target }) => kind === "semantic" && !acknowledged.has(target))
      .map(({ target }) => target);
    if (missing.length > 0) {
      throw migrationError(
        "E_MIGRATION_SEMANTIC_UNCONFIRMED",
        `Semantic migration changes need confirmation: ${missing.join(", ")}.`,
        { affected: missing, retry: "none" },
      );
    }
    const job = this.#jobQueue.enqueue({
      kind: "migration.apply",
      title: `Migrate ${plan.fromFormat} to ${plan.toFormat}`,
      payload: { migrationId: plan.migrationId, projectDir: resolve(projectDir) },
      cancellable: false,
    });
    return { jobId: job.jobId };
  }

  async #applyPrepared(projectDir: string, prepared: PreparedMigration): Promise<void> {
    let backup;
    try {
      backup = await this.#backup.runPreMigration(projectDir);
    } catch (error: unknown) {
      throw migrationError(
        "E_MIGRATION_BACKUP_MISSING",
        `Pre-migration backup failed: ${error instanceof Error ? error.message : String(error)}`,
        { retry: "safe", suggestion: "Configure an available backup target and retry." },
      );
    }
    if (!backup.verified) {
      throw migrationError(
        "E_MIGRATION_BACKUP_MISSING",
        `Pre-migration backup ${backup.backupId} was not verified.`,
        { retry: "safe", suggestion: "Repair the backup target and run verification before migrating." },
      );
    }
    const now = this.#now().toISOString();
    const snapshotName = `${prepared.plan.fromFormat}-to-${prepared.plan.toFormat}-${now}`
      .replaceAll("/", "-").replaceAll(":", "-");
    const snapshot = join(projectDir, "history/pre-migration", snapshotName);
    const masterPath = join(projectDir, "episode.guyditor.yaml");
    const sidecarsPath = join(projectDir, "sidecars");
    const headPath = join(projectDir, "history/HEAD");
    const journalPath = join(projectDir, "history/transactions.jsonl");
    const [originalMaster, originalHead, originalJournal] = await Promise.all([
      readFile(masterPath, "utf8"),
      readFile(headPath, "utf8"),
      readFile(journalPath, "utf8"),
    ]);
    await mkdir(snapshot, { recursive: true });
    await atomicWrite(join(snapshot, "episode.guyditor.yaml"), originalMaster);
    await cp(sidecarsPath, join(snapshot, "sidecars"), { recursive: true });
    const resultRevision = formatRevision(parseRevision(prepared.original.revision) + 1);
    const writes = new Map(prepared.result.sidecarWrites.map((write) => [write.path, {
      content: sidecarContent(write.path, write.content),
      schema: write.schema,
    }]));
    const document: ProjectDocument = {
      ...structuredClone(prepared.result.document),
      revision: resultRevision,
      sidecars: prepared.result.document.sidecars.map((sidecar) => sidecarWithHash(sidecar, writes)),
    };
    const validator = this.#validators.get(document.format);
    if (validator === undefined) {
      throw migrationError("E_MIGRATION_VALIDATOR_MISSING", `No validator is registered for ${document.format}.`);
    }
    const validationErrors = validator(document);
    if (validationErrors.length > 0) {
      throw migrationError("E_MIGRATION_VALIDATION_FAILED", validationErrors.join(" "), { retry: "unsafe" });
    }
    const master = canonicalizeYaml(document as GuyditorProject);
    const revisionPath = join(projectDir, "history/revisions", `${resultRevision}.yaml`);
    const lockPath = join(projectDir, "history/revisions", `${resultRevision}.lock.json`);
    try {
      for (const [path, write] of writes) await atomicWrite(join(projectDir, path), write.content);
      await atomicWrite(masterPath, master);
      await atomicWrite(revisionPath, master);
      for (const sidecar of document.sidecars) {
        const source = join(projectDir, sidecar.path);
        const destination = join(
          projectDir,
          "history/revisions",
          `${resultRevision}.sidecars`,
          sidecar.path.slice("sidecars/".length),
        );
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination);
      }
      await atomicWrite(lockPath, `${canonicalJson(revisionLock(document, master, this.#appVersion))}\n`);
      await appendFile(
        journalPath,
        `${canonicalJson(transaction(prepared.original, document, prepared.plan, now, this.#appVersion))}\n`,
        "utf8",
      );
      await atomicWrite(headPath, `${resultRevision}\n`);
    } catch (error: unknown) {
      await atomicWrite(masterPath, originalMaster).catch(() => undefined);
      await rm(sidecarsPath, { recursive: true, force: true }).catch(() => undefined);
      await cp(join(snapshot, "sidecars"), sidecarsPath, { recursive: true }).catch(() => undefined);
      await atomicWrite(headPath, originalHead).catch(() => undefined);
      await atomicWrite(journalPath, originalJournal).catch(() => undefined);
      await rm(revisionPath, { force: true }).catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
      await rm(join(projectDir, "history/revisions", `${resultRevision}.sidecars`), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      throw error;
    }
  }
}
