import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
  deriveTimeline,
  makeGuyditorError,
  parseProjectYaml,
  resolveAnchor,
} from "../../core/src/index.js";
import type {
  Deliverable,
  GuyditorError,
  GuyditorProject,
  JobExecutorContext,
  JobQueue,
  KeySettings,
  ProjectStore,
} from "../../core/src/index.js";
import {
  DEFAULT_CAPTION_STYLE,
  buildWordTimelineMap,
  compileCaptionTrack,
  createTranscriptWordLookup,
  loadPinnedCaptionPreset,
  parseTranscriptSidecar,
  resolveCaptionStyle,
  serializeSubtitles,
} from "../../transcript/src/index.js";
import type {
  CaptionFrameSpec,
  CaptionRenderModel,
  TranscriptSidecar,
} from "../../transcript/src/index.js";
import {
  probeMedia,
  resolveFfmpeg,
  resolveFfprobe,
  runFfmpeg,
} from "../../media/src/index.js";

import { compileFiltergraph } from "./filtergraph.js";
import { compileRenderGraph } from "./graph.js";
import type { DiagnosticBackground } from "./graph.js";
import type {
  EncodeNodeParams,
  RenderGraph,
  SourceNodeParams,
  ToolchainManifest,
} from "./ir.js";
import { loadRenderProfile } from "./profile.js";
import type { LoadedRenderProfile } from "./profile.js";
import {
  captionOverlayToolchain,
  createCaptionTextMeasurer,
  renderCaptionOverlaySequence,
} from "./caption-overlay.js";
import {
  GRAPHIC_OVERLAY_RENDERER_VERSION,
  renderGraphicFrame,
  renderGraphicOverlaySequence,
} from "./graphic-overlay.js";
import {
  loadTemplateRuntime,
  renderTemplatePng,
  TEMPLATE_RENDERER_VERSION,
} from "./template-runtime.js";
import { TemplateRegistry } from "./template-registry.js";
import type { TemplateCatalogEntry } from "./template-registry.js";
import { rasterizeKeyMasks } from "./key-mask.js";
import { rasterizePipAssets } from "./pip-assets.js";
import type { RasterizedPipAssets } from "./pip-assets.js";

const RENDER_PACKAGE_VERSION = "0.0.0";

export interface RenderRequest {
  revision: string;
  deliverableId: string;
  range?: { startFrame: number; endFrame: number };
  quality: "proxy" | "high";
}

export interface DiagnosticRenderRequest {
  revision: string;
  deliverableId: string;
  inspectedLayerId: string;
  diagnosticBackground: Exclude<DiagnosticBackground, "none">;
  saturatedColor?: string;
  outputDir: string;
}

export interface DiagnosticRenderResult {
  jobId: string;
  outputPath: string;
}

export interface ExportRequest {
  revision: string;
  deliverableId: string;
  variants: Array<"burnin" | "clean">;
  outputDir: string;
  skipValidationWarnings?: boolean;
}

export interface ExportEnqueueResult {
  jobId: string;
  jobIds: string[];
  subtitlePaths: { srt: string; vtt: string } | null;
}

export interface FunctionalEquivalenceSpec {
  videoHashMax?: number;
  videoHashMean?: number;
  loudnessLu?: number;
  truePeakDb?: number;
}

export interface EquivalenceResult {
  equivalent: boolean;
  differences: string[];
}

export interface ExportValidationCheckResult {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
  affected: string[];
  range?: { startFrame: number; endFrame: number };
  measured?: Record<string, number>;
}

export interface ExportValidationResult {
  deliverableId: string;
  revision: string;
  profileId: string;
  profileVersion: string;
  checks: ExportValidationCheckResult[];
  outcome: "pass" | "warnings" | "blocked";
}

export interface ExportReport {
  reportVersion: "guyditor-export-report/1";
  createdAt: string;
  jobId: string;
  revision: string;
  deliverableId: string;
  variant: "burnin" | "clean";
  profile: { id: string; version: string; sha256: string };
  toolchain: ToolchainManifest;
  sources: Array<{ assetId: string; path: string; sha256: string }>;
  sidecars: Array<{ path: string; sha256: string }>;
  renderSettings: EncodeNodeParams;
  validation: ExportValidationResult;
  warnings: string[];
  warningsAcknowledged: boolean;
  output: {
    path: string;
    sha256: string;
    bytes: number;
    durationFrames: number;
    fps: string;
    width: number;
    height: number;
    container: string;
  };
}

export interface RenderServiceOptions {
  projectRoot: string;
  store: ProjectStore;
  jobQueue: JobQueue;
  profilesRoot?: string | URL;
  templateRegistry?: TemplateRegistry;
}

interface PreparedExport {
  command: ReturnType<typeof compileFiltergraph>;
  graph: RenderGraph;
  outputPath: string;
  profile: LoadedRenderProfile;
  project: GuyditorProject;
  request: ExportRequest;
  validation: ExportValidationResult;
  variant: "burnin" | "clean";
}

interface PrepareOptions {
  diagnostic?: {
    background: Exclude<DiagnosticBackground, "none">;
    inspectedLayerId: string;
    saturatedColor?: string;
  };
}

