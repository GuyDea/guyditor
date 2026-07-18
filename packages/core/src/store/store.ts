import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import {
  canonicalizeYaml,
  makeId,
  parseProjectYaml,
  parseRevision,
  validateProject,
} from "../project/index.js";
import type {
  GuyditorProject,
  IdPrefix,
  SkillPin,
} from "../project/index.js";
import type { Rational } from "../time/index.js";
import type { RevisionLock, TransactionRecord } from "./types.js";

const MASTER_FILE = "episode.guyditor.yaml";
const GITIGNORE = ".guyditor/\nproposals/*/previews/\nmedia/\n";
const SKELETON_DIRECTORIES = [
  "sidecars",
  "proposals",
  "history/revisions",
  "history/proposals",
  "media/generated",
  "media/pickups",
  "presets",
  "skills",
  ".guyditor/cache",
] as const;
const DEFAULT_PRIMARY_OUTPUT_FORMAT = "youtube-longform@1.0.0";
const EMPTY_ANNOTATIONS = "format: guyditor.annotations/v1\nannotations: []\n";

let temporaryOrdinal = 0;

export interface ProjectStoreOptions {
  appVersion?: string;
  idFactory?: (prefix: IdPrefix) => string;
  now?: () => Date;
  profilesDirectory?: string;
}

export interface WatchFolderConfig {
  path: string;
  convention: "guyditor" | "flat";
  ignore?: string[];
  autoIngest: boolean;
  autoJobs: {
    proxy: boolean;
    analysis: boolean;
    transcription: boolean;
  };
}

export interface CreateProjectRequest {
  name: string;
  primaryOutputFormat?: string;
  skills?: SkillPin[];
  watchFolders?: WatchFolderConfig[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : undefined;
}

function rationalValue(value: unknown): Rational | undefined {
  return typeof value === "string" && /^\d+\/[1-9]\d*$/u.test(value)
    ? value
    : undefined;
}

interface CreationProfileSettings {
  audio: { channels: number; sampleRate: number };
  fps: Rational;
  height: number;
  id: string;
  kind: "longform" | "short";
  version: string;
  width: number;
}

function versionedProfileId(profile: string): { id: string; version: string } | undefined {
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)@(\d+\.\d+\.\d+)$/u.exec(profile);
  return match === null ? undefined : { id: match[1]!, version: match[2]! };
}

function legacyProfileDefaults(
  id: string,
  version: string,
): Omit<CreationProfileSettings, "id" | "version"> | undefined {
  return id === "youtube-longform" && version === "1.0.0"
    ? {
        audio: { channels: 2, sampleRate: 48_000 },
        fps: "30000/1001",
        height: 2160,
        kind: "longform",
        width: 3840,
      }
    : undefined;
}

