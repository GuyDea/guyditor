import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  isBuiltinLookPresetPinAvailable,
  makeGuyditorError,
  OperationEngine,
} from "../../../core/src/index.js";
import { motionPresetPin } from "../../../compositor/src/index.js";
import { loadPinnedCaptionPreset } from "../../../transcript/src/index.js";
import type {
  AutomationPolicy,
  GuyditorProject,
  GuyditorError,
  PresetPin,
  ProjectStore,
  SkillPin,
} from "../../../core/src/index.js";

import {
  SKILL_CATEGORIES,
} from "./types.js";
import type {
  CreateSkillDraftInput,
  PresetReference,
  ResolvedSkill,
  ResolvedSkillExample,
  SkillCategory,
  SkillExample,
  SkillExamples,
  SkillManifest,
  SkillManifestSource,
  SkillRule,
  SkillRuleStrength,
  SkillScope,
  SkillVersionDiff,
  UpdateSkillDraftInput,
} from "./types.js";

const FORMAT = "guyditor-skill/v1";
const BODY_FILE = "SKILL.md";
const MANIFEST_FILE = "skill.yaml";
const INDEX_FILE = ".registry.json";
const DRAFTS_DIRECTORY = ".drafts";
const PUBLISH_LOCK_FILE = ".publish.lock";
const PUBLISH_LOCK_OWNERS_DIRECTORY = ".publish-locks";
const PUBLISH_RECLAIM_DIRECTORY = ".publish.reclaim";
const PUBLISH_LOCK_FORMAT = "guyditor-skill-publish-lock/v1";
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SKILL_ID = /^skl_[a-z2-7]{10}$/u;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PRESET_REFERENCE = /\b(pre_[a-z2-7]{10})@(0|[1-9][0-9]*)\b/gu;

interface RegistryIndex {
  versions: Record<string, { contentHash: string; name: string; version: string }>;
}

interface PublishLockOwner {
  format: typeof PUBLISH_LOCK_FORMAT;
  token: string;
  pid: number;
  createdAt: string;
}

interface ReadDirectoryResult extends ResolvedSkill {
  source: SkillManifestSource;
  actualHash: string;
}

export interface SkillRegistryOptions {
  globalRoot?: string;
  exampleIdFactory?: () => string;
  now?: () => Date;
  presetResolver?: PresetReferenceResolver;
}

export type PresetReferenceResolver = (
  project: ProjectStore,
  reference: PresetReference,
) => boolean | Promise<boolean>;

export interface ProjectPinOptions {
  appVersion?: string;
  actorId?: string;
}

export interface ProjectPinResult {
  pin: SkillPin;
  transactionId: string;
  revision: string;
}

export interface CaptureSkillExampleInput {
  project: ProjectStore;
  proposalId: string;
  skillId: string;
  decision: "approved" | "rejected";
  description: string;
}

export interface PreferencePackFile {
  path: string;
  sha256: string;
  contentBase64: string;
}

export interface PreferencePack {
  format: "guyditor-preference-pack/v1";
  createdAt: string;
  presets: Array<{ pin: PresetPin; file?: PreferencePackFile }>;
  skills: Array<{ pin: SkillPin; files: PreferencePackFile[] }>;
}

