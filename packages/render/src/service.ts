import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  convertTimeRounding,
  canonicalJson,
  deriveTimeline,
  makeId,
  makeGuyditorError,
  placedItemAppliesToSequence,
  OperationEngine,
  parseProjectYaml,
  programmaticAnimationSidecar,
  resolveBrandTemplateParams,
  resolveAnchor,
  touchedDerivativeIds,
} from "../../core/src/index.js";
import type {
  CaptionTrack,
  Deliverable,
  GuyditorError,
  GuyditorProject,
  JobExecutorContext,
  JobQueue,
  KeySettings,
  ProgrammaticAnimationProvenance,
  ProjectStore,
  TemplateBrandDefaults,
} from "../../core/src/index.js";
import {
  DEFAULT_CAPTION_STYLE,
  buildWordTimelineMap,
  compileCaptionTrack,
  compileDerivativeCaptionTrack,
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
  parseSubjectTrackAnalysis,
  materializeProgrammaticAnimationArtifact,
  probeMedia,
  resolveFfmpeg,
  resolveFfprobe,
  runFfmpeg,
} from "../../media/src/index.js";
import type { LoudnessTarget } from "../../media/src/index.js";
import { parseFramingSidecar, selectCoverFrames } from "../../deliver/src/index.js";
import type { FramingSidecar } from "../../deliver/src/index.js";

import { compileFiltergraph } from "./filtergraph.js";
import { compileRenderGraph } from "./graph.js";
import { framingPreviewSpec } from "./framing-preview.js";
import type { FramingPreviewSpec } from "./framing-preview.js";
import type { DiagnosticBackground } from "./graph.js";
import type {
  EncodeNodeParams,
  RenderGraph,
  SourceNodeParams,
  ToolchainManifest,
} from "./ir.js";
import { loadRenderProfile } from "./profile.js";
import type { LoadedRenderProfile, RenderProfile } from "./profile.js";
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
import { PRIMITIVES_V1_VERSION } from "./primitives/v1.js";
import {
  LOTTIE_RENDERER_VERSION,
  LOTTIE_SHIM_VERSION,
  lottieToolchainHash,
} from "./lottie.js";
import {
  loadTemplateRuntime,
  renderTemplatePng,
  resolveTemplateDuration,
  TEMPLATE_CANVAS_VERSION,
  TEMPLATE_RENDERER_VERSION,
} from "./template-runtime.js";
import { TemplateRegistry } from "./template-registry.js";
import type { TemplateCatalogEntry } from "./template-registry.js";
import type { BrandContext } from "./template-contract.js";
import { rasterizeKeyMasks } from "./key-mask.js";
import { rasterizePipAssets } from "./pip-assets.js";
import type { RasterizedPipAssets } from "./pip-assets.js";
import type { SpeechInterval } from "./ducking.js";
import {
  measureDeliveredLoudness,
  normalizeMasterLoudness,
} from "./loudness.js";
import { validateOverlayLayout, validatePublishMetadataCheck } from "./validation.js";
import { laplacianVariance } from "./cover-analysis.js";

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

export interface OutputSetRequest {
  revision: string;
  deliverableId: string;
  outputDir: string;
  skipValidationWarnings?: boolean;
}

export interface OutputSetEnqueueResult {
  jobId: string;
  jobIds: string[];
  output: OutputSetPaths;
}

export interface OutputSetPaths {
  root: string;
  videoBurned: string;
  videoClean: string;
  srt: string;
  vtt: string;
  coversDir: string;
  report: string;
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
  brandDefaults?: () => Promise<TemplateBrandDefaults | undefined>;
  onTemplateFreezePhase?: (phase: TemplateFreezePhase) => Promise<void>;
}

export type TemplateFreezePhase = "rendered" | "exact-preflighted" | "published";

export interface TemplateFreezeRequest {
  revision: string;
  deliverableId?: string;
  templateId: string;
  params?: Record<string, unknown>;
  seed?: number;
  durationFrames?: number;
  placeAsClip?: boolean;
  clipIndex?: number;
}

export interface TemplateFreezeResult {
  assetId: string;
  clipId?: string;
  sequenceId: string;
  outputPath: string;
  provenancePath: string;
  frames: number;
  fps: string;
  width: number;
  height: number;
  revision: string;
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
  loudness?: {
    audioKey: string;
    measurementPath: string;
    normalizedPath: string;
    sampleRate: number;
    target: LoudnessTarget;
    toleranceLu: number;
  };
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

function exactSamplesForSeconds(
  value: { num: number; den: number },
  sampleRate: number,
  feature: string,
): number {
  if (
    !Number.isSafeInteger(value.num) || !Number.isSafeInteger(value.den) || value.den <= 0 ||
    !Number.isSafeInteger(sampleRate) || sampleRate <= 0
  ) {
    throw makeGuyditorError(
      "E_RENDER_GRAPH_INVALID",
      `${feature} has an invalid rational time.`,
      { affected: [feature] },
    );
  }
  const numerator = BigInt(value.num) * BigInt(sampleRate);
  const denominator = BigInt(value.den);
  if (numerator < 0n || numerator % denominator !== 0n) {
    throw makeGuyditorError(
      "E_RENDER_UNSUPPORTED",
      `${feature} cannot be represented at ${String(sampleRate)} Hz without rounding.`,
      { affected: [feature] },
    );
  }
  const samples = numerator / denominator;
  if (samples > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw makeGuyditorError(
      "E_RENDER_UNSUPPORTED",
      `${feature} is outside exact sample bounds.`,
      { affected: [feature] },
    );
  }
  return Number(samples);
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

async function removePublishedFile(path: string): Promise<void> {
  await chmod(path, 0o644).catch(() => undefined);
  await rm(path, { force: true });
}

const COVER_ANALYSIS_WIDTH = 160;
const COVER_ANALYSIS_HEIGHT = 160;

async function coverSharpnessScores(input: {
  videoPath: string;
  durationFrames: number;
  fps: number;
  signal: AbortSignal;
}): Promise<Array<{ frame: number; sharpness: number }>> {
  const chunks: Buffer[] = [];
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", input.videoPath,
    "-vf", `fps=1,scale=${String(COVER_ANALYSIS_WIDTH)}:${String(COVER_ANALYSIS_HEIGHT)}:flags=area,format=gray`,
    "-an", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], {
    collectStdout: false,
    onStdoutChunk: (chunk) => chunks.push(Buffer.from(chunk)),
    signal: input.signal,
  });
  const bytes = Buffer.concat(chunks);
  const frameBytes = COVER_ANALYSIS_WIDTH * COVER_ANALYSIS_HEIGHT;
  const count = Math.floor(bytes.length / frameBytes);
  return Array.from({ length: count }, (_, index) => {
    const frame = Math.min(input.durationFrames - 1, Math.round(index * input.fps));
    return {
      frame,
      sharpness: laplacianVariance(
        bytes.subarray(index * frameBytes, (index + 1) * frameBytes),
        COVER_ANALYSIS_WIDTH,
        COVER_ANALYSIS_HEIGHT,
      ),
    };
  });
}

