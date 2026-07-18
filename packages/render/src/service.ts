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
  makeGuyditorError,
  parseProjectYaml,
} from "../../core/src/index.js";
import type {
  GuyditorError,
  GuyditorProject,
  JobExecutorContext,
  JobQueue,
  ProjectStore,
} from "../../core/src/index.js";
import {
  probeMedia,
  resolveFfmpeg,
  resolveFfprobe,
  runFfmpeg,
} from "../../media/src/index.js";

import { compileFiltergraph } from "./filtergraph.js";
import { compileRenderGraph } from "./graph.js";
import type {
  EncodeNodeParams,
  RenderGraph,
  SourceNodeParams,
  ToolchainManifest,
} from "./ir.js";
import { loadRenderProfile } from "./profile.js";
import type { LoadedRenderProfile } from "./profile.js";

const RENDER_PACKAGE_VERSION = "0.0.0";

export interface RenderRequest {
  revision: string;
  deliverableId: string;
  range?: { startFrame: number; endFrame: number };
  quality: "proxy" | "high";
}

export interface ExportRequest {
  revision: string;
  deliverableId: string;
  variants: Array<"burnin" | "clean">;
  outputDir: string;
  skipValidationWarnings?: boolean;
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

function isProposalRevision(revision: string): boolean {
  return /^prp_[a-z2-7]{10}$/u.test(revision);
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
      version: "not-used-m0",
      canvasVersion: "not-used-m0",
      fontHashes: {},
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

export class RenderService {
  readonly #projectRoot: string;
  readonly #store: ProjectStore;
  readonly #jobQueue: JobQueue;
  readonly #profilesRoot: string | URL;
  readonly #prepared = new Map<string, PreparedExport>();

  public constructor(options: RenderServiceOptions) {
    this.#projectRoot = resolve(options.projectRoot);
    this.#store = options.store;
    this.#jobQueue = options.jobQueue;
    this.#profilesRoot = options.profilesRoot ?? resolve("profiles");
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
  }

  public async renderPreview(req: RenderRequest): Promise<{ jobId: string }> {
    void req;
    throw renderUnsupported("preview rendering", "Part 12");
  }

  public async renderExport(req: ExportRequest): Promise<{ jobId: string }> {
    if (isProposalRevision(req.revision)) {
      throw renderUnsupported(`proposal revision ${req.revision}`, "Part 5", [req.revision]);
    }
    if (req.variants.length !== 1) {
      throw renderUnsupported("zero or multiple export variants in one job", "Part 12", [req.deliverableId]);
    }
    const variant = req.variants[0]!;
    const prepared = await this.#prepare(req, variant);
    const validation = await this.validateExport(req.deliverableId, prepared.graph.revision);
    prepared.validation = validation;
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
    const job = this.#jobQueue.enqueue({
      kind: "render.export",
      title: `Render ${req.deliverableId} ${variant}`,
      cancellable: true,
      payload: {
        deliverableId: req.deliverableId,
        outputPath: prepared.outputPath,
        revision: prepared.graph.revision,
        variant,
      },
    });
    this.#prepared.set(job.jobId, prepared);
    return { jobId: job.jobId };
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
    try {
      const profile = await loadRenderProfile(deliverable.profile, this.#profilesRoot);
      const resolved = this.#withResolvedAssetPaths(project);
      compileRenderGraph({
        project: resolved,
        revision: resolved.revision,
        deliverableId,
        variant: "clean",
        quality: "high",
        profile: profile.profile,
        profileSha256: profile.sha256,
        toolchain: await toolchainManifest(),
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

  async #prepare(req: ExportRequest, variant: "burnin" | "clean"): Promise<PreparedExport> {
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
    const graph = compileRenderGraph({
      project,
      revision: project.revision,
      deliverableId: req.deliverableId,
      variant,
      quality: "high",
      profile: profile.profile,
      profileSha256: profile.sha256,
      toolchain: await toolchainManifest(),
    });
    const outputPath = exportOutputPath(
      resolve(req.outputDir),
      req.deliverableId,
      variant,
      profile.profile.container,
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