function skillError(
  code: `E_SKILL_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
): GuyditorError {
  return makeGuyditorError(code, message, { affected });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "EEXIST";
}

function isRenameCollision(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function parsePublishLockOwner(value: unknown): PublishLockOwner {
  const source = requiredRecord(value, "publish lock owner");
  const format = requiredString(source["format"], "publish lock owner.format");
  const token = requiredString(source["token"], "publish lock owner.token");
  const pid = source["pid"];
  const createdAt = requiredString(source["createdAt"], "publish lock owner.createdAt");
  if (format !== PUBLISH_LOCK_FORMAT || !/^[0-9a-f-]{36}$/u.test(token) ||
    typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 ||
    !Number.isFinite(Date.parse(createdAt))) {
    throw skillError("E_SKILL_REGISTRY", "Skill publish lock owner metadata is malformed.");
  }
  return { format, token, pid, createdAt };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(isRecord(error) && (error["code"] === "ESRCH" || error["code"] === "EINVAL"));
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw skillError("E_SKILL_FORMAT", `${path} must be an object.`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw skillError("E_SKILL_FORMAT", `${path} must be a non-empty string.`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw skillError("E_SKILL_FORMAT", `${path} contains unsupported fields: ${extras.join(", ")}.`);
  }
}

function parseCategory(value: unknown, path: string): SkillCategory {
  const category = requiredString(value, path);
  if (!SKILL_CATEGORIES.includes(category as SkillCategory)) {
    throw skillError("E_SKILL_FORMAT", `${path} must use the §9.5 category enum.`);
  }
  return category as SkillCategory;
}

function parseRule(value: unknown, path: string): SkillRule {
  const source = requiredRecord(value, path);
  exactKeys(source, ["id", "category", "strength", "text"], path);
  const strength = requiredString(source["strength"], `${path}.strength`);
  if (strength !== "must" && strength !== "prefer" && strength !== "avoid") {
    throw skillError("E_SKILL_FORMAT", `${path}.strength must be must, prefer, or avoid.`);
  }
  return {
    id: requiredString(source["id"], `${path}.id`),
    category: parseCategory(source["category"], `${path}.category`),
    strength: strength as SkillRuleStrength,
    text: requiredString(source["text"], `${path}.text`),
  };
}

function parseExample(value: unknown, path: string): SkillExample {
  const source = requiredRecord(value, path);
  exactKeys(source, ["id", "description", "media", "provenance"], path);
  const mediaSource = source["media"] === undefined
    ? undefined
    : requiredRecord(source["media"], `${path}.media`);
  if (mediaSource !== undefined) exactKeys(mediaSource, ["path", "sha256"], `${path}.media`);
  const provenanceSource = source["provenance"] === undefined
    ? undefined
    : requiredRecord(source["provenance"], `${path}.provenance`);
  if (provenanceSource !== undefined) {
    exactKeys(provenanceSource, ["projectId", "revision"], `${path}.provenance`);
  }
  const media = mediaSource === undefined ? undefined : {
    path: requiredString(mediaSource["path"], `${path}.media.path`),
    sha256: requiredString(mediaSource["sha256"], `${path}.media.sha256`),
  };
  if (media !== undefined && !SHA256.test(media.sha256)) {
    throw skillError("E_SKILL_FORMAT", `${path}.media.sha256 must be a SHA-256 digest.`);
  }
  return {
    id: requiredString(source["id"], `${path}.id`),
    description: requiredString(source["description"], `${path}.description`),
    ...(media === undefined ? {} : { media }),
    ...(provenanceSource === undefined ? {} : {
      provenance: {
        projectId: requiredString(provenanceSource["projectId"], `${path}.provenance.projectId`),
        revision: requiredString(provenanceSource["revision"], `${path}.provenance.revision`),
      },
    }),
  };
}

function parseExampleList(value: unknown, path: string): SkillExample[] {
  if (!Array.isArray(value)) throw skillError("E_SKILL_FORMAT", `${path} must be an array.`);
  const examples = value.map((entry, index) => parseExample(entry, `${path}[${String(index)}]`));
  if (new Set(examples.map(({ id }) => id)).size !== examples.length) {
    throw skillError("E_SKILL_FORMAT", `${path} contains duplicate example IDs.`);
  }
  return examples;
}

function parseManifest(value: unknown): SkillManifestSource {
  const source = requiredRecord(value, "skill.yaml");
  exactKeys(source, [
    "format", "id", "name", "version", "title", "categories", "summary",
    "rules", "examples", "body",
  ], "skill.yaml");
  const format = requiredString(source["format"], "skill.yaml.format");
  if (format !== FORMAT) throw skillError("E_SKILL_FORMAT", `Unsupported skill format ${format}.`);
  const id = requiredString(source["id"], "skill.yaml.id");
  const name = requiredString(source["name"], "skill.yaml.name");
  const version = requiredString(source["version"], "skill.yaml.version");
  const body = requiredString(source["body"], "skill.yaml.body");
  if (!SKILL_ID.test(id)) throw skillError("E_SKILL_FORMAT", `Skill ID ${id} is malformed.`, [id]);
  if (!SKILL_NAME.test(name)) throw skillError("E_SKILL_FORMAT", `Skill name ${name} is not path-safe.`, [id]);
  if (!SEMVER.test(version)) throw skillError("E_SKILL_FORMAT", `Skill version ${version} is not immutable semver.`, [id]);
  if (body !== BODY_FILE) throw skillError("E_SKILL_FORMAT", `skill.yaml.body must be ${BODY_FILE}.`, [id]);
  if (!Array.isArray(source["categories"]) || source["categories"].length === 0) {
    throw skillError("E_SKILL_FORMAT", "skill.yaml.categories must be a non-empty array.", [id]);
  }
  if (!Array.isArray(source["rules"])) {
    throw skillError("E_SKILL_FORMAT", "skill.yaml.rules must be an array.", [id]);
  }
  const examples = requiredRecord(source["examples"], "skill.yaml.examples");
  exactKeys(examples, ["approved", "rejected"], "skill.yaml.examples");
  const rules = source["rules"].map((entry, index) => parseRule(entry, `skill.yaml.rules[${String(index)}]`));
  if (new Set(rules.map(({ id: ruleId }) => ruleId)).size !== rules.length) {
    throw skillError("E_SKILL_FORMAT", "skill.yaml.rules contains duplicate rule IDs.", [id]);
  }
  const approved = parseExampleList(examples["approved"], "skill.yaml.examples.approved");
  const rejected = parseExampleList(examples["rejected"], "skill.yaml.examples.rejected");
  if (new Set([...approved, ...rejected].map(({ id: exampleId }) => exampleId)).size !== approved.length + rejected.length) {
    throw skillError("E_SKILL_FORMAT", "Approved and rejected examples must have unique IDs.", [id]);
  }
  return {
    format: FORMAT,
    id,
    name,
    version,
    title: requiredString(source["title"], "skill.yaml.title"),
    categories: source["categories"].map((entry, index) =>
      parseCategory(entry, `skill.yaml.categories[${String(index)}]`)),
    summary: requiredString(source["summary"], "skill.yaml.summary"),
    rules,
    examples: { approved, rejected },
    body: BODY_FILE,
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw skillError("E_SKILL_FORMAT", "Skill examples contain a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  throw skillError("E_SKILL_FORMAT", `Skill examples contain unsupported ${typeof value}.`);
}

function contentHash(manifestText: string, body: string, examples: SkillExamples): string {
  return createHash("sha256")
    .update(`${MANIFEST_FILE}\0${manifestText}\0${BODY_FILE}\0${body}\0examples\0${canonical(examples)}`)
    .digest("hex");
}

function manifestFromSource(source: SkillManifestSource, hash: string): SkillManifest {
  return {
    id: source.id,
    name: source.name,
    version: source.version,
    title: source.title,
    categories: source.categories,
    summary: source.summary,
    rules: source.rules,
    examples: source.examples,
    contentHash: hash,
  };
}

function serializeManifest(source: SkillManifestSource): string {
  return stringifyYaml(source, { lineWidth: 0 });
}

function versionTuple(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (match === null) throw skillError("E_SKILL_FORMAT", `Version ${version} is not semver.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const a = versionTuple(left);
  const b = versionTuple(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function generatedExampleId(): string {
  return `ex_${createHash("sha256").update(`${Date.now().toString()}-${Math.random().toString()}`)
    .digest("hex").slice(0, 12)}`;
}

function nextPatch(version: string): string {
  const [major, minor, patch] = versionTuple(version);
  return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
}

function operationReferences(text: string): string[] {
  return [...new Set(text.match(/\b[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)+\b/gu) ?? [])];
}

function presetReferences(source: SkillManifestSource, body: string): PresetReference[] {
  const found = new Map<string, PresetReference>();
  const text = [source.summary, ...source.rules.map(({ text: ruleText }) => ruleText), body].join("\n");
  for (const match of text.matchAll(PRESET_REFERENCE)) {
    const id = match[1];
    const version = match[2];
    if (id !== undefined && version !== undefined) {
      found.set(`${id}@${version}`, { id, version: Number(version) });
    }
  }
  return [...found.values()].sort((left, right) =>
    left.id.localeCompare(right.id) || left.version - right.version);
}

async function defaultPresetResolver(
  project: ProjectStore,
  reference: PresetReference,
): Promise<boolean> {
  const pin = project.currentProject.presets.find(({ id, version }) =>
    id === reference.id && version === reference.version);
  if (pin === undefined) return false;
  try {
    if (pin.kind === "caption") {
      const presetsRoot = resolve(project.root, "presets");
      const path = resolve(project.root, pin.path);
      if (!path.startsWith(`${presetsRoot}${sep}`)) return false;
      await loadPinnedCaptionPreset(project.root, pin);
      return true;
    }
    if (pin.kind === "motion") {
      const installed = motionPresetPin(pin.id, pin.version);
      return installed.id === pin.id &&
        installed.name === pin.name &&
        installed.path === pin.path &&
        installed.sha256 === pin.sha256;
    }
    if (pin.kind === "look") return isBuiltinLookPresetPinAvailable(pin);
    return false;
  } catch (error: unknown) {
    if (isMissing(error) || error instanceof TypeError ||
      (isRecord(error) && typeof error["code"] === "string")) return false;
    throw error;
  }
}

function safeMediaPath(directory: string, mediaPath: string): string {
  const examplesRoot = resolve(directory, "examples");
  const candidate = resolve(directory, mediaPath);
  if (!mediaPath.startsWith("examples/") || (candidate !== examplesRoot && !candidate.startsWith(`${examplesRoot}${sep}`))) {
    throw skillError("E_SKILL_FORMAT", `Example path ${mediaPath} must stay inside examples/.`);
  }
  return candidate;
}

async function validateDirectoryLayout(directory: string): Promise<void> {
  const topLevel = await readdir(directory, { withFileTypes: true });
  const examples = topLevel.find(({ name }) => name === "examples");
  if (examples === undefined || !examples.isDirectory()) {
    throw skillError("E_SKILL_FORMAT", "Skill packages must contain an examples/ directory.");
  }
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const parent = entry.parentPath;
    const path = join(parent, entry.name);
    const child = relative(directory, path).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      throw skillError("E_SKILL_FORMAT", `Skill packages may not contain symbolic links (${child}).`);
    }
    if (entry.isDirectory()) {
      if (child !== "examples" && !child.startsWith("examples/")) {
        throw skillError("E_SKILL_FORMAT", `Unexpected skill directory ${child}.`);
      }
    } else if (child !== MANIFEST_FILE && child !== BODY_FILE && !child.startsWith("examples/")) {
      throw skillError("E_SKILL_FORMAT", `Unexpected skill file ${child}.`);
    }
  }
}