async function coverFaceAreas(input: {
  projectRoot: string;
  project: GuyditorProject;
  deliverable: Deliverable;
  frames: readonly number[];
  outputFps: string;
}): Promise<Map<number, number>> {
  const sequence = input.project.sequences.find(({ id }) => id === input.deliverable.sequenceId);
  if (sequence === undefined) return new Map();
  const derived = deriveTimeline(input.project, sequence.id);
  if (!derived.ok) throw derived.error;
  const tracking = new Map<string, ReturnType<typeof parseSubjectTrackAnalysis>>();
  for (const assetId of new Set(sequence.clips.map(({ asset }) => asset))) {
    const reference = input.project.sidecars.find(({ path, schema }) =>
      schema === "guyditor.analysis/v1" &&
      path === `sidecars/analysis/${assetId}.subject.track.json`);
    if (reference === undefined) continue;
    tracking.set(assetId, parseSubjectTrackAnalysis(await readFile(
      resolvedMediaPath(input.projectRoot, reference.path),
      "utf8",
    )));
  }
  const result = new Map<number, number>();
  for (const frame of input.frames) {
    const converted = convertTimeRounding(
      { frames: frame, fps: input.outputFps },
      input.project.settings.timeline.fps,
    );
    if (!converted.ok) continue;
    const timelineFrame = converted.value.time.frames;
    const timed = derived.value.clips.find(({ start, duration }) =>
      timelineFrame >= start.frames && timelineFrame < start.frames + duration.frames);
    const clip = sequence.clips.find(({ id }) => id === timed?.clipId);
    const sidecar = clip === undefined ? undefined : tracking.get(clip.asset);
    if (timed === undefined || clip === undefined) {
      result.set(frame, 0);
      continue;
    }
    if (sidecar === undefined) continue;
    const progress = timed.duration.frames <= 1
      ? 0
      : (timelineFrame - timed.start.frames) / timed.duration.frames;
    const sourceFrame = Math.min(
      clip.source.out.frames - 1,
      clip.source.in.frames + Math.max(0, Math.round(
        progress * (clip.source.out.frames - clip.source.in.frames),
      )),
    );
    const sample = sidecar.data.samples.slice().sort((left, right) =>
      Math.abs(left.frame - sourceFrame) - Math.abs(right.frame - sourceFrame) ||
      left.frame - right.frame)[0];
    result.set(frame, sample?.boxes.filter(({ kind }) => kind === "face")
      .reduce((total, box) => total + box.w * box.h, 0) ?? 0);
  }
  return result;
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
      version:
        `${captionOverlayToolchain().version}+${GRAPHIC_OVERLAY_RENDERER_VERSION}+` +
        `${TEMPLATE_RENDERER_VERSION}+${PRIMITIVES_V1_VERSION}+` +
        `${LOTTIE_RENDERER_VERSION}+${LOTTIE_SHIM_VERSION}+${lottieToolchainHash()}`,
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
  const paths = outputSetPaths(outputDir, deliverableId, container);
  return variant === "burnin" ? paths.videoBurned : paths.videoClean;
}

export function exportReportPath(outputPath: string): string {
  return join(dirname(outputPath), "export-report.json");
}

export function outputSetPaths(
  outputDir: string,
  deliverableId: string,
  container: "mp4" | "mov" | "webm",
): OutputSetPaths {
  const root = join(outputDir, deliverableId);
  return {
    root,
    videoBurned: join(root, `video.burned.${container}`),
    videoClean: join(root, `video.clean.${container}`),
    srt: join(root, "subtitles.srt"),
    vtt: join(root, "subtitles.vtt"),
    coversDir: join(root, "covers"),
    report: join(root, "export-report.json"),
  };
}

export function subtitleOutputPaths(
  outputDir: string,
  deliverableId: string,
): { srt: string; vtt: string } {
  return {
    srt: join(outputDir, deliverableId, "subtitles.srt"),
    vtt: join(outputDir, deliverableId, "subtitles.vtt"),
  };
}

export class RenderService {
  readonly #projectRoot: string;
  readonly #store: ProjectStore;
  readonly #jobQueue: JobQueue;
  readonly #profilesRoot: string | URL;
  readonly #templateRegistry: TemplateRegistry;
  readonly #brandDefaults: () => Promise<TemplateBrandDefaults | undefined>;
  readonly #onTemplateFreezePhase: RenderServiceOptions["onTemplateFreezePhase"];
  readonly #prepared = new Map<string, PreparedExport>();

