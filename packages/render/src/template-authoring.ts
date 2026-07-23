import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { transform } from "esbuild";
import { parse, stringify } from "yaml";

import {
  makeGuyditorError,
} from "../../core/src/index.js";
import type {
  TemplateAssetDeclaration,
  TemplateDescriptor,
  TemplateKind,
} from "../../core/src/index.js";
import {
  loadTemplateRuntime,
  renderTemplatePng,
} from "./template-runtime.js";
import type {
  TemplateManifest,
  TemplateRegistry,
} from "./template-registry.js";

export const MAX_AUTHORED_TEMPLATE_SOURCE_BYTES = 64 * 1024;
export const DEFAULT_TEMPLATE_AUTHOR_PROBE_FRAMES = 5;
export const DEFAULT_TEMPLATE_AUTHOR_FRAMES_PER_SECOND_FLOOR = 1;

export type TemplateAuthorCheckName =
  | "source_size"
  | "source_parse"
  | "imports"
  | "manifest"
  | "param_schema"
  | "sandbox_probe"
  | "determinism"
  | "performance";

export interface TemplateAuthorValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface TemplateAuthorValidationCheck {
  check: TemplateAuthorCheckName;
  ok: boolean;
  errors: TemplateAuthorValidationError[];
  metrics?: Record<string, number>;
}

export interface TemplateAuthorManifest {
  params: Record<string, unknown>;
  duration: {
    mode: "fixed" | "param" | "intrinsic" | "anchor_span";
    default?: { frames: number; fps: string };
  };
  assets: TemplateAssetDeclaration[];
  previewParams?: Record<string, unknown>;
  kind?: TemplateKind;
  safeAreaAware?: boolean;
}

export interface TemplateAuthorSubmission {
  name: string;
  description: string;
  manifest: TemplateAuthorManifest;
  source: string;
  supersedes?: string;
}

export interface TemplateAuthorProvenance {
  sessionId: string;
  model: string;
}

export type TemplateAuthorStatusValue =
  | "awaiting_review"
  | "changes_requested"
  | "rejected"
  | "superseded"
  | "published";

export interface TemplateAuthorStatus {
  submissionId: string;
  templateId: string;
  draftVersion: string;
  draftRevision: number;
  name: string;
  description: string;
  status: TemplateAuthorStatusValue;
  provenance: TemplateAuthorProvenance;
  submittedAt: string;
  updatedAt: string;
  previewPaths: string[];
  checks: TemplateAuthorValidationCheck[];
  supersedes?: string;
  supersededBy?: string;
  reason?: string;
  published?: TemplateDescriptor;
}

export type TemplateAuthorSubmitResult =
  | {
      ok: true;
      draft: TemplateAuthorStatus;
      checks: TemplateAuthorValidationCheck[];
    }
  | {
      ok: false;
      checks: TemplateAuthorValidationCheck[];
    };

export interface TemplateAuthorReviewInput {
  submissionId: string;
  decision: "approve" | "reject" | "request_changes";
  reason?: string;
}

export interface TemplateAuthorAuditEvent {
  type: "submitted" | "reviewed";
  status: TemplateAuthorStatus;
  decision?: TemplateAuthorReviewInput["decision"];
}

export interface TemplateAuthoringServiceOptions {
  registry: TemplateRegistry;
  draftRoot: string;
  now?: () => Date;
  idFactory?: (prefix: "tas" | "tpl") => string;
  probe?: {
    frames?: number;
    framesPerSecondFloor?: number;
  };
  resolveAsset?: (declaration: TemplateAssetDeclaration) => Promise<Uint8Array>;
  onAudit?: (event: TemplateAuthorAuditEvent) => void;
}

interface DraftMetadata extends TemplateAuthorStatus {
  schema: "guyditor/template-author-draft/v1";
}

const AUTHOR_MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["params", "duration", "assets"],
  properties: {
    params: { type: "object" },
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
            fps: { type: "string", pattern: "^[1-9][0-9]*/[1-9][0-9]*$" },
          },
        },
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
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          license: {
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
          },
        },
      },
    },
    previewParams: { type: "object" },
    kind: {
      enum: [
        "title", "lower_third", "diagram", "callout", "highlight",
        "transition", "motion",
      ],
    },
    safeAreaAware: { type: "boolean" },
  },
} as const;