async function readDirectory(directory: string, expectedHash?: string): Promise<ReadDirectoryResult> {
  await validateDirectoryLayout(directory);
  const [manifestText, body] = await Promise.all([
    readFile(join(directory, MANIFEST_FILE), "utf8"),
    readFile(join(directory, BODY_FILE), "utf8"),
  ]);
  const source = parseManifest(parseYaml(manifestText, { schema: "core" }) as unknown);
  const resolveExamples = async (examples: readonly SkillExample[]): Promise<ResolvedSkillExample[]> =>
    Promise.all(examples.map(async (example) => {
      if (example.media === undefined) return { example };
      const bytes = await readFile(safeMediaPath(directory, example.media.path));
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== example.media.sha256) {
        throw skillError(
          "E_SKILL_EXAMPLE_HASH",
          `Example ${example.id} expected ${example.media.sha256}, received ${actual}.`,
          [source.id, example.id],
        );
      }
      if (!example.media.path.endsWith(".json")) return { example };
      try {
        return { example, payload: JSON.parse(bytes.toString("utf8")) as unknown };
      } catch (error: unknown) {
        throw skillError(
          "E_SKILL_EXAMPLE_FORMAT",
          `Example ${example.id} JSON is malformed: ${errorMessage(error)}.`,
          [source.id, example.id],
        );
      }
    }));
  const [approvedContents, rejectedContents] = await Promise.all([
    resolveExamples(source.examples.approved),
    resolveExamples(source.examples.rejected),
  ]);
  const actualHash = contentHash(manifestText, body, source.examples);
  return {
    source,
    manifest: manifestFromSource(source, expectedHash ?? actualHash),
    body,
    presetReferences: presetReferences(source, body),
    exampleContents: { approved: approvedContents, rejected: rejectedContents },
    actualHash,
  };
}

