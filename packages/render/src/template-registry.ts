import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { loadImage } from "@napi-rs/canvas";
import { transform } from "esbuild";
import { parse } from "yaml";

import {
  analyzeLottieDocument,
  failure,
  makeGuyditorError,
  success,
} from "../../core/src/index.js";
import type {
  FrameTime,
  TemplateAssetDeclaration,
  TemplateAssetLicense,
  Result,
  TemplateDescriptor,
  TemplateInstallRequest,
  TemplateKind,
  TemplateProvider,
} from "../../core/src/index.js";

export interface TemplateFontDeclaration {
  family: string;
  file: string;
  weight: number;
  sha256: string;
  license: TemplateAssetLicense;
}

export type {
  TemplateAssetDeclaration,
  TemplateAssetLicense,
} from "../../core/src/index.js";

export interface TemplateManifest {
  schema: "guyditor/template/v1";
  id: string;
  name: string;
  kind: TemplateKind;
  version: string;
  engine: "overlay/v1";
  entry: string;
  min_guyditor: string;
  duration: {
    mode: "fixed" | "param" | "intrinsic" | "anchor_span";
    default?: FrameTime;
  };
  params: Record<string, unknown>;
  preview: { file: string; params: Record<string, unknown> };
  fonts: TemplateFontDeclaration[];
  assets?: TemplateAssetDeclaration[];
  safe_area_aware: boolean;
}

export interface LoadedTemplatePackage {
  root: string;
  manifest: TemplateManifest;
  contentHash: string;
  compiledSource: string;
  files: string[];
  reviewState: "published" | "draft";
  authoring?: {
    submissionId: string;
    status: "awaiting_review" | "changes_requested" | "rejected" | "superseded" | "published";
    description: string;
    previewPaths: string[];
    reason?: string;
  };
}

export interface TemplateCatalogEntry extends TemplateDescriptor {
  previewPath: string;
  previewDataUrl?: string;
  previewParams: Record<string, unknown>;
  assets: TemplateAssetDeclaration[];
  builtinName?: string;
  reviewState: "published" | "draft";
  authoringStatus?: "awaiting_review" | "changes_requested" | "rejected" | "superseded" | "published";
  submissionId?: string;
  description?: string;
  reviewReason?: string;
  previewStripPaths?: string[];
  previewStripDataUrls?: string[];
}

export interface TemplateRegistryOptions {
  builtinsRoot?: string;
  userRoot?: string;
  projectRoot?: string;
  compiledRoot?: string;
  draftRoot?: string;
}

const SEMVER = "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$";
const TEMPLATE_ID = "^tpl_[a-z2-7]{10}$";
const RATIONAL = "^[0-9]+/[1-9][0-9]*$";
const SHA256 = "^[0-9a-f]{64}$";

const licenseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["origin", "licenseName", "licensor", "restrictions"],
  properties: {
    origin: {
      enum: ["licensed", "stock", "generated", "programmatic", "unknown"],
    },
    licenseName: { type: "string", minLength: 1 },
    licenseUrl: { type: "string", minLength: 1 },
    licensor: { type: "string", minLength: 1 },
    restrictions: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
    },
  },
} as const;

const manifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schema", "id", "name", "kind", "version", "engine", "entry",
    "min_guyditor", "duration", "params", "preview", "fonts",
    "safe_area_aware",
  ],
  properties: {
    schema: { const: "guyditor/template/v1" },
    id: { type: "string", pattern: TEMPLATE_ID },
    name: { type: "string", minLength: 1 },
    kind: {
      enum: [
        "title", "lower_third", "diagram", "callout", "highlight",
        "transition", "motion",
      ],
    },
    version: { type: "string", pattern: SEMVER },
    engine: { const: "overlay/v1" },
    entry: { type: "string", minLength: 1 },
    min_guyditor: { type: "string", pattern: SEMVER },
    duration: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { enum: ["fixed", "param", "intrinsic", "anchor_span"] },
        default: {
          type: "object",
          additionalProperties: false,
          required: ["frames", "fps"],
          properties: {
            frames: { type: "integer", minimum: 1 },
            fps: { type: "string", pattern: RATIONAL },
          },
        },
      },
    },
    params: { type: "object" },
    preview: {
      type: "object",
      additionalProperties: false,
      required: ["file", "params"],
      properties: {
        file: { type: "string", minLength: 1 },
        params: { type: "object" },
      },
    },
    fonts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          family: { type: "string", minLength: 1 },
          file: { type: "string", minLength: 1 },
          weight: { type: "integer", minimum: 1, maximum: 1000 },
          sha256: { type: "string", pattern: SHA256 },
          license: licenseSchema,
        },
        required: ["family", "file", "weight", "sha256", "license"],
      },
    },
    assets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind", "file", "sha256", "license"],
        properties: {
          name: { type: "string", pattern: "^[a-z][a-z0-9_-]*$" },
          kind: { enum: ["image", "svg", "lottie"] },
          file: { type: "string", minLength: 1 },
          sha256: { type: "string", pattern: SHA256 },
          license: licenseSchema,
        },
      },
    },
    safe_area_aware: { type: "boolean" },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateManifest = ajv.compile<TemplateManifest>(manifestSchema);

