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
import { basename, dirname, join, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import {
  ID_PREFIXES,
  canonicalizeYaml,
  formatRevision,
  isId,
  makeId,
  parseProjectYaml,
  parseRevision,
  validateProject,
} from "../project/index.js";
import type {
  GuyditorProject,
  IdPrefix,
  SkillPin,
  WatchFolderConfig,
} from "../project/index.js";
import type { Rational } from "../time/index.js";
import {
  structuralSemanticEntries,
} from "../operations/diff.js";
import type { Proposal } from "../operations/types.js";
import { computeChangedRanges } from "./history.js";
import type {
  RevisionComparison,
  RevisionLock,
  TransactionRecord,
} from "./types.js";

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

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
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
  reproducibilityTools?: RevisionLock["tools"],
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
    templates: Object.entries(project.templates ?? {})
      .map(([id, { version, contentHash }]) => ({ id, version, contentHash }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tools: reproducibilityTools === undefined
      ? [{ name: "guyditor", version: appVersion }]
      : structuredClone(reproducibilityTools),
  };
}

function snapshotPath(root: string, revision: string): string {
  return join(root, "history/revisions", `${revision}.yaml`);
}

function lockPath(root: string, revision: string): string {
  return join(root, "history/revisions", `${revision}.lock.json`);
}

function sidecarSnapshotPath(root: string, revision: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) {
    throw new Error(`Sidecar name ${name} is not safe for revision snapshots.`);
  }
  return join(root, "history/revisions", `${revision}.sidecars`, name);
}

function sidecarFilePath(root: string, relativePath: string): string {
  const sidecarsRoot = resolve(root, "sidecars");
  const path = resolve(root, relativePath);
  if (path !== sidecarsRoot && !path.startsWith(`${sidecarsRoot}${sep}`)) {
    throw new Error(`Sidecar path ${relativePath} must stay under sidecars/.`);
  }
  return path;
}

async function findSidecarSnapshot(
  root: string,
  revision: string,
  name: string,
  sha256: string,
): Promise<string | undefined> {
  for (let ordinal = parseRevision(revision); ordinal >= 1; ordinal -= 1) {
    const content = await readOptional(sidecarSnapshotPath(
      root,
      formatRevision(ordinal),
      name,
    ));
    if (
      content !== undefined &&
      createHash("sha256").update(content).digest("hex") === sha256
    ) return content;
  }
  return undefined;
}

async function snapshotChangedSidecars(
  root: string,
  project: GuyditorProject,
  previous: GuyditorProject | undefined,
): Promise<void> {
  for (const sidecar of project.sidecars) {
    const prior = previous?.sidecars.find(({ name }) => name === sidecar.name);
    if (
      prior?.sha256 === sidecar.sha256 &&
      await findSidecarSnapshot(root, previous!.revision, sidecar.name, sidecar.sha256) !== undefined
    ) continue;
    const content = await readOptional(sidecarFilePath(root, sidecar.path));
    if (content === undefined) continue;
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== sidecar.sha256) {
      throw new Error(
        `Sidecar ${sidecar.name} hash ${actual} does not match registered hash ${sidecar.sha256}.`,
      );
    }
    await atomicWrite(sidecarSnapshotPath(root, project.revision, sidecar.name), content);
  }
}

function proposalPath(root: string, id: string, archived = false): string {
  return join(root, archived ? "history/proposals" : "proposals", id);
}