const authorAjv = new Ajv2020({ allErrors: true, strict: true });
const validateAuthorManifest = authorAjv.compile<TemplateAuthorManifest>(AUTHOR_MANIFEST_SCHEMA);
const STATUS_FILE = "authoring.json";
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function generatedId(prefix: "tas" | "tpl"): string {
  const bytes = randomBytes(10);
  let suffix = "";
  for (const byte of bytes) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function check(
  name: TemplateAuthorCheckName,
  errors: TemplateAuthorValidationError[] = [],
  metrics?: Record<string, number>,
): TemplateAuthorValidationCheck {
  return {
    check: name,
    ok: errors.length === 0,
    errors,
    ...(metrics === undefined ? {} : { metrics }),
  };
}

function completeSkippedChecks(
  checks: TemplateAuthorValidationCheck[],
): TemplateAuthorValidationCheck[] {
  const present = new Set(checks.map(({ check: name }) => name));
  for (const name of [
    "source_size",
    "source_parse",
    "imports",
    "manifest",
    "param_schema",
    "sandbox_probe",
    "determinism",
    "performance",
  ] as const) {
    if (!present.has(name)) {
      checks.push(check(name, [{
        code: "E_TEMPLATE_CHECK_SKIPPED",
        message: `${name} was skipped because an earlier validation check failed.`,
      }]));
    }
  }
  return checks;
}

function ajvErrors(
  code: string,
  errors: readonly ErrorObject[] | null | undefined,
): TemplateAuthorValidationError[] {
  return (errors ?? []).map((error) => ({
    code,
    message: error.message ?? error.keyword,
    path: error.instancePath === "" ? "/" : error.instancePath,
  }));
}

function importSpecifiers(source: string): {
  specifiers: string[];
  dynamicOrRequire: boolean;
} {
  const specifiers: string[] = [];
  const pattern = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return {
    specifiers,
    dynamicOrRequire: /\brequire\s*\(|\bimport\s*\(/u.test(source),
  };
}

function isPackageRelativePath(candidate: string): boolean {
  if (candidate.includes("\\") || isAbsolute(candidate)) return false;
  const packageRoot = resolve("/", "guyditor-authored-template");
  const resolved = resolve(packageRoot, candidate);
  const rel = relative(packageRoot, resolved);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function valueForSchema(schema: unknown, boundary: "default" | "lower" | "upper"): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return null;
  const record = schema as Record<string, unknown>;
  if (boundary === "default" && record["default"] !== undefined) {
    return structuredClone(record["default"]);
  }
  const values = Array.isArray(record["enum"]) ? record["enum"] : undefined;
  if (values !== undefined && values.length > 0) {
    return structuredClone(boundary === "upper" ? values.at(-1) : values[0]);
  }
  if (record["type"] === "string") {
    if (typeof record["pattern"] === "string" && record["pattern"].includes("#")) return "#336699";
    const length = boundary === "upper" && typeof record["maxLength"] === "number"
      ? Math.min(32, record["maxLength"])
      : typeof record["minLength"] === "number" ? Math.max(1, record["minLength"]) : 1;
    return "x".repeat(length);
  }
  if (record["type"] === "integer" || record["type"] === "number") {
    if (boundary === "upper" && typeof record["maximum"] === "number") return record["maximum"];
    if (typeof record["minimum"] === "number") return record["minimum"];
    if (typeof record["maximum"] === "number") return record["maximum"];
    return 0;
  }
  if (record["type"] === "boolean") return boundary === "upper";
  if (record["type"] === "array") return [];
  if (record["type"] === "object") return {};
  return null;
}

function parameterSamples(schema: Record<string, unknown>): Record<string, unknown>[] {
  const properties = typeof schema["properties"] === "object" &&
    schema["properties"] !== null && !Array.isArray(schema["properties"])
    ? schema["properties"] as Record<string, unknown>
    : {};
  return (["default", "lower", "upper"] as const).map((boundary) =>
    Object.fromEntries(Object.entries(properties).map(([name, property]) => [
      name,
      valueForSchema(property, boundary),
    ])));
}

function packageManifest(
  templateId: string,
  version: string,
  input: TemplateAuthorSubmission,
  previewParams: Record<string, unknown>,
): TemplateManifest {
  return {
    schema: "guyditor/template/v1",
    id: templateId,
    name: input.name,
    kind: input.manifest.kind ?? "motion",
    version,
    engine: "overlay/v1",
    entry: "render.ts",
    min_guyditor: "1.0.0",
    duration: structuredClone(input.manifest.duration),
    params: structuredClone(input.manifest.params),
    preview: { file: "preview.png", params: structuredClone(previewParams) },
    fonts: [],
    ...(input.manifest.assets.length === 0
      ? {}
      : { assets: structuredClone(input.manifest.assets) }),
    safe_area_aware: input.manifest.safeAreaAware ?? true,
  };
}

async function metadataAt(root: string): Promise<DraftMetadata> {
  return JSON.parse(await readFile(join(root, STATUS_FILE), "utf8")) as DraftMetadata;
}

function authoringError(code: `E_${Uppercase<string>}`, message: string, affected: string[] = []) {
  return makeGuyditorError(code, message, { affected });
}

export class TemplateAuthoringService {
  readonly #registry: TemplateRegistry;
  readonly #draftRoot: string;
  readonly #now: () => Date;
  readonly #idFactory: (prefix: "tas" | "tpl") => string;
  readonly #probeFrames: number;
  readonly #framesPerSecondFloor: number;
  readonly #resolveAsset: TemplateAuthoringServiceOptions["resolveAsset"];
  readonly #onAudit: TemplateAuthoringServiceOptions["onAudit"];

  public constructor(options: TemplateAuthoringServiceOptions) {
    this.#registry = options.registry;
    this.#draftRoot = resolve(options.draftRoot);
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? generatedId;
    this.#probeFrames = options.probe?.frames ?? DEFAULT_TEMPLATE_AUTHOR_PROBE_FRAMES;
    this.#framesPerSecondFloor = options.probe?.framesPerSecondFloor ??
      DEFAULT_TEMPLATE_AUTHOR_FRAMES_PER_SECOND_FLOOR;
    this.#resolveAsset = options.resolveAsset;
    this.#onAudit = options.onAudit;
    if (!Number.isInteger(this.#probeFrames) || this.#probeFrames < 2) {
      throw new RangeError("Template authoring probe frames must be an integer of at least 2.");
    }
    if (!Number.isFinite(this.#framesPerSecondFloor) || this.#framesPerSecondFloor <= 0) {
      throw new RangeError("Template authoring frames/second floor must be positive.");
    }
  }

  public async submit(
    input: TemplateAuthorSubmission,
    provenance: TemplateAuthorProvenance,
  ): Promise<TemplateAuthorSubmitResult> {
    const checks: TemplateAuthorValidationCheck[] = [];
    const sourceBytes = Buffer.byteLength(input.source, "utf8");
    checks.push(check("source_size", sourceBytes <= MAX_AUTHORED_TEMPLATE_SOURCE_BYTES
      ? []
      : [{
          code: "E_TEMPLATE_SOURCE_TOO_LARGE",
          message: `Source is ${String(sourceBytes)} bytes; the cap is ${String(MAX_AUTHORED_TEMPLATE_SOURCE_BYTES)} bytes.`,
        }], { bytes: sourceBytes, capBytes: MAX_AUTHORED_TEMPLATE_SOURCE_BYTES }));

    let compiledSource: string | undefined;
    try {
      compiledSource = (await transform(input.source, {
        format: "cjs",
        loader: "ts",
        platform: "node",
        target: "node22",
        sourcemap: false,
      })).code;
      checks.push(check("source_parse"));
    } catch (error: unknown) {
      checks.push(check("source_parse", [{
        code: "E_TEMPLATE_SOURCE_PARSE",
        message: errorMessage(error),
      }]));
    }

    const imported = importSpecifiers(input.source);
    const declaredAssets = new Set(input.manifest.assets.map(({ name }) => `asset:${name}`));
    const disallowed = imported.specifiers.filter((specifier) =>
      specifier !== "@guyditor/render/primitives/v1" && !declaredAssets.has(specifier));
    checks.push(check("imports", [
      ...disallowed.map((specifier) => ({
        code: "E_TEMPLATE_IMPORT_DISALLOWED",
        message: `Import ${specifier} is outside primitives/v1 and the declared asset set.`,
      })),
      ...(imported.dynamicOrRequire ? [{
        code: "E_TEMPLATE_IMPORT_DISALLOWED",
        message: "Dynamic import and direct require calls are forbidden.",
      }] : []),
    ]));

    const manifestErrors = validateAuthorManifest(input.manifest)
      ? []
      : ajvErrors("E_TEMPLATE_MANIFEST_INVALID", validateAuthorManifest.errors);
    if (input.name.trim() === "") {
      manifestErrors.push({ code: "E_TEMPLATE_MANIFEST_INVALID", message: "name must not be empty", path: "/name" });
    }
    if (input.description.trim() === "") {
      manifestErrors.push({
        code: "E_TEMPLATE_MANIFEST_INVALID",
        message: "description must not be empty",
        path: "/description",
      });
    }
    if (
      (input.manifest.duration.mode === "fixed" || input.manifest.duration.mode === "param") &&
      input.manifest.duration.default === undefined
    ) {
      manifestErrors.push({
        code: "E_TEMPLATE_MANIFEST_INVALID",
        message: `${input.manifest.duration.mode} duration requires default frames/fps`,
        path: "/manifest/duration/default",
      });
    }
    if (input.manifest.assets.length > 0 && this.#resolveAsset === undefined) {
      manifestErrors.push({
        code: "E_TEMPLATE_ASSET_UNAVAILABLE",
        message: "Declared assets require a registered asset resolver.",
        path: "/manifest/assets",
      });
    }
    for (const [index, asset] of input.manifest.assets.entries()) {
      if (!isPackageRelativePath(asset.file)) {
        manifestErrors.push({
          code: "E_TEMPLATE_MANIFEST_INVALID",
          message: "asset file must be a package-relative POSIX path",
          path: `/manifest/assets/${String(index)}/file`,
        });
      }
    }
    checks.push(check("manifest", manifestErrors));

    let validateParams: ReturnType<Ajv2020["compile"]> | undefined;
    try {
      validateParams = new Ajv2020({ allErrors: true, strict: true }).compile(input.manifest.params);
      const samples = parameterSamples(input.manifest.params);
      const invalid = samples.flatMap((sample, index) => validateParams!(sample)
        ? []
        : ajvErrors(
            "E_TEMPLATE_PARAM_SCHEMA_INVALID",
            validateParams!.errors,
          ).map((error) => ({
            ...error,
            message: `Probe parameter sample ${String(index)}: ${error.message}`,
          })));
      if (
        input.manifest.previewParams !== undefined &&
        !validateParams(input.manifest.previewParams)
      ) {
        invalid.push(...ajvErrors(
          "E_TEMPLATE_PARAM_SCHEMA_INVALID",
          validateParams.errors,
        ));
      }
      checks.push(check("param_schema", invalid));
    } catch (error: unknown) {
      checks.push(check("param_schema", [{
        code: "E_TEMPLATE_PARAM_SCHEMA_INVALID",
        message: errorMessage(error),
      }]));
    }

    if (checks.some(({ ok }) => !ok) || compiledSource === undefined || validateParams === undefined) {
      return { ok: false, checks: completeSkippedChecks(checks) };
    }

    let prior: TemplateAuthorStatus | undefined;
    if (input.supersedes !== undefined) {
      let candidate: TemplateAuthorStatus | undefined;
      try {
        candidate = await this.status(input.supersedes);
      } catch {
        candidate = undefined;
      }
      if (candidate === undefined || candidate.status !== "changes_requested") {
        const manifestCheck = checks.find(({ check: checkName }) => checkName === "manifest")!;
        manifestCheck.ok = false;
        manifestCheck.errors.push({
          code: "E_TEMPLATE_SUPERSESSION_INVALID",
          message: `Submission ${input.supersedes} is not awaiting requested changes.`,
        });
        return { ok: false, checks: completeSkippedChecks(checks) };
      }
      prior = candidate;
    }

    const submissionId = this.#idFactory("tas");
    const templateId = prior?.templateId ?? this.#idFactory("tpl");
    const draftRevision = (prior?.draftRevision ?? 0) + 1;
    const draftVersion = `1.0.0-draft.${String(draftRevision)}`;
    const draftDirectory = join(this.#draftRoot, submissionId);
    await mkdir(draftDirectory, { recursive: true });
    try {
      await writeFile(join(draftDirectory, "render.ts"), input.source, "utf8");
      const samples = parameterSamples(input.manifest.params);
      const previewParams = structuredClone(input.manifest.previewParams ?? samples[0] ?? {});
      await writeFile(
        join(draftDirectory, "template.yaml"),
        stringify(packageManifest(templateId, draftVersion, input, previewParams), {
          lineWidth: 0,
        }),
        "utf8",
      );
      await writeFile(
        join(draftDirectory, "preview.png"),
        createCanvas(640, 360).toBuffer("image/png"),
      );
      try {
        for (const declaration of input.manifest.assets) {
          const bytes = await this.#resolveAsset!(declaration);
          const actual = createHash("sha256").update(bytes).digest("hex");
          if (actual !== declaration.sha256) {
            throw authoringError(
              "E_TEMPLATE_ASSET_HASH",
              `Declared asset ${declaration.name} resolved to ${actual}, expected ${declaration.sha256}.`,
              [templateId, declaration.name],
            );
          }
          await mkdir(dirname(join(draftDirectory, declaration.file)), { recursive: true });
          await writeFile(join(draftDirectory, declaration.file), bytes);
        }
      } catch (error: unknown) {
        checks.push(check("sandbox_probe", [{
          code: typeof error === "object" && error !== null && "code" in error &&
            typeof error.code === "string"
            ? error.code
            : "E_TEMPLATE_ASSET_UNAVAILABLE",
          message: errorMessage(error),
        }]));
        return { ok: false, checks: completeSkippedChecks(checks) };
      }

      const packageResult = await this.#registry.validateDraftPackage(draftDirectory);
      if (!packageResult.ok) {
        checks.push(check("sandbox_probe", [{
          code: packageResult.error.code,
          message: packageResult.error.message,
        }]));
        return { ok: false, checks: completeSkippedChecks(checks) };
      }
      const runtime = await loadTemplateRuntime(packageResult.value);
      if (!runtime.ok) {
        checks.push(check("sandbox_probe", [{
          code: runtime.error.code,
          message: runtime.error.message,
        }]));
        return { ok: false, checks: completeSkippedChecks(checks) };
      }

      const durationFrames = input.manifest.duration.default?.frames ?? 90;
      const fps = input.manifest.duration.default?.fps ?? "30/1";
      const frameNumbers = Array.from({ length: this.#probeFrames }, (_, index) =>
        Math.min(
          durationFrames - 1,
          Math.round(index * (durationFrames - 1) / (this.#probeFrames - 1)),
        ));
      const seeds = [0x4755_5944, 0x6120_0002];
      const sandboxErrors: TemplateAuthorValidationError[] = [];
      const determinismErrors: TemplateAuthorValidationError[] = [];
      const previewFrames: Buffer[] = [];
      let renderCount = 0;
      const startedAt = performance.now();
      for (const [sampleIndex, params] of samples.entries()) {
        for (const seed of seeds) {
          for (const frame of frameNumbers) {
            const options = {
              params,
              seed,
              frame,
              totalFrames: durationFrames,
              fps,
              width: 640,
              height: 360,
              safeArea: { top: 22, right: 32, bottom: 22, left: 32 },
              brand: { palette: {} },
            };
            const first = renderTemplatePng(runtime.value, options);
            if (!first.ok) {
              sandboxErrors.push({
                code: first.error.code,
                message: `sample ${String(sampleIndex)}, seed ${String(seed)}, frame ${String(frame)}: ${first.error.message}`,
              });
              continue;
            }
            renderCount += 1;
            const second = renderTemplatePng(runtime.value, options);
            if (!second.ok) {
              sandboxErrors.push({
                code: second.error.code,
                message: second.error.message,
              });
            } else if (!first.value.equals(second.value)) {
              determinismErrors.push({
                code: "E_TEMPLATE_NONDETERMINISTIC",
                message: `Repeated sample ${String(sampleIndex)}, seed ${String(seed)}, frame ${String(frame)} was not byte-equal.`,
              });
            }
            if (sampleIndex === 0 && seed === seeds[0]) previewFrames.push(first.value);
          }
        }
      }
      const elapsedSeconds = Math.max(0.000_001, (performance.now() - startedAt) / 1_000);
      const framesPerSecond = renderCount / elapsedSeconds;
      checks.push(check("sandbox_probe", sandboxErrors, {
        parameterSamples: samples.length,
        seeds: seeds.length,
        framesPerSample: frameNumbers.length,
        renderedFrames: renderCount,
      }));
      checks.push(check("determinism", determinismErrors, { repeatedFrames: renderCount }));
      checks.push(check("performance", framesPerSecond >= this.#framesPerSecondFloor
        ? []
        : [{
            code: "E_TEMPLATE_PERFORMANCE_BUDGET",
            message: `Probe measured ${framesPerSecond.toFixed(2)} fps below the ${this.#framesPerSecondFloor.toFixed(2)} fps floor.`,
          }], { framesPerSecond, floor: this.#framesPerSecondFloor }));
      if (checks.some(({ ok }) => !ok)) {
        return { ok: false, checks: completeSkippedChecks(checks) };
      }

      const previewDirectory = join(draftDirectory, "previews");
      await mkdir(previewDirectory, { recursive: true });
      const previewPaths: string[] = [];
      for (const [index, bytes] of previewFrames.entries()) {
        const path = join(previewDirectory, `frame-${String(index).padStart(2, "0")}.png`);
        await writeFile(path, bytes);
        previewPaths.push(path);
      }
      await writeFile(join(draftDirectory, "preview.png"), previewFrames[0]!);
      const timestamp = this.#now().toISOString();
      const draft: DraftMetadata = {
        schema: "guyditor/template-author-draft/v1",
        submissionId,
        templateId,
        draftVersion,
        draftRevision,
        name: input.name,
        description: input.description,
        status: "awaiting_review",
        provenance: structuredClone(provenance),
        submittedAt: timestamp,
        updatedAt: timestamp,
        previewPaths,
        checks: structuredClone(checks),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      };
      await this.#writeMetadata(draftDirectory, draft);
      if (prior !== undefined) {
        await this.#update(prior.submissionId, {
          status: "superseded",
          supersededBy: submissionId,
        });
      }
      this.#onAudit?.({ type: "submitted", status: structuredClone(draft) });
      return { ok: true, draft, checks };
    } finally {
      if (checks.some(({ ok }) => !ok)) {
        await rm(draftDirectory, { recursive: true, force: true });
      }
    }
  }

  public async status(): Promise<TemplateAuthorStatus[]>;
  public async status(submissionId: string): Promise<TemplateAuthorStatus>;
  public async status(submissionId?: string): Promise<TemplateAuthorStatus | TemplateAuthorStatus[]> {
    if (submissionId !== undefined) {
      try {
        return await metadataAt(join(this.#draftRoot, submissionId));
      } catch {
        throw authoringError(
          "E_TEMPLATE_SUBMISSION_NOT_FOUND",
          `Template author submission ${submissionId} was not found.`,
          [submissionId],
        );
      }
    }
    let entries: string[];
    try {
      const { readdir } = await import("node:fs/promises");
      entries = (await readdir(this.#draftRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^tas_[a-z2-7]{10}$/u.test(entry.name))
        .map(({ name }) => name)
        .sort();
    } catch {
      return [];
    }
    return Promise.all(entries.map((entry) => metadataAt(join(this.#draftRoot, entry))));
  }

  public async review(input: TemplateAuthorReviewInput): Promise<TemplateAuthorStatus> {
    const current = await this.status(input.submissionId);
    if (current.status !== "awaiting_review") {
      throw authoringError(
        "E_TEMPLATE_REVIEW_FINAL",
        `Template submission ${input.submissionId} is ${current.status} and cannot be reviewed again.`,
        [input.submissionId],
      );
    }
    const reason = input.reason?.trim();
    if (input.decision !== "approve" && (reason === undefined || reason === "")) {
      throw authoringError(
        "E_TEMPLATE_REVIEW_REASON_REQUIRED",
        `${input.decision} requires a creator reason.`,
        [input.submissionId],
      );
    }
    if (input.decision === "approve") {
      const published = await this.#publish(current);
      const updated = await this.#update(current.submissionId, {
        status: "published",
        published,
      });
      this.#onAudit?.({ type: "reviewed", status: structuredClone(updated), decision: "approve" });
      return updated;
    }
    const status = input.decision === "reject" ? "rejected" : "changes_requested";
    const updated = await this.#update(current.submissionId, { status, reason: reason! });
    this.#onAudit?.({
      type: "reviewed",
      status: structuredClone(updated),
      decision: input.decision,
    });
    return updated;
  }

  async #publish(current: TemplateAuthorStatus): Promise<TemplateDescriptor> {
    const source = join(this.#draftRoot, current.submissionId);
    const temporary = join(this.#draftRoot, `.${current.submissionId}-publish`);
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true });
    try {
      for (const name of ["render.ts", "preview.png", "previews"]) {
        await cp(join(source, name), join(temporary, name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      const draftManifest = parse(await readFile(join(source, "template.yaml"), "utf8")) as
        Record<string, unknown>;
      draftManifest["version"] = "1.0.0";
      await writeFile(
        join(temporary, "template.yaml"),
        stringify(draftManifest, { lineWidth: 0 }),
        "utf8",
      );
      const draftPackage = await this.#registry.validateDraftPackage(source);
      if (!draftPackage.ok) throw draftPackage.error;
      for (const declaration of [
        ...draftPackage.value.manifest.fonts,
        ...(draftPackage.value.manifest.assets ?? []),
      ]) {
        await mkdir(dirname(join(temporary, declaration.file)), { recursive: true });
        await cp(join(source, declaration.file), join(temporary, declaration.file), {
          force: false,
          errorOnExist: true,
        });
      }
      await writeFile(
        join(temporary, "authoring-provenance.json"),
        `${JSON.stringify({
          schema: "guyditor/template-author-provenance/v1",
          submissionId: current.submissionId,
          templateId: current.templateId,
          sessionId: current.provenance.sessionId,
          model: current.provenance.model,
          submittedAt: current.submittedAt,
          acceptedAt: this.#now().toISOString(),
          description: current.description,
          checks: current.checks.map(({ check: checkName, ok, errors }) => ({
            check: checkName,
            ok,
            errors,
          })),
        }, null, 2)}\n`,
        "utf8",
      );
      const installed = await this.#registry.install({ packagePath: temporary }, { dryRun: false });
      if (!installed.ok) throw installed.error;
      return installed.value;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #update(
    submissionId: string,
    patch: Partial<Pick<
      DraftMetadata,
      "status" | "reason" | "supersededBy" | "published"
    >>,
  ): Promise<TemplateAuthorStatus> {
    const directory = join(this.#draftRoot, submissionId);
    const current = await metadataAt(directory);
    const next: DraftMetadata = {
      ...current,
      ...structuredClone(patch),
      updatedAt: this.#now().toISOString(),
    };
    await this.#writeMetadata(directory, next);
    return next;
  }

  async #writeMetadata(directory: string, metadata: DraftMetadata): Promise<void> {
    const target = join(directory, STATUS_FILE);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }
}