  public constructor(options: RenderServiceOptions) {
    this.#projectRoot = resolve(options.projectRoot);
    this.#store = options.store;
    this.#jobQueue = options.jobQueue;
    this.#profilesRoot = options.profilesRoot ?? resolve("profiles");
    this.#templateRegistry = options.templateRegistry ?? new TemplateRegistry({
      projectRoot: join(this.#projectRoot, "templates"),
    });
    this.#brandDefaults = options.brandDefaults ?? (() => Promise.resolve(undefined));
    this.#onTemplateFreezePhase = options.onTemplateFreezePhase;
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
    this.#jobQueue.registerExecutor("render.outputset", async (job, context) => {
      const payload = job.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new TypeError(`Output-set job ${job.jobId} has an invalid payload.`);
      }
      const deliverableId = payload["deliverableId"];
      const revision = payload["revision"];
      const outputDir = payload["outputDir"];
      if (typeof deliverableId !== "string" || typeof revision !== "string" || typeof outputDir !== "string") {
        throw new TypeError(`Output-set job ${job.jobId} has incomplete identifiers.`);
      }
      return this.#finalizeOutputSet(deliverableId, revision, outputDir, context);
    });
  }

  async #brandContext(): Promise<BrandContext> {
    const defaults = await this.#brandDefaults();
    return defaults === undefined
      ? { palette: {} }
      : {
          palette: structuredClone(defaults.palette),
          fontSlots: structuredClone(defaults.fonts),
          logoSlotDefaults: structuredClone(defaults.logoSlots),
          templateDefaults: structuredClone(defaults),
        };
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

  public async framingFrame(request: {
    revision: string;
    deliverableId: string;
    frame: number;
  }): Promise<FramingPreviewSpec | null> {
    requirePreviewFrame(request.frame, "Framing");
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
    const framing = await this.#framingSidecar(project, deliverable);
    if (framing === undefined) return null;
    const sequence = project.sequences.find(({ id }) => id === deliverable.sequenceId);
    if (sequence === undefined) return null;
    const timeline = deriveTimeline(project, sequence.id);
    if (!timeline.ok) throw timeline.error;
    const timed = timeline.value.clips.find(({ start, duration }) =>
      request.frame >= start.frames && request.frame < start.frames + duration.frames);
    const clip = sequence.clips.find(({ id }) => id === timed?.clipId);
    if (timed === undefined || clip === undefined) return null;
    const sourceSpan = clip.source.out.frames - clip.source.in.frames;
    const progress = timed.duration.frames === 0
      ? 0
      : (request.frame - timed.start.frames) / timed.duration.frames;
    const sourceFrame = clip.source.in.frames + Math.round(progress * sourceSpan);
    const decision = framing.decisions.find(({ shot }) =>
      shot.clipId === clip.id &&
      sourceFrame >= shot.source.start.frames && sourceFrame < shot.source.end.frames);
    if (decision === undefined) return null;
    const trackReference = project.sidecars.find(({ schema, path }) =>
      schema === "guyditor.analysis/v1" &&
      path === `sidecars/analysis/${clip.asset}.subject.track.json`);
    const tracking = trackReference === undefined
      ? undefined
      : parseSubjectTrackAnalysis(await readFile(
          resolvedMediaPath(this.#projectRoot, trackReference.path),
          "utf8",
        ));
    const sample = tracking?.data.samples.slice().sort((left, right) =>
      Math.abs(left.frame - sourceFrame) - Math.abs(right.frame - sourceFrame) ||
      left.frame - right.frame)[0];
    const profile = (await loadRenderProfile(
      deliverable.profile,
      this.#profilesRoot,
      deliverable.profileOverrides,
    )).profile;
    const override = deliverable.framingOverrides?.find(({ decisionId }) =>
      decisionId === decision.decisionId);
    return framingPreviewSpec({
      decision,
      sourceFrame,
      ...(override === undefined ? {} : { override }),
      boxes: sample?.boxes ?? [],
      output: profile.video.resolution ?? {
        width: project.settings.timeline.width,
        height: project.settings.timeline.height,
      },
      safeArea: profile.safeAreas?.title ?? { top: 0, bottom: 0, left: 0, right: 0 },
    });
  }

  public async templateCatalog(): Promise<TemplateCatalogEntry[]> {
    const catalog = await this.#templateRegistry.list();
    if (!catalog.ok) throw catalog.error;
    const brand = await this.#brandContext();
    return Promise.all(catalog.value.map(async (entry) => ({
      ...entry,
      previewParams: resolveBrandTemplateParams({
        templateId: entry.id,
        schema: entry.params,
        explicit: {},
        ...(brand.templateDefaults === undefined
          ? {}
          : { brand: brand.templateDefaults }),
      }),
      previewDataUrl: `data:image/png;base64,${(await readFile(entry.previewPath)).toString("base64")}`,
      ...(entry.previewStripPaths === undefined
        ? {}
        : {
            previewStripDataUrls: await Promise.all(entry.previewStripPaths.map(async (path) =>
              `data:image/png;base64,${(await readFile(path)).toString("base64")}`)),
          }),
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
    const brand = await this.#brandContext();
    const png = renderTemplatePng(runtime.value, {
      params: resolveBrandTemplateParams({
        templateId: pkg.value.manifest.id,
        schema: pkg.value.manifest.params,
        explicit: request.params ?? {},
        ...(brand.templateDefaults === undefined
          ? {}
          : { brand: brand.templateDefaults }),
      }),
      seed: request.seed ?? 0x4755_5944,
      frame: Math.max(0, Math.min(totalFrames - 1, frame)),
      totalFrames,
      fps: pkg.value.manifest.duration.default?.fps ?? "30/1",
      width: 640,
      height: 360,
      safeArea: { top: 22, right: 32, bottom: 22, left: 32 },
      brand,
    });
    if (!png.ok) throw png.error;
    return {
      dataUrl: `data:image/png;base64,${png.value.toString("base64")}`,
      width: 640,
      height: 360,
    };
  }

  public async templateFreeze(
    request: TemplateFreezeRequest,
  ): Promise<TemplateFreezeResult> {
    const project = await this.#loadProject(request.revision);
    const deliverableId = request.deliverableId ?? project.settings.primaryDeliverable;
    const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
    if (deliverable === undefined) {
      throw makeGuyditorError(
        "E_RENDER_DELIVERABLE_NOT_FOUND",
        `Deliverable ${deliverableId} does not exist at ${project.revision}.`,
        { affected: [deliverableId, project.revision] },
      );
    }
    const profile = (await loadRenderProfile(
      deliverable.profile,
      this.#profilesRoot,
      deliverable.profileOverrides,
    )).profile;
    const width = profile.video.resolution?.width ?? project.settings.timeline.width;
    const height = profile.video.resolution?.height ?? project.settings.timeline.height;
    const fps = profile.video.fps ?? project.settings.timeline.fps;
    const pin = project.templates?.[request.templateId];
    const descriptor = pin === undefined
      ? await this.#templateRegistry.latest(request.templateId)
      : await this.#templateRegistry.get(request.templateId, pin.version);
    if (!descriptor.ok) throw descriptor.error;
    if (descriptor.value.reviewState === "draft") {
      throw makeGuyditorError(
        "E_TEMPLATE_UNREVIEWED",
        `Template ${request.templateId}@${descriptor.value.version} is awaiting creator review and is preview-only.`,
        { affected: [request.templateId] },
      );
    }
    if (pin !== undefined && descriptor.value.contentHash !== pin.contentHash) {
      throw makeGuyditorError(
        "E_TEMPLATE_MISSING_VERSION",
        `Template ${request.templateId}@${pin.version} does not match the project pin.`,
        { affected: [request.templateId] },
      );
    }
    const pkg = await this.#templateRegistry.package(
      descriptor.value.id,
      descriptor.value.version,
      descriptor.value.contentHash,
    );
    if (!pkg.ok) throw pkg.error;
    const runtime = await loadTemplateRuntime(pkg.value);
    if (!runtime.ok) throw runtime.error;
    const brand = await this.#brandContext();
    const params = resolveBrandTemplateParams({
      templateId: descriptor.value.id,
      schema: descriptor.value.params,
      explicit: request.params ?? {},
      ...(brand.templateDefaults === undefined
        ? {}
        : { brand: brand.templateDefaults }),
    });
    let frames = request.durationFrames;
    if (frames === undefined && descriptor.value.duration.default !== undefined) {
      const converted = convertTimeRounding(descriptor.value.duration.default, fps);
      if (!converted.ok) throw converted.error;
      frames = converted.value.time.frames;
    }
    if (frames === undefined) {
      const duration = resolveTemplateDuration(runtime.value, params, { width, height, fps });
      if (!duration.ok) throw duration.error;
      if (duration.value.mode !== "fixed") {
        throw makeGuyditorError(
          "E_TEMPLATE_DURATION_INVALID",
          `Template ${descriptor.value.id} needs an explicit duration to freeze.`,
          { affected: [descriptor.value.id] },
        );
      }
      const converted = convertTimeRounding(
        { frames: duration.value.frames, fps: duration.value.fps },
        fps,
      );
      if (!converted.ok) throw converted.error;
      frames = converted.value.time.frames;
    }
    if (!Number.isSafeInteger(frames) || frames < 1) {
      throw makeGuyditorError(
        "E_TEMPLATE_DURATION_INVALID",
        "Template freeze duration must be a positive safe frame count.",
        { affected: [descriptor.value.id] },
      );
    }
    const seed = request.seed ?? 0x4755_5944;
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw makeGuyditorError(
        "E_TEMPLATE_RENDER_CONTEXT",
        "Template freeze seed must be a uint32.",
        { affected: [descriptor.value.id] },
      );
    }
    const titleSafe = profile.safeAreas?.title;
    const safeArea = {
      top: Math.round(height * (titleSafe?.top ?? 0.05)),
      right: Math.round(width * (titleSafe?.right ?? 0.05)),
      bottom: Math.round(height * (titleSafe?.bottom ?? 0.05)),
      left: Math.round(width * (titleSafe?.left ?? 0.05)),
    };
    let assetId = makeId("ast");
    while (project.assets.some(({ id }) => id === assetId)) assetId = makeId("ast");
    const outputDirectory = join(this.#projectRoot, "media/programmatic");
    const outputPath = join(outputDirectory, `${assetId}.${profile.container}`);
    let clipId: string | undefined;
    let placement: {
      sequenceId: string;
      layerId: string;
      clipId: string;
      index: number;
    } | undefined;
    if (request.placeAsClip === true) {
      const layer = project.layers.find(({ kind, sequence }) =>
        kind === "video" && sequence === deliverable.sequenceId);
      const sequence = project.sequences.find(({ id }) => id === deliverable.sequenceId);
      if (layer === undefined || sequence === undefined) {
        throw makeGuyditorError(
          "E_OP_LAYER_TARGET",
          `Deliverable ${deliverable.id} has no sequence-bound video layer.`,
          { affected: [deliverable.id, deliverable.sequenceId] },
        );
      }
      clipId = makeId("clp");
      while (project.sequences.some(({ clips }) => clips.some(({ id }) => id === clipId))) {
        clipId = makeId("clp");
      }
      placement = {
        sequenceId: sequence.id,
        layerId: layer.id,
        clipId,
        index: request.clipIndex ?? sequence.clips.length,
      };
    }
    const preflightRights = {
      origin: "programmatic" as const,
      restrictions: [],
      confirmedBy: "creator" as const,
    };
    const preflightHash = createHash("sha256")
      .update(`template-freeze-preflight:${assetId}`)
      .digest("hex");
    const preflightProvenance: ProgrammaticAnimationProvenance = {
      schema: "guyditor.programmatic-provenance/v1",
      assetId,
      template: {
        id: descriptor.value.id,
        version: descriptor.value.version,
        contentHash: descriptor.value.contentHash,
      },
      params: structuredClone(params),
      seed,
      renderer: {
        template: TEMPLATE_RENDERER_VERSION,
        primitives: PRIMITIVES_V1_VERSION,
        canvas: TEMPLATE_CANVAS_VERSION,
        toolchainHash: `sha256:${preflightHash}`,
        fontHashes: Object.fromEntries(
          Object.entries(runtime.value.fonts).map(([family, font]) =>
            [family, font.sha256]),
        ),
      },
      output: { frames, fps, width, height },
      rights: preflightRights,
      contentHash: `sha256:${preflightHash}`,
    };
    const preflightSidecar = programmaticAnimationSidecar(preflightProvenance);
    const preflightOperation = {
      op: "template.freeze",
      params: {
        asset: {
          id: assetId,
          kind: "generated",
          path: `media/programmatic/${assetId}.${profile.container}`,
          sha256: preflightHash,
          bytes: 1,
          container: profile.container,
          probe: {
            duration: { frames, fps },
            width,
            height,
            fps,
          },
          video: {
            codec: profile.video.codec,
            width,
            height,
            fps,
            pixFmt: profile.video.pixelFormat,
            hasAlpha: false,
            rotation: 0,
          },
          integrity: "ok",
          ingest: {
            at: "2000-01-01T00:00:00.000Z",
            ffprobeVersion: "template-freeze-preflight",
            via: "generated",
          },
          provenance: { sidecar: preflightSidecar.name },
          rights: preflightRights,
        },
        provenance: preflightProvenance,
        sidecar: preflightSidecar,
        ...(placement === undefined ? {} : { placement }),
      },
    };
    const divergence = touchedDerivativeIds(project, project, [preflightOperation]).length > 0
      ? "graphics" as const
      : undefined;
    const preflightEngine = new OperationEngine(this.#store.currentProject, {
      committer: this.#store,
      templateProvider: this.#templateRegistry,
    });
    const preflight = await preflightEngine.execute([preflightOperation], {
      baseRevision: request.revision,
      origin: "ui",
      dryRun: true,
      recordUndo: false,
      ...(divergence === undefined ? {} : { divergence }),
    });
    if (!preflight.ok) throw preflight.error;
    const freezeKey = createHash("sha256").update(canonicalJson({
      template: {
        id: descriptor.value.id,
        version: descriptor.value.version,
        contentHash: descriptor.value.contentHash,
      },
      params,
      seed,
      frames,
      fps,
      width,
      height,
      safeArea,
      renderer: TEMPLATE_RENDERER_VERSION,
      primitives: PRIMITIVES_V1_VERSION,
      lottie: {
        renderer: LOTTIE_RENDERER_VERSION,
        shim: LOTTIE_SHIM_VERSION,
        sha256: lottieToolchainHash(),
      },
      canvas: TEMPLATE_CANVAS_VERSION,
      brand: brand.templateDefaults ?? null,
    })).digest("hex");
    const cacheDirectory = join(
      this.#projectRoot,
      ".guyditor/cache/render/template-freeze",
    );
    await mkdir(cacheDirectory, { recursive: true });
    const temporaryDirectory = await mkdtemp(
      join(cacheDirectory, `.tmp-${freezeKey.slice(0, 12)}-`),
    );
    const frameDirectory = join(temporaryDirectory, "frames");
    const temporaryOutputPath = join(temporaryDirectory, `asset.${profile.container}`);
    const temporaryProvenancePath = join(temporaryDirectory, "provenance.json");
    let outputPublished = false;
    let provenancePublished = false;
    let provenancePath: string | undefined;
    try {
      await mkdir(frameDirectory);
      for (let frame = 0; frame < frames; frame += 1) {
        const png = renderTemplatePng(runtime.value, {
          params,
          seed,
          frame,
          totalFrames: frames,
          fps,
          width,
          height,
          safeArea,
          brand,
          timeline: { frames: frame, fps },
        });
        if (!png.ok) throw png.error;
        await writeFile(
          join(frameDirectory, `${String(frame).padStart(8, "0")}.png`),
          png.value,
        );
      }
      await runFfmpeg([
        "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        "-framerate", fps,
        "-start_number", "0",
        "-i", join(frameDirectory, "%08d.png"),
        "-frames:v", String(frames),
        "-an",
        "-c:v", profile.video.codec,
        "-preset", "medium",
        "-crf", String(profile.video.crf),
        "-pix_fmt", profile.video.pixelFormat,
        "-r", fps,
        "-threads", "1",
        "-fflags", "+bitexact",
        "-flags:v", "+bitexact",
        "-map_metadata", "-1",
        "-metadata", "creation_time=2000-01-01T00:00:00.000Z",
        ...(profile.container === "mp4" ? ["-movflags", "+faststart"] : []),
        temporaryOutputPath,
      ]);
      await this.#onTemplateFreezePhase?.("rendered");
      const toolchain = await toolchainManifest();
      const materialized = await materializeProgrammaticAnimationArtifact({
        projectRoot: this.#projectRoot,
        outputPath: temporaryOutputPath,
        assetId,
        template: {
          id: descriptor.value.id,
          version: descriptor.value.version,
          contentHash: descriptor.value.contentHash,
        },
        params,
        seed,
        renderer: {
          template: TEMPLATE_RENDERER_VERSION,
          primitives: PRIMITIVES_V1_VERSION,
          canvas: TEMPLATE_CANVAS_VERSION,
          toolchainHash: `sha256:${createHash("sha256")
            .update(canonicalJson(toolchain))
            .digest("hex")}`,
          fontHashes: Object.fromEntries(
            Object.entries(runtime.value.fonts).map(([family, font]) =>
              [family, font.sha256]),
          ),
        },
        expected: { frames, fps, width, height },
        ingestedAt: new Date().toISOString(),
      });
      const artifact = {
        ...materialized,
        asset: {
          ...materialized.asset,
          path: `media/programmatic/${assetId}.${profile.container}`,
        },
      };
      const operation = {
        op: "template.freeze",
        params: {
          asset: artifact.asset,
          provenance: artifact.provenance,
          sidecar: artifact.sidecar,
          ...(placement === undefined ? {} : { placement }),
        },
      };
      const exactProject = this.#store.currentProject;
      const exactDivergence = touchedDerivativeIds(
        exactProject,
        exactProject,
        [operation],
      ).length > 0
        ? "graphics" as const
        : undefined;
      const exactEngine = new OperationEngine(exactProject, {
        committer: this.#store,
        templateProvider: this.#templateRegistry,
      });
      const exactContext = {
        baseRevision: request.revision,
        origin: "ui" as const,
        recordUndo: false,
        ...(exactDivergence === undefined ? {} : { divergence: exactDivergence }),
      };
      const exactPreflight = await exactEngine.execute([operation], {
        ...exactContext,
        dryRun: true,
      });
      if (!exactPreflight.ok) throw exactPreflight.error;
      await writeFile(temporaryProvenancePath, artifact.serialized, "utf8");
      await this.#onTemplateFreezePhase?.("exact-preflighted");

      provenancePath = join(this.#projectRoot, artifact.sidecar.path);
      await Promise.all([
        mkdir(outputDirectory, { recursive: true }),
        mkdir(dirname(provenancePath), { recursive: true }),
      ]);
      await link(temporaryOutputPath, outputPath);
      outputPublished = true;
      await link(temporaryProvenancePath, provenancePath);
      provenancePublished = true;
      await Promise.all([
        chmod(outputPath, 0o444),
        chmod(provenancePath, 0o444),
      ]);
      await this.#onTemplateFreezePhase?.("published");

      const committed = await exactEngine.execute([operation], {
        ...exactContext,
        dryRun: false,
      });
      if (!committed.ok) throw committed.error;
      const result = {
        assetId,
        ...(clipId === undefined ? {} : { clipId }),
        sequenceId: deliverable.sequenceId,
        outputPath,
        provenancePath,
        frames,
        fps,
        width,
        height,
        revision: this.#store.currentProject.revision,
      };
      await rm(temporaryDirectory, { recursive: true, force: true })
        .catch(() => undefined);
      return result;
    } catch (error: unknown) {
      await Promise.allSettled([
        ...(outputPublished ? [removePublishedFile(outputPath)] : []),
        ...(provenancePublished && provenancePath !== undefined
          ? [removePublishedFile(provenancePath)]
          : []),
        rm(temporaryDirectory, { recursive: true, force: true }),
      ]);
      throw error;
    }
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
      brand: await this.#brandContext(),
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
    const lifecycleProject = await this.#loadProject(req.revision);
    const lifecycleDeliverable = lifecycleProject.deliverables.find(({ id }) => id === req.deliverableId);
    if (lifecycleDeliverable?.status === "stale") {
      throw makeGuyditorError(
        "E_DELIVERABLE_STALE",
        `Deliverable ${req.deliverableId} is stale and cannot be exported.`,
        {
          affected: [req.deliverableId],
          retry: "none",
          suggestion: "Run deliverable.refresh and review the diff",
        },
      );
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
      prepared.validation = structuredClone(validation);
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

  public async renderOutputSet(req: OutputSetRequest): Promise<OutputSetEnqueueResult> {
    const project = await this.#loadProject(req.revision);
    const deliverable = project.deliverables.find(({ id }) => id === req.deliverableId);
    if (deliverable === undefined) {
      throw makeGuyditorError(
        "E_RENDER_DELIVERABLE_NOT_FOUND",
        `Deliverable ${req.deliverableId} does not exist at ${project.revision}.`,
        { affected: [req.deliverableId, project.revision] },
      );
    }
    if (deliverable.status !== "approved") {
      throw makeGuyditorError(
        "E_DELIVERABLE_STATUS",
        `Deliverable ${req.deliverableId} must be approved and non-stale before output-set export.`,
        { affected: [req.deliverableId], retry: "none" },
      );
    }
    const profile = await loadRenderProfile(
      deliverable.profile,
      this.#profilesRoot,
      deliverable.profileOverrides,
    );
    const rendered = await this.renderExport({
      revision: req.revision,
      deliverableId: req.deliverableId,
      variants: ["burnin", "clean"],
      outputDir: req.outputDir,
      ...(req.skipValidationWarnings === undefined
        ? {}
        : { skipValidationWarnings: req.skipValidationWarnings }),
    });
    const output = outputSetPaths(resolve(req.outputDir), req.deliverableId, profile.profile.container);
    const finalizer = this.#jobQueue.enqueue({
      kind: "render.outputset",
      title: `Finalize output set · ${deliverable.name}`,
      cancellable: true,
      dependsOn: rendered.jobIds,
      payload: {
        deliverableId: req.deliverableId,
        revision: project.revision,
        outputDir: resolve(req.outputDir),
      },
    });
    return {
      jobId: finalizer.jobId,
      jobIds: [...rendered.jobIds, finalizer.jobId],
      output,
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
          const visualProfile = await loadRenderProfile(
            deliverable.profile,
            this.#profilesRoot,
            deliverable.profileOverrides,
          );
          checks.push(validateOverlayLayout({
            deliverableId,
            profile: { safeAreas: visualProfile.profile.safeAreas ?? {
              title: { top: 0, right: 0, bottom: 0, left: 0 },
              action: { top: 0, right: 0, bottom: 0, left: 0 },
              platformUi: [],
            } },
            captionOverflowWordIds: overflow,
            boxes: model.cues.map(({ box }) => ({
              ownerId: deliverable.captionsTrackId!,
              kind: "caption" as const,
              rect: box,
            })),
          }));
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
        ? (layer.items ?? []).filter((item) =>
            item.template !== undefined &&
            placedItemAppliesToSequence(project, item, deliverable.sequenceId))
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
          brand: await this.#brandContext(),
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
      const profile = await loadRenderProfile(
        deliverable.profile,
        this.#profilesRoot,
        deliverable.profileOverrides,
      );
      if (deliverable.publish?.metadata !== undefined && profile.profile.metadata !== undefined) {
        checks.push(validatePublishMetadataCheck({
          deliverableId,
          metadata: deliverable.publish.metadata,
          profile: { metadata: profile.profile.metadata },
        }));
      }
      const resolved = this.#withResolvedAssetPaths(project);
      const sidecars = await this.#captionSidecars(project);
      const anchorFrames = await this.#renderAnchorFrames(
        resolved,
        deliverable,
        sidecars,
      );
      const framing = await this.#framingSidecar(project, deliverable);
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
        speechIntervals: this.#speechIntervals(resolved, deliverable, sidecars),
        ...(framing === undefined ? {} : { framing }),
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

  async #framingSidecar(
    project: GuyditorProject,
    deliverable: Deliverable,
  ): Promise<FramingSidecar | undefined> {
    const reference = project.sidecars.find(({ schema, path }) =>
      schema === "guyditor.framing/v1" &&
      path === `sidecars/framing/${deliverable.id}.framing.json`);
    if (reference === undefined) return undefined;
    return parseFramingSidecar(await readFile(
      resolvedMediaPath(this.#projectRoot, reference.path),
      "utf8",
    ));
  }

  async #renderAnchorFrames(
    project: GuyditorProject,
    deliverable: Deliverable,
    sidecars: readonly TranscriptSidecar[],
  ): Promise<Record<string, number>> {
    const audioSequenceIds = new Set(project.layers.flatMap((layer) =>
      layer.enabled &&
      (layer.kind === "audio" || layer.kind === "music" || layer.kind === "ambience" || layer.kind === "sfx") &&
      layer.sequence !== undefined
        ? [layer.sequence]
        : []));
    const anchors = [...new Set([
      ...project.layers.flatMap(({ pip }) => pip?.keyframes.map(({ at }) => at) ?? []),
      ...project.layers.flatMap(({ ducking }) => ducking?.overrides.map(({ at }) => at) ?? []),
      ...project.sequences
        .filter(({ id }) => audioSequenceIds.has(id))
        .flatMap(({ clips }) => clips.flatMap(({ anchor }) => anchor === undefined ? [] : [anchor])),
    ])];
    const frames: Record<string, number> = {};
    const dependencies = { wordLookup: createTranscriptWordLookup(sidecars) };
    for (const anchor of anchors) {
      const resolution = await resolveAnchor(project, anchor, deliverable.sequenceId, dependencies);
      if (!resolution.ok) throw resolution.error;
      if (resolution.value.status !== "resolved" || resolution.value.timeline === undefined) {
        throw makeGuyditorError(
          "E_RENDER_GRAPH_INVALID",
          `Render anchor ${anchor} is orphaned and cannot be resolved.`,
          { affected: [anchor] },
        );
      }
      frames[anchor] = resolution.value.timeline.frames;
    }
    return frames;
  }

  #speechIntervals(
    project: GuyditorProject,
    deliverable: Deliverable,
    sidecars: readonly TranscriptSidecar[],
  ): SpeechInterval[] {
    const sourceLayerIds = project.layers
      .filter((layer) =>
        layer.enabled && layer.sequence === deliverable.sequenceId &&
        (layer.kind === "video" || layer.kind === "audio"))
      .map(({ id }) => id);
    if (sourceLayerIds.length === 0 || sidecars.length === 0) return [];
    const track: CaptionTrack = {
      id: "cap_aaaaaaaaaa",
      name: "Derived ducking speech map",
      sourceLayerIds,
      preset: { presetId: "pre_aaaaaaaaaa", version: 0 },
      styleOverrides: {},
      breakOverrides: [],
      emphasisOverrides: [],
      timingOffsets: [],
      enabled: true,
    };
    const timeline = buildWordTimelineMap({
      project,
      sequenceId: deliverable.sequenceId,
      track,
      sidecars,
    });
    const sampleRate = project.settings.audio.sampleRate;
    return timeline.instances.map(({ start, end, wordId }) => ({
      start: {
        samples: exactSamplesForSeconds(start, sampleRate, `speech start ${wordId}`),
        rate: sampleRate,
      },
      end: {
        samples: exactSamplesForSeconds(end, sampleRate, `speech end ${wordId}`),
        rate: sampleRate,
      },
    }));
  }

  async #rasterizedPips(
    project: GuyditorProject,
    deliverable: Deliverable,
    anchorFrames: Readonly<Record<string, number>>,
    profile: RenderProfile,
  ): Promise<Record<string, RasterizedPipAssets>> {
    const timeline = deriveTimeline(project, deliverable.sequenceId);
    if (!timeline.ok) throw timeline.error;
    const profileFps = deliverable.kind === "short" ? profile.video.fps : undefined;
    const profileResolution = deliverable.kind === "short" ? profile.video.resolution : undefined;
    const [durationNumerator = "0", durationDenominator = "1"] = timeline.value.duration.split("/");
    const [fpsNumerator = "1", fpsDenominator = "1"] =
      (profileFps ?? project.settings.timeline.fps).split("/");
    const durationFrames = Number(
      BigInt(durationNumerator) * BigInt(fpsNumerator) /
      (BigInt(durationDenominator) * BigInt(fpsDenominator)),
    );
    const entries = await Promise.all(project.layers.flatMap((layer) =>
      layer.enabled && layer.pip !== undefined
        ? [rasterizePipAssets({
            pip: layer.pip,
            compWidth: profileResolution?.width ?? project.settings.timeline.width,
            compHeight: profileResolution?.height ?? project.settings.timeline.height,
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
    suppliedProfile?: RenderProfile,
  ): Promise<CaptionRenderModel | undefined> {
    const captionId = deliverable.captionsTrackId;
    if (captionId === undefined) return undefined;
    const track = project.captions.find(({ id }) => id === captionId);
    if (track === undefined || !track.enabled) return undefined;
    const pin = project.presets.find(({ id, version }) =>
      id === track.preset.presetId && version === track.preset.version);
    if (pin === undefined) throw new TypeError(`Caption preset ${track.preset.presetId}@${String(track.preset.version)} is not pinned.`);
    const preset = await loadPinnedCaptionPreset(this.#projectRoot, pin);
    const sidecars = await this.#captionSidecars(project);
    const timeline = buildWordTimelineMap({
      project,
      sequenceId: deliverable.sequenceId,
      track,
      sidecars,
    });
    const profile = suppliedProfile ?? (await loadRenderProfile(
      deliverable.profile,
      this.#profilesRoot,
      deliverable.profileOverrides,
    )).profile;
    if (
      deliverable.kind === "short" &&
      profile.video.resolution !== undefined &&
      profile.video.fps !== undefined &&
      profile.safeAreas !== undefined &&
      profile.captionDefaults !== undefined
    ) {
      return compileDerivativeCaptionTrack({
        track,
        timeline,
        sidecars,
        presetStyle: preset.style,
        profile: {
          video: {
            resolution: profile.video.resolution,
            fps: { default: profile.video.fps },
          },
          safeAreas: { title: profile.safeAreas.title },
          captionDefaults: profile.captionDefaults,
        },
        measureText: createCaptionTextMeasurer(),
      });
    }
    const style = resolveCaptionStyle(preset.style, track.styleOverrides);
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
    const profile = await loadRenderProfile(
      deliverable.profile,
      this.#profilesRoot,
      deliverable.profileOverrides,
    );
    const captionModel = await this.#captionModel(project, deliverable, profile.profile);
    let overlays: Parameters<typeof compileRenderGraph>[0]["overlays"] = [];
    if (captionModel !== undefined) {
      const subtitlePaths = subtitleOutputPaths(resolve(req.outputDir), req.deliverableId);
      await mkdir(dirname(subtitlePaths.srt), { recursive: true });
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
    const profileResolution = deliverable.kind === "short"
      ? profile.profile.video.resolution
      : undefined;
    const profileFps = deliverable.kind === "short" ? profile.profile.video.fps : undefined;
    const graphicPlan = await renderGraphicOverlaySequence({
      project,
      sequenceId: deliverable.sequenceId,
      registry: this.#templateRegistry,
      anchorDependencies: { wordLookup: createTranscriptWordLookup(transcriptSidecars) },
      width: profileResolution?.width ?? project.settings.timeline.width,
      height: profileResolution?.height ?? project.settings.timeline.height,
      fps: profileFps ?? project.settings.timeline.fps,
      brand: await this.#brandContext(),
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
    const anchorFrames = await this.#renderAnchorFrames(project, deliverable, transcriptSidecars);
    const speechIntervals = this.#speechIntervals(project, deliverable, transcriptSidecars);
    const pipAssets = await this.#rasterizedPips(
      project,
      deliverable,
      anchorFrames,
      profile.profile,
    );
    const framing = await this.#framingSidecar(project, deliverable);
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
      speechIntervals,
      pipAssets,
      ...(framing === undefined ? {} : { framing }),
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
    const hasProgramAudio = graph.nodes.some((node) => {
      if (node.kind !== "source") return false;
      const source = node.params as SourceNodeParams;
      return source.stream === "audio" && source.path.length > 0;
    });
    const profileLoudness = profile.profile.audio.loudness ?? {
      integratedLufs: -14,
      toleranceLu: 1,
      truePeakDbtp: -1,
      lraMaxLu: 11,
    };
    const sampleRate = profile.profile.audio.sampleRate ?? project.settings.audio.sampleRate;
    const target: LoudnessTarget = {
      integratedLufs: profileLoudness.integratedLufs,
      truePeakDbtp: profileLoudness.truePeakDbtp,
      loudnessRangeLu: profileLoudness.lraMaxLu,
    };
    const audioKey = createHash("sha256").update(JSON.stringify({
      revision: graph.revision,
      deliverableId: graph.deliverableId,
      sampleRate,
      target,
      audioNodes: graph.nodes.filter((node) =>
        node.kind === "audiochain" ||
        (node.kind === "source" && (node.params as SourceNodeParams).stream === "audio")),
    })).digest("hex");
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
      ...(options.diagnostic === undefined && hasProgramAudio ? {
        loudness: {
          audioKey,
          measurementPath: join(this.#projectRoot, ".guyditor/cache/render/measure", `${audioKey}.json`),
          normalizedPath: join(
            this.#projectRoot,
            ".guyditor/cache/render/audio",
            `${audioKey}-${variant}.wav`,
          ),
          sampleRate,
          target,
          toleranceLu: profileLoudness.toleranceLu,
        },
      } : {}),
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
      ...project.layers.flatMap((layer) =>
        layer.sequence !== undefined && layer.sequence !== deliverable.sequenceId
          ? []
          : (layer.items ?? []).flatMap((item) => {
              if (!placedItemAppliesToSequence(project, item, deliverable.sequenceId)) return [];
              if (item.asset === undefined) return [];
              const durationFrames = typeof item.duration === "object" && "frames" in item.duration
                ? item.duration.frames
                : item.source !== undefined && "in" in item.source
                  ? item.source.out.frames - item.source.in.frames
                  : 1;
              return [{
                assetId: item.asset,
                durationFrames: Math.max(1, durationFrames),
                effects: item.effects ?? [],
              }];
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
      await this.#normalizeMasterAudio(jobId, prepared, context);
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

  async #normalizeMasterAudio(
    jobId: string,
    prepared: PreparedExport,
    context: JobExecutorContext,
  ): Promise<void> {
    const loudness = prepared.loudness;
    if (loudness === undefined) return;
    const run = async (args: readonly string[]) => runFfmpeg(args, { signal: context.signal });
    const normalization = await normalizeMasterLoudness({
      inputPath: prepared.outputPath,
      outputPath: loudness.normalizedPath,
      measurementPath: loudness.measurementPath,
      target: loudness.target,
      sampleRate: loudness.sampleRate,
      run,
    });
    if (normalization.silent) {
      prepared.validation.checks.push({
        id: "VAL-500",
        status: "pass",
        message: "Program audio is silent; the integrated loudness target is not applicable.",
        affected: [prepared.request.deliverableId],
      });
      prepared.validation.checks.push({
        id: "VAL-501",
        status: "pass",
        message: "Program audio is silent and has no true-peak excursion.",
        affected: [prepared.request.deliverableId],
      });
      return;
    }

    const temporaryPath = `${prepared.outputPath}.${jobId}.loudness.${prepared.profile.profile.container}`;
    try {
      await runFfmpeg([
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        prepared.outputPath,
        "-i",
        loudness.normalizedPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        prepared.profile.profile.audio.codec,
        "-b:a",
        prepared.profile.profile.audio.bitrate,
        "-ar",
        String(loudness.sampleRate),
        "-ac",
        "2",
        "-shortest",
        temporaryPath,
      ], { signal: context.signal });
      await rename(temporaryPath, prepared.outputPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }

    const delivered = await measureDeliveredLoudness(prepared.outputPath, run);
    const integratedDelta = Math.abs(delivered.integratedLufs - loudness.target.integratedLufs);
    const integratedPass = integratedDelta <= loudness.toleranceLu;
    const peakPass = delivered.truePeakDbtp <= loudness.target.truePeakDbtp;
    const integratedStatus = normalization.limiterApplied
      ? "warn"
      : integratedPass
        ? integratedDelta > loudness.toleranceLu / 2 ? "warn" : "pass"
        : "fail";
    prepared.validation.checks.push({
      id: "VAL-500",
      status: integratedStatus,
      message: normalization.limiterApplied
        ? `Delivered master is ${delivered.integratedLufs} LUFS; true-peak protection limited the linear correction toward ${loudness.target.integratedLufs} LUFS.`
        : integratedPass
          ? `Delivered master is ${delivered.integratedLufs} LUFS, within ${String(loudness.toleranceLu)} LU of ${loudness.target.integratedLufs} LUFS.`
        : `Delivered master is ${delivered.integratedLufs} LUFS, outside ${String(loudness.toleranceLu)} LU of ${loudness.target.integratedLufs} LUFS.`,
      affected: [prepared.request.deliverableId],
      measured: {
        integratedLufs: delivered.integratedLufs,
        targetLufs: loudness.target.integratedLufs,
        deltaLu: integratedDelta,
      },
    });
    if (integratedStatus === "warn" && prepared.validation.outcome === "pass") {
      prepared.validation.outcome = "warnings";
    }
    prepared.validation.checks.push({
      id: "VAL-501",
      status: peakPass ? "pass" : "fail",
      message: peakPass
        ? `Delivered true peak ${delivered.truePeakDbtp} dBTP is at or below ${loudness.target.truePeakDbtp} dBTP.`
        : `Delivered true peak ${delivered.truePeakDbtp} dBTP exceeds ${loudness.target.truePeakDbtp} dBTP.`,
      affected: [prepared.request.deliverableId],
      measured: {
        truePeakDbtp: delivered.truePeakDbtp,
        targetTruePeakDbtp: loudness.target.truePeakDbtp,
      },
    });
    if (integratedStatus === "fail" || !peakPass) {
      prepared.validation.outcome = "blocked";
      throw makeGuyditorError(
        "E_EXPORT_VALIDATION_FAILED",
        `Delivered audio failed loudness validation for ${prepared.request.deliverableId}: ` +
        `I ${String(delivered.integratedLufs)} LUFS (target ${String(loudness.target.integratedLufs)}), ` +
        `TP ${String(delivered.truePeakDbtp)} dBTP (ceiling ${String(loudness.target.truePeakDbtp)}).`,
        {
          affected: [prepared.request.deliverableId],
          suggestion: "Inspect the cached loudnorm measurement and master audio chain.",
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

  async #finalizeOutputSet(
    deliverableId: string,
    revision: string,
    outputDir: string,
    context: JobExecutorContext,
  ): Promise<{
    deliverableId: string;
    root: string;
    videoBurned: string;
    videoClean: string;
    srt: string;
    vtt: string;
    coversDir: string;
    report: string;
    coverCandidates: string[];
  }> {
    const project = await this.#loadProject(revision);
    const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
    if (deliverable === undefined) {
      throw makeGuyditorError(
        "E_RENDER_DELIVERABLE_NOT_FOUND",
        `Deliverable ${deliverableId} does not exist at ${revision}.`,
        { affected: [deliverableId, revision] },
      );
    }
    const loaded = await loadRenderProfile(
      deliverable.profile,
      this.#profilesRoot,
      deliverable.profileOverrides,
    );
    const output = outputSetPaths(outputDir, deliverableId, loaded.profile.container);
    await mkdir(output.root, { recursive: true });
    if (!await exists(output.srt)) await writeFile(output.srt, "", "utf8");
    if (!await exists(output.vtt)) await writeFile(output.vtt, "WEBVTT\n\n", "utf8");
    const covers: string[] = [];
    if (deliverable.kind === "short") {
      const probe = await probeMedia(output.videoClean);
      const durationFrames = probe.probe.duration !== undefined && "frames" in probe.probe.duration
        ? probe.probe.duration.frames
        : 0;
      const [fpsNumerator, fpsDenominator] = (loaded.profile.video.fps ?? project.settings.timeline.fps)
        .split("/").map(Number);
      const fps = fpsNumerator! / fpsDenominator!;
      const beatFrames: number[] = [];
      const transcriptSidecars = await this.#captionSidecars(project);
      const dependencies = { wordLookup: createTranscriptWordLookup(transcriptSidecars) };
      for (const beat of project.beats) {
        const resolved = await resolveAnchor(project, beat.anchor, deliverable.sequenceId, dependencies);
        if (resolved.ok && resolved.value.status === "resolved" && resolved.value.timeline !== undefined) {
          beatFrames.push(resolved.value.timeline.frames);
        }
      }
      const hookWordId = deliverable.dependencies?.[0]?.source.words?.startWordId;
      const hook = hookWordId === undefined
        ? undefined
        : await resolveAnchor(project, `word:${hookWordId}`, deliverable.sequenceId, dependencies);
      const hookFrame = hook?.ok === true && hook.value.status === "resolved" && hook.value.timeline !== undefined
        ? hook.value.timeline.frames
        : 0;
      const sharpness = await coverSharpnessScores({
        videoPath: output.videoClean,
        durationFrames,
        fps,
        signal: context.signal,
      });
      const faceAreas = await coverFaceAreas({
        projectRoot: this.#projectRoot,
        project,
        deliverable,
        frames: sharpness.map(({ frame }) => frame),
        outputFps: loaded.profile.video.fps ?? project.settings.timeline.fps,
      });
      const scoredFrames = sharpness.map(({ frame, sharpness: score }) => ({
        frame,
        faceArea: faceAreas.get(frame) ?? 1,
        sharpness: score,
      }));
      const frames = selectCoverFrames({
        fps,
        durationFrames,
        hookFrame,
        beatFrames,
        scoredFrames,
        limit: 6,
      });
      await mkdir(output.coversDir, { recursive: true });
      for (const [index, frame] of frames.entries()) {
        const cover = join(output.coversDir, `cover-${String(index + 1).padStart(2, "0")}.jpg`);
        await runFfmpeg([
          "-hide_banner", "-nostdin", "-y",
          "-i", output.videoClean,
          "-vf", `select=eq(n\\,${String(frame)}),scale=${String(loaded.profile.cover?.resolution.width ?? loaded.profile.video.resolution?.width ?? 1080)}:${String(loaded.profile.cover?.resolution.height ?? loaded.profile.video.resolution?.height ?? 1920)}`,
          "-frames:v", "1", "-q:v", "2", cover,
        ], { signal: context.signal });
        covers.push(cover);
        context.reportProgress((index + 1) / Math.max(1, frames.length));
      }
    }
    const reportText = await readFile(output.report, "utf8");
    const report = JSON.parse(reportText) as Record<string, unknown>;
    const artifactPaths = [
      output.videoBurned,
      output.videoClean,
      output.srt,
      output.vtt,
      ...covers,
    ];
    const artifacts = await Promise.all(artifactPaths.map(async (path) => ({
      path: relative(output.root, path).replaceAll("\\", "/"),
      sha256: await sha256(path),
    })));
    report["outputSet"] = {
      videoBurned: output.videoBurned,
      videoClean: output.videoClean,
      srt: output.srt,
      vtt: output.vtt,
      coverCandidates: covers,
      report: output.report,
      artifacts,
    };
    await writeFile(output.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return {
      deliverableId,
      root: output.root,
      videoBurned: output.videoBurned,
      videoClean: output.videoClean,
      srt: output.srt,
      vtt: output.vtt,
      coversDir: output.coversDir,
      report: output.report,
      coverCandidates: covers,
    };
  }
}