function unifiedMasterDiff(accepted: string, proposed: string): string {
  const before = accepted.endsWith("\n") ? accepted.slice(0, -1).split("\n") : accepted.split("\n");
  const after = proposed.endsWith("\n") ? proposed.slice(0, -1).split("\n") : proposed.split("\n");
  return [
    "--- a/episode.guyditor.yaml",
    "+++ b/episode.guyditor.yaml",
    `@@ -1,${String(before.length)} +1,${String(after.length)} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function operationInputRecord(value: unknown): boolean {
  return isRecord(value) && typeof value["op"] === "string" && isRecord(value["params"]);
}

function semanticOperationRecord(value: unknown): boolean {
  if (
    !isRecord(value) || typeof value["op"] !== "string" ||
    isRecord(value["params"]) === false || typeof value["summary"] !== "string"
  ) return false;
  const inverse = value["inverse"];
  return inverse === undefined || operationInputRecord(inverse) ||
    (Array.isArray(inverse) && inverse.every(operationInputRecord));
}

function appliedOperationRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const captionImpacts = new Set(["none", "shift", "retime", "realign"]);
  return typeof value["op"] === "string" && isRecord(value["params"]) &&
    typeof value["summary"] === "string" && Array.isArray(value["inverse"]) &&
    value["inverse"].every(operationInputRecord) &&
    typeof value["captionImpact"] === "string" &&
    captionImpacts.has(value["captionImpact"]) &&
    Array.isArray(value["warnings"]) && value["warnings"].every(isRecord) &&
    Array.isArray(value["affected"]) &&
    value["affected"].every((affected) => typeof affected === "string");
}

function semanticDiffRecord(value: unknown, baseRevision: string): boolean {
  return isRecord(value) && value["base"] === baseRevision &&
    Array.isArray(value["entries"]) && value["entries"].every((entry) =>
      isRecord(entry) && typeof entry["summary"] === "string" &&
      typeof entry["op"] === "string" && Array.isArray(entry["anchors"]) &&
      entry["anchors"].every((anchor) => typeof anchor === "string") &&
      typeof entry["entityId"] === "string" && typeof entry["entityType"] === "string" &&
      typeof entry["change"] === "string" && Array.isArray(entry["fields"])) &&
    Array.isArray(value["orphanedAnchors"]) && isRecord(value["stats"]);
}

function proposalRecord(value: unknown, expectedId: string): Proposal | undefined {
  if (!isRecord(value)) return undefined;
  const statuses = new Set(["draft", "ready", "accepted", "rejected", "superseded", "withdrawn"]);
  const risks = new Set(["low", "normal", "consequential"]);
  const instructions = new Set(["user-text", "annotation", "ui-direct", "skill-policy"]);
  const actors = new Set(["human", "agent", "tool"]);
  const sources = new Set(["instruction", "annotation", "skill-rule", "media-evidence"]);
  const instruction = value["instruction"];
  const actor = value["actor"];
  const reason = value["reason"];
  const prepared = value["status"] !== "draft";
  const terminal = value["status"] === "accepted" || value["status"] === "rejected" ||
    value["status"] === "superseded" || value["status"] === "withdrawn";
  const unresolved = value["status"] === "draft" || value["status"] === "ready";
  return value["id"] === expectedId && isId("prp", value["id"]) &&
    typeof value["baseRevision"] === "string" &&
    typeof value["status"] === "string" && statuses.has(value["status"]) &&
    isRecord(instruction) && typeof instruction["kind"] === "string" &&
    instructions.has(instruction["kind"]) &&
    isRecord(actor) && typeof actor["kind"] === "string" && actors.has(actor["kind"]) &&
    typeof actor["id"] === "string" &&
    (actor["model"] === undefined || typeof actor["model"] === "string") &&
    (value["sessionId"] === undefined ||
      typeof value["sessionId"] === "string" && isId("ses", value["sessionId"])) &&
    isRecord(reason) && typeof reason["text"] === "string" &&
    Array.isArray(reason["sources"]) && reason["sources"].every((source) =>
      isRecord(source) && typeof source["kind"] === "string" && sources.has(source["kind"]) &&
      typeof source["ref"] === "string") &&
    typeof value["riskClass"] === "string" && risks.has(value["riskClass"]) &&
    Array.isArray(value["operations"]) && value["operations"].every(semanticOperationRecord) &&
    Array.isArray(value["addresses"]) && value["addresses"].every((address) =>
      typeof address === "string" && isId("ann", address)) &&
    Array.isArray(value["orphanedAnchors"]) && value["orphanedAnchors"].every((orphan) =>
      isRecord(orphan) && typeof orphan["owner"] === "string" &&
      typeof orphan["anchor"] === "string") &&
    typeof value["createdAt"] === "string" &&
    (value["resolvedAt"] === undefined || typeof value["resolvedAt"] === "string") &&
    (value["resolvedBy"] === undefined || typeof value["resolvedBy"] === "string") &&
    (value["resultTransaction"] === undefined ||
      typeof value["resultTransaction"] === "string" && isId("txn", value["resultTransaction"])) &&
    (!terminal ||
      typeof value["resolvedAt"] === "string" && typeof value["resolvedBy"] === "string") &&
    (!unresolved ||
      value["resolvedAt"] === undefined && value["resolvedBy"] === undefined &&
      value["resultTransaction"] === undefined && value["supersededBy"] === undefined) &&
    (value["status"] !== "accepted" ||
      typeof value["resultTransaction"] === "string" && isId("txn", value["resultTransaction"]) &&
      value["supersededBy"] === undefined) &&
    (value["status"] !== "superseded" ||
      typeof value["supersededBy"] === "string" && isId("prp", value["supersededBy"]) &&
      value["resultTransaction"] === undefined) &&
    ((value["status"] !== "rejected" && value["status"] !== "withdrawn") ||
      value["resultTransaction"] === undefined && value["supersededBy"] === undefined) &&
    (!prepared ||
      Array.isArray(value["applied"]) && value["applied"].every(appliedOperationRecord) &&
      semanticDiffRecord(value["diff"], value["baseRevision"]) &&
      Array.isArray(value["warnings"]) && value["warnings"].every(isRecord))
    ? value as unknown as Proposal
    : undefined;
}

function proposalAuthorship(proposal: Proposal): unknown {
  return {
    id: proposal.id,
    baseRevision: proposal.baseRevision,
    instruction: proposal.instruction,
    actor: proposal.actor,
    sessionId: proposal.sessionId,
    reason: proposal.reason,
    addresses: proposal.addresses,
    createdAt: proposal.createdAt,
  };
}

function proposalImmutableReadyFields(proposal: Proposal): unknown {
  const mutable = new Set([
    "status",
    "previewJobId",
    "staleBase",
    "supersededBy",
    "resolvedAt",
    "resolvedBy",
    "resultTransaction",
  ]);
  return Object.fromEntries(
    Object.entries(proposal).filter(([key]) => !mutable.has(key)),
  );
}

async function validateArchivedProposals(root: string): Promise<Result<true>> {
  try {
    const entries = await readdir(join(root, "history/proposals"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isId("prp", entry.name)) {
        return storeFailure(
          "E_PROJECT_PROPOSAL",
          `Unexpected entry history/proposals/${entry.name}.`,
        );
      }
      const record = await readProposalAt(proposalPath(root, entry.name, true), entry.name);
      if (!record.ok) return record;
      if (record.value.status === "draft" || record.value.status === "ready") {
        return storeFailure(
          "E_PROJECT_PROPOSAL",
          `Archived proposal ${entry.name} has non-terminal status ${record.value.status}.`,
        );
      }
      const directory = proposalPath(root, entry.name, true);
      const [proposed, patch] = await Promise.all([
        readOptional(join(directory, "master.proposed.yaml")),
        readOptional(join(directory, "diff.patch")),
        access(join(directory, "previews")),
      ]);
      if (proposed === undefined || patch === undefined) {
        return storeFailure(
          "E_PROJECT_PROPOSAL",
          `Archived proposal ${entry.name} is missing review artifacts.`,
        );
      }
    }
    return success(true);
  } catch (error: unknown) {
    return storeFailure(
      "E_PROJECT_PROPOSAL",
      `Could not validate archived proposals: ${errorMessage(error)}`,
    );
  }
}

async function validateActiveProposals(
  root: string,
  journal: readonly TransactionRecord[],
): Promise<Result<true>> {
  try {
    const entries = await readdir(join(root, "proposals"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isId("prp", entry.name)) {
        return storeFailure(
          "E_PROJECT_PROPOSAL",
          `Unexpected entry proposals/${entry.name}.`,
        );
      }
      const directory = proposalPath(root, entry.name);
      const loaded = await readProposalAt(directory, entry.name);
      if (!loaded.ok) return loaded;
      let record = loaded.value;
      const accepted = journal.find(({ acceptance }) => acceptance.proposal === entry.name);
      if (accepted !== undefined && record.status !== "accepted") {
        record = {
          ...record,
          status: "accepted",
          resultTransaction: accepted.id,
          resolvedAt: accepted.acceptance.at,
          resolvedBy: accepted.acceptance.status === "auto-accepted-low-risk"
            ? "auto"
            : accepted.acceptance.by,
        };
        await atomicWrite(join(directory, "proposal.json"), `${canonicalJson(record)}\n`);
      }
      if (record.status !== "draft" && record.status !== "ready") {
        if (record.status === "accepted" && accepted === undefined) {
          return storeFailure(
            "E_PROJECT_PROPOSAL",
            `Accepted proposal ${entry.name} has no linked journal transaction.`,
          );
        }
        await rename(directory, proposalPath(root, entry.name, true));
        await syncDirectory(join(root, "proposals"));
        await syncDirectory(join(root, "history/proposals"));
        continue;
      }
      const [proposedText, patchText] = await Promise.all([
        readOptional(join(directory, "master.proposed.yaml")),
        readOptional(join(directory, "diff.patch")),
        access(join(directory, "previews")),
      ]);
      const proposed = proposedText === undefined ? undefined : parseProjectYaml(proposedText);
      if (
        proposedText === undefined || patchText === undefined ||
        proposed === undefined || !proposed.ok ||
        proposed.value.revision !== formatRevision(parseRevision(record.baseRevision) + 1)
      ) {
        return storeFailure(
          "E_PROJECT_PROPOSAL",
          `Proposal ${entry.name} has invalid or missing proposed-master artifacts.`,
        );
      }
      if (
        record.status === "ready" &&
        (record.applied === undefined || record.diff === undefined ||
          record.warnings === undefined ||
          record.diff.base !== record.baseRevision)
      ) {
        return storeFailure(
          "E_PROJECT_PROPOSAL",
          `Ready proposal ${entry.name} is missing its dry-run result.`,
        );
      }
    }
    return success(true);
  } catch (error: unknown) {
    return storeFailure(
      "E_PROJECT_PROPOSAL",
      `Could not validate active proposals: ${errorMessage(error)}`,
    );
  }
}

async function readProposalAt(path: string, id: string): Promise<Result<Proposal>> {
  try {
    const parsed = JSON.parse(await readFile(join(path, "proposal.json"), "utf8")) as unknown;
    const proposal = proposalRecord(parsed, id);
    return proposal === undefined
      ? storeFailure("E_PROJECT_PROPOSAL", `Proposal ${id} has an invalid proposal.json record.`)
      : success(proposal);
  } catch (error: unknown) {
    return storeFailure(
      "E_PROJECT_PROPOSAL",
      `Could not read proposal ${id}: ${errorMessage(error)}`,
    );
  }
}

async function writeRevisionArtifacts(
  root: string,
  project: GuyditorProject,
  canonicalMaster: string,
  appVersion: string,
  previous?: GuyditorProject,
  reproducibilityTools?: RevisionLock["tools"],
): Promise<void> {
  await atomicWrite(snapshotPath(root, project.revision), canonicalMaster);
  const lock = revisionLock(project, canonicalMaster, appVersion, reproducibilityTools);
  await atomicWrite(lockPath(root, project.revision), `${canonicalJson(lock)}\n`);
  await snapshotChangedSidecars(root, project, previous);
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

async function readRevisionProject(
  root: string,
  revision: string,
): Promise<Result<GuyditorProject>> {
  const text = await readOptional(snapshotPath(root, revision));
  if (text === undefined) {
    return storeFailure("E_PROJECT_REVISION", `Revision snapshot ${revision} does not exist.`);
  }
  const parsed = parseProjectYaml(text);
  return parsed.ok && parsed.value.revision === revision
    ? parsed
    : storeFailure("E_PROJECT_REVISION", `Revision snapshot ${revision} is invalid.`);
}

async function readRevisionLock(
  root: string,
  revision: string,
): Promise<Result<RevisionLock>> {
  const text = await readOptional(lockPath(root, revision));
  if (text === undefined) {
    return storeFailure("E_PROJECT_REVISION", `Revision lock ${revision} does not exist.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    return storeFailure(
      "E_PROJECT_REVISION",
      `Revision lock ${revision} is invalid JSON: ${errorMessage(error)}`,
    );
  }
  const recordArray = (candidate: unknown): candidate is Record<string, unknown>[] =>
    Array.isArray(candidate) && candidate.every(isRecord);
  if (
    !isRecord(value) || value["revision"] !== revision ||
    typeof value["masterSha256"] !== "string" ||
    !recordArray(value["assets"]) || !recordArray(value["sidecars"]) ||
    !recordArray(value["presets"]) || !recordArray(value["skills"]) ||
    !recordArray(value["profiles"]) ||
    !(value["templates"] === undefined || recordArray(value["templates"])) ||
    !recordArray(value["tools"]) ||
    !value["presets"].every((pin) =>
      typeof pin["id"] === "string" && typeof pin["version"] === "number" &&
      typeof pin["sha256"] === "string") ||
    !value["skills"].every((pin) =>
      typeof pin["id"] === "string" && typeof pin["version"] === "string" &&
      typeof pin["contentHash"] === "string") ||
    !(value["templates"] ?? []).every((pin) =>
      typeof pin["id"] === "string" && typeof pin["version"] === "string" &&
      typeof pin["contentHash"] === "string") ||
    !value["tools"].every((tool) =>
      typeof tool["name"] === "string" && typeof tool["version"] === "string")
  ) {
    return storeFailure("E_PROJECT_REVISION", `Revision lock ${revision} is invalid.`);
  }
  return success({
    ...(value as unknown as Omit<RevisionLock, "templates">),
    templates: (value["templates"] ?? []) as RevisionLock["templates"],
  });
}

function objectIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (ID_PREFIXES.some((prefix) => isId(prefix, value)) ||
      /^w[0-9]{6}$/u.test(value)) ids.add(value);
  } else if (Array.isArray(value)) {
    for (const child of value) objectIds(child, ids);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) objectIds(child, ids);
  }
  return ids;
}

function linealRange(
  transactions: readonly TransactionRecord[],
  a: string,
  b: string,
): TransactionRecord[] | undefined {
  if (a === b) return [];
  if (parseRevision(a) >= parseRevision(b)) return undefined;
  const selected: TransactionRecord[] = [];
  let cursor = a;
  while (cursor !== b) {
    const transaction = transactions.find(({ baseRevision }) => baseRevision === cursor);
    if (
      transaction === undefined ||
      transaction.operations.some(({ op }) => op === "project.restore") ||
      parseRevision(transaction.resultRevision) !== parseRevision(cursor) + 1
    ) return undefined;
    selected.push(transaction);
    cursor = transaction.resultRevision;
    if (parseRevision(cursor) > parseRevision(b)) return undefined;
  }
  return selected;
}

function comparisonValue(value: unknown): string {
  if (value === undefined) return "∅";
  if (isRecord(value) && typeof value["frames"] === "number" && typeof value["fps"] === "string") {
    return `${String(value["frames"])} frames`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function significantRanges(
  ranges: RevisionComparison["changedRanges"],
  maximum: number,
): RevisionComparison["changedRanges"] {
  return [...ranges]
    .sort((left, right) => {
      const leftScore = (left.end.frames - left.start.frames) * (1 + left.affectedObjects.length);
      const rightScore = (right.end.frames - right.start.frames) * (1 + right.affectedObjects.length);
      return rightScore - leftScore || left.start.frames - right.start.frames;
    })
    .slice(0, maximum);
}

export class ProjectStore {
  readonly #root: string;
  readonly #appVersion: string;
  readonly #idFactory: (prefix: IdPrefix) => string;
  readonly #now: () => Date;
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
    this.#idFactory = options.idFactory ?? makeId;
    this.#now = options.now ?? (() => new Date());
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

  public async readAcceptedRevision(): Promise<Result<string>> {
    try {
      return success(await readHead(this.#root));
    } catch (error: unknown) {
      return storeFailure(
        "E_PROJECT_HEAD",
        `Could not read history/HEAD: ${errorMessage(error)}`,
      );
    }
  }

  public async readTransaction(id: string): Promise<Result<TransactionRecord>> {
    if (!isId("txn", id)) {
      return storeFailure("E_PROJECT_TRANSACTION", `Transaction ID ${id} is malformed.`);
    }
    try {
      const parsed = parseJournal(await readFile(
        join(this.#root, "history/transactions.jsonl"),
        "utf8",
      ));
      if (!parsed.ok) return parsed;
      const transaction = parsed.value.find((candidate) => candidate.id === id);
      return transaction === undefined
        ? storeFailure("E_PROJECT_TRANSACTION", `Transaction ${id} was not found.`)
        : success(transaction);
    } catch (error: unknown) {
      return storeFailure(
        "E_PROJECT_TRANSACTION",
        `Could not read transaction ${id}: ${errorMessage(error)}`,
      );
    }
  }

  public async restore(targetRevision: string): Promise<Result<GuyditorProject>> {
    const previous = this.#commitTail;
    let release: (() => void) | undefined;
    this.#commitTail = new Promise<void>((resolveCommit) => {
      release = resolveCommit;
    });
    await previous;
    try {
      return await this.#restoreUnlocked(targetRevision);
    } finally {
      release?.();
    }
  }

  async #restoreUnlocked(targetRevision: string): Promise<Result<GuyditorProject>> {
    let target: Result<GuyditorProject>;
    try {
      target = await readRevisionProject(this.#root, targetRevision);
    } catch (error: unknown) {
      return storeFailure(
        "E_PROJECT_RESTORE",
        `Could not load revision ${targetRevision}: ${errorMessage(error)}`,
      );
    }
    if (!target.ok) return target;
    const targetLock = await readRevisionLock(this.#root, targetRevision);
    if (!targetLock.ok) return targetLock;
    const targetHash = createHash("sha256")
      .update(canonicalizeYaml(target.value))
      .digest("hex");
    if (targetHash !== targetLock.value.masterSha256) {
      return storeFailure(
        "E_PROJECT_RESTORE",
        `Revision ${targetRevision} does not match its lock-file master hash.`,
      );
    }
    const previousContents = new Map<string, string | undefined>();
    try {
      for (const sidecar of this.#project.sidecars) {
        previousContents.set(
          sidecar.path,
          await readOptional(sidecarFilePath(this.#root, sidecar.path)),
        );
      }
      for (const sidecar of target.value.sidecars) {
        if (!previousContents.has(sidecar.path)) {
          previousContents.set(
            sidecar.path,
            await readOptional(sidecarFilePath(this.#root, sidecar.path)),
          );
        }
        const content = await findSidecarSnapshot(
          this.#root,
          targetRevision,
          sidecar.name,
          sidecar.sha256,
        );
        if (content === undefined) {
          const unchanged = this.#project.sidecars.some((current) =>
            current.name === sidecar.name &&
            current.path === sidecar.path &&
            current.sha256 === sidecar.sha256);
          const currentContent = await readOptional(sidecarFilePath(this.#root, sidecar.path));
          const currentMatches = currentContent !== undefined &&
            createHash("sha256").update(currentContent).digest("hex") === sidecar.sha256;
          if (unchanged && currentMatches) continue;
          await this.#restoreSidecarContents(previousContents);
          return storeFailure(
            "E_PROJECT_RESTORE",
            `No sidecar snapshot for ${sidecar.name} at ${targetRevision}.`,
          );
        }
        await atomicWrite(sidecarFilePath(this.#root, sidecar.path), content);
      }
      const targetPaths = new Set(target.value.sidecars.map(({ path }) => path));
      for (const sidecar of this.#project.sidecars) {
        if (!targetPaths.has(sidecar.path)) {
          await unlinkIfPresent(sidecarFilePath(this.#root, sidecar.path));
        }
      }
      const resultRevision = formatRevision(parseRevision(this.#head) + 1);
      const model = { ...structuredClone(target.value), revision: resultRevision };
      const actor = { kind: "human" as const, id: "ui" };
      const transaction: TransactionRecord = {
        id: this.#idFactory("txn"),
        baseRevision: this.#head,
        resultRevision,
        operations: [{
          op: "project.restore",
          params: { target: targetRevision },
          summary: `Restore project to ${targetRevision}`,
          inverse: { op: "project.restore", params: { target: this.#head } },
        }],
        instruction: { kind: "ui-direct" },
        actor,
        versions: {
          app: this.#appVersion,
          schema: "guyditor/v1",
          skills: targetLock.value.skills.map(({ id, version }) => ({ id, version })),
          presets: targetLock.value.presets.map(({ id, version }) => ({ id, version })),
          tools: structuredClone(targetLock.value.tools),
        },
        acceptance: {
          status: "accepted",
          by: actor.id,
          at: this.#now().toISOString(),
        },
        orphanedAnchors: [],
        addresses: [],
      };
      const committed = await this.#commitUnlocked(model, transaction);
      if (committed.ok) return committed;
      await this.#restoreSidecarContents(previousContents);
      return committed;
    } catch (error: unknown) {
      await this.#restoreSidecarContents(previousContents).catch(() => undefined);
      return storeFailure(
        "E_PROJECT_RESTORE",
        `Could not restore revision ${targetRevision}: ${errorMessage(error)}`,
      );
    }
  }

  async #restoreSidecarContents(
    contents: ReadonlyMap<string, string | undefined>,
  ): Promise<void> {
    for (const [relativePath, content] of contents) {
      const path = sidecarFilePath(this.#root, relativePath);
      if (content === undefined) await unlinkIfPresent(path);
      else await atomicWrite(path, content);
    }
  }

  public async compareRevisions(
    a: string,
    b: string,
    options: { maxRanges?: number } = {},
  ): Promise<Result<RevisionComparison>> {
    try {
      const [before, after, journalText] = await Promise.all([
        readRevisionProject(this.#root, a),
        readRevisionProject(this.#root, b),
        readFile(join(this.#root, "history/transactions.jsonl"), "utf8"),
      ]);
      if (!before.ok) return before;
      if (!after.ok) return after;
      const journal = parseJournal(journalText);
      if (!journal.ok) return journal;
      const lineal = linealRange(journal.value, a, b);
      const summary: RevisionComparison["summary"] = [];
      const affected = new Set<string>();
      if (lineal !== undefined) {
        for (const transaction of lineal) {
          for (const operation of transaction.operations) {
            const ids = [...objectIds(operation.params)];
            for (const id of ids) affected.add(id);
            const grouped = ids.length === 0 ? [undefined] : ids;
            for (const objectId of grouped) {
              summary.push({
                ...(objectId === undefined ? {} : { objectId }),
                text: operation.summary,
                transaction: transaction.id,
                instruction: transaction.instruction,
                actor: transaction.actor,
                ...(transaction.reason === undefined ? {} : { reason: transaction.reason }),
              });
            }
          }
        }
      } else {
        for (const entry of structuralSemanticEntries(before.value, after.value)) {
          affected.add(entry.entityId);
          if (entry.fields.length === 0) {
            summary.push({ objectId: entry.entityId, text: entry.summary });
          } else {
            for (const field of entry.fields) {
              summary.push({
                objectId: entry.entityId,
                text: `${entry.entityId}: ${field.field} ${comparisonValue(field.before)} → ${comparisonValue(field.after)}`,
              });
            }
          }
        }
      }
      const changedRanges = significantRanges(
        computeChangedRanges(before.value, after.value, [...affected]),
        options.maxRanges ?? 6,
      );
      return success({
        a,
        b,
        lineal: lineal !== undefined,
        summary,
        changedRanges,
        // TODO(Part 10/12): attach before/after frame pairs through the preview renderer.
        previews: [],
      });
    } catch (error: unknown) {
      return storeFailure(
        "E_PROJECT_COMPARE",
        `Could not compare ${a} and ${b}: ${errorMessage(error)}`,
      );
    }
  }

  public async saveProposal(
    proposal: Proposal,
    proposedProject: GuyditorProject,
  ): Promise<Result<Proposal>> {
    if (!isId("prp", proposal.id)) {
      return storeFailure("E_PROJECT_PROPOSAL", `Proposal ID ${proposal.id} is malformed.`);
    }
    if (proposalRecord(proposal, proposal.id) === undefined) {
      return storeFailure("E_PROJECT_PROPOSAL", `Proposal ${proposal.id} has an invalid record.`);
    }
    const acceptedRevision = await this.readAcceptedRevision();
    if (!acceptedRevision.ok) return acceptedRevision;
    if (
      proposal.baseRevision !== acceptedRevision.value ||
      proposal.baseRevision !== this.#head
    ) {
      return storeFailure(
        "E_PROPOSAL_STALE",
        `Proposal base ${proposal.baseRevision} does not match history/HEAD ${acceptedRevision.value}.`,
      );
    }
    try {
      const root = proposalPath(this.#root, proposal.id);
      const existingText = await readOptional(join(root, "proposal.json"));
      if (existingText === undefined && proposal.status !== "draft") {
        return storeFailure(
          "E_PROJECT_PROPOSAL",
          `New proposal ${proposal.id} must begin in draft status.`,
        );
      }
      if (existingText !== undefined) {
        const current = await readProposalAt(root, proposal.id);
        if (!current.ok) return current;
        if (
          current.value.status !== "draft" || proposal.status !== "ready" ||
          canonicalJson(proposalAuthorship(current.value)) !==
            canonicalJson(proposalAuthorship(proposal))
        ) {
          return storeFailure(
            "E_PROJECT_PROPOSAL",
            `Proposal ${proposal.id} may only be promoted from its immutable draft to ready.`,
          );
        }
      }
      await mkdir(join(root, "previews"), { recursive: true });
      const proposed = canonicalizeYaml(proposedProject);
      const accepted = await readFile(join(this.#root, MASTER_FILE), "utf8");
      await atomicWrite(join(root, "master.proposed.yaml"), proposed);
      await atomicWrite(join(root, "diff.patch"), unifiedMasterDiff(accepted, proposed));
      await atomicWrite(join(root, "proposal.json"), `${canonicalJson(proposal)}\n`);
      return success(proposal);
    } catch (error: unknown) {
      return storeFailure(
        "E_PROJECT_PROPOSAL",
        `Could not persist proposal ${proposal.id}: ${errorMessage(error)}`,
      );
    }
  }

  public async readProposal(id: string): Promise<Result<Proposal>> {
    if (!isId("prp", id)) {
      return storeFailure("E_PROJECT_PROPOSAL", `Proposal ID ${id} is malformed.`);
    }
    const active = await readOptional(join(proposalPath(this.#root, id), "proposal.json"));
    return readProposalAt(
      proposalPath(this.#root, id, active === undefined),
      id,
    );
  }

  public async updateProposal(proposal: Proposal): Promise<Result<Proposal>> {
    if (!isId("prp", proposal.id)) {
      return storeFailure("E_PROJECT_PROPOSAL", `Proposal ID ${proposal.id} is malformed.`);
    }
    if (proposalRecord(proposal, proposal.id) === undefined) {
      return storeFailure("E_PROJECT_PROPOSAL", `Proposal ${proposal.id} has an invalid record.`);
    }
    try {
      const root = proposalPath(this.#root, proposal.id);
      const current = await readProposalAt(root, proposal.id);
      if (!current.ok) return current;
      if (
        current.value.status !== "ready" ||
        (proposal.status !== "ready" && proposal.status !== "accepted" &&
          proposal.status !== "rejected" && proposal.status !== "superseded" &&
          proposal.status !== "withdrawn") ||
        (proposal.status === "ready" && current.value.staleBase === true &&
          proposal.staleBase !== true) ||
        canonicalJson(proposalImmutableReadyFields(current.value)) !==
          canonicalJson(proposalImmutableReadyFields(proposal))
      ) {
        return storeFailure(
          "E_PROJECT_PROPOSAL",
          `Ready proposal ${proposal.id} may only receive lifecycle-resolution fields.`,
        );
      }
      await atomicWrite(join(root, "proposal.json"), `${canonicalJson(proposal)}\n`);
      return success(proposal);
    } catch (error: unknown) {
      return storeFailure(
        "E_PROJECT_PROPOSAL",
        `Could not update proposal ${proposal.id}: ${errorMessage(error)}`,
      );
    }
  }

  public async archiveProposal(id: string): Promise<Result<Proposal>> {
    if (!isId("prp", id)) {
      return storeFailure("E_PROJECT_PROPOSAL", `Proposal ID ${id} is malformed.`);
    }
    const proposal = await readProposalAt(proposalPath(this.#root, id), id);
    if (!proposal.ok) return proposal;
    try {
      await rename(
        proposalPath(this.#root, id),
        proposalPath(this.#root, id, true),
      );
      await syncDirectory(join(this.#root, "proposals"));
      await syncDirectory(join(this.#root, "history/proposals"));
      return proposal;
    } catch (error: unknown) {
      return storeFailure(
        "E_PROJECT_PROPOSAL",
        `Could not archive proposal ${id}: ${errorMessage(error)}`,
      );
    }
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
        this.#project,
        transaction.operations.some(({ op }) => op === "project.restore")
          ? transaction.versions.tools
          : undefined,
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

    const proposals = await validateActiveProposals(root, journal.value);
    if (!proposals.ok) return proposals;
    const archivedProposals = await validateArchivedProposals(root);
    if (!archivedProposals.ok) return archivedProposals;

    return success(new ProjectStore(root, project, options));
  } catch (error: unknown) {
    return storeFailure(
      "E_PROJECT_OPEN",
      `Project open failed: ${errorMessage(error)}`,
    );
  }
}