function renderUnsupported(feature: string, part: string, affected: readonly string[] = []): GuyditorError {
  return makeGuyditorError(
    "E_RENDER_UNSUPPORTED",
    `${feature} is unsupported by the M0 renderer; ${part} owns this feature.`,
    { affected },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : String(error);
}

function commandFailureMessage(error: unknown): string {
  const message = errorMessage(error);
  if (
    typeof error === "object" && error !== null &&
    "stderrLines" in error && Array.isArray(error.stderrLines)
  ) {
    const lines = error.stderrLines.filter((line): line is string => typeof line === "string");
    if (lines.length > 0) return `${message}: ${lines.join(" | ")}`;
  }
  return message;
}

function isGuyditorError(error: unknown): error is GuyditorError {
  return typeof error === "object" && error !== null &&
    "code" in error && typeof error.code === "string" &&
    "message" in error && typeof error.message === "string" &&
    "affected" in error && Array.isArray(error.affected);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolvedMediaPath(projectRoot: string, path: string): string {
  if (isAbsolute(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)) return path;
  return resolve(projectRoot, path);
}

function profilePin(pin: string): { id: string; version: string } {
  const separator = pin.lastIndexOf("@");
  return separator === -1
    ? { id: pin, version: "unknown" }
    : { id: pin.slice(0, separator), version: pin.slice(separator + 1) };
}

function captionPreset(
  deliverable: Deliverable,
  project: GuyditorProject,
): { presetId: string; version: number } {
  const track = project.captions.find(({ id }) => id === deliverable.captionsTrackId);
  if (track === undefined) {
    throw new TypeError(`Caption track ${deliverable.captionsTrackId ?? "<unset>"} does not exist.`);
  }
  return track.preset;
}

function isProposalRevision(revision: string): boolean {
  return /^prp_[a-z2-7]{10}$/u.test(revision);
}

function requirePreviewFrame(frame: number, label: string): void {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new RangeError(`${label} preview frame must be a non-negative safe integer.`);
  }
}

function platform(): ToolchainManifest["os"] {
  if (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") {
    return process.platform;
  }
  throw renderUnsupported(`operating system ${process.platform}`, "Part 1");
}

async function toolchainManifest(): Promise<ToolchainManifest> {
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  return {
    ffmpeg: { version: ffmpeg.version, buildSha256: await sha256(ffmpeg.path) },
    ffprobe: { version: ffprobe.version, buildSha256: await sha256(ffprobe.path) },
    renderPackage: RENDER_PACKAGE_VERSION,
    overlayRenderer: {
      ...captionOverlayToolchain(),
      version: `${captionOverlayToolchain().version}+${GRAPHIC_OVERLAY_RENDERER_VERSION}+${TEMPLATE_RENDERER_VERSION}`,
    },
    encoderThreads: 1,
    os: platform(),
  };
}

function progressMicroseconds(line: string): bigint | undefined {
  const match = /^out_time=(\d+):(\d+):(\d+)(?:\.(\d+))?$/u.exec(line);
  if (match === null) return undefined;
  const fractional = (match[4] ?? "").padEnd(6, "0").slice(0, 6);
  return (
    BigInt(match[1]!) * 3_600_000_000n +
    BigInt(match[2]!) * 60_000_000n +
    BigInt(match[3]!) * 1_000_000n +
    BigInt(fractional.length === 0 ? "0" : fractional)
  );
}

function rationalMicroseconds(value: string): bigint {
  const match = /^(\d+)(?:\/(\d+))?$/u.exec(value);
  if (match === null) throw new Error(`Invalid exact duration ${value}.`);
  return BigInt(match[1]!) * 1_000_000n / BigInt(match[2] ?? "1");
}

export function exportOutputPath(
  outputDir: string,
  deliverableId: string,
  variant: "burnin" | "clean",
  container: "mp4" | "mov" | "webm",
): string {
  return join(outputDir, `${deliverableId}-${variant}.${container}`);
}

export function exportReportPath(outputPath: string): string {
  const extension = extname(outputPath);
  return `${outputPath.slice(0, -extension.length)}.export-report.json`;
}

export function subtitleOutputPaths(
  outputDir: string,
  deliverableId: string,
): { srt: string; vtt: string } {
  return {
    srt: join(outputDir, `${deliverableId}.srt`),
    vtt: join(outputDir, `${deliverableId}.vtt`),
  };
}

export class RenderService {
  readonly #projectRoot: string;
  readonly #store: ProjectStore;
  readonly #jobQueue: JobQueue;
  readonly #profilesRoot: string | URL;
  readonly #templateRegistry: TemplateRegistry;
  readonly #prepared = new Map<string, PreparedExport>();

  public constructor(options: RenderServiceOptions) {
    this.#projectRoot = resolve(options.projectRoot);
    this.#store = options.store;
    this.#jobQueue = options.jobQueue;
    this.#profilesRoot = options.profilesRoot ?? resolve("profiles");
    this.#templateRegistry = options.templateRegistry ?? new TemplateRegistry({
      projectRoot: join(this.#projectRoot, "templates"),
    });
    this.#jobQueue.registerExecutor("render.export", async (job, context) => {
      const prepared = this.#prepared.get(job.jobId);
      if (prepared === undefined) {
        throw makeGuyditorError(
          "E_RENDER_SEGMENT_FAILED",
          `Render job ${job.jobId} has no compiled M0 graph in this process.`,
          { affected: [job.jobId], retry: "safe" },
        );
      }
      await this.#execute(job.jobId, prepared, context);
      return {
        deliverableId: prepared.request.deliverableId,
        outputPath: prepared.outputPath,
        reportPath: exportReportPath(prepared.outputPath),
        revision: prepared.graph.revision,
        variant: prepared.variant,
      };
    });
    this.#jobQueue.registerExecutor("render.diagnostic", async (job, context) => {
      const prepared = this.#prepared.get(job.jobId);
      if (prepared === undefined) {
        throw makeGuyditorError(
          "E_RENDER_SEGMENT_FAILED",
          `Diagnostic render job ${job.jobId} has no compiled graph in this process.`,
          { affected: [job.jobId], retry: "safe" },
        );
      }
      await this.#execute(job.jobId, prepared, context);
      return {
        deliverableId: prepared.request.deliverableId,
        outputPath: prepared.outputPath,
        revision: prepared.graph.revision,
        variant: "diagnostic",
      };
    });
  }

  public async renderPreview(req: RenderRequest): Promise<{ jobId: string }> {
    void req;
    throw renderUnsupported("preview rendering", "Part 12");
  }

  public async renderDiagnostic(req: DiagnosticRenderRequest): Promise<DiagnosticRenderResult> {
    const request: ExportRequest = {
      revision: req.revision,
      deliverableId: req.deliverableId,
      outputDir: req.outputDir,
      variants: ["clean"],
      skipValidationWarnings: true,
    };
    const prepared = await this.#prepare(request, "clean", {
      diagnostic: {
        background: req.diagnosticBackground,
        inspectedLayerId: req.inspectedLayerId,
        ...(req.saturatedColor === undefined ? {} : { saturatedColor: req.saturatedColor }),
      },
    });
    const job = this.#jobQueue.enqueue({
      kind: "render.diagnostic",
      title: `Render ${req.diagnosticBackground} key diagnostic for ${req.inspectedLayerId}`,
      cancellable: true,
      payload: {
        background: req.diagnosticBackground,
        deliverableId: req.deliverableId,
        inspectedLayerId: req.inspectedLayerId,
        outputPath: prepared.outputPath,
        revision: prepared.graph.revision,
      },
    });
    this.#prepared.set(job.jobId, prepared);
    return { jobId: job.jobId, outputPath: prepared.outputPath };
  }

  public async captionFrame(request: {
    revision: string;
    deliverableId: string;
    frame: number;
  }): Promise<CaptionFrameSpec> {
    requirePreviewFrame(request.frame, "Caption");
    const project = await this.#loadProject(request.revision);
    await this.#verifySidecars(project);
    const deliverable = project.deliverables.find(({ id }) => id === request.deliverableId);
    if (deliverable === undefined) {
      throw makeGuyditorError(
        "E_RENDER_DELIVERABLE_NOT_FOUND",
        `Deliverable ${request.deliverableId} does not exist at ${project.revision}.`,
        { affected: [request.deliverableId, project.revision] },
      );
    }
    const model = await this.#captionModel(project, deliverable);
    return model?.captionsAtFrame(request.frame) ?? {
      cues: [],
      styleResolved: resolveCaptionStyle(DEFAULT_CAPTION_STYLE, {}),
    };
  }

  public async templateCatalog(): Promise<TemplateCatalogEntry[]> {
    const catalog = await this.#templateRegistry.list();
    if (!catalog.ok) throw catalog.error;
    return Promise.all(catalog.value.map(async (entry) => ({
      ...entry,
      previewDataUrl: `data:image/png;base64,${(await readFile(entry.previewPath)).toString("base64")}`,
    })));
  }

  public async templateFrame(request: {
    templateId: string;
    params?: Record<string, unknown>;
    seed?: number;
    frame?: number;
  }): Promise<{ dataUrl: string; width: number; height: number }> {
    const descriptor = await this.#templateRegistry.latest(request.templateId);
    if (!descriptor.ok) throw descriptor.error;
    const pkg = await this.#templateRegistry.package(
      descriptor.value.id,
      descriptor.value.version,
      descriptor.value.contentHash,
    );
    if (!pkg.ok) throw pkg.error;
    const runtime = await loadTemplateRuntime(pkg.value);
    if (!runtime.ok) throw runtime.error;
    const totalFrames = pkg.value.manifest.duration.default?.frames ?? 120;
    const frame = request.frame ?? Math.round(totalFrames * 0.38);
    const png = renderTemplatePng(runtime.value, {
      params: request.params ?? pkg.value.manifest.preview.params,
      seed: request.seed ?? 0x4755_5944,
      frame: Math.max(0, Math.min(totalFrames - 1, frame)),
      totalFrames,
      fps: pkg.value.manifest.duration.default?.fps ?? "30/1",
      width: 640,
      height: 360,
      safeArea: { top: 22, right: 32, bottom: 22, left: 32 },
      brand: { palette: {} },
    });
    if (!png.ok) throw png.error;
    return {
      dataUrl: `data:image/png;base64,${png.value.toString("base64")}`,
      width: 640,
      height: 360,
    };
  }

  public async graphicsFrame(request: {
    revision: string;
    deliverableId: string;
    frame: number;
  }): Promise<{ dataUrl: string; width: number; height: number }> {
    requirePreviewFrame(request.frame, "Graphics");
    const project = await this.#loadProject(request.revision);
    await this.#verifySidecars(project);
    const deliverable = project.deliverables.find(({ id }) => id === request.deliverableId);
    if (deliverable === undefined) {
      throw makeGuyditorError(
        "E_RENDER_DELIVERABLE_NOT_FOUND",
        `Deliverable ${request.deliverableId} does not exist at ${project.revision}.`,
        { affected: [request.deliverableId, project.revision] },
      );
    }
    const sidecars = await this.#captionSidecars(project);
    const png = await renderGraphicFrame({
      project,
      sequenceId: deliverable.sequenceId,
      registry: this.#templateRegistry,
      anchorDependencies: { wordLookup: createTranscriptWordLookup(sidecars) },
      width: project.settings.timeline.width,
      height: project.settings.timeline.height,
      fps: project.settings.timeline.fps,
      frame: request.frame,
      brand: { palette: {} },
    });
    return {
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      width: project.settings.timeline.width,
      height: project.settings.timeline.height,
    };
  }

  public async renderExport(req: ExportRequest): Promise<ExportEnqueueResult> {
    if (isProposalRevision(req.revision)) {
      throw renderUnsupported(`proposal revision ${req.revision}`, "Part 5", [req.revision]);
    }
    const variants = [...new Set(req.variants)];
    if (variants.length === 0) {
      throw renderUnsupported("an export without a variant", "Part 12", [req.deliverableId]);
    }
    const preparedExports = await Promise.all(variants.map((variant) => this.#prepare(req, variant)));
    const validation = await this.validateExport(req.deliverableId, preparedExports[0]!.graph.revision);
    if (
      validation.outcome === "blocked" ||
      (validation.outcome === "warnings" && req.skipValidationWarnings !== true)
    ) {
      const failed = validation.checks.filter((check) => check.status !== "pass");
      throw makeGuyditorError(
        "E_EXPORT_VALIDATION_FAILED",
        `Export validation blocked ${req.deliverableId}: ${failed.map((check) => check.message).join("; ")}`,
        {
          affected: [...new Set(failed.flatMap((check) => check.affected))],
          suggestion: "Fix the failing validation checks and run validateExport again.",
        },
      );
    }
    const jobs = preparedExports.map((prepared) => {
      prepared.validation = validation;
      const job = this.#jobQueue.enqueue({
        kind: "render.export",
        title: `Render ${req.deliverableId} ${prepared.variant}`,
        cancellable: true,
        payload: {
          deliverableId: req.deliverableId,
          outputPath: prepared.outputPath,
          revision: prepared.graph.revision,
          variant: prepared.variant,
        },
      });
      this.#prepared.set(job.jobId, prepared);
      return job;
    });
    const first = jobs[0]!;
    return {
      jobId: first.jobId,
      jobIds: jobs.map(({ jobId }) => jobId),
      subtitlePaths: preparedExports[0]!.project.deliverables.find(({ id }) => id === req.deliverableId)?.captionsTrackId === undefined
        ? null
        : subtitleOutputPaths(resolve(req.outputDir), req.deliverableId),
    };
  }

  public async validateExport(
    deliverableId: string,
    revision: string,
  ): Promise<ExportValidationResult> {
    const checks: ExportValidationCheckResult[] = [];
    let project: GuyditorProject;
    try {
      project = await this.#loadProject(revision);
      checks.push({
        id: "VAL-REVISION",
        status: "pass",
        message: `Accepted revision ${project.revision} exists.`,
        affected: [project.revision],
      });
    } catch (error: unknown) {
      checks.push({
        id: "VAL-REVISION",
        status: "fail",
        message: errorMessage(error),
        affected: [revision],
      });
      return {
        deliverableId,
        revision,
        profileId: "unknown",
        profileVersion: "unknown",
        checks,
        outcome: "blocked",
      };
    }
    const deliverable = project.deliverables.find((item) => item.id === deliverableId);
    if (deliverable === undefined) {
      checks.push({
        id: "VAL-DELIVERABLE",
        status: "fail",
        message: `Deliverable ${deliverableId} does not exist at ${project.revision}.`,
        affected: [deliverableId, project.revision],
      });
      return {
        deliverableId,
        revision: project.revision,
        profileId: "unknown",
        profileVersion: "unknown",
        checks,
        outcome: "blocked",
      };
    }
    const pin = profilePin(deliverable.profile);
    checks.push({
      id: "VAL-DELIVERABLE",
      status: "pass",
      message: `Deliverable ${deliverableId} exists.`,
      affected: [deliverableId],
    });
    const sequence = project.sequences.find((item) => item.id === deliverable.sequenceId);
    const assetIds = new Set(sequence?.clips.map((clip) => clip.asset) ?? []);
    for (const asset of project.assets.filter((item) => assetIds.has(item.id))) {
      const path = resolvedMediaPath(this.#projectRoot, asset.path);
      if (!await exists(path)) {
        checks.push({
          id: "VAL-100",
          status: "fail",
          message: `Asset ${asset.id} is missing at its recorded local path.`,
          affected: [asset.id],
        });
        continue;
      }
      const actual = await sha256(path);
      checks.push({
        id: actual === asset.sha256 ? "VAL-100" : "VAL-101",
        status: actual === asset.sha256 ? "pass" : "fail",
        message: actual === asset.sha256
          ? `Asset ${asset.id} exists with its recorded SHA-256.`
          : `Asset ${asset.id} SHA-256 mismatch: expected ${asset.sha256}, received ${actual}.`,
        affected: [asset.id],
      });
    }
    for (const sidecar of project.sidecars) {
      const path = resolvedMediaPath(this.#projectRoot, sidecar.path);
      const actual = await exists(path) ? await sha256(path) : undefined;
      checks.push({
        id: "VAL-300",
        status: actual === sidecar.sha256 ? "pass" : "fail",
        message: actual === sidecar.sha256
          ? `Sidecar ${sidecar.path} exists with its recorded SHA-256.`
          : `Sidecar ${sidecar.path} is missing or does not match its recorded SHA-256.`,
        affected: [sidecar.path],
      });
    }
    if (deliverable.captionsTrackId !== undefined) {
      try {
        const model = await this.#captionModel(project, deliverable);
        if (model !== undefined) {
          const orphaned = model.diagnostics.orphanedAnchors;
          const overflow = model.cues.flatMap(({ overflow }) => overflow);
          checks.push({
            id: "VAL-CAPTION-ANCHORS",
            status: orphaned.length === 0 ? "pass" : "fail",
            message: orphaned.length === 0
              ? "Caption word anchors resolve on the derived timeline."
              : `${String(orphaned.length)} caption override anchors are orphaned.`,
            affected: orphaned.length === 0 ? [deliverable.captionsTrackId] : orphaned.map(({ anchor }) => anchor),
          });
          checks.push({
            id: "VAL-CAPTION-OVERFLOW",
            status: overflow.length === 0 ? "pass" : "fail",
            message: overflow.length === 0
              ? "Caption words fit the configured safe width."
              : `${String(overflow.length)} caption words exceed the configured safe width.`,
            affected: overflow.length === 0 ? [deliverable.captionsTrackId] : overflow,
          });
          const ambiguous = model.diagnostics.ambiguousRanges;
          checks.push({
            id: "VAL-CAPTION-AMBIGUITY",
            status: ambiguous.length === 0 ? "pass" : "warn",
            message: ambiguous.length === 0
              ? "Caption speech mapping is unambiguous."
              : `${String(ambiguous.length)} overlapping speech ranges need review.`,
            affected: ambiguous.length === 0
              ? [deliverable.captionsTrackId]
              : [...new Set(ambiguous.flatMap(({ layerIds }) => layerIds))],
          });
          const provisional = model.diagnostics.provisionalAssetIds ?? [];
          checks.push({
            id: "VAL-CAPTION-PROVISIONAL",
            status: provisional.length === 0 ? "pass" : "warn",
            message: provisional.length === 0
              ? "Caption timing comes from canonical aligned transcripts."
              : `${String(provisional.length)} imported subtitle transcript needs audio realignment.`,
            affected: provisional.length === 0 ? [deliverable.captionsTrackId] : provisional,
          });
        }
      } catch (error: unknown) {
        checks.push({
          id: "VAL-CAPTION-COMPILE",
          status: "fail",
          message: errorMessage(error),
          affected: [deliverable.captionsTrackId],
        });
      }
    }
    const graphics = project.layers.flatMap((layer) =>
      layer.enabled &&
      (layer.sequence === undefined || layer.sequence === deliverable.sequenceId) &&
      (layer.kind === "text" || layer.kind === "animation")
        ? (layer.items ?? []).filter(({ template }) => template !== undefined)
        : []);
    if (graphics.length > 0) {
      try {
        const sidecars = await this.#captionSidecars(project);
        await renderGraphicFrame({
          project,
          sequenceId: deliverable.sequenceId,
          registry: this.#templateRegistry,
          anchorDependencies: { wordLookup: createTranscriptWordLookup(sidecars) },
          width: project.settings.timeline.width,
          height: project.settings.timeline.height,
          fps: project.settings.timeline.fps,
          frame: 0,
          brand: { palette: {} },
        });
        checks.push({
          id: "VAL-GRAPHICS",
          status: "pass",
          message: `${String(graphics.length)} deliberate graphic instance(s) resolve to pinned deterministic templates.`,
          affected: graphics.map(({ id }) => id),
        });
      } catch (error: unknown) {
        checks.push({
          id: "VAL-GRAPHICS",
          status: "fail",
          message: errorMessage(error),
          affected: isGuyditorError(error)
            ? error.affected
            : graphics.map(({ id }) => id),
        });
      }
    }
    try {
      const profile = await loadRenderProfile(deliverable.profile, this.#profilesRoot);
      const resolved = this.#withResolvedAssetPaths(project);
      const anchorFrames = await this.#pipAnchorFrames(
        resolved,
        deliverable,
        await this.#captionSidecars(project),
      );
      compileRenderGraph({
        project: resolved,
        revision: resolved.revision,
        deliverableId,
        variant: "clean",
        quality: "high",
        profile: profile.profile,
        profileSha256: profile.sha256,
        toolchain: await toolchainManifest(),
        anchorFrames,
      });
      checks.push({
        id: "VAL-200",
        status: "pass",
        message: "The deliverable uses the supported M0 render subset.",
        affected: [deliverableId],
      });
    } catch (error: unknown) {
      checks.push({
        id: "VAL-200",
        status: "fail",
        message: errorMessage(error),
        affected: isGuyditorError(error) ? error.affected : [deliverableId],
      });
    }
    return {
      deliverableId,
      revision: project.revision,
      profileId: pin.id,
      profileVersion: pin.version,
      checks,
      outcome: checks.some((check) => check.status === "fail")
        ? "blocked"
        : checks.some((check) => check.status === "warn")
          ? "warnings"
          : "pass",
    };
  }

  public async verifyEquivalence(
    fileA: string,
    fileB: string,
    spec?: FunctionalEquivalenceSpec,
  ): Promise<EquivalenceResult> {
    void fileA;
    void fileB;
    void spec;
    throw renderUnsupported("functional equivalence comparison", "Part 12");
  }

  public async cacheStats(): Promise<{ entries: number; bytes: number; byKind: Record<string, number> }> {
    throw renderUnsupported("render cache statistics", "Part 13");
  }

  async #loadProject(revision: string): Promise<GuyditorProject> {
    if (isProposalRevision(revision)) {
      throw renderUnsupported(`proposal revision ${revision}`, "Part 5", [revision]);
    }
    if (revision === "accepted" || revision === this.#store.head) {
      return structuredClone(this.#store.currentProject);
    }
    if (!/^rev_\d{5}$/u.test(revision)) {
      throw makeGuyditorError(
        "E_RENDER_REVISION_NOT_FOUND",
        `Revision ${revision} is not an accepted revision id.`,
        { affected: [revision] },
      );
    }
    const snapshotPath = join(this.#projectRoot, "history/revisions", `${revision}.yaml`);
    let text: string;
    try {
      text = await readFile(snapshotPath, "utf8");
    } catch {
      throw makeGuyditorError(
        "E_RENDER_REVISION_NOT_FOUND",
        `Accepted revision ${revision} does not exist.`,
        { affected: [revision] },
      );
    }
    const parsed = parseProjectYaml(text);
    if (!parsed.ok || parsed.value.revision !== revision) {
      throw makeGuyditorError(
        "E_RENDER_REVISION_NOT_FOUND",
        `Accepted revision snapshot ${revision} is invalid.`,
        { affected: [revision] },
      );
    }
    return parsed.value;
  }

  #withResolvedAssetPaths(project: GuyditorProject): GuyditorProject {
    const resolved = structuredClone(project);
    for (const asset of resolved.assets) {
      asset.path = resolvedMediaPath(this.#projectRoot, asset.path);
    }
    return resolved;
  }

  async #verifySidecars(project: GuyditorProject): Promise<void> {
    for (const sidecar of project.sidecars) {
      const path = resolvedMediaPath(this.#projectRoot, sidecar.path);
      const actual = await exists(path) ? await sha256(path) : undefined;
      if (actual !== sidecar.sha256) {
        throw makeGuyditorError(
          "E_RENDER_SIDECAR_HASH_MISMATCH",
          `Sidecar ${sidecar.path} does not match revision ${project.revision}.`,
          {
            affected: [sidecar.path, project.revision],
            suggestion: "Regenerate or restore the sidecar, then run the project integrity check.",
          },
        );
      }
    }
  }

  async #captionSidecars(project: GuyditorProject): Promise<TranscriptSidecar[]> {
    const sidecars: TranscriptSidecar[] = [];
    for (const reference of project.sidecars) {
      if (reference.schema !== "guyditor.transcript/v1") continue;
      sidecars.push(parseTranscriptSidecar(await readFile(
        resolvedMediaPath(this.#projectRoot, reference.path),
        "utf8",
      )));
    }
    return sidecars;
  }

  async #pipAnchorFrames(
    project: GuyditorProject,
    deliverable: Deliverable,
    sidecars: readonly TranscriptSidecar[],
  ): Promise<Record<string, number>> {
    const anchors = [...new Set(project.layers.flatMap(({ pip }) =>
      pip?.keyframes.map(({ at }) => at) ?? []))];
    const frames: Record<string, number> = {};
    const dependencies = { wordLookup: createTranscriptWordLookup(sidecars) };
    for (const anchor of anchors) {
      const resolution = await resolveAnchor(project, anchor, deliverable.sequenceId, dependencies);
      if (!resolution.ok) throw resolution.error;
      if (resolution.value.status !== "resolved" || resolution.value.timeline === undefined) {
        throw makeGuyditorError(
          "E_PIP_ANCHOR_UNRESOLVED",
          `PiP anchor ${anchor} is orphaned and cannot be rendered.`,
          { affected: [anchor] },
        );
      }
      frames[anchor] = resolution.value.timeline.frames;
    }
    return frames;
  }

  async #rasterizedPips(
    project: GuyditorProject,
    deliverable: Deliverable,
    anchorFrames: Readonly<Record<string, number>>,
  ): Promise<Record<string, RasterizedPipAssets>> {
    const timeline = deriveTimeline(project, deliverable.sequenceId);
    if (!timeline.ok) throw timeline.error;
    const [durationNumerator = "0", durationDenominator = "1"] = timeline.value.duration.split("/");
    const [fpsNumerator = "1", fpsDenominator = "1"] = project.settings.timeline.fps.split("/");
    const durationFrames = Number(
      BigInt(durationNumerator) * BigInt(fpsNumerator) /
      (BigInt(durationDenominator) * BigInt(fpsDenominator)),
    );
    const entries = await Promise.all(project.layers.flatMap((layer) =>
      layer.enabled && layer.pip !== undefined
        ? [rasterizePipAssets({
            pip: layer.pip,
            compWidth: project.settings.timeline.width,
            compHeight: project.settings.timeline.height,
            durationFrames: Math.max(1, durationFrames),
            anchorFrames,
            cacheRoot: join(this.#projectRoot, ".guyditor/cache/render/pip"),
          }).then((assets) => [layer.id, assets] as const)]
        : []));
    return Object.fromEntries(entries);
  }

  async #captionModel(
    project: GuyditorProject,
    deliverable: Deliverable,
  ): Promise<CaptionRenderModel | undefined> {
    const captionId = deliverable.captionsTrackId;
    if (captionId === undefined) return undefined;
    const track = project.captions.find(({ id }) => id === captionId);
    if (track === undefined || !track.enabled) return undefined;
    const pin = project.presets.find(({ id, version }) =>
      id === track.preset.presetId && version === track.preset.version);
    if (pin === undefined) throw new TypeError(`Caption preset ${track.preset.presetId}@${String(track.preset.version)} is not pinned.`);
    const preset = await loadPinnedCaptionPreset(this.#projectRoot, pin);
    const style = resolveCaptionStyle(preset.style, track.styleOverrides);
    const sidecars = await this.#captionSidecars(project);
    const timeline = buildWordTimelineMap({
      project,
      sequenceId: deliverable.sequenceId,
      track,
      sidecars,
    });
    const safeArea = style.safeArea === "none"
      ? { x: 0, y: 0, w: 1, h: 1 }
      : { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
    return compileCaptionTrack({
      track,
      timeline,
      sidecars,
      style,
      safeArea,
      output: {
        width: project.settings.timeline.width,
        height: project.settings.timeline.height,
        fps: project.settings.timeline.fps,
      },
      measureText: createCaptionTextMeasurer(),
    });
  }

  async #prepare(
    req: ExportRequest,
    variant: "burnin" | "clean",
    options: PrepareOptions = {},
  ): Promise<PreparedExport> {
    const loaded = await this.#loadProject(req.revision);
    await this.#verifySidecars(loaded);
    const project = this.#withResolvedAssetPaths(loaded);
    const deliverable = project.deliverables.find((item) => item.id === req.deliverableId);
    if (deliverable === undefined) {
      throw makeGuyditorError(
        "E_RENDER_DELIVERABLE_NOT_FOUND",
        `Deliverable ${req.deliverableId} does not exist at ${project.revision}.`,
        { affected: [req.deliverableId, project.revision] },
      );
    }
    const profile = await loadRenderProfile(deliverable.profile, this.#profilesRoot);
    const captionModel = await this.#captionModel(project, deliverable);
    let overlays: Parameters<typeof compileRenderGraph>[0]["overlays"] = [];
    if (captionModel !== undefined) {
      await mkdir(resolve(req.outputDir), { recursive: true });
      const subtitlePaths = subtitleOutputPaths(resolve(req.outputDir), req.deliverableId);
      await Promise.all([
        writeFile(subtitlePaths.srt, serializeSubtitles(captionModel, {
          format: "srt",
          vttWordTimestamps: false,
          vttPositioning: false,
          includeSpeakerLabels: false,
        }), "utf8"),
        writeFile(subtitlePaths.vtt, serializeSubtitles(captionModel, {
          format: "vtt",
          vttWordTimestamps: true,
          vttPositioning: true,
          includeSpeakerLabels: false,
        }), "utf8"),
      ]);
      if (variant === "burnin" && captionModel.cues.length > 0) {
        const plan = await renderCaptionOverlaySequence({
          model: captionModel,
          cacheRoot: join(this.#projectRoot, ".guyditor/cache/render/overlays"),
          versions: { preset: captionPreset(deliverable, project), captionRevision: project.revision },
        });
        overlays = [{
          overlayAssetPath: plan.pathPattern,
          overlaySha256: plan.overlaySha256,
          atOutputFrame: plan.atOutputFrame,
          durationFrames: plan.durationFrames,
        }];
      }
    }
    const transcriptSidecars = await this.#captionSidecars(project);
    const graphicPlan = await renderGraphicOverlaySequence({
      project,
      sequenceId: deliverable.sequenceId,
      registry: this.#templateRegistry,
      anchorDependencies: { wordLookup: createTranscriptWordLookup(transcriptSidecars) },
      width: project.settings.timeline.width,
      height: project.settings.timeline.height,
      fps: project.settings.timeline.fps,
      brand: { palette: {} },
      cacheRoot: join(this.#projectRoot, ".guyditor/cache/render/graphics"),
    });
    const graphicOverlays: Parameters<typeof compileRenderGraph>[0]["graphicOverlays"] =
      graphicPlan === undefined
        ? []
        : [{
            overlayAssetPath: graphicPlan.pathPattern,
            overlaySha256: graphicPlan.overlaySha256,
            atOutputFrame: graphicPlan.atOutputFrame,
            durationFrames: graphicPlan.durationFrames,
          }];
    const maskAssets = await this.#rasterizedMasks(project, deliverable);
    const anchorFrames = await this.#pipAnchorFrames(project, deliverable, transcriptSidecars);
    const pipAssets = await this.#rasterizedPips(project, deliverable, anchorFrames);
    const graph = compileRenderGraph({
      project,
      revision: project.revision,
      deliverableId: req.deliverableId,
      variant,
      quality: "high",
      profile: profile.profile,
      profileSha256: profile.sha256,
      toolchain: await toolchainManifest(),
      overlays,
      graphicOverlays,
      maskAssets,
      anchorFrames,
      pipAssets,
      ...(options.diagnostic === undefined ? {} : {
        diagnosticBackground: options.diagnostic.background,
        diagnosticSaturatedColor: options.diagnostic.saturatedColor,
        inspectedLayerId: options.diagnostic.inspectedLayerId,
      }),
    });
    const outputPath = options.diagnostic === undefined
      ? exportOutputPath(resolve(req.outputDir), req.deliverableId, variant, profile.profile.container)
      : join(
          resolve(req.outputDir),
          `${req.deliverableId}-${options.diagnostic.inspectedLayerId}-${options.diagnostic.background}.${profile.profile.container}`,
        );
    return {
      command: compileFiltergraph(graph, outputPath),
      graph,
      outputPath,
      profile,
      project,
      request: req,
      validation: {
        deliverableId: req.deliverableId,
        revision: graph.revision,
        profileId: profile.profile.id,
        profileVersion: profile.profile.version,
        checks: [],
        outcome: "pass",
      },
      variant,
    };
  }

  async #rasterizedMasks(
    project: GuyditorProject,
    deliverable: Deliverable,
  ): Promise<NonNullable<Parameters<typeof compileRenderGraph>[0]["maskAssets"]>> {
    const sequence = project.sequences.find(({ id }) => id === deliverable.sequenceId);
    if (sequence === undefined) return {};
    const candidates = [
      ...sequence.clips.map((clip) => ({
        assetId: clip.asset,
        durationFrames: Math.max(1, clip.source.out.frames - clip.source.in.frames),
        effects: clip.effects ?? [],
      })),
      ...project.layers.flatMap((layer) => (layer.items ?? []).flatMap((item) => {
        if (item.asset === undefined) return [];
        const durationFrames = typeof item.duration === "object" && "frames" in item.duration
          ? item.duration.frames
          : item.source !== undefined && "in" in item.source
            ? item.source.out.frames - item.source.in.frames
            : 1;
        return [{ assetId: item.asset, durationFrames: Math.max(1, durationFrames), effects: item.effects ?? [] }];
      })),
    ];
    const result: Record<string, { path: string; sha256: string; animated?: boolean }> = {};
    for (const candidate of candidates) {
      const asset = project.assets.find(({ id }) => id === candidate.assetId);
      if (asset === undefined) continue;
      for (const effect of candidate.effects.filter(({ kind }) => kind === "key")) {
        const settings = effect.params as unknown as KeySettings;
        if (settings.masks.length === 0) continue;
        const rendered = await rasterizeKeyMasks({
          masks: settings.masks,
          width: asset.video?.width ?? asset.image?.width ?? project.settings.timeline.width,
          height: asset.video?.height ?? asset.image?.height ?? project.settings.timeline.height,
          durationFrames: candidate.durationFrames,
          fps: project.settings.timeline.fps,
          cacheRoot: join(this.#projectRoot, ".guyditor/cache/masks"),
        });
        for (const mask of rendered) {
          result[mask.id] = { path: mask.path, sha256: mask.sha256, animated: mask.animated };
        }
      }
    }
    return result;
  }

  async #execute(
    jobId: string,
    prepared: PreparedExport,
    context: JobExecutorContext,
  ): Promise<void> {
    await mkdir(dirname(prepared.outputPath), { recursive: true });
    const expectedMicros = rationalMicroseconds(prepared.command.expectedDurationSeconds);
    try {
      await runFfmpeg(prepared.command.args, {
        signal: context.signal,
        onStdoutLine: (line) => {
          const current = progressMicroseconds(line);
          if (current === undefined || expectedMicros === 0n) return;
          const scaled = current * 1_000_000n / expectedMicros;
          context.reportProgress(Math.min(0.99, Number(scaled) / 1_000_000));
        },
      });
      const probe = await probeMedia(prepared.outputPath);
      if (
        probe.video === undefined ||
        probe.probe.duration === undefined ||
        !("frames" in probe.probe.duration) ||
        probe.probe.duration.frames !== prepared.command.expectedDurationFrames
      ) {
        throw makeGuyditorError(
          "E_RENDER_SEGMENT_FAILED",
          `Rendered ${prepared.request.deliverableId} did not have the expected exact frame duration.`,
          { affected: [prepared.request.deliverableId], retry: "safe" },
        );
      }
      await this.#writeReport(jobId, prepared, probe);
      this.#prepared.delete(jobId);
    } catch (error: unknown) {
      await rm(prepared.outputPath, { force: true }).catch(() => undefined);
      if (context.signal.aborted) {
        throw makeGuyditorError(
          "E_RENDER_CANCELLED",
          `Render job ${jobId} was cancelled.`,
          { affected: [jobId], retry: "safe" },
        );
      }
      if (isGuyditorError(error) && error.code !== "E_FFMPEG_FAILED" && error.code !== "E_FFMPEG_MISSING") {
        throw error;
      }
      throw makeGuyditorError(
        "E_RENDER_SEGMENT_FAILED",
        `FFmpeg failed for ${prepared.request.deliverableId}: ${commandFailureMessage(error)}`,
        {
          affected: [prepared.request.deliverableId],
          retry: "safe",
          suggestion: "Inspect the FFmpeg error and retry the render job.",
        },
      );
    }
  }

  async #writeReport(
    jobId: string,
    prepared: PreparedExport,
    probe: Awaited<ReturnType<typeof probeMedia>>,
  ): Promise<void> {
    if (probe.video === undefined || probe.probe.duration === undefined || !("frames" in probe.probe.duration)) {
      throw new Error("The completed export has no video duration.");
    }
    const encode = prepared.graph.nodes.find((node) => node.kind === "encode");
    if (encode === undefined) throw new Error("The completed export graph has no encode node.");
    const sources = new Map<string, { assetId: string; path: string; sha256: string }>();
    for (const node of prepared.graph.nodes.filter((item) => item.kind === "source")) {
      const source = node.params as SourceNodeParams;
      if (source.path.length > 0) {
        sources.set(source.assetId, {
          assetId: source.assetId,
          path: source.path,
          sha256: source.assetSha256,
        });
      }
    }
    const outputStat = await stat(prepared.outputPath);
    const report: ExportReport = {
      reportVersion: "guyditor-export-report/1",
      createdAt: new Date().toISOString(),
      jobId,
      revision: prepared.graph.revision,
      deliverableId: prepared.graph.deliverableId,
      variant: prepared.variant,
      profile: {
        id: prepared.profile.profile.id,
        version: prepared.profile.profile.version,
        sha256: prepared.profile.sha256,
      },
      toolchain: prepared.graph.toolchain,
      sources: [...sources.values()].sort((left, right) => left.assetId.localeCompare(right.assetId)),
      sidecars: prepared.project.sidecars.map((sidecar) => ({
        path: resolvedMediaPath(this.#projectRoot, sidecar.path),
        sha256: sidecar.sha256,
      })),
      renderSettings: encode.params as EncodeNodeParams,
      validation: prepared.validation,
      warnings: prepared.validation.checks
        .filter((check) => check.status === "warn")
        .map((check) => check.message),
      warningsAcknowledged: prepared.request.skipValidationWarnings === true,
      output: {
        path: prepared.outputPath,
        sha256: await sha256(prepared.outputPath),
        bytes: outputStat.size,
        durationFrames: probe.probe.duration.frames,
        fps: probe.video.fps,
        width: probe.video.width,
        height: probe.video.height,
        container: probe.container ?? prepared.profile.profile.container,
      },
    };
    await writeFile(exportReportPath(prepared.outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}