function resolvedSkill(read: ReadDirectoryResult): ResolvedSkill {
  return {
    manifest: read.manifest,
    body: read.body,
    presetReferences: read.presetReferences,
    ...(read.exampleContents === undefined ? {} : { exampleContents: read.exampleContents }),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function relativePackPath(root: string, path: string): string {
  const child = relative(root, path).split(sep).join("/");
  if (child.length === 0 || child === ".." || child.startsWith("../") || child.startsWith("/")) {
    throw skillError("E_SKILL_PACK", `Preference-pack path ${child || "."} escapes its package root.`);
  }
  return child;
}

async function packFiles(root: string): Promise<PreferencePackFile[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: PreferencePackFile[] = [];
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw skillError("E_SKILL_PACK", "Preference packs may not contain symbolic links.");
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(path);
    files.push({
      path: relativePackPath(root, path),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentBase64: bytes.toString("base64"),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function packedBytes(file: PreferencePackFile): Buffer {
  if (!SHA256.test(file.sha256) || file.path.length === 0) {
    throw skillError("E_SKILL_PACK", "Preference pack contains malformed file metadata.");
  }
  const bytes = Buffer.from(file.contentBase64, "base64");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== file.sha256) {
    throw skillError("E_SKILL_PACK", `Preference-pack file ${file.path} failed its SHA-256 check.`);
  }
  return bytes;
}

async function writePackedFile(root: string, file: PreferencePackFile): Promise<void> {
  const destination = resolve(root, file.path);
  const rootPath = resolve(root);
  if (!destination.startsWith(`${rootPath}${sep}`)) {
    throw skillError("E_SKILL_PACK", `Preference-pack file ${file.path} escapes its destination.`);
  }
  const bytes = packedBytes(file);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await writeFile(destination, bytes, { flag: "wx" });
  } catch (error: unknown) {
    if (!isRecord(error) || error["code"] !== "EEXIST") throw error;
    const existing = await readFile(destination);
    if (createHash("sha256").update(existing).digest("hex") !== file.sha256) {
      throw skillError("E_SKILL_PACK", `Immutable destination ${file.path} already differs.`);
    }
  }
}

function indexKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function exampleIds(examples: readonly SkillExample[]): Set<string> {
  return new Set(examples.map(({ id }) => id));
}

function exampleDiff(before: readonly SkillExample[], after: readonly SkillExample[]) {
  const a = exampleIds(before);
  const b = exampleIds(after);
  return {
    added: [...b].filter((id) => !a.has(id)).sort(),
    removed: [...a].filter((id) => !b.has(id)).sort(),
    unchanged: [...a].filter((id) => b.has(id)).sort(),
  };
}

export class SkillRegistry {
  readonly #globalRoot: string;
  readonly #exampleIdFactory: () => string;
  readonly #now: () => Date;
  readonly #presetResolver: PresetReferenceResolver;
  #publishLock: Promise<void> = Promise.resolve();

  public constructor(options: SkillRegistryOptions = {}) {
    this.#globalRoot = resolve(options.globalRoot ?? join(homedir(), ".guyditor", "skills"));
    this.#exampleIdFactory = options.exampleIdFactory ?? generatedExampleId;
    this.#now = options.now ?? (() => new Date());
    this.#presetResolver = options.presetResolver ?? defaultPresetResolver;
  }

  public get globalRoot(): string {
    return this.#globalRoot;
  }

  async #readIndex(): Promise<RegistryIndex> {
    try {
      const parsed = JSON.parse(await readFile(join(this.#globalRoot, INDEX_FILE), "utf8")) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed["versions"])) {
        throw skillError("E_SKILL_REGISTRY", "Skill registry index is malformed.");
      }
      return parsed as unknown as RegistryIndex;
    } catch (error: unknown) {
      if (isMissing(error)) return { versions: {} };
      throw error;
    }
  }

  async #writeIndex(index: RegistryIndex): Promise<void> {
    await mkdir(this.#globalRoot, { recursive: true });
    const temporary = join(
      this.#globalRoot,
      `${INDEX_FILE}.${process.pid.toString()}.${randomUUID()}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(temporary, join(this.#globalRoot, INDEX_FILE));
  }

  async #withPublishLock<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.#publishLock;
    let release = (): void => undefined;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    this.#publishLock = previous.then(() => current);
    await previous;
    try {
      return await this.#withFilesystemPublishLock(operation);
    } finally {
      release();
    }
  }

  async #withFilesystemPublishLock<Value>(operation: () => Promise<Value>): Promise<Value> {
    await mkdir(this.#globalRoot, { recursive: true });
    const ownersDirectory = join(this.#globalRoot, PUBLISH_LOCK_OWNERS_DIRECTORY);
    await mkdir(ownersDirectory, { recursive: true });
    const lockFile = join(this.#globalRoot, PUBLISH_LOCK_FILE);
    const token = randomUUID();
    const ownerPath = join(ownersDirectory, `${token}.json`);
    const owner: PublishLockOwner = {
      format: PUBLISH_LOCK_FORMAT,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
    let acquired = false;
    try {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        try {
          await link(ownerPath, lockFile);
          acquired = true;
          break;
        } catch (error: unknown) {
          if (!isAlreadyExists(error)) throw error;
          await this.#reclaimDeadPublishLock(lockFile, ownersDirectory);
          await delay(10);
        }
      }
      if (!acquired) {
        throw skillError(
          "E_SKILL_REGISTRY",
          `Skill registry ${this.#globalRoot} remained busy for 10 seconds.`,
        );
      }
      return await operation();
    } finally {
      if (acquired) {
        try {
          const current = parsePublishLockOwner(JSON.parse(await readFile(lockFile, "utf8")) as unknown);
          if (current.token === token) await rm(lockFile, { force: true });
        } catch (error: unknown) {
          if (!isMissing(error)) throw error;
        }
      }
      await rm(ownerPath, { force: true });
    }
  }

  async #reclaimDeadPublishLock(lockFile: string, ownersDirectory: string): Promise<void> {
    const reclaimDirectory = join(this.#globalRoot, PUBLISH_RECLAIM_DIRECTORY);
    await this.#withReclaimLease(reclaimDirectory, async () => {
      let owner: PublishLockOwner;
      try {
        owner = parsePublishLockOwner(JSON.parse(await readFile(lockFile, "utf8")) as unknown);
      } catch (error: unknown) {
        if (isMissing(error)) return;
        throw error;
      }
      if (processIsAlive(owner.pid)) return;
      await rm(lockFile, { force: true });
      await rm(join(ownersDirectory, `${owner.token}.json`), { force: true });
    });
  }

  async #withReclaimLease(
    reclaimDirectory: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const token = randomUUID();
    const candidate = join(this.#globalRoot, `.publish.reclaim.${token}.candidate`);
    const owner: PublishLockOwner = {
      format: PUBLISH_LOCK_FORMAT,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    await mkdir(candidate);
    await writeFile(join(candidate, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
    let acquired = false;
    try {
      try {
        await rename(candidate, reclaimDirectory);
        acquired = true;
      } catch (error: unknown) {
        if (!isRenameCollision(error)) throw error;
      }
      if (!acquired) {
        let existing: PublishLockOwner;
        try {
          existing = parsePublishLockOwner(JSON.parse(
            await readFile(join(reclaimDirectory, "owner.json"), "utf8"),
          ) as unknown);
        } catch (error: unknown) {
          if (isMissing(error)) return;
          throw error;
        }
        if (processIsAlive(existing.pid)) return;
        const tombstone = join(
          this.#globalRoot,
          `.publish.reclaim.${existing.token}.${randomUUID()}.stale`,
        );
        try {
          await rename(reclaimDirectory, tombstone);
        } catch (error: unknown) {
          if (isMissing(error)) return;
          throw error;
        }
        const claimed = parsePublishLockOwner(JSON.parse(
          await readFile(join(tombstone, "owner.json"), "utf8"),
        ) as unknown);
        if (claimed.token === existing.token && !processIsAlive(claimed.pid)) {
          await rm(tombstone, { recursive: true, force: true });
        } else {
          try {
            await rename(tombstone, reclaimDirectory);
          } catch (error: unknown) {
            if (!isRenameCollision(error)) throw error;
          }
        }
        return;
      }
      await operation();
    } finally {
      await rm(candidate, { recursive: true, force: true });
      if (acquired) {
        try {
          const current = parsePublishLockOwner(JSON.parse(
            await readFile(join(reclaimDirectory, "owner.json"), "utf8"),
          ) as unknown);
          if (current.token === token) {
            await rm(reclaimDirectory, { recursive: true, force: true });
          }
        } catch (error: unknown) {
          if (!isMissing(error)) throw error;
        }
      }
    }
  }

  async #cleanupAbandonedStagingDirectories(): Promise<void> {
    const entries = await readdir(this.#globalRoot, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) =>
        entry.isDirectory() && /^\.publish\.[0-9]+\.[0-9a-f-]{36}\.tmp$/u.test(entry.name))
      .map(({ name }) => rm(join(this.#globalRoot, name), { recursive: true, force: true })));
  }

  #publishedDirectory(name: string, version: string): string {
    return join(this.#globalRoot, name, version);
  }

  #draftDirectory(name: string, version: string): string {
    return join(this.#globalRoot, DRAFTS_DIRECTORY, name, version);
  }

  public async publish(directory: string): Promise<SkillManifest> {
    return this.#withPublishLock(() => this.#publishUnlocked(directory));
  }

  async #publishUnlocked(directory: string): Promise<SkillManifest> {
    let read: ReadDirectoryResult;
    try {
      read = await readDirectory(resolve(directory));
    } catch (error: unknown) {
      if (isRecord(error) && typeof error["code"] === "string") throw error;
      throw skillError("E_SKILL_FORMAT", `Could not read skill package: ${errorMessage(error)}.`);
    }
    const destination = this.#publishedDirectory(read.source.name, read.source.version);
    const index = await this.#readIndex();
    await this.#cleanupAbandonedStagingDirectories();
    const key = indexKey(read.source.id, read.source.version);
    const destinationExists = await pathExists(destination);
    if (destinationExists && index.versions[key] === undefined) {
      let orphan: ReadDirectoryResult | undefined;
      try {
        orphan = await readDirectory(destination);
      } catch {
        orphan = undefined;
      }
      if (orphan?.source.id === read.source.id &&
        orphan.source.name === read.source.name &&
        orphan.source.version === read.source.version &&
        orphan.actualHash === read.actualHash) {
        index.versions[key] = {
          contentHash: orphan.actualHash,
          name: orphan.source.name,
          version: orphan.source.version,
        };
        try {
          await this.#writeIndex(index);
        } catch (error: unknown) {
          delete index.versions[key];
          throw skillError(
            "E_SKILL_PUBLISH",
            `Could not recover installed skill: ${errorMessage(error)}.`,
            [read.source.id],
          );
        }
        return manifestFromSource(orphan.source, orphan.actualHash);
      }
      const quarantine = join(
        this.#globalRoot,
        ".orphans",
        `${read.source.name}-${read.source.version}-${randomUUID()}`,
      );
      await mkdir(dirname(quarantine), { recursive: true });
      await rename(destination, quarantine);
    }
    if (index.versions[key] !== undefined) {
      throw skillError(
        "E_SKILL_IMMUTABLE",
        `Published skill ${read.source.id}@${read.source.version} is immutable.`,
        [read.source.id],
      );
    }
    const existingIdentity = Object.entries(index.versions).find(([key, entry]) =>
      entry.name === read.source.name && !key.startsWith(`${read.source.id}@`));
    const existingName = Object.entries(index.versions).find(([key]) =>
      key.startsWith(`${read.source.id}@`))?.[1];
    if (existingIdentity !== undefined) {
      throw skillError("E_SKILL_IDENTITY", `Skill name ${read.source.name} already belongs to another ID.`);
    }
    if (existingName !== undefined && existingName.name !== read.source.name) {
      throw skillError("E_SKILL_IDENTITY", `Skill ${read.source.id} cannot change its name.`);
    }
    await mkdir(dirname(destination), { recursive: true });
    const staging = join(
      this.#globalRoot,
      `.publish.${process.pid.toString()}.${randomUUID()}.tmp`,
    );
    try {
      await cp(resolve(directory), staging, { recursive: true, force: false, errorOnExist: true });
    } catch (error: unknown) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw skillError("E_SKILL_PUBLISH", `Could not publish skill: ${errorMessage(error)}.`, [read.source.id]);
    }
    try {
      await rename(staging, destination);
    } catch (error: unknown) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw skillError("E_SKILL_PUBLISH", `Could not install skill: ${errorMessage(error)}.`, [read.source.id]);
    }
    index.versions[key] = {
      contentHash: read.actualHash,
      name: read.source.name,
      version: read.source.version,
    };
    try {
      await this.#writeIndex(index);
    } catch (error: unknown) {
      delete index.versions[key];
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      throw skillError(
        "E_SKILL_PUBLISH",
        `Could not index published skill: ${errorMessage(error)}.`,
        [read.source.id],
      );
    }
    return manifestFromSource(read.source, read.actualHash);
  }

  public async versions(skillId: string): Promise<string[]> {
    const index = await this.#readIndex();
    return Object.entries(index.versions)
      .filter(([key]) => key.startsWith(`${skillId}@`))
      .map(([, entry]) => entry.version)
      .sort(compareVersions);
  }

  async #indexedEntry(skillId: string, version?: string): Promise<{
    contentHash: string;
    name: string;
    version: string;
  }> {
    const index = await this.#readIndex();
    const selectedVersion = version ?? (await this.versions(skillId)).at(-1);
    const entry = selectedVersion === undefined
      ? undefined
      : index.versions[indexKey(skillId, selectedVersion)];
    if (entry === undefined) {
      throw skillError("E_SKILL_NOT_FOUND", `Skill ${skillId}${version === undefined ? "" : `@${version}`} is not published.`, [skillId]);
    }
    return entry;
  }

  public async get(skillId: string, version?: string): Promise<ResolvedSkill> {
    const entry = await this.#indexedEntry(skillId, version);
    const read = await readDirectory(
      this.#publishedDirectory(entry.name, entry.version),
      entry.contentHash,
    );
    if (read.source.id !== skillId || read.source.version !== entry.version) {
      throw skillError("E_SKILL_IDENTITY", `Published skill directory does not match ${skillId}@${entry.version}.`, [skillId]);
    }
    if (read.actualHash !== entry.contentHash) {
      throw skillError(
        "E_SKILL_HASH",
        `Published skill ${skillId}@${entry.version} expected ${entry.contentHash}, received ${read.actualHash}.`,
        [skillId],
      );
    }
    return resolvedSkill(read);
  }

  public async list(scope: SkillScope, project?: ProjectStore): Promise<SkillManifest[]> {
    if (scope === "project") {
      if (project === undefined) return [];
      return (await this.pinned(project)).map(({ manifest }) => manifest);
    }
    const index = await this.#readIndex();
    const values = await Promise.all(Object.keys(index.versions).map(async (key) => {
      const separator = key.lastIndexOf("@");
      return (await this.get(key.slice(0, separator), key.slice(separator + 1))).manifest;
    }));
    const global = values.sort((left, right) =>
      left.name.localeCompare(right.name) || compareVersions(left.version, right.version));
    if (scope === "global" || project === undefined) return global;
    const projectManifests = (await this.pinned(project)).map(({ manifest }) => manifest);
    const combined = new Map(global.map((manifest) => [indexKey(manifest.id, manifest.version), manifest]));
    for (const manifest of projectManifests) {
      combined.set(indexKey(manifest.id, manifest.version), manifest);
    }
    return [...combined.values()].sort((left, right) =>
      left.name.localeCompare(right.name) || compareVersions(left.version, right.version));
  }

  public async verify(skillId: string, version: string): Promise<{
    ok: boolean;
    expected: string;
    actual: string;
  }> {
    const entry = await this.#indexedEntry(skillId, version);
    const read = await readDirectory(this.#publishedDirectory(entry.name, entry.version));
    return { ok: read.actualHash === entry.contentHash, expected: entry.contentHash, actual: read.actualHash };
  }

  async #createDraftFromDirectory(
    baseDirectory: string,
    skillId: string,
    version: string,
  ): Promise<ResolvedSkill> {
    if (!SEMVER.test(version)) {
      throw skillError("E_SKILL_FORMAT", `Draft version ${version} is not semver.`, [skillId]);
    }
    const base = await readDirectory(baseDirectory);
    if (base.manifest.id !== skillId) {
      throw skillError("E_SKILL_IDENTITY", `Draft base does not match ${skillId}.`, [skillId]);
    }
    const destination = this.#draftDirectory(base.manifest.name, version);
    if (await pathExists(destination) || (await this.versions(skillId)).includes(version)) {
      throw skillError("E_SKILL_DRAFT_EXISTS", `Skill draft ${skillId}@${version} already exists.`, [skillId]);
    }
    await mkdir(dirname(destination), { recursive: true });
    await cp(baseDirectory, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const source = { ...base.source, version };
    await writeFile(join(destination, MANIFEST_FILE), serializeManifest(source), "utf8");
    return resolvedSkill(await readDirectory(destination));
  }

  public async createDraft(input: CreateSkillDraftInput): Promise<ResolvedSkill> {
    const base = await this.get(input.base.skillId, input.base.version);
    return this.#createDraftFromDirectory(
      this.#publishedDirectory(base.manifest.name, input.base.version),
      input.base.skillId,
      input.version,
    );
  }

  public async updateDraft(input: UpdateSkillDraftInput): Promise<ResolvedSkill> {
    const indexEntry = await this.#indexedEntry(input.skillId).catch(() => undefined);
    if (indexEntry === undefined) {
      throw skillError("E_SKILL_NOT_FOUND", `Skill ${input.skillId} is not published.`, [input.skillId]);
    }
    const directory = this.#draftDirectory(indexEntry.name, input.version);
    if (!await pathExists(directory)) {
      throw skillError("E_SKILL_DRAFT_NOT_FOUND", `Skill draft ${input.skillId}@${input.version} does not exist.`, [input.skillId]);
    }
    const read = await readDirectory(directory);
    const source: SkillManifestSource = {
      ...read.source,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.categories === undefined ? {} : { categories: structuredClone(input.categories) }),
      ...(input.rules === undefined ? {} : { rules: structuredClone(input.rules) }),
      ...(input.examples === undefined ? {} : { examples: structuredClone(input.examples) }),
    };
    await writeFile(join(directory, MANIFEST_FILE), serializeManifest(source), "utf8");
    if (input.body !== undefined) await writeFile(join(directory, BODY_FILE), input.body, "utf8");
    const updated = await readDirectory(directory);
    return resolvedSkill(updated);
  }

  public async drafts(skillId?: string): Promise<ResolvedSkill[]> {
    let names: string[];
    try {
      names = (await readdir(join(this.#globalRoot, DRAFTS_DIRECTORY), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(({ name }) => name);
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
    const values: ResolvedSkill[] = [];
    for (const name of names) {
      const versions = (await readdir(join(this.#globalRoot, DRAFTS_DIRECTORY, name), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && SEMVER.test(entry.name))
        .map(({ name: version }) => version)
        .sort(compareVersions);
      for (const version of versions) {
        const read = await readDirectory(this.#draftDirectory(name, version));
        if (skillId === undefined || read.source.id === skillId) {
          values.push(resolvedSkill(read));
        }
      }
    }
    return values.sort((left, right) =>
      left.manifest.name.localeCompare(right.manifest.name) ||
      compareVersions(left.manifest.version, right.manifest.version));
  }

  public async deleteDraft(skillId: string, version: string): Promise<void> {
    const draft = (await this.drafts(skillId)).find(({ manifest }) => manifest.version === version);
    if (draft === undefined) {
      throw skillError("E_SKILL_DRAFT_NOT_FOUND", `Skill draft ${skillId}@${version} does not exist.`, [skillId]);
    }
    await rm(this.#draftDirectory(draft.manifest.name, version), { recursive: true, force: false });
  }

  public async publishDraft(skillId: string, version: string): Promise<SkillManifest> {
    const draft = (await this.drafts(skillId)).find(({ manifest }) => manifest.version === version);
    if (draft === undefined) {
      throw skillError("E_SKILL_DRAFT_NOT_FOUND", `Skill draft ${skillId}@${version} does not exist.`, [skillId]);
    }
    const directory = this.#draftDirectory(draft.manifest.name, version);
    const published = await this.publish(directory);
    await rm(directory, { recursive: true, force: false });
    return published;
  }

  public async diff(
    skillId: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<SkillVersionDiff> {
    const [before, after] = await Promise.all([
      this.#getPublishedOrDraft(skillId, fromVersion),
      this.#getPublishedOrDraft(skillId, toVersion),
    ]);
    const beforeRules = new Map(before.manifest.rules.map((rule) => [rule.id, rule]));
    const afterRules = new Map(after.manifest.rules.map((rule) => [rule.id, rule]));
    const added = [...afterRules].filter(([id]) => !beforeRules.has(id)).map(([, rule]) => rule);
    const removed = [...beforeRules].filter(([id]) => !afterRules.has(id)).map(([, rule]) => rule);
    const changed = [...beforeRules].flatMap(([id, prior]) => {
      const next = afterRules.get(id);
      return next === undefined || canonical(prior) === canonical(next)
        ? []
        : [{ id, before: prior, after: next }];
    });
    return {
      skillId,
      fromVersion,
      toVersion,
      metadata: {
        title: { before: before.manifest.title, after: after.manifest.title },
        summary: { before: before.manifest.summary, after: after.manifest.summary },
        categories: {
          before: before.manifest.categories,
          after: after.manifest.categories,
        },
      },
      rules: { added, removed, changed },
      examples: {
        approved: exampleDiff(before.manifest.examples.approved, after.manifest.examples.approved),
        rejected: exampleDiff(before.manifest.examples.rejected, after.manifest.examples.rejected),
      },
      body: { before: before.body, after: after.body },
    };
  }

  async #getPublishedOrDraft(skillId: string, version: string): Promise<ResolvedSkill> {
    try {
      return await this.get(skillId, version);
    } catch (error: unknown) {
      if (!isRecord(error) || error["code"] !== "E_SKILL_NOT_FOUND") throw error;
      const draft = (await this.drafts(skillId)).find(({ manifest }) =>
        manifest.version === version);
      if (draft === undefined) throw error;
      return draft;
    }
  }

  async #materializeSnapshot(project: ProjectStore, skill: ResolvedSkill): Promise<{
    pin: SkillPin;
    created: boolean;
  }> {
    const verified = await this.verify(skill.manifest.id, skill.manifest.version);
    if (!verified.ok) {
      throw skillError(
        "E_SKILL_HASH",
        `Global skill ${skill.manifest.id}@${skill.manifest.version} expected ${verified.expected}, received ${verified.actual}.`,
        [skill.manifest.id],
      );
    }
    const pin: SkillPin = {
      id: skill.manifest.id,
      name: skill.manifest.name,
      version: skill.manifest.version,
      path: `skills/${skill.manifest.name}/${skill.manifest.version}/`,
      contentHash: skill.manifest.contentHash,
    };
    const destination = resolve(project.root, pin.path);
    const skillsRoot = resolve(project.root, "skills");
    if (!destination.startsWith(`${skillsRoot}${sep}`)) {
      throw skillError("E_SKILL_PATH", `Skill snapshot path ${pin.path} escapes the project.`, [pin.id]);
    }
    if (await pathExists(destination)) {
      const existing = await readDirectory(destination);
      if (
        existing.source.id !== pin.id || existing.source.version !== pin.version ||
        existing.actualHash !== pin.contentHash
      ) {
        throw skillError(
          "E_SKILL_IMMUTABLE",
          `Existing project snapshot ${pin.path} differs from ${pin.id}@${pin.version}.`,
          [pin.id],
        );
      }
      return { pin, created: false };
    }
    const temporary = `${destination}.tmp-${process.pid.toString()}`;
    await mkdir(dirname(destination), { recursive: true });
    try {
      await cp(
        this.#publishedDirectory(skill.manifest.name, skill.manifest.version),
        temporary,
        { recursive: true, force: false, errorOnExist: true },
      );
      await rename(temporary, destination);
      return { pin, created: true };
    } catch (error: unknown) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw skillError(
        "E_SKILL_SNAPSHOT",
        `Could not snapshot ${pin.id}@${pin.version}: ${errorMessage(error)}.`,
        [pin.id],
      );
    }
  }

  async #pinProject(
    project: ProjectStore,
    skillId: string,
    version: string,
    options: ProjectPinOptions,
  ): Promise<ProjectPinResult> {
    const skill = await this.get(skillId, version);
    await this.#verifyPresetReferences(project, skill);
    const snapshot = await this.#materializeSnapshot(project, skill);
    const engine = new OperationEngine(project.currentProject, {
      appVersion: options.appVersion ?? "0.0.0",
      committer: project,
    });
    const result = await engine.execute([{
      op: "skill.pin.set",
      params: { skillId, pin: snapshot.pin },
    }], {
      baseRevision: project.currentProject.revision,
      origin: "ui",
      dryRun: false,
      recordUndo: false,
      actor: { kind: "human", id: options.actorId ?? "ui" },
      instruction: {
        kind: "skill-policy",
        text: `Pin ${snapshot.pin.name} at ${snapshot.pin.version}`,
      },
    });
    if (!result.ok) {
      if (snapshot.created) await rm(resolve(project.root, snapshot.pin.path), {
        recursive: true,
        force: true,
      });
      throw result.error;
    }
    if (result.value.transactionId === undefined) {
      throw skillError("E_SKILL_PIN", `Pinning ${skillId} did not produce a transaction.`, [skillId]);
    }
    return {
      pin: snapshot.pin,
      transactionId: result.value.transactionId,
      revision: project.currentProject.revision,
    };
  }

  public async associateProject(
    project: ProjectStore,
    skillId: string,
    version: string,
    options: ProjectPinOptions = {},
  ): Promise<ProjectPinResult> {
    if (project.currentProject.skills.some(({ id }) => id === skillId)) {
      throw skillError("E_SKILL_ALREADY_PINNED", `Skill ${skillId} is already associated with this project.`, [skillId]);
    }
    return this.#pinProject(project, skillId, version, options);
  }

  public async upgradeProject(
    project: ProjectStore,
    skillId: string,
    version: string,
    options: ProjectPinOptions = {},
  ): Promise<ProjectPinResult> {
    const current = project.currentProject.skills.find(({ id }) => id === skillId);
    if (current === undefined) {
      throw skillError("E_SKILL_NOT_PINNED", `Skill ${skillId} is not associated with this project.`, [skillId]);
    }
    if (current.version === version) {
      throw skillError("E_SKILL_VERSION", `Skill ${skillId} is already pinned at ${version}.`, [skillId]);
    }
    return this.#pinProject(project, skillId, version, options);
  }

  public async pinned(project: ProjectStore): Promise<ResolvedSkill[]> {
    const resolved: ResolvedSkill[] = [];
    for (const pin of project.currentProject.skills) {
      const directory = resolve(project.root, pin.path);
      const skillsRoot = resolve(project.root, "skills");
      if (!directory.startsWith(`${skillsRoot}${sep}`)) {
        throw skillError("E_SKILL_PATH", `Pinned path ${pin.path} escapes the project.`, [pin.id]);
      }
      let read: ReadDirectoryResult;
      try {
        read = await readDirectory(directory, pin.contentHash);
      } catch (error: unknown) {
        throw skillError("E_SKILL_HASH", `Could not verify pinned skill ${pin.id}: ${errorMessage(error)}.`, [pin.id]);
      }
      if (
        read.source.id !== pin.id || read.source.name !== pin.name ||
        read.source.version !== pin.version || read.actualHash !== pin.contentHash
      ) {
        throw skillError(
          "E_SKILL_HASH",
          `Pinned skill ${pin.id}@${pin.version} expected ${pin.contentHash}, received ${read.actualHash}.`,
          [pin.id],
        );
      }
      await this.#verifyPresetReferences(project, read);
      resolved.push(resolvedSkill(read));
    }
    return resolved.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }

  async #verifyPresetReferences(
    project: ProjectStore,
    skill: Pick<ResolvedSkill, "manifest" | "presetReferences">,
  ): Promise<void> {
    for (const reference of skill.presetReferences) {
      if (!await this.#presetResolver(project, reference)) {
        throw skillError(
          "E_SKILL_PRESET",
          `Skill ${skill.manifest.id}@${skill.manifest.version} references missing or invalid preset ${reference.id}@${String(reference.version)}.`,
          [skill.manifest.id, reference.id],
        );
      }
    }
  }

  public async createPreferencePack(project: ProjectStore): Promise<PreferencePack> {
    await this.pinned(project);
    const presets: PreferencePack["presets"] = [];
    for (const pin of project.currentProject.presets) {
      if (pin.path.startsWith("builtin:")) {
        presets.push({ pin: structuredClone(pin) });
        continue;
      }
      const path = resolve(project.root, pin.path);
      const presetRoot = resolve(project.root, "presets");
      if (!path.startsWith(`${presetRoot}${sep}`)) {
        throw skillError("E_SKILL_PACK", `Preset path ${pin.path} escapes the project preset directory.`, [pin.id]);
      }
      const bytes = await readFile(path);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== pin.sha256) {
        throw skillError("E_SKILL_PACK", `Preset ${pin.id}@${String(pin.version)} failed its pinned hash.`, [pin.id]);
      }
      presets.push({
        pin: structuredClone(pin),
        file: { path: pin.path, sha256: hash, contentBase64: bytes.toString("base64") },
      });
    }
    const skills = await Promise.all(project.currentProject.skills.map(async (pin) => ({
      pin: structuredClone(pin),
      files: await packFiles(resolve(project.root, pin.path)),
    })));
    return {
      format: "guyditor-preference-pack/v1",
      createdAt: this.#now().toISOString(),
      presets,
      skills,
    };
  }

  public async applyPreferencePack(
    projectRoot: string,
    project: GuyditorProject,
    pack: PreferencePack,
  ): Promise<GuyditorProject> {
    if (pack.format !== "guyditor-preference-pack/v1") {
      throw skillError("E_SKILL_PACK", `Unsupported preference-pack format ${String(pack.format)}.`);
    }
    const next = structuredClone(project);
    for (const entry of pack.presets) {
      const existing = next.presets.find(({ id }) => id === entry.pin.id);
      if (existing !== undefined && canonical(existing) !== canonical(entry.pin)) {
        throw skillError("E_SKILL_PACK", `Preset ${entry.pin.id} conflicts with the fresh project.`, [entry.pin.id]);
      }
      if (entry.pin.path.startsWith("builtin:")) {
        if (entry.file !== undefined) {
          throw skillError("E_SKILL_PACK", `Built-in preset ${entry.pin.id} must not embed a file.`, [entry.pin.id]);
        }
      } else {
        if (entry.file === undefined || entry.file.path !== entry.pin.path) {
          throw skillError("E_SKILL_PACK", `Preset ${entry.pin.id} is missing its exact pinned file.`, [entry.pin.id]);
        }
        const destination = resolve(projectRoot, entry.pin.path);
        const presetsRoot = resolve(projectRoot, "presets");
        if (!destination.startsWith(`${presetsRoot}${sep}`)) {
          throw skillError("E_SKILL_PACK", `Preset path ${entry.pin.path} escapes the project.`, [entry.pin.id]);
        }
        const bytes = packedBytes(entry.file);
        if (createHash("sha256").update(bytes).digest("hex") !== entry.pin.sha256) {
          throw skillError("E_SKILL_PACK", `Preset ${entry.pin.id} does not match its pin.`, [entry.pin.id]);
        }
        await writePackedFile(projectRoot, entry.file);
      }
      if (existing === undefined) next.presets.push(structuredClone(entry.pin));
    }
    for (const entry of pack.skills) {
      const existing = next.skills.find(({ id }) => id === entry.pin.id);
      if (existing !== undefined && canonical(existing) !== canonical(entry.pin)) {
        throw skillError("E_SKILL_PACK", `Skill ${entry.pin.id} conflicts with the fresh project.`, [entry.pin.id]);
      }
      const directory = resolve(projectRoot, entry.pin.path);
      const skillsRoot = resolve(projectRoot, "skills");
      if (!directory.startsWith(`${skillsRoot}${sep}`)) {
        throw skillError("E_SKILL_PACK", `Skill path ${entry.pin.path} escapes the project.`, [entry.pin.id]);
      }
      await mkdir(join(directory, "examples"), { recursive: true });
      const paths = new Set<string>();
      for (const file of entry.files) {
        if (paths.has(file.path)) {
          throw skillError("E_SKILL_PACK", `Skill ${entry.pin.id} contains duplicate file ${file.path}.`, [entry.pin.id]);
        }
        paths.add(file.path);
        await writePackedFile(directory, file);
      }
      const read = await readDirectory(directory, entry.pin.contentHash);
      if (
        read.source.id !== entry.pin.id || read.source.name !== entry.pin.name ||
        read.source.version !== entry.pin.version || read.actualHash !== entry.pin.contentHash
      ) {
        throw skillError("E_SKILL_PACK", `Skill ${entry.pin.id}@${entry.pin.version} does not match its pin.`, [entry.pin.id]);
      }
      if (existing === undefined) next.skills.push(structuredClone(entry.pin));
    }
    next.presets.sort((left, right) => left.id.localeCompare(right.id));
    next.skills.sort((left, right) => left.id.localeCompare(right.id));
    return next;
  }

  public resolveAutomationPolicy(
    policy: AutomationPolicy,
    skills: readonly ResolvedSkill[],
  ): AutomationPolicy {
    const positive = new Set<string>();
    const avoided = new Set<string>();
    for (const rule of skills.flatMap(({ manifest }) => manifest.rules)) {
      const target = rule.strength === "avoid" ? avoided : positive;
      for (const operation of operationReferences(rule.text)) target.add(operation);
    }
    const candidates = policy.allowedOperations.length === 0 && positive.size > 0
      ? [...positive].sort()
      : policy.allowedOperations;
    const allowedOperations = candidates.filter((operation) =>
      !avoided.has(operation) && (positive.size === 0 || positive.has(operation)));
    return {
      ...structuredClone(policy),
      ...(policy.allowedOperations.length === 0 && positive.size === 0 && avoided.size > 0
        ? { enabled: false }
        : {}),
      allowedOperations,
    };
  }

  public async captureExample(input: CaptureSkillExampleInput): Promise<ResolvedSkill> {
    const description = input.description.trim();
    if (description.length === 0) {
      throw skillError("E_SKILL_EXAMPLE", "Preference example description cannot be empty.", [input.skillId]);
    }
    const proposalResult = await input.project.readProposal(input.proposalId);
    if (!proposalResult.ok) throw proposalResult.error;
    const proposal = proposalResult.value;
    const expectedStatus = input.decision === "approved" ? "accepted" : "rejected";
    if (proposal.status !== expectedStatus) {
      throw skillError(
        "E_SKILL_EXAMPLE_STATE",
        `Proposal ${proposal.id} must be ${expectedStatus} before it can be saved as ${input.decision}.`,
        [input.skillId, proposal.id],
      );
    }
    const pin = input.project.currentProject.skills.find(({ id }) => id === input.skillId);
    if (pin === undefined) {
      throw skillError("E_SKILL_NOT_PINNED", `Skill ${input.skillId} is not associated with this project.`, [input.skillId]);
    }
    const [publishedVersions, existingDrafts] = await Promise.all([
      this.versions(input.skillId),
      this.drafts(input.skillId),
    ]);
    const publishedBase = (await this.get(input.skillId, publishedVersions.at(-1) ?? pin.version));
    const draftBase = existingDrafts.at(-1);
    const base = draftBase !== undefined &&
      compareVersions(draftBase.manifest.version, publishedBase.manifest.version) > 0
      ? {
          directory: this.#draftDirectory(draftBase.manifest.name, draftBase.manifest.version),
          skill: draftBase,
        }
      : {
          directory: this.#publishedDirectory(publishedBase.manifest.name, publishedBase.manifest.version),
          skill: publishedBase,
        };
    const occupied = new Set([
      ...publishedVersions,
      ...existingDrafts.map(({ manifest }) => manifest.version),
    ]);
    let version = nextPatch(base.skill.manifest.version);
    while (occupied.has(version)) version = nextPatch(version);
    await this.#createDraftFromDirectory(base.directory, input.skillId, version);
    const exampleId = this.#exampleIdFactory();
    if (!/^ex_[A-Za-z0-9_-]+$/u.test(exampleId)) {
      throw skillError("E_SKILL_EXAMPLE", `Example ID ${exampleId} is not path-safe.`, [input.skillId]);
    }
    let revision = proposal.baseRevision;
    if (proposal.resultTransaction !== undefined) {
      const transaction = await input.project.readTransaction(proposal.resultTransaction);
      if (!transaction.ok) throw transaction.error;
      revision = transaction.value.resultRevision;
    }
    const payload = {
      format: "guyditor.skill-example/v1",
      decision: input.decision,
      proposalId: proposal.id,
      capturedAt: this.#now().toISOString(),
      semanticDiff: proposal.diff ?? null,
      operations: proposal.operations,
      context: {
        projectId: input.project.currentProject.project.id,
        projectName: input.project.currentProject.project.name,
        revision,
        baseRevision: proposal.baseRevision,
        instruction: proposal.instruction,
        reason: proposal.reason,
        addresses: proposal.addresses,
      },
    };
    const content = `${canonical(payload)}\n`;
    const mediaPath = `examples/${exampleId}.json`;
    const draftDirectory = this.#draftDirectory(pin.name, version);
    await writeFile(join(draftDirectory, mediaPath), content, "utf8");
    const draft = (await this.drafts(input.skillId)).find(({ manifest }) =>
      manifest.version === version);
    if (draft === undefined) {
      throw skillError("E_SKILL_DRAFT_NOT_FOUND", `Draft ${input.skillId}@${version} disappeared.`, [input.skillId]);
    }
    const example: SkillExample = {
      id: exampleId,
      description,
      media: {
        path: mediaPath,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
      provenance: {
        projectId: input.project.currentProject.project.id,
        revision,
      },
    };
    const examples = structuredClone(draft.manifest.examples);
    examples[input.decision === "approved" ? "approved" : "rejected"].push(example);
    return this.updateDraft({
      skillId: input.skillId,
      version,
      examples,
    });
  }
}

export type {
  CreateSkillDraftInput,
  PresetReference,
  ResolvedSkill,
  SkillCategory,
  SkillExample,
  SkillExamples,
  SkillManifest,
  SkillManifestSource,
  SkillRule,
  SkillRuleStrength,
  SkillScope,
  SkillVersionDiff,
  UpdateSkillDraftInput,
} from "./types.js";
