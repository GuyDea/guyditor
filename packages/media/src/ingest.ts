import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
} from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

import {
  makeId,
  OperationEngine,
} from "../../core/src/index.js";
import type {
  Asset,
  IdPrefix,
  JobQueue,
  JobRecord,
  JsonValue,
  ProjectStore,
  Rational,
} from "../../core/src/index.js";

import {
  FfmpegError,
  MediaError,
} from "./errors.js";
import {
  formatSupportTier,
} from "./formats.js";
import type { FormatSupportTier } from "./formats.js";
import { estimateProjectCacheUse } from "./cache.js";
import type { CacheUseEstimate } from "./cache.js";
import { probeMedia } from "./probe.js";
import type { ProbedAssetMedia } from "./probe.js";
import { generatePeaks } from "./peaks.js";
import {
  generateProxy,
  proxyCachePaths,
  proxyIsStale,
} from "./proxy.js";
import type { ProxyTier } from "./commands.js";
import { registerMlworkerJobExecutors } from "./mlworker/executors.js";
import type { MlworkerTaskRunner } from "./mlworker/types.js";

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export type AssetRecord = Asset;
export type FollowUpJobKind = "proxy.generate" | "peaks.generate" | "vad" | "transcribe";

export interface IngestSource {
  path: string;
  generated?: boolean;
  provenance?: Asset["provenance"];
  rights?: Asset["rights"];
  session?: string;
  takes?: string[];
  markers?: string[];
  speechBearing?: boolean;
}

export interface IngestRequest {
  sources: IngestSource[];
  via?: NonNullable<Asset["ingest"]>["via"];
  followUpJobs?: readonly FollowUpJobKind[];
}

export interface MediaEngineOptions {
  jobQueue: JobQueue;
  followUpJobs?: readonly FollowUpJobKind[];
  mlworker?: MlworkerTaskRunner;
  idFactory?: (prefix: IdPrefix) => string;
  now?: () => Date;
  /**
   * The project this engine serves. Jobs queued in an earlier session (proxy,
   * peaks) resume as soon as executors register, so the project must be known
   * before then rather than only after the next ingest.
   */
  project?: ProjectStore;
}

export interface IngestAssetResult {
  assetId: string;
  duplicate: boolean;
  kind: Asset["kind"];
  path: string;
  supportTier: FormatSupportTier;
}

export interface IngestWarning {
  assetId: string;
  code: "E_MEDIA_UNSUPPORTED_BESTEFFORT";
  message: string;
}

export interface IngestJobResult {
  assets: IngestAssetResult[];
  followUpJobIds: string[];
  transactionId?: string;
  warnings: IngestWarning[];
}

export interface PickupImportResult {
  path: string;
  job: JobRecord;
}

interface PreparedSource {
  absolutePath: string;
  bytes: number;
  mtime: Date;
  probed: ProbedAssetMedia;
  request: IngestSource;
  sha256: string;
  storedPath: string;
}

interface ClassifiedSource {
  baseKind: Exclude<Asset["kind"], "generated">;
  kind: Asset["kind"];
  tier: FormatSupportTier;
}

interface IngestJobPayload {
  projectRoot: string;
  request: Required<Pick<IngestRequest, "sources" | "via" | "followUpJobs">>;
}

interface ProxyGeneratePayload {
  assetId: string;
  projectRoot: string;
  tier: ProxyTier;
}

interface PeaksGeneratePayload {
  assetId: string;
  projectRoot: string;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function invalidSource(sourcePath: string, reason: string): MediaError {
  return new MediaError(
    "E_MEDIA_INGEST_INVALID_SOURCE",
    `Cannot ingest ${sourcePath}: ${reason}`,
    "none",
    { affected: [sourcePath] },
  );
}

function isInsideCache(sourcePath: string): boolean {
  return /(?:^|[\\/])\.guyditor[\\/]cache(?:[\\/]|$)/u.test(sourcePath);
}

function storedProjectPath(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." &&
      !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : absolutePath;
}

function pickupTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/gu, "").replace("T", "-").slice(0, 15);
}