function packageFailure(message: string, affected: readonly string[] = []) {
  return failure(makeGuyditorError(
    "E_TEMPLATE_PACKAGE_INVALID",
    `Template package ${message}`,
    { affected },
  ));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function schemaErrors(errors: readonly ErrorObject[] | null | undefined): string {
  return errors?.map((error) => {
    const path = error.instancePath === "" ? "/" : error.instancePath;
    return `${path} ${error.message ?? error.keyword}`;
  }).join("; ") ?? "unknown schema error";
}

function safePackagePath(root: string, candidate: string, label: string): Result<string> {
  if (candidate.includes("\\") || isAbsolute(candidate)) {
    return packageFailure(`${label} must be a package-relative POSIX path.`);
  }
  const path = resolve(root, candidate);
  const rel = relative(root, path);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`)
    ? packageFailure(`${label} escapes the package directory.`)
    : success(path);
}

async function packageFiles(root: string, directory = root): Promise<Result<string[]>> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    return packageFailure(`cannot read ${directory}: ${errorMessage(error)}.`);
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return packageFailure(`must not contain symbolic link ${relative(root, path)}.`);
    }
    if (stats.isDirectory()) {
      const nested = await packageFiles(root, path);
      if (!nested.ok) return nested;
      files.push(...nested.value);
    } else if (stats.isFile()) {
      files.push(relative(root, path).split(sep).join("/"));
    } else {
      return packageFailure(`contains unsupported filesystem entry ${relative(root, path)}.`);
    }
  }
  return success(files.sort());
}

async function contentHash(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const filename of files) {
    const bytes = await readFile(resolve(root, filename));
    const name = Buffer.from(filename, "utf8");
    const lengths = Buffer.alloc(16);
    lengths.writeBigUInt64BE(BigInt(name.length), 0);
    lengths.writeBigUInt64BE(BigInt(bytes.length), 8);
    hash.update(lengths).update(name).update(bytes);
  }
  return hash.digest("hex");
}

export function templateDescriptor(pkg: LoadedTemplatePackage): TemplateDescriptor {
  return {
    schema: pkg.manifest.schema,
    id: pkg.manifest.id,
    name: pkg.manifest.name,
    kind: pkg.manifest.kind,
    version: pkg.manifest.version,
    engine: pkg.manifest.engine,
    duration: structuredClone(pkg.manifest.duration),
    params: structuredClone(pkg.manifest.params),
    contentHash: pkg.contentHash,
    reviewState: pkg.reviewState,
  };
}

export async function validateTemplatePackage(
  root: string,
): Promise<Result<LoadedTemplatePackage>> {
  const absoluteRoot = resolve(root);
  let manifestText: string;
  try {
    manifestText = await readFile(resolve(absoluteRoot, "template.yaml"), "utf8");
  } catch (error: unknown) {
    return packageFailure(`at ${absoluteRoot} has no readable template.yaml: ${errorMessage(error)}.`);
  }
  let value: unknown;
  try {
    value = parse(manifestText) as unknown;
  } catch (error: unknown) {
    return packageFailure(`manifest YAML is invalid: ${errorMessage(error)}.`);
  }
  if (!validateManifest(value)) {
    return packageFailure(`manifest failed validation: ${schemaErrors(validateManifest.errors)}.`);
  }
  if (
    (value.duration.mode === "fixed" || value.duration.mode === "param") &&
    value.duration.default === undefined
  ) {
    return packageFailure(`manifest duration mode ${value.duration.mode} requires duration.default.`);
  }
  const files = await packageFiles(absoluteRoot);
  if (!files.ok) return files;

  const declared = [
    { name: value.entry, label: "entry" },
    { name: value.preview.file, label: "preview.file" },
    ...value.fonts.map(({ file }) => ({ name: file, label: "fonts[].file" })),
    ...(value.assets ?? []).map(({ file }) => ({ name: file, label: "assets[].file" })),
  ];
  for (const declaration of declared) {
    const path = safePackagePath(absoluteRoot, declaration.name, declaration.label);
    if (!path.ok) return path;
    const relativeName = relative(absoluteRoot, path.value).split(sep).join("/");
    if (!files.value.includes(relativeName)) {
      return packageFailure(`${declaration.label} ${declaration.name} does not exist.`);
    }
  }
  if (new Set(value.fonts.map(({ family }) => family)).size !== value.fonts.length) {
    return packageFailure("fonts contains duplicate family declarations.", [value.id]);
  }
  if (
    value.assets !== undefined &&
    new Set(value.assets.map(({ name }) => name)).size !== value.assets.length
  ) {
    return packageFailure("assets contains duplicate names.", [value.id]);
  }
  for (const declaration of [
    ...value.fonts.map(({ file, sha256: expected }) => ({ file, expected, kind: "font" })),
    ...(value.assets ?? []).map(({ file, sha256: expected, kind }) => ({
      file,
      expected,
      kind,
    })),
  ]) {
    if (declaration.kind === "svg" && extname(declaration.file).toLowerCase() !== ".svg") {
      return packageFailure(`SVG asset ${declaration.file} must use the .svg extension.`, [value.id]);
    }
    if (declaration.kind === "lottie" && extname(declaration.file).toLowerCase() !== ".json") {
      return packageFailure(
        `Lottie asset ${declaration.file} must use the .json extension.`,
        [value.id],
      );
    }
    const actual = createHash("sha256")
      .update(await readFile(resolve(absoluteRoot, declaration.file)))
      .digest("hex");
    if (actual !== declaration.expected) {
      return packageFailure(
        `${declaration.file} does not match its declared SHA-256.`,
        [value.id, declaration.file],
      );
    }
  }
  const registeredAssets = structuredClone(value.assets ?? []);
  const registeredRasterPaths = registeredAssets
    .filter(({ kind }) => kind === "image")
    .map(({ file }) => file);
  for (const declaration of registeredAssets) {
    if (declaration.kind !== "lottie") continue;
    let document: unknown;
    try {
      document = JSON.parse(
        await readFile(resolve(absoluteRoot, declaration.file), "utf8"),
      ) as unknown;
    } catch (error: unknown) {
      return packageFailure(
        `Lottie asset ${declaration.file} is not valid JSON: ${errorMessage(error)}.`,
        [value.id, declaration.file],
      );
    }
    const analysis = analyzeLottieDocument(document, {
      documentPath: declaration.file,
      registeredRasterPaths,
    });
    if (!analysis.ok) {
      return packageFailure(
        `Lottie asset ${declaration.file} uses unsupported features: ${
          analysis.unsupported.map(({ feature, layerPath: path }) =>
            `${feature} at ${path}`).join("; ")
        }.`,
        [value.id, declaration.file],
      );
    }
    declaration.featureProfile = analysis.profile;
  }

  try {
    const paramsAjv = new Ajv2020({ allErrors: true, strict: true });
    const validateParams = paramsAjv.compile<Record<string, unknown>>(value.params);
    if (!validateParams(value.preview.params)) {
      return packageFailure(
        `preview.params failed the parameter schema: ${schemaErrors(validateParams.errors)}.`,
        [value.id],
      );
    }
  } catch (error: unknown) {
    return packageFailure(`parameter schema is invalid: ${errorMessage(error)}.`, [value.id]);
  }

  const previewPath = safePackagePath(absoluteRoot, value.preview.file, "preview.file");
  if (!previewPath.ok) return previewPath;
  try {
    const preview = await loadImage(previewPath.value);
    if (preview.width !== 640 || preview.height !== 360) {
      return packageFailure(
        `preview must be exactly 640×360 pixels, received ${String(preview.width)}×${String(preview.height)}.`,
        [value.id],
      );
    }
  } catch (error: unknown) {
    return packageFailure(`preview cannot be decoded: ${errorMessage(error)}.`, [value.id]);
  }

  const entryPath = safePackagePath(absoluteRoot, value.entry, "entry");
  if (!entryPath.ok) return entryPath;
  let compiledSource: string;
  try {
    const compiled = await transform(await readFile(entryPath.value, "utf8"), {
      format: "cjs",
      loader: "ts",
      platform: "node",
      target: "node22",
      sourcemap: false,
    });
    compiledSource = compiled.code;
  } catch (error: unknown) {
    return packageFailure(`entry ${value.entry} does not compile: ${errorMessage(error)}.`, [value.id]);
  }

  return success({
    root: absoluteRoot,
    manifest: {
      ...structuredClone(value),
      ...(registeredAssets.length === 0 ? {} : { assets: registeredAssets }),
    },
    contentHash: await contentHash(absoluteRoot, files.value),
    compiledSource,
    files: files.value,
    reviewState: "published",
  });
}

function semverParts(version: string): {
  numbers: [number, number, number];
  prerelease: string[];
} {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (match === null) throw new TypeError(`Invalid semver ${version}.`);
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) {
      return a.numbers[index]! < b.numbers[index]! ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length
      ? 0
      : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = a.prerelease[index];
    const r = b.prerelease[index];
    if (l === undefined || r === undefined) return l === r ? 0 : l === undefined ? -1 : 1;
    if (l === r) continue;
    const ln = /^[0-9]+$/u.test(l) ? Number(l) : undefined;
    const rn = /^[0-9]+$/u.test(r) ? Number(r) : undefined;
    if (ln !== undefined || rn !== undefined) {
      if (ln === undefined) return 1;
      if (rn === undefined) return -1;
      return ln < rn ? -1 : 1;
    }
    return l < r ? -1 : 1;
  }
  return 0;
}

function catalogEntry(
  pkg: LoadedTemplatePackage,
  builtinName?: string,
): TemplateCatalogEntry {
  return {
    ...templateDescriptor(pkg),
    previewPath: resolve(pkg.root, pkg.manifest.preview.file),
    previewParams: structuredClone(pkg.manifest.preview.params),
    assets: structuredClone(pkg.manifest.assets ?? []),
    reviewState: pkg.reviewState,
    ...(pkg.authoring === undefined
      ? {}
      : {
          authoringStatus: pkg.authoring.status,
          submissionId: pkg.authoring.submissionId,
          description: pkg.authoring.description,
          ...(pkg.authoring.reason === undefined ? {} : { reviewReason: pkg.authoring.reason }),
          previewStripPaths: [...pkg.authoring.previewPaths],
        }),
    ...(builtinName === undefined ? {} : { builtinName }),
  };
}

async function directoryNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(({ name }) => name)
      .sort();
  } catch {
    return [];
  }
}

export class TemplateRegistry implements TemplateProvider {
  readonly #builtinsRoot: string;
  readonly #userRoot: string;
  readonly #projectRoot: string | undefined;
  readonly #compiledRoot: string;
  readonly #draftRoot: string;

  public constructor(options: TemplateRegistryOptions = {}) {
    this.#builtinsRoot = resolve(options.builtinsRoot ?? join(process.cwd(), "templates"));
    this.#userRoot = resolve(options.userRoot ?? join(homedir(), ".guyditor", "templates"));
    this.#projectRoot = options.projectRoot === undefined
      ? undefined
      : resolve(options.projectRoot);
    this.#compiledRoot = resolve(options.compiledRoot ?? join(this.#userRoot, ".compiled"));
    this.#draftRoot = resolve(options.draftRoot ?? join(this.#userRoot, ".drafts"));
  }

  public async validateDraftPackage(root: string): Promise<Result<LoadedTemplatePackage>> {
    const loaded = await validateTemplatePackage(root);
    return loaded.ok
      ? success({ ...loaded.value, reviewState: "draft" })
      : loaded;
  }

  async #builtinPackages(): Promise<Result<Array<{
    package: LoadedTemplatePackage;
    builtinName: string;
  }>>> {
    const packages: Array<{ package: LoadedTemplatePackage; builtinName: string }> = [];
    for (const builtinName of await directoryNames(this.#builtinsRoot)) {
      const loaded = await validateTemplatePackage(join(this.#builtinsRoot, builtinName));
      if (!loaded.ok) return loaded;
      packages.push({ package: loaded.value, builtinName });
    }
    return success(packages);
  }

  async #installedPackages(root: string | undefined): Promise<Result<LoadedTemplatePackage[]>> {
    if (root === undefined) return success([]);
    const packages: LoadedTemplatePackage[] = [];
    for (const templateId of await directoryNames(root)) {
      if (!new RegExp(TEMPLATE_ID, "u").test(templateId)) continue;
      for (const version of await directoryNames(join(root, templateId))) {
        const loaded = await validateTemplatePackage(join(root, templateId, version));
        if (!loaded.ok) return loaded;
        if (loaded.value.manifest.id !== templateId || loaded.value.manifest.version !== version) {
          return packageFailure(
            `library path ${templateId}/${version} does not match its manifest id/version.`,
            [loaded.value.manifest.id],
          );
        }
        packages.push(loaded.value);
      }
    }
    return success(packages);
  }

  async #draftPackages(): Promise<Result<LoadedTemplatePackage[]>> {
    const packages: LoadedTemplatePackage[] = [];
    for (const submissionId of await directoryNames(this.#draftRoot)) {
      if (!/^tas_[a-z2-7]{10}$/u.test(submissionId)) continue;
      let authoring: LoadedTemplatePackage["authoring"];
      try {
        const metadata = JSON.parse(
          await readFile(join(this.#draftRoot, submissionId, "authoring.json"), "utf8"),
        ) as Record<string, unknown>;
        const previewPaths = Array.isArray(metadata["previewPaths"])
          ? metadata["previewPaths"].filter((value): value is string => typeof value === "string")
          : [];
        const status = metadata["status"];
        if (
          typeof metadata["submissionId"] !== "string" ||
          typeof metadata["description"] !== "string" ||
          typeof status !== "string" ||
          !["awaiting_review", "changes_requested", "rejected", "superseded", "published"]
            .includes(status)
        ) {
          return packageFailure(`draft ${submissionId} has invalid authoring metadata.`);
        }
        authoring = {
          submissionId: metadata["submissionId"],
          description: metadata["description"],
          status: status as NonNullable<LoadedTemplatePackage["authoring"]>["status"],
          previewPaths,
          ...(typeof metadata["reason"] === "string" ? { reason: metadata["reason"] } : {}),
        };
      } catch (error: unknown) {
        return packageFailure(
          `draft ${submissionId} has unreadable authoring metadata: ${errorMessage(error)}.`,
        );
      }
      const loaded = await this.validateDraftPackage(join(this.#draftRoot, submissionId));
      if (!loaded.ok) return loaded;
      packages.push({ ...loaded.value, authoring });
    }
    return success(packages);
  }

  async #all(): Promise<Result<Array<{
    package: LoadedTemplatePackage;
    priority: number;
    builtinName?: string;
  }>>> {
    const [builtins, user, project, drafts] = await Promise.all([
      this.#builtinPackages(),
      this.#installedPackages(this.#userRoot),
      this.#installedPackages(this.#projectRoot),
      this.#draftPackages(),
    ]);
    if (!builtins.ok) return builtins;
    if (!user.ok) return user;
    if (!project.ok) return project;
    if (!drafts.ok) return drafts;
    return success([
      ...builtins.value.map(({ package: pkg, builtinName }) => ({
        package: pkg,
        priority: 0,
        builtinName,
      })),
      ...user.value.map((pkg) => ({ package: pkg, priority: 1 })),
      ...project.value.map((pkg) => ({ package: pkg, priority: 2 })),
      ...drafts.value.map((pkg) => ({ package: pkg, priority: -1 })),
    ]);
  }

  public async package(
    templateId: string,
    version: string,
    expectedHash?: string,
  ): Promise<Result<LoadedTemplatePackage>> {
    const all = await this.#all();
    if (!all.ok) return all;
    const selected = all.value
      .filter(({ package: pkg }) =>
        pkg.manifest.id === templateId && pkg.manifest.version === version)
      .sort((left, right) => right.priority - left.priority)[0]?.package;
    if (selected === undefined ||
        (expectedHash !== undefined && selected.contentHash !== expectedHash)) {
      return failure(makeGuyditorError(
        "E_TEMPLATE_MISSING_VERSION",
        `Template ${templateId}@${version}${expectedHash === undefined ? "" : ` with hash ${expectedHash}`} is absent from all libraries.`,
        { affected: [templateId] },
      ));
    }
    return success(selected);
  }

  public async get(templateId: string, version: string): Promise<Result<TemplateDescriptor>> {
    const loaded = await this.package(templateId, version);
    return loaded.ok ? success(templateDescriptor(loaded.value)) : loaded;
  }

  public async latest(templateId: string): Promise<Result<TemplateDescriptor>> {
    const all = await this.#all();
    if (!all.ok) return all;
    const versions = [...new Set(all.value
      .filter(({ package: pkg }) => pkg.manifest.id === templateId)
      .map(({ package: pkg }) => pkg.manifest.version))]
      .sort(compareSemver);
    const version = versions.at(-1);
    return version === undefined
      ? failure(makeGuyditorError(
          "E_TEMPLATE_MISSING_VERSION",
          `No installed version exists for template ${templateId}.`,
          { affected: [templateId] },
        ))
      : this.get(templateId, version);
  }

  public async list(): Promise<Result<TemplateCatalogEntry[]>> {
    const all = await this.#all();
    if (!all.ok) return all;
    const entries: TemplateCatalogEntry[] = [];
    const published = all.value.filter(({ package: pkg }) => pkg.reviewState === "published");
    const ids = [...new Set(published.map(({ package: pkg }) => pkg.manifest.id))].sort();
    for (const id of ids) {
      const candidates = published.filter(({ package: pkg }) => pkg.manifest.id === id);
      const latestVersion = candidates.map(({ package: pkg }) => pkg.manifest.version)
        .sort(compareSemver).at(-1)!;
      const selected = candidates.filter(({ package: pkg }) => pkg.manifest.version === latestVersion)
        .sort((left, right) => right.priority - left.priority)[0]!;
      entries.push(catalogEntry(selected.package, selected.builtinName));
    }
    for (const draft of all.value
      .filter(({ package: pkg }) =>
        pkg.reviewState === "draft" && pkg.authoring?.status === "awaiting_review")
      .sort((left, right) =>
        left.package.manifest.name.localeCompare(right.package.manifest.name))) {
      entries.push(catalogEntry(draft.package));
    }
    return success(entries);
  }

  public async install(
    request: TemplateInstallRequest,
    options: { dryRun: boolean },
  ): Promise<Result<TemplateDescriptor>> {
    const source = request.packagePath ?? (
      request.builtinName === undefined
        ? undefined
        : join(this.#builtinsRoot, request.builtinName)
    );
    if (source === undefined) {
      return packageFailure("install requires packagePath or builtinName.");
    }
    const loaded = await validateTemplatePackage(source);
    if (!loaded.ok) return loaded;
    if (
      loaded.value.files.includes("authoring.json") ||
      /-draft\.\d+$/u.test(loaded.value.manifest.version)
    ) {
      return failure(makeGuyditorError(
        "E_TEMPLATE_UNREVIEWED",
        `Authored draft ${loaded.value.manifest.id}@${loaded.value.manifest.version} cannot be installed; creator approval must publish it first.`,
        { affected: [loaded.value.manifest.id] },
      ));
    }
    if (options.dryRun) return success(templateDescriptor(loaded.value));
    const destination = join(
      this.#userRoot,
      loaded.value.manifest.id,
      loaded.value.manifest.version,
    );
    try {
      const existing = await validateTemplatePackage(destination);
      if (existing.ok) {
        return existing.value.contentHash === loaded.value.contentHash
          ? success(templateDescriptor(existing.value))
          : packageFailure(
              `cannot replace immutable ${loaded.value.manifest.id}@${loaded.value.manifest.version} with different content.`,
              [loaded.value.manifest.id],
            );
      }
      await mkdir(resolve(destination, ".."), { recursive: true });
      await cp(loaded.value.root, destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await mkdir(this.#compiledRoot, { recursive: true });
      await writeFile(
        join(this.#compiledRoot, `${loaded.value.contentHash}.js`),
        loaded.value.compiledSource,
        { encoding: "utf8", flag: "wx" },
      ).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return;
        throw error;
      });
      return success(templateDescriptor(loaded.value));
    } catch (error: unknown) {
      return packageFailure(
        `could not install ${basename(source)}: ${errorMessage(error)}.`,
        [loaded.value.manifest.id],
      );
    }
  }

  public async uninstall(
    templateId: string,
    version: string,
    options: { dryRun: boolean },
  ): Promise<Result<void>> {
    const path = join(this.#userRoot, templateId, version);
    const loaded = await validateTemplatePackage(path);
    if (!loaded.ok) return loaded;
    if (!options.dryRun) await rm(path, { recursive: true, force: false });
    return success(undefined);
  }
}
