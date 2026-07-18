import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import {
  canonicalizeYaml,
  parseProjectYaml,
  parseRevision,
  validateProject,
} from "../project/index.js";
import type { GuyditorProject } from "../project/index.js";
import type { RevisionLock, TransactionRecord } from "./types.js";

const MASTER_FILE = "episode.guyditor.yaml";
const GITIGNORE = ".guyditor/\nproposals/*/previews/\nmedia/\n";
const SKELETON_DIRECTORIES = [
  "sidecars",
  "proposals",
  "history/revisions",
  "history/proposals",
  "media/generated",
  "presets",
  "skills",
  ".guyditor/cache",
] as const;

let temporaryOrdinal = 0;

export interface ProjectStoreOptions {
  appVersion?: string;
}

function storeFailure(code: `E_${Uppercase<string>}`, message: string) {
  return failure(makeGuyditorError(code, message));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortedJsonValue(child)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  temporaryOrdinal += 1;
  const temporary = `${path}.tmp-${String(process.pid)}-${String(temporaryOrdinal)}`;
  const handle = await open(temporary, "wx");
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function appendDurably(path: string, content: string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function profilePin(profile: string): { id: string; version: string } {
  const separator = profile.lastIndexOf("@");
  return separator === -1
    ? { id: profile, version: "unversioned" }
    : { id: profile.slice(0, separator), version: profile.slice(separator + 1) };
}

function revisionLock(
  project: GuyditorProject,
  canonicalMaster: string,
  appVersion: string,
): RevisionLock {
  const profiles = new Map(
    project.deliverables.map((deliverable) => {
      const pin = profilePin(deliverable.profile);
      return [`${pin.id}@${pin.version}`, pin] as const;
    }),
  );
  return {
    revision: project.revision,
    masterSha256: createHash("sha256").update(canonicalMaster).digest("hex"),
    assets: project.assets
      .map(({ id, path, sha256 }) => ({ id, path, sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    sidecars: project.sidecars
      .map(({ name, schema, sha256 }) => ({ name, schema, sha256 }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    presets: project.presets
      .map(({ id, version, sha256 }) => ({ id, version, sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    skills: project.skills
      .map(({ id, version, contentHash }) => ({ id, version, contentHash }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    profiles: [...profiles.values()].sort((left, right) => left.id.localeCompare(right.id)),
    tools: [{ name: "guyditor", version: appVersion }],
  };
}

function snapshotPath(root: string, revision: string): string {
  return join(root, "history/revisions", `${revision}.yaml`);
}

function lockPath(root: string, revision: string): string {
  return join(root, "history/revisions", `${revision}.lock.json`);
}

async function writeRevisionArtifacts(
  root: string,
  project: GuyditorProject,
  canonicalMaster: string,
  appVersion: string,
): Promise<void> {
  await atomicWrite(snapshotPath(root, project.revision), canonicalMaster);
  const lock = revisionLock(project, canonicalMaster, appVersion);
  await atomicWrite(lockPath(root, project.revision), `${canonicalJson(lock)}\n`);
}

function parseJournal(text: string): Result<TransactionRecord[]> {
  const records: TransactionRecord[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      return storeFailure(
        "E_PROJECT_JOURNAL",
        `Transaction journal line ${String(index + 1)} is invalid JSON: ${errorMessage(error)}`,
      );
    }
    if (
      typeof parsed !== "object" || parsed === null ||
      !("baseRevision" in parsed) || typeof parsed.baseRevision !== "string" ||
      !("resultRevision" in parsed) || typeof parsed.resultRevision !== "string"
    ) {
      return storeFailure(
        "E_PROJECT_JOURNAL",
        `Transaction journal line ${String(index + 1)} is not a TransactionRecord.`,
      );
    }
    records.push(parsed as TransactionRecord);
  }
  return success(records);
}

async function readHead(root: string): Promise<string> {
  return (await readFile(join(root, "history/HEAD"), "utf8")).trim();
}

export class ProjectStore {
  readonly #root: string;
  readonly #appVersion: string;
  #project: GuyditorProject;
  #head: string;

  public constructor(
    root: string,
    project: GuyditorProject,
    options: ProjectStoreOptions = {},
  ) {
    this.#root = root;
    this.#project = project;
    this.#head = project.revision;
    this.#appVersion = options.appVersion ?? "0.0.0";
  }

  public get currentProject(): GuyditorProject {
    return this.#project;
  }

  public get head(): string {
    return this.#head;
  }

  public async commit(
    model: GuyditorProject,
    transaction: TransactionRecord,
  ): Promise<Result<GuyditorProject>> {
    try {
      const diskHead = await readHead(this.#root);
      if (
        transaction.baseRevision !== diskHead ||
        transaction.baseRevision !== this.#head
      ) {
        return storeFailure(
          "E_OP_STALE_BASE",
          `Transaction base ${transaction.baseRevision} does not match history/HEAD ${diskHead}.`,
        );
      }
      if (
        transaction.resultRevision !== model.revision ||
        parseRevision(transaction.resultRevision) !== parseRevision(transaction.baseRevision) + 1
      ) {
        return storeFailure(
          "E_PROJECT_COMMIT",
          "Transaction result revision must match the model and increment the base by one.",
        );
      }
      const valid = validateProject(model);
      if (!valid.ok) return valid;

      const canonicalMaster = canonicalizeYaml(model);
      await atomicWrite(join(this.#root, MASTER_FILE), canonicalMaster);
      await writeRevisionArtifacts(
        this.#root,
        model,
        canonicalMaster,
        this.#appVersion,
      );
      await appendDurably(
        join(this.#root, "history/transactions.jsonl"),
        `${canonicalJson(transaction)}\n`,
      );
      await atomicWrite(join(this.#root, "history/HEAD"), `${model.revision}\n`);

      this.#project = model;
      this.#head = model.revision;
      return success(model);
    } catch (error: unknown) {
      return storeFailure(
        "E_PROJECT_COMMIT",
        `Project commit failed: ${errorMessage(error)}`,
      );
    }
  }
}

export async function createProject(
  root: string,
  initialModel: GuyditorProject,
  options: ProjectStoreOptions = {},
): Promise<Result<ProjectStore>> {
  try {
    const masterPath = join(root, MASTER_FILE);
    try {
      await access(masterPath);
      return storeFailure(
        "E_PROJECT_EXISTS",
        `A Guyditor project already exists at ${root}.`,
      );
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }

    const valid = validateProject(initialModel);
    if (!valid.ok) return valid;
    await mkdir(root, { recursive: true });
    await Promise.all(
      SKELETON_DIRECTORIES.map((relative) =>
        mkdir(join(root, relative), { recursive: true }),
      ),
    );
    const canonicalMaster = canonicalizeYaml(initialModel);
    const appVersion = options.appVersion ?? "0.0.0";
    await atomicWrite(masterPath, canonicalMaster);
    await atomicWrite(join(root, ".gitignore"), GITIGNORE);
    await atomicWrite(join(root, "history/transactions.jsonl"), "");
    await writeRevisionArtifacts(root, initialModel, canonicalMaster, appVersion);
    await atomicWrite(join(root, "history/HEAD"), `${initialModel.revision}\n`);
    return success(new ProjectStore(root, initialModel, options));
  } catch (error: unknown) {
    return storeFailure(
      "E_PROJECT_CREATE",
      `Project creation failed: ${errorMessage(error)}`,
    );
  }
}

function acceptedRevision(
  head: string,
  transactions: readonly TransactionRecord[],
): Result<{ revision: string; advanceHead: boolean }> {
  const last = transactions.at(-1);
  if (last === undefined || last.resultRevision === head) {
    return success({ revision: head, advanceHead: false });
  }
  if (last.baseRevision === head) {
    return success({ revision: last.resultRevision, advanceHead: true });
  }
  return storeFailure(
    "E_PROJECT_JOURNAL",
    `history/HEAD ${head} does not agree with the last transaction.`,
  );
}

function projectAtRevision(
  text: string | undefined,
  revision: string,
): GuyditorProject | undefined {
  if (text === undefined) return undefined;
  const parsed = parseProjectYaml(text);
  return parsed.ok && parsed.value.revision === revision
    ? parsed.value
    : undefined;
}

export async function openProject(
  root: string,
  options: ProjectStoreOptions = {},
): Promise<Result<ProjectStore>> {
  try {
    const head = await readHead(root);
    const journalText = await readFile(
      join(root, "history/transactions.jsonl"),
      "utf8",
    );
    const journal = parseJournal(journalText);
    if (!journal.ok) return journal;
    const accepted = acceptedRevision(head, journal.value);
    if (!accepted.ok) return accepted;

    const masterText = await readOptional(join(root, MASTER_FILE));
    const snapshotText = await readOptional(snapshotPath(root, accepted.value.revision));
    const snapshot = projectAtRevision(snapshotText, accepted.value.revision);
    const master = projectAtRevision(masterText, accepted.value.revision);
    const project = master ?? snapshot;
    if (project === undefined) {
      return storeFailure(
        "E_PROJECT_OPEN",
        `No valid master or snapshot exists for ${accepted.value.revision}.`,
      );
    }

    const canonicalMaster = canonicalizeYaml(project);
    if (master === undefined) {
      await atomicWrite(join(root, MASTER_FILE), canonicalMaster);
    }
    if (snapshot === undefined) {
      await atomicWrite(snapshotPath(root, project.revision), canonicalMaster);
    }
    const existingLock = await readOptional(lockPath(root, project.revision));
    if (existingLock === undefined) {
      const lock = revisionLock(
        project,
        canonicalMaster,
        options.appVersion ?? "0.0.0",
      );
      await atomicWrite(lockPath(root, project.revision), `${canonicalJson(lock)}\n`);
    }
    if (accepted.value.advanceHead) {
      await atomicWrite(join(root, "history/HEAD"), `${project.revision}\n`);
    }

    return success(new ProjectStore(root, project, options));
  } catch (error: unknown) {
    return storeFailure(
      "E_PROJECT_OPEN",
      `Project open failed: ${errorMessage(error)}`,
    );
  }
}