function pickupSlug(value: string): string {
  const slug = value.toLocaleLowerCase("en")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return slug === "" ? "pickup" : slug;
}

async function streamingSha256(sourcePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(sourcePath, {
    flags: "r",
    highWaterMark: HASH_CHUNK_BYTES,
  });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function probeFailure(sourcePath: string, error: FfmpegError): MediaError {
  return new MediaError(
    "E_MEDIA_PROBE_FAILED",
    `ffprobe could not read ${sourcePath}.`,
    "safe",
    {
      affected: [sourcePath],
      ...(error.binary === undefined ? {} : { binary: error.binary }),
      ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      ...(error.signal === undefined ? {} : { signal: error.signal }),
      ...(error.stderrLines === undefined ? {} : { stderrLines: error.stderrLines }),
      suggestion: "Check that the file is complete and readable, then retry ingest.",
    },
  );
}

async function prepareSource(
  projectRoot: string,
  request: IngestSource,
): Promise<PreparedSource> {
  const resolved = path.resolve(request.path);
  if (isInsideCache(resolved)) {
    throw invalidSource(request.path, "sources inside .guyditor/cache are disposable");
  }

  let absolutePath: string;
  let sourceStat: Awaited<ReturnType<typeof stat>>;
  try {
    absolutePath = await realpath(resolved);
    if (isInsideCache(absolutePath)) {
      throw invalidSource(request.path, "sources inside .guyditor/cache are disposable");
    }
    await access(absolutePath, constants.R_OK);
    sourceStat = await stat(absolutePath);
  } catch (error: unknown) {
    if (error instanceof MediaError) throw error;
    throw invalidSource(request.path, error instanceof Error ? error.message : String(error));
  }
  if (!sourceStat.isFile()) throw invalidSource(request.path, "the source is not a regular file");
  if (sourceStat.size <= 0) throw invalidSource(request.path, "the source is empty");
  if (!Number.isSafeInteger(sourceStat.size)) {
    throw invalidSource(request.path, "the source byte size exceeds the project format limit");
  }

  try {
    const [sha256, probed] = await Promise.all([
      streamingSha256(absolutePath),
      probeMedia(absolutePath),
    ]);
    return {
      absolutePath,
      bytes: sourceStat.size,
      mtime: sourceStat.mtime,
      probed,
      request,
      sha256,
      storedPath: storedProjectPath(projectRoot, absolutePath),
    };
  } catch (error: unknown) {
    if (error instanceof FfmpegError) throw probeFailure(request.path, error);
    if (error instanceof MediaError) throw error;
    throw invalidSource(request.path, error instanceof Error ? error.message : String(error));
  }
}

function isSubtitle(sourcePath: string, probed: ProbedAssetMedia): boolean {
  const extension = path.extname(sourcePath).toLowerCase();
  return extension === ".srt" || extension === ".vtt" ||
    probed.metadata.streams.some(({ codecType }) => codecType === "subtitle");
}

function isAnimatedWebp(sourcePath: string, probed: ProbedAssetMedia): boolean {
  if (path.extname(sourcePath).toLowerCase() !== ".webp") return false;
  const frameCount = probed.metadata.streams.find(
    ({ codecType, attachedPicture }) => codecType === "video" && !attachedPicture,
  )?.frameCount;
  if (frameCount !== undefined) return frameCount > 1;
  const duration = probed.probe.duration;
  return duration !== undefined && "frames" in duration && duration.frames > 1;
}

function baseKind(sourcePath: string, probed: ProbedAssetMedia): ClassifiedSource["baseKind"] {
  if (isSubtitle(sourcePath, probed)) return "subtitle";
  if (probed.image !== undefined) {
    return isAnimatedWebp(sourcePath, probed) ? "animation" : "image";
  }
  if (probed.video !== undefined) {
    return path.extname(sourcePath).toLowerCase() === ".gif" ||
      isAnimatedWebp(sourcePath, probed) || probed.video.hasAlpha
      ? "animation"
      : "video";
  }
  if ((probed.audio?.length ?? 0) > 0) return "audio";
  return "other";
}

function classifySource(prepared: PreparedSource): ClassifiedSource {
  const underlying = baseKind(prepared.absolutePath, prepared.probed);
  const tier = underlying === "other"
    ? 3
    : formatSupportTier(prepared.absolutePath, underlying, prepared.probed);
  if (tier === 3) return { baseKind: underlying, kind: "other", tier };
  if (prepared.request.generated === true) {
    if (prepared.request.provenance === undefined) {
      throw invalidSource(
        prepared.request.path,
        "generated media requires an explicit provenance sidecar",
      );
    }
    return { baseKind: underlying, kind: "generated", tier };
  }
  return { baseKind: underlying, kind: underlying, tier };
}

function normalizedIso(value: string): string | undefined {
  const timezoneNormalized = value.replace(/([+-]\d{2})(\d{2})$/u, "$1:$2");
  const milliseconds = Date.parse(timezoneNormalized);
  return Number.isNaN(milliseconds) ? undefined : new Date(milliseconds).toISOString();
}

function captureTime(
  prepared: PreparedSource,
): NonNullable<Asset["captureTime"]> {
  for (const tag of ["creation_time", "com.apple.quicktime.creationdate"] as const) {
    const value = prepared.probed.metadata.formatTags[tag];
    const normalized = value === undefined ? undefined : normalizedIso(value);
    if (normalized !== undefined) return { value: normalized, source: "container" };
  }
  return { value: prepared.mtime.toISOString(), source: "file-mtime" };
}

function startTimecode(
  probed: ProbedAssetMedia,
  projectFps: Rational,
): Asset["timecode"] {
  const tmcd = probed.metadata.streams.find(({ codecTag, tags }) =>
    codecTag?.toLowerCase() === "tmcd" || tags["timecode"] !== undefined);
  const start = tmcd?.tags["timecode"] ?? probed.metadata.formatTags["timecode"];
  if (start === undefined) return undefined;
  return {
    start,
    fps: tmcd?.frameRate ?? probed.probe.fps ?? probed.video?.fps ?? projectFps,
  };
}

function buildAsset(
  project: ProjectStore,
  prepared: PreparedSource,
  classification: ClassifiedSource,
  assetId: string,
  at: string,
  via: NonNullable<Asset["ingest"]>["via"],
): Asset {
  const captured = captureTime(prepared);
  const timecode = startTimecode(
    prepared.probed,
    project.currentProject.settings.timeline.fps,
  );
  return {
    id: assetId,
    kind: classification.kind,
    path: prepared.storedPath,
    sha256: prepared.sha256,
    bytes: prepared.bytes,
    ...(prepared.probed.container === undefined
      ? {}
      : { container: prepared.probed.container }),
    probe: {
      ...prepared.probed.probe,
      capturedAt: captured.value,
    },
    ...(prepared.probed.video === undefined
      ? {}
      : { video: prepared.probed.video }),
    ...(prepared.probed.audio === undefined
      ? {}
      : { audio: prepared.probed.audio }),
    ...(prepared.probed.image === undefined
      ? {}
      : { image: prepared.probed.image }),
    captureTime: captured,
    ...(timecode === undefined ? {} : { timecode }),
    ...(prepared.request.session === undefined ? {} : { session: prepared.request.session }),
    takes: [...(prepared.request.takes ?? [])],
    markers: [...(prepared.request.markers ?? [])],
    analyses: {},
    integrity: "ok",
    ingest: { at, ffprobeVersion: prepared.probed.ffprobeVersion, via },
    ...(classification.kind === "generated" && prepared.request.provenance !== undefined
      ? { provenance: prepared.request.provenance }
      : {}),
    ...(prepared.request.rights === undefined ? {} : { rights: prepared.request.rights }),
  };
}

function followUpTitle(kind: FollowUpJobKind, assetId: string): string {
  if (kind === "proxy.generate") return `Generate proxy for ${assetId}`;
  if (kind === "peaks.generate") return `Generate peaks for ${assetId}`;
  if (kind === "vad") return `Analyze speech for ${assetId}`;
  return `Transcribe ${assetId}`;
}

function jobAssetId(payload: JsonValue): string | undefined {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
      typeof payload["assetId"] === "string"
    ? payload["assetId"]
    : undefined;
}

function proxyJobMatches(
  payload: JsonValue,
  projectRoot: string,
  assetId: string,
  tier: ProxyTier,
): boolean {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
    payload["projectRoot"] === projectRoot && payload["assetId"] === assetId &&
    payload["tier"] === tier;
}

export class MediaEngine {
  readonly #queue: JobQueue;
  readonly #followUpJobs: readonly FollowUpJobKind[];
  readonly #idFactory: (prefix: IdPrefix) => string;
  readonly #now: () => Date;
  readonly #projects = new Map<string, ProjectStore>();

  public constructor(options: MediaEngineOptions) {
    this.#queue = options.jobQueue;
    this.#followUpJobs = [...(options.followUpJobs ?? [
      "proxy.generate",
      "peaks.generate",
      "transcribe",
    ])];
    this.#idFactory = options.idFactory ?? makeId;
    this.#now = options.now ?? (() => new Date());
    if (options.project !== undefined) {
      this.#projects.set(options.project.root, options.project);
    }
    if (options.mlworker !== undefined) {
      registerMlworkerJobExecutors(this.#queue, options.mlworker);
    }
    this.#queue.registerExecutor("ingest", async (job, { reportProgress }) => {
      const payload = job.payload as unknown as IngestJobPayload;
      const project = this.#projects.get(payload.projectRoot);
      if (project === undefined) {
        throw new MediaError(
          "E_MEDIA_INGEST_INVALID_SOURCE",
          `Project ${payload.projectRoot} is not attached to this MediaEngine.`,
          "safe",
          { affected: [payload.projectRoot] },
        );
      }
      return jsonValue(await this.#execute(
        project,
        payload.request,
        job.jobId,
        reportProgress,
      ));
    });
    this.#queue.registerExecutor("proxy.generate", async (job, { signal }) => {
      const payload = job.payload as unknown as ProxyGeneratePayload;
      const project = this.#projects.get(payload.projectRoot);
      const asset = project?.currentProject.assets.find(
        ({ id }) => id === payload.assetId,
      );
      if (project === undefined || asset === undefined || payload.tier !== "edit") {
        throw new MediaError(
          "E_MEDIA_INGEST_INVALID_SOURCE",
          `Proxy job ${job.jobId} does not reference an attached asset.`,
          "safe",
          { affected: [payload.assetId] },
        );
      }
      return jsonValue(await generateProxy(
        project.root,
        asset,
        payload.tier,
        project.currentProject.settings.timeline.fps,
        signal,
        this.#now,
      ));
    });
    this.#queue.registerExecutor("peaks.generate", async (job, { signal }) => {
      const payload = job.payload as unknown as PeaksGeneratePayload;
      const project = this.#projects.get(payload.projectRoot);
      const asset = project?.currentProject.assets.find(
        ({ id }) => id === payload.assetId,
      );
      if (
        project === undefined || asset === undefined ||
        (asset.audio?.length ?? 0) === 0
      ) {
        throw new MediaError(
          "E_MEDIA_INGEST_INVALID_SOURCE",
          `Peaks job ${job.jobId} does not reference an attached audio asset.`,
          "safe",
          { affected: [payload.assetId] },
        );
      }
      return jsonValue(await generatePeaks(project.root, asset, signal));
    });
  }

  public ingest(
    project: ProjectStore,
    request: IngestRequest,
    dependsOn: string[] = [],
  ): JobRecord {
    if (request.sources.length === 0) {
      throw new TypeError("Ingest requires at least one source.");
    }
    this.#projects.set(project.root, project);
    const payload: IngestJobPayload = {
      projectRoot: project.root,
      request: {
        sources: structuredClone(request.sources),
        via: request.via ?? "manual",
        followUpJobs: [...(request.followUpJobs ?? this.#followUpJobs)],
      },
    };
    return this.#queue.enqueue({
      kind: "ingest",
      title: `Ingest ${String(request.sources.length)} assets`,
      payload: jsonValue(payload),
      cancellable: false,
      dependsOn,
    });
  }

  public async importPickup(
    project: ProjectStore,
    sourcePath: string,
    slug: string,
  ): Promise<PickupImportResult> {
    const source = path.resolve(sourcePath);
    const extension = path.extname(source).toLocaleLowerCase("en");
    if (extension === "") throw invalidSource(sourcePath, "pickup recording has no file extension");
    const directory = path.join(project.root, "media", "pickups");
    await mkdir(directory, { recursive: true });
    const destination = path.join(
      directory,
      `${pickupTimestamp(this.#now())}_${pickupSlug(slug)}${extension}`,
    );
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    return {
      path: destination,
      job: this.ingest(project, {
        sources: [{ path: destination, speechBearing: true }],
        via: "pickup",
        followUpJobs: ["proxy.generate", "peaks.generate", "transcribe"],
      }),
    };
  }

  public async ensureProxy(
    project: ProjectStore,
    assetId: string,
    tier: ProxyTier,
    dependsOn: string[] = [],
  ): Promise<JobRecord | undefined> {
    const asset = project.currentProject.assets.find(({ id }) => id === assetId);
    if (asset === undefined) {
      throw new MediaError(
        "E_MEDIA_INGEST_INVALID_SOURCE",
        `Asset ${assetId} does not exist in project ${project.root}.`,
        "none",
        { affected: [assetId] },
      );
    }
    return this.#ensureProxy(project, asset, tier, dependsOn);
  }

  async #ensureProxy(
    project: ProjectStore,
    asset: Asset,
    tier: ProxyTier,
    dependsOn: string[],
  ): Promise<JobRecord | undefined> {
    this.#projects.set(project.root, project);
    if (proxyCachePaths(project.root, asset, tier) === undefined) return undefined;
    if (!await proxyIsStale(
      project.root,
      asset,
      tier,
      project.currentProject.settings.timeline.fps,
    )) {
      return undefined;
    }
    const active = this.#queue.list({ state: ["queued", "running"] }).find(
      (job) => job.kind === "proxy.generate" &&
        proxyJobMatches(job.payload, project.root, asset.id, tier),
    );
    if (active !== undefined) return active;
    return this.#queue.enqueue({
      kind: "proxy.generate",
      title: followUpTitle("proxy.generate", asset.id),
      payload: { assetId: asset.id, projectRoot: project.root, tier },
      cancellable: true,
      dependsOn,
    });
  }

  public estimateCacheUse(project: ProjectStore): Promise<CacheUseEstimate> {
    return estimateProjectCacheUse(
      project.root,
      project.currentProject.assets,
      project.currentProject.settings.timeline.fps,
    );
  }

  async #execute(
    project: ProjectStore,
    request: IngestJobPayload["request"],
    ingestJobId: string,
    reportProgress: (progress: number, etaSeconds?: number) => void,
  ): Promise<IngestJobResult> {
    const prepared = await Promise.all(
      request.sources.map((source) => prepareSource(project.root, source)),
    );
    reportProgress(0.65);

    const byHash = new Map(
      project.currentProject.assets.map((asset) => [asset.sha256, asset] as const),
    );
    const mutations = new Map<string, Asset>();
    const results: IngestAssetResult[] = [];
    const warnings = new Map<string, IngestWarning>();
    const sourceByAsset = new Map<string, IngestSource[]>();
    const usedIds = new Set(project.currentProject.assets.map(({ id }) => id));
    const ingestedAt = this.#now().toISOString();

    for (const source of prepared) {
      const classification = classifySource(source);
      const existing = byHash.get(source.sha256);
      let asset: Asset;
      let duplicate: boolean;
      if (existing === undefined) {
        let assetId = this.#idFactory("ast");
        while (usedIds.has(assetId)) assetId = this.#idFactory("ast");
        usedIds.add(assetId);
        asset = buildAsset(
          project,
          source,
          classification,
          assetId,
          ingestedAt,
          request.via,
        );
        byHash.set(source.sha256, asset);
        mutations.set(asset.id, asset);
        duplicate = false;
      } else {
        const knownPaths = new Set(existing.knownPaths ?? []);
        if (source.storedPath !== existing.path) knownPaths.add(source.storedPath);
        const updated = knownPaths.size === (existing.knownPaths?.length ?? 0)
          ? existing
          : { ...existing, knownPaths: [...knownPaths] };
        byHash.set(source.sha256, updated);
        mutations.set(updated.id, updated);
        asset = updated;
        duplicate = true;
      }
      const assetSources = sourceByAsset.get(asset.id) ?? [];
      assetSources.push(source.request);
      sourceByAsset.set(asset.id, assetSources);
      results.push({
        assetId: asset.id,
        duplicate,
        kind: asset.kind,
        path: source.storedPath,
        supportTier: classification.tier,
      });
      if (classification.tier === 3 && !warnings.has(asset.id)) {
        warnings.set(asset.id, {
          assetId: asset.id,
          code: "E_MEDIA_UNSUPPORTED_BESTEFFORT",
          message: `Ingested ${source.storedPath} as best-effort media; proxy or render support may be limited.`,
        });
      }
    }

    const followUpJobIds: string[] = [];
    const assetsById = new Map([...byHash.values()].map((asset) => [asset.id, asset] as const));
    const assetIds = [...new Set(results.map(({ assetId }) => assetId))];
    for (const assetId of assetIds) {
      const asset = assetsById.get(assetId);
      if (asset === undefined) continue;
      const sourceRequests = sourceByAsset.get(assetId) ?? [];
      const speechBearing = sourceRequests.some((source) => source.speechBearing !== false);
      for (const kind of request.followUpJobs) {
        if (kind === "proxy.generate") {
          const followUp = await this.#ensureProxy(
            project,
            asset,
            "edit",
            [ingestJobId],
          );
          if (followUp !== undefined) followUpJobIds.push(followUp.jobId);
          continue;
        }
        const applicable = kind === "peaks.generate"
          ? (asset.audio?.length ?? 0) > 0
          : (asset.audio?.length ?? 0) > 0 && speechBearing;
        if (!applicable) continue;
        const alreadyQueued = this.#queue.list({ state: ["queued", "running"] }).some(
          (job) => job.kind === kind && jobAssetId(job.payload) === assetId &&
            (kind !== "peaks.generate" ||
              (typeof job.payload === "object" && job.payload !== null &&
                !Array.isArray(job.payload) &&
                job.payload["projectRoot"] === project.root)),
        );
        if (alreadyQueued) continue;
        const followUp = this.#queue.enqueue({
          kind,
          title: followUpTitle(kind, assetId),
          payload: kind === "peaks.generate"
            ? { assetId, projectRoot: project.root }
            : {
                assetId,
                audioPath: path.isAbsolute(asset.path)
                  ? asset.path
                  : path.resolve(project.root, asset.path),
                ...(kind === "transcribe"
                  ? { language: null, model: "large-v3", wordTimestamps: true }
                  : {}),
              },
          cancellable: true,
          dependsOn: [ingestJobId],
        });
        followUpJobIds.push(followUp.jobId);
      }
    }

    let transactionId: string | undefined;
    if (mutations.size > 0) {
      const engine = new OperationEngine(project.currentProject, {
        appVersion: "0.0.0",
        committer: project,
        idFactory: this.#idFactory,
        now: this.#now,
      });
      const committed = await engine.execute([{
        op: "asset.ingest",
        params: { assets: [...mutations.values()] },
      }], {
        baseRevision: project.currentProject.revision,
        dryRun: false,
        origin: "system",
      });
      if (!committed.ok) throw committed.error;
      transactionId = committed.value.transactionId;
    }
    reportProgress(0.9);

    return {
      assets: results,
      followUpJobIds,
      ...(transactionId === undefined ? {} : { transactionId }),
      warnings: [...warnings.values()],
    };
  }
}