async function loadCreationProfile(
  profileId: string,
  options: ProjectStoreOptions,
): Promise<Result<CreationProfileSettings>> {
  const pin = versionedProfileId(profileId);
  if (pin === undefined) {
    return storeFailure(
      "E_PROJECT_PROFILE_INVALID",
      `Primary output format ${profileId} must be a versioned profile ID.`,
    );
  }
  const profilesDirectory = options.profilesDirectory ?? resolve("profiles");
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(
      join(profilesDirectory, pin.id, `${pin.version}.yaml`),
      "utf8",
    )) as unknown;
  } catch (error: unknown) {
    return storeFailure(
      "E_PROJECT_PROFILE_INVALID",
      `Could not load profile ${profileId}: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(parsed) || parsed["id"] !== pin.id || parsed["version"] !== pin.version) {
    return storeFailure(
      "E_PROJECT_PROFILE_INVALID",
      `Profile ${profileId} does not match its file identity.`,
    );
  }

  const video = isRecord(parsed["video"]) ? parsed["video"] : {};
  const resolution = isRecord(video["resolution"]) ? video["resolution"] : {};
  const fps = isRecord(video["fps"]) ? video["fps"] : {};
  const audio = isRecord(parsed["audio"]) ? parsed["audio"] : {};
  const fallback = legacyProfileDefaults(pin.id, pin.version);
  const width = positiveInteger(resolution["width"]) ?? fallback?.width;
  const height = positiveInteger(resolution["height"]) ?? fallback?.height;
  const defaultFps = rationalValue(fps["default"]) ?? fallback?.fps;
  const sampleRate = positiveInteger(audio["sampleRate"]) ?? fallback?.audio.sampleRate;
  const channels = positiveInteger(audio["channels"]) ?? fallback?.audio.channels;
  const kindValue = typeof parsed["kind"] === "string" ? parsed["kind"] : fallback?.kind;
  if (
    width === undefined || height === undefined || defaultFps === undefined ||
    sampleRate === undefined || channels === undefined ||
    (kindValue !== "longform" && kindValue !== "short")
  ) {
    return storeFailure(
      "E_PROJECT_PROFILE_INVALID",
      `Profile ${profileId} is missing creation defaults for video resolution, fps, or audio.`,
    );
  }
  return success({
    audio: { channels, sampleRate },
    fps: defaultFps,
    height,
    id: pin.id,
    kind: kindValue,
    version: pin.version,
    width,
  });
}

function isInsideCache(path: string): boolean {
  return /(?:^|[\\/])\.guyditor[\\/]cache(?:[\\/]|$)/u.test(path);
}

async function canonicalTargetPath(root: string): Promise<string> {
  let cursor = resolve(root);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missingSegments);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(root);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
}

async function validateCreationLocation(
  root: string,
  allowPreassembledLegacyModel: boolean,
): Promise<Result<string>> {
  const target = await canonicalTargetPath(root);
  if (isInsideCache(target)) {
    return storeFailure(
      "E_PROJECT_LOCATION_INVALID",
      `Project location ${target} is inside .guyditor/cache.`,
    );
  }

  let cursor = target;
  while (true) {
    try {
      await access(join(cursor, MASTER_FILE));
      return cursor === target
        ? storeFailure("E_PROJECT_EXISTS", `A Guyditor project already exists at ${target}.`)
        : storeFailure(
            "E_PROJECT_LOCATION_INVALID",
            `Project location ${target} is inside the project at ${cursor}.`,
          );
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  if (allowPreassembledLegacyModel) return success(target);
  try {
    if ((await readdir(target)).length > 0) {
      return storeFailure(
        "E_PROJECT_LOCATION_INVALID",
        `Project location ${target} must be empty or not yet exist.`,
      );
    }
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
  return success(target);
}

function isInitialModel(
  value: GuyditorProject | CreateProjectRequest,
): value is GuyditorProject {
  return "format" in value && value.format === "guyditor/v1";
}

function buildInitialModel(
  request: CreateProjectRequest,
  profile: CreationProfileSettings,
  options: ProjectStoreOptions,
): GuyditorProject {
  const makeProjectId = options.idFactory ?? makeId;
  const created = (options.now ?? (() => new Date()))().toISOString();
  const projectId = makeProjectId("prj");
  const deliverableId = makeProjectId("dlv");
  const sequenceId = makeProjectId("seq");
  const layerId = makeProjectId("lyr");
  const annotationHash = createHash("sha256").update(EMPTY_ANNOTATIONS).digest("hex");
  return {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: { id: projectId, name: request.name, created },
    settings: {
      timeline: { fps: profile.fps, width: profile.width, height: profile.height },
      audio: profile.audio,
      primaryDeliverable: deliverableId,
    },
    transcript: { nextWordOrdinal: 1 },
    assets: [],
    beats: [],
    sequences: [{ id: sequenceId, name: "main", clips: [] }],
    layers: [{
      id: layerId,
      kind: "video",
      name: "main",
      order: 0,
      enabled: true,
      locked: false,
      sequence: sequenceId,
    }],
    captions: [],
    annotations: {
      sidecar: "annotations",
      summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 },
    },
    deliverables: [{
      id: deliverableId,
      kind: profile.kind,
      name: "master",
      profile: `${profile.id}@${profile.version}`,
      sequenceId,
      status: "draft",
    }],
    ...(request.watchFolders === undefined
      ? {}
      : { watchFolders: structuredClone(request.watchFolders) }),
    presets: [],
    skills: structuredClone(request.skills ?? []),
    sidecars: [{
      name: "annotations",
      path: "sidecars/annotations.yaml",
      schema: "guyditor.annotations/v1",
      sha256: annotationHash,
      inputs: [],
    }],
  };
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
  #commitTail: Promise<void> = Promise.resolve();

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

  public get root(): string {
    return this.#root;
  }

  public static createProject(
    root: string,
    request: CreateProjectRequest,
    options: ProjectStoreOptions = {},
  ): Promise<Result<ProjectStore>> {
    return createProject(root, request, options);
  }

  public get head(): string {
    return this.#head;
  }

  public async commit(
    model: GuyditorProject,
    transaction: TransactionRecord,
  ): Promise<Result<GuyditorProject>> {
    const previous = this.#commitTail;
    let release: (() => void) | undefined;
    this.#commitTail = new Promise<void>((resolveCommit) => {
      release = resolveCommit;
    });
    await previous;
    try {
      return await this.#commitUnlocked(model, transaction);
    } finally {
      release?.();
    }
  }

  async #commitUnlocked(
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

export function createProject(
  root: string,
  initialModel: GuyditorProject,
  options?: ProjectStoreOptions,
): Promise<Result<ProjectStore>>;
export function createProject(
  root: string,
  request: CreateProjectRequest,
  options?: ProjectStoreOptions,
): Promise<Result<ProjectStore>>;
export async function createProject(
  root: string,
  modelOrRequest: GuyditorProject | CreateProjectRequest,
  options: ProjectStoreOptions = {},
): Promise<Result<ProjectStore>> {
  try {
    const legacyModel = isInitialModel(modelOrRequest);
    const location = await validateCreationLocation(root, legacyModel);
    if (!location.ok) return location;
    const projectRoot = location.value;
    const masterPath = join(projectRoot, MASTER_FILE);

    let initialModel: GuyditorProject;
    let writesInitialAnnotations = false;
    if (legacyModel) {
      initialModel = modelOrRequest;
    } else {
      const profile = await loadCreationProfile(
        modelOrRequest.primaryOutputFormat ?? DEFAULT_PRIMARY_OUTPUT_FORMAT,
        options,
      );
      if (!profile.ok) return profile;
      initialModel = buildInitialModel(modelOrRequest, profile.value, options);
      writesInitialAnnotations = true;
    }

    const valid = validateProject(initialModel);
    if (!valid.ok) return valid;
    await mkdir(projectRoot, { recursive: true });
    await Promise.all(
      SKELETON_DIRECTORIES.map((relative) =>
        mkdir(join(projectRoot, relative), { recursive: true }),
      ),
    );
    const canonicalMaster = canonicalizeYaml(initialModel);
    const appVersion = options.appVersion ?? "0.0.0";
    await atomicWrite(masterPath, canonicalMaster);
    if (writesInitialAnnotations) {
      await atomicWrite(join(projectRoot, "sidecars/annotations.yaml"), EMPTY_ANNOTATIONS);
    }
    await atomicWrite(join(projectRoot, ".gitignore"), GITIGNORE);

    const actor = { kind: "tool" as const, id: "system" };
    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    const creationTransaction: TransactionRecord = {
      id: (options.idFactory ?? makeId)("txn"),
      baseRevision: "rev_00000",
      resultRevision: "rev_00001",
      operations: [{
        op: "project.create",
        params: {
          name: initialModel.project.name,
          primaryOutputFormat: initialModel.deliverables.find(
            ({ id }) => id === initialModel.settings.primaryDeliverable,
          )?.profile ?? DEFAULT_PRIMARY_OUTPUT_FORMAT,
        },
        summary: `Create project ${initialModel.project.name}`,
      }],
      instruction: { kind: "ui-direct" },
      actor,
      versions: {
        app: appVersion,
        schema: "guyditor/v1",
        skills: initialModel.skills.map(({ id, version }) => ({ id, version })),
        presets: initialModel.presets.map(({ id, version }) => ({ id, version })),
        tools: [],
      },
      acceptance: { status: "accepted", by: actor.id, at: createdAt },
      orphanedAnchors: [],
      addresses: [],
    };
    await atomicWrite(
      join(projectRoot, "history/transactions.jsonl"),
      `${canonicalJson(creationTransaction)}\n`,
    );
    await writeRevisionArtifacts(projectRoot, initialModel, canonicalMaster, appVersion);
    await atomicWrite(join(projectRoot, "history/HEAD"), `${initialModel.revision}\n`);
    return success(new ProjectStore(projectRoot, initialModel, options));
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
