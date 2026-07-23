import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AnchorResolverRegistry,
  AnnotationService,
  absoluteSeconds,
  buildAnnotationContext,
  convertTimeRounding,
  DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG,
  findJumpCutWarnings,
  formatRevision,
  JobQueue,
  makeId,
  OperationEngine,
  openProject as openCoreProject,
  parseRevision,
  parseRestylePlan,
  parseTakeMarkerSidecar,
  planJumpCutConcealment,
  resolveAnchor,
  serializeTakeMarkerSidecar,
} from "../../../core/src/index.js";
import type {
  Asset, FaceTrackAvailability, JumpCutConcealmentConfig, JobFilter, JobOverview, JobRecord,
  OperationBatchResult, OperationCommitter, OperationInput, Proposal, ProjectStore, Result,
  RestyleFrameRange, RestylePlan, RestyleSeamTreatment, RightsPolicy, SidecarRef,
  TakeMarkerSidecar, TransactionRecord, WatchFolderConfig,
} from "../../../core/src/index.js";
import {
  buildCaptureGuidanceReport,
  CaptureWatcher,
  createSubjectTrackAnalysis,
  loadPeaks,
  MediaEngine,
  MlworkerSupervisor,
  probeMedia,
  proxyCachePaths,
  registerKeyQcExecutor,
  createStoragePreflight,
  parseSubjectTrackAnalysis,
  subjectTrackSidecarPath,
  writeSubjectTrackAnalysis,
  writeCaptureGuidanceReport,
  StorageAccountant,
} from "../../../media/src/index.js";
import type { KeyQcJobPayload, KeyQcReport, MlworkerTrackResult, SubjectTrackAnalysis } from "../../../media/src/index.js";
import {
  compileFillerProposal,
  createAnnotationTranscriptSource,
  createTranscriptWordLookup,
  detectSpokenTakeMarkers,
  enqueueFillerDetection,
  importJsonTakeMarkers,
  importTakeNotes,
  parseFillerDetectionResult,
  parseTranscriptSidecar,
  planPickupSplice,
  registerFillerDetectionExecutor,
  TranscriptEngine,
  buildWordTimelineMap,
} from "../../../transcript/src/index.js";
import { assessSourceRangeContinuity } from "../../../transcript/src/continuity.js";
import type { TranscribeResult } from "../../../transcript/src/index.js";
import { loadTranscriptWorkspace } from "../../../transcript/src/operations.js";
import {
  renderFramingPreviewStrip,
  RenderService,
} from "../../../render/src/index.js";
import type { ExportReport } from "../../../render/src/index.js";
import {
  AdapterRegistry,
  AuditLog,
  CostMeter,
  FileCredentialStore,
  GenerationExecutionService,
  KlingRestyleAdapter,
  pinnedBrandTemplateDefaults,
  RestyleExecutionService,
  SkillRegistry,
} from "../../../agent/src/index.js";
import type {
  BudgetConfig,
  CredentialStore,
  KlingAdapterConfig,
} from "../../../agent/src/index.js";
import { CompositorModel } from "../../../compositor/src/index.js";
import {
  createRefreshProposal,
  createRestylePlan,
  BatchExportService,
  draftPublishMetadata,
  deriveFramingSidecar,
  discoverShortCandidates,
  extractTranscriptText,
  generateChapterList,
  loadPlatformProfile,
  parseFramingSidecar,
  PublishService,
  resolveDerivationSources,
  writeCandidateCache,
  writeFramingSidecar,
} from "../../../deliver/src/index.js";
import type {
  DeliverableTranscript,
  DerivationSelection,
  OtioExportOptions,
  PublishMetadata,
  PublishFileResult,
  RestylePlanningSignals,
  ShortCandidate,
} from "../../../deliver/src/index.js";

import type {
  ExecuteRequest,
  ExecuteResult,
  JobStatus,
  ServiceName,
} from "../shared/ipc.js";
import type { IpcService } from "./rpc.js";
import type { WindowEventPublisher } from "./events.js";
import { validateExportWithRights } from "./export-validation.js";
import {
  generationService,
  registerBuiltInGenerationAdapters,
} from "./generation-service.js";
import { skillRegistryService } from "./skill-service.js";
import { TakeComparisonService } from "./take-comparison-service.js";
import {
  createRecoveryServices,
  recoveryService,
} from "./recovery-service.js";
import type { ProjectServices } from "./project-services.js";
import { MatteService } from "./matte-service.js";
import { OtioService } from "./otio-service.js";
import {
  createProjectTemplateServices,
  templateAuthoringIpc,
} from "./template-authoring-service.js";

interface AppHostSettings {
  auditRetentionDays: number;
  budgets: BudgetConfig;
  maxConcurrentJobs: number | "auto";
  rightsRequirementLevel?: RightsPolicy["requirementLevel"];
  restyleAdapter?: KlingAdapterConfig & { enabled: boolean };
}

export interface AppServiceHostOptions {
  appVersion: string;
  userDirectory: string;
  settings: AppHostSettings;
  credentials?: CredentialStore;
  autoStartMlworker: boolean;
  profilesRoot?: string;
  mlworker?: {
    command: string;
    args: readonly string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
  };
}

export interface WindowServiceHostOptions {
  publisher: WindowEventPublisher;
  chooseProject?: () => Promise<string | undefined>;
  chooseMedia?: () => Promise<string[]>;
  chooseTemplate?: () => Promise<string | undefined>;
  revealPath?: (path: string) => void;
  openPath?: (path: string) => Promise<string>;
}

function resultValue<Value>(result: Result<Value>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function concurrency(value: number | "auto"): number {
  return value === "auto" ? Math.min(4, Math.ceil(cpus().length / 2)) : value;
}

function projectAudioPath(store: ProjectStore, assetId: string): string {
  const asset = store.currentProject.assets.find(({ id }) => id === assetId);
  if (asset === undefined) throw new Error(`Asset ${assetId} does not exist.`);
  return isAbsolute(asset.path) ? asset.path : resolve(store.root, asset.path);
}

function inverseOperations(result: OperationBatchResult): OperationInput[] {
  return result.applied.slice().reverse().flatMap(({ inverse }) => inverse);
}

function publicJobStatus(job: JobRecord): JobStatus {
  return {
    jobId: job.jobId,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    dependsOn: [...job.dependsOn],
    ...(job.error === undefined ? {} : { error: job.error }),
    title: job.title,
    cancellable: job.cancellable,
    createdAt: job.createdAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.etaSeconds === undefined ? {} : { etaSeconds: job.etaSeconds }),
  };
}

function emptyJobOverview(): JobOverview {
  return {
    running: [],
    queued: [],
    retryable: [],
    waitingOnCreator: { proposals: [], annotations: [], confirmations: [] },
    waitingOnExternal: [],
    aggregateFraction: 1,
    idle: true,
  };
}

async function history(store: ProjectStore): Promise<TransactionRecord[]> {
  const contents = await readFile(join(store.root, "history/transactions.jsonl"), "utf8");
  return contents.split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TransactionRecord);
}

async function transcriptSidecars(store: ProjectStore) {
  return Promise.all(store.currentProject.sidecars
    .filter(({ schema }) => schema === "guyditor.transcript/v1")
    .map(async ({ path }) => parseTranscriptSidecar(
      await readFile(join(store.root, path), "utf8"),
    )));
}

function deliverableTranscripts(
  sidecars: Awaited<ReturnType<typeof transcriptSidecars>>,
): DeliverableTranscript[] {
  return sidecars.map((sidecar) => ({
    assetId: sidecar.assetId,
    words: sidecar.segments.flatMap(({ words }) => words).flatMap((id) => {
      const word = sidecar.words[id];
      return word === undefined ? [] : [{
        id,
        text: word.text,
        punctAfter: word.punctAfter,
        state: word.state,
        start: structuredClone(word.start),
        end: structuredClone(word.end),
      }];
    }),
  }));
}

async function publishTranscript(store: ProjectStore, deliverableId: string): Promise<{
  language: string;
  text: string;
}> {
  const project = store.currentProject;
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
  const sidecars = await transcriptSidecars(store);
  const words = sidecars.flatMap((sidecar) => Object.entries(sidecar.words).map(([id, word]) => ({
    id,
    assetId: sidecar.assetId,
    text: word.text,
    punctAfter: word.punctAfter,
    startSamples: word.start.samples,
    endSamples: word.end.samples,
    rate: word.start.rate,
    state: word.state,
    ...(sidecar.speakers.find(({ id: speakerId }) => speakerId === sidecar.segments
      .find(({ words: segmentWords }) => segmentWords.includes(id))?.speaker)?.label === undefined
      ? {}
      : { speaker: sidecar.speakers.find(({ id: speakerId }) => speakerId === sidecar.segments
          .find(({ words: segmentWords }) => segmentWords.includes(id))?.speaker)!.label }),
  })));
  const clips = deliverable.dependencies?.flatMap(({ source }) => source.words === undefined ? [] : [{
    assetId: source.assetId,
    startWordId: source.words.startWordId,
    endWordId: source.words.endWordId,
  }]) ?? [];
  if (clips.length === 0) {
    const sequence = project.sequences.find(({ id }) => id === deliverable.sequenceId);
    for (const clip of sequence?.clips ?? []) {
      if (clip.origin === "local") continue;
      const sidecar = sidecars.find(({ assetId }) => assetId === clip.asset);
      if (sidecar === undefined) continue;
      const [fpsNumerator = "0", fpsDenominator = "1"] = clip.source.in.fps.split("/");
      const fps = Number(fpsNumerator) / Number(fpsDenominator);
      const sourceStart = clip.source.in.frames / fps;
      const sourceEnd = clip.source.out.frames / fps;
      const ids = Object.entries(sidecar.words)
        .filter(([, word]) => word.state === "active" &&
          word.end.samples / word.end.rate > sourceStart &&
          word.start.samples / word.start.rate < sourceEnd)
        .map(([id]) => id)
        .sort();
      if (ids[0] !== undefined && ids.at(-1) !== undefined) {
        clips.push({ assetId: sidecar.assetId, startWordId: ids[0], endWordId: ids.at(-1)! });
      }
    }
  }
  const beatWordIds = project.beats.flatMap(({ anchor }) => {
    const match = /^word:(w[0-9]{6})/u.exec(anchor);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  return {
    language: sidecars.find(({ language }) => language.length > 0)?.language ?? "en",
    text: extractTranscriptText({ clips, beatWordIds, words }),
  };
}

function secondsAt(frame: { frames: number; fps: string }): number {
  const value = resultValue(absoluteSeconds(frame));
  const [numerator, denominator] = value.split("/").map(Number);
  if (numerator === undefined || denominator === undefined || denominator === 0) {
    throw new TypeError(`Invalid exact second value ${value}.`);
  }
  return Math.floor(numerator / denominator);
}

function mergedPublishFiles(
  deliverable: ProjectStore["currentProject"]["deliverables"][number],
  results: readonly PublishFileResult[],
): Array<{ path: string; sha256: string }> {
  const files = new Map((deliverable.publishFiles ?? []).map((file) => [file.path, file]));
  for (const { path, sha256 } of results) files.set(path, { path, sha256 });
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function candidateCache(store: ProjectStore): Promise<ShortCandidate[]> {
  try {
    const parsed = JSON.parse(await readFile(join(
      store.root,
      ".guyditor",
      "cache",
      "candidates",
      `${store.currentProject.revision}.json`,
    ), "utf8")) as { candidates?: ShortCandidate[] };
    return parsed.candidates ?? [];
  } catch {
    return [];
  }
}

async function acceptedRestylePlan(
  store: ProjectStore,
  deliverableId: string,
): Promise<RestylePlan | null> {
  const deliverable = store.currentProject.deliverables.find(({ id }) => id === deliverableId);
  const sidecarName = deliverable?.restyle?.planSidecar;
  const reference = sidecarName === undefined
    ? undefined
    : store.currentProject.sidecars.find(({ name }) => name === sidecarName);
  if (reference === undefined) return null;
  const parsed = parseRestylePlan(await readFile(join(store.root, reference.path), "utf8"));
  return resultValue(parsed);
}

function framesAtFps(
  time: { num: number; den: number },
  fps: string,
): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(fps);
  if (match === null) throw new Error(`Timeline fps ${fps} is invalid.`);
  return Math.round(time.num / time.den * Number(match[1]) / Number(match[2]));
}

function restyleAnalysisSignals(value: unknown): Pick<
  RestylePlanningSignals,
  "vadSilences" | "lowMotionFrames"
> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { vadSilences: [], lowMotionFrames: [] };
  }
  const record = value as Record<string, unknown>;
  const vadSilences = Array.isArray(record["vadSilences"])
    ? record["vadSilences"].flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const range = entry as Record<string, unknown>;
        return Number.isSafeInteger(range["startFrame"]) && Number.isSafeInteger(range["endFrame"])
          ? [{ startFrame: Number(range["startFrame"]), endFrame: Number(range["endFrame"]) }]
          : [];
      })
    : [];
  const lowMotionFrames = Array.isArray(record["lowMotionFrames"])
    ? record["lowMotionFrames"].filter((frame): frame is number =>
        typeof frame === "number" && Number.isSafeInteger(frame) && frame >= 0)
    : [];
  return { vadSilences, lowMotionFrames };
}

async function planningSignals(
  store: ProjectStore,
  deliverableId: string,
): Promise<RestylePlanningSignals> {
  const project = store.currentProject;
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
  const sources = project.layers.filter(({ enabled, sequence }) =>
    enabled && sequence === deliverable.sequenceId).map(({ id }) => id);
  const sidecars = await transcriptSidecars(store);
  const timeline = buildWordTimelineMap({
    project,
    sequenceId: deliverable.sequenceId,
    sidecars,
    track: {
      id: "restyle-planning",
      name: "Restyle planning",
      sourceLayerIds: sources,
      preset: { presetId: "restyle-planning", version: 1 },
      styleOverrides: {},
      breakOverrides: [],
      emphasisOverrides: [],
      timingOffsets: [],
      enabled: true,
    },
  });
  let analysis: Pick<RestylePlanningSignals, "vadSilences" | "lowMotionFrames"> = {
    vadSilences: [],
    lowMotionFrames: [],
  };
  try {
    analysis = restyleAnalysisSignals(JSON.parse(await readFile(
      join(store.root, "sidecars/analysis/restyle-signals.json"),
      "utf8",
    )) as unknown);
  } catch {
    // Word gaps remain the deterministic fallback when analysis is unavailable.
  }
  const resolvers = new AnchorResolverRegistry();
  resolvers.registerWordLookup(createTranscriptWordLookup(sidecars));
  const beats = await Promise.all(project.beats.map(async (beat) => {
    const resolved = await resolveAnchor(
      project,
      beat.anchor,
      deliverable.sequenceId,
      resolvers.dependencies(),
    );
    return resolved.ok && resolved.value.status === "resolved" && resolved.value.timeline !== undefined
      ? { id: beat.id, frame: resolved.value.timeline.frames }
      : undefined;
  }));
  return {
    words: timeline.instances.map((word) => ({
      id: word.wordId,
      startFrame: framesAtFps(word.start, project.settings.timeline.fps),
      endFrame: framesAtFps(word.end, project.settings.timeline.fps),
    })),
    beats: beats.flatMap((beat) => beat === undefined ? [] : [beat]),
    vadSilences: analysis.vadSilences,
    lowMotionFrames: analysis.lowMotionFrames,
  };
}

async function activeProposals(store: ProjectStore): Promise<Proposal[]> {
  const entries = await readdir(join(store.root, "proposals"), { withFileTypes: true });
  const proposals = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^prp_[a-z2-7]{10}$/u.test(entry.name))
    .map(({ name }) => store.readProposal(name)));
  return proposals.flatMap((proposal) => proposal.ok ? [proposal.value] : [])
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function latestExportReport(store: ProjectStore): Promise<ExportReport | null> {
  const root = join(store.root, "exports");
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch {
    return null;
  }
  const reports = await Promise.all(names
    .filter((name) => name.endsWith("export-report.json"))
    .map(async (name) => {
      try {
        return JSON.parse(await readFile(join(root, name), "utf8")) as ExportReport;
      } catch {
        return undefined;
      }
    }));
  return reports.flatMap((report) => report === undefined ? [] : [report])
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function transcriptionFromJob(job: JobRecord): {
  assetId: string;
  result: TranscribeResult;
} | undefined {
  const payload = jsonRecord(job.payload);
  const engine = jsonRecord(payload?.["engine"]);
  if (
    typeof payload?.["assetId"] !== "string" ||
    typeof payload["language"] !== "string" ||
    typeof payload["languageProbability"] !== "number" ||
    !Array.isArray(payload["segments"]) ||
    typeof engine?.["name"] !== "string" ||
    typeof engine["version"] !== "string" ||
    typeof engine["model"] !== "string"
  ) return undefined;
  return {
    assetId: payload["assetId"],
    result: {
      language: payload["language"],
      languageProbability: payload["languageProbability"],
      segments: payload["segments"] as TranscribeResult["segments"],
      engine: {
        name: engine["name"],
        version: engine["version"],
        model: engine["model"],
      },
      jobId: job.jobId,
    },
  };
}

function assetTiming(
  asset: Asset,
  timelineFps: string,
): { fps: string; endFrame: number } {
  const fps = asset.video?.fps ?? asset.probe.fps ?? timelineFps;
  const duration = asset.probe.duration;
  if (duration === undefined) return { fps, endFrame: 1 };
  const converted = "frames" in duration
    ? convertTimeRounding(duration, fps)
    : convertTimeRounding(
        { frames: duration.samples, fps: `${String(duration.rate)}/1` },
        fps,
      );
  return {
    fps,
    endFrame: converted.ok ? Math.max(1, converted.value.time.frames) : 1,
  };
}

function markerFingerprint(
  marker: TakeMarkerSidecar["markers"][number],
): string {
  return JSON.stringify({
    at: marker.at,
    type: marker.type,
    note: marker.note ?? null,
    anchor: marker.anchor ?? null,
    detected: marker.detected ?? false,
    source: marker.source,
  });
}

export class AppServiceHost {
  public readonly auditLog: AuditLog;
  public readonly costMeter: CostMeter;
  public readonly mlworker: MlworkerSupervisor;
  public readonly credentials: CredentialStore;
  public readonly skillRegistry: SkillRegistry;
  readonly #options: AppServiceHostOptions;
  readonly #windows = new Set<WindowServiceHost>();

  public constructor(options: AppServiceHostOptions) {
    this.#options = options;
    this.credentials = options.credentials ?? new FileCredentialStore({
      userDir: options.userDirectory,
    });
    this.auditLog = new AuditLog({
      userDir: options.userDirectory,
      retention: { retentionDays: options.settings.auditRetentionDays },
      credentialValues: () => this.credentials.knownValues(),
    });
    this.skillRegistry = new SkillRegistry({
      globalRoot: join(options.userDirectory, "skills"),
    });
    this.auditLog.prune();
    this.costMeter = CostMeter.open({
      userDir: options.userDirectory,
      auditLog: this.auditLog,
      budgets: options.settings.budgets,
    });
    this.mlworker = new MlworkerSupervisor({
      ...(options.mlworker ?? {}),
      onStateChange: ({ state }) => {
        if (
          state === "starting" || state === "ready" || state === "restarting" ||
          state === "unavailable"
        ) {
          for (const window of this.#windows) {
            window.publisher.publish({ kind: "mlworker.state", state });
          }
        }
      },
    });
    if (options.autoStartMlworker) void this.mlworker.start();
  }

  public createWindowHost(options: WindowServiceHostOptions): WindowServiceHost {
    const host = new WindowServiceHost(this, options);
    this.#windows.add(host);
    return host;
  }

  public forgetWindow(host: WindowServiceHost): void {
    this.#windows.delete(host);
  }

  public async close(): Promise<void> {
    for (const window of [...this.#windows]) await window.close();
    await this.mlworker.stop();
    this.costMeter.close();
  }

  public get appVersion(): string {
    return this.#options.appVersion;
  }

  public get maxConcurrentJobs(): number {
    return concurrency(this.#options.settings.maxConcurrentJobs);
  }

  public get profilesRoot(): string {
    return this.#options.profilesRoot ?? resolve("profiles");
  }

  public get userDirectory(): string {
    return this.#options.userDirectory;
  }

  public get rightsPolicy(): RightsPolicy {
    return {
      requirementLevel: this.#options.settings.rightsRequirementLevel ?? "warn",
    };
  }

  public get restyleAdapter(): KlingAdapterConfig & {
    enabled: boolean;
    costPerSecond: number;
    concurrency: number;
  } {
    const configured = this.#options.settings.restyleAdapter;
    if (configured !== undefined) {
      return {
        ...configured,
        costPerSecond: configured.costPerSecond ?? 0.14,
        concurrency: configured.concurrency ?? 2,
      };
    }
    return {
      enabled: true,
      apiKeyRef: "apiKey",
      model: "kling-video-o1",
      costPerSecond: 0.14,
      concurrency: 2,
    };
  }
}

export class WindowServiceHost {
  public readonly publisher: WindowEventPublisher;
  readonly #app: AppServiceHost;
  readonly #chooseProject: (() => Promise<string | undefined>) | undefined;
  readonly #chooseMedia: (() => Promise<string[]>) | undefined;
  readonly #chooseTemplate: (() => Promise<string | undefined>) | undefined;
  readonly #revealPath: ((path: string) => void) | undefined;
  readonly #openPath: ((path: string) => Promise<string>) | undefined;
  #project: ProjectServices | undefined;
  #closed = false;

  public constructor(app: AppServiceHost, options: WindowServiceHostOptions) {
    this.#app = app;
    this.publisher = options.publisher;
    this.#chooseProject = options.chooseProject;
    this.#chooseMedia = options.chooseMedia;
    this.#chooseTemplate = options.chooseTemplate;
    this.#revealPath = options.revealPath;
    this.#openPath = options.openPath;
  }

  public async openProject(projectPath: string): Promise<ReturnType<WindowServiceHost["snapshot"]>> {
    if (this.#closed) throw new Error("Window service host is closed.");
    const opened = await openCoreProject(resolve(projectPath), { appVersion: this.#app.appVersion });
    const store = resultValue(opened);
    this.#closeProject();
    const annotations = new AnnotationService({ appVersion: this.#app.appVersion });
    const otio = new OtioService({ store, annotations });
    const restyleRuntime: { service?: RestyleExecutionService } = {};
    const storage = new StorageAccountant({ userDirectory: this.#app.userDirectory });
    const { queue: jobs } = JobQueue.open(join(store.root, ".guyditor/jobs.sqlite"), {
      concurrency: this.#app.maxConcurrentJobs,
      preflight: createStoragePreflight(storage, { projectDir: store.root }),
      overviewSources: {
        proposals: async () => (await activeProposals(store))
          .filter(({ status }) => status === "ready")
          .map((proposal) => ({
            proposalId: proposal.id,
            title: proposal.reason.text,
            createdAt: proposal.createdAt,
          })),
        annotations: async () => resultValue(await annotations.list(store))
          .filter((annotation) => annotation.blocking &&
            (annotation.state === "open" || annotation.state === "reopened"))
          .map((annotation) => ({
            annotationId: annotation.id,
            code: "VAL-400",
            message: annotation.body,
            sequenceId: annotation.canvasRef.sequenceId,
          })),
        confirmations: () => this.#app.costMeter
          .outstandingConfirmations(store.currentProject.project.id)
          .map((confirmation) => ({
            confirmToken: confirmation.confirmToken,
            taskId: confirmation.taskId,
            level: confirmation.level,
            message: confirmation.message,
            estimatedUsd: confirmation.estimatedUsd,
            createdAt: confirmation.createdAt,
          })),
        external: () => restyleRuntime.service?.externalWaits() ?? [],
      },
    });
    const recovery = await createRecoveryServices(
      store, jobs, storage, this.#app.appVersion, this.#app.userDirectory,
      () => this.#app.credentials.values(),
    );
    jobs.registerExecutor("candidates", async (job, context) => {
      const payload = jsonRecord(job.payload);
      const profilePin = payload?.["profile"];
      const revision = payload?.["revision"];
      if (typeof profilePin !== "string" || typeof revision !== "string") {
        throw new Error("Candidate discovery payload is incomplete.");
      }
      if (store.currentProject.revision !== revision) {
        throw new Error(`Candidate discovery base ${revision} is stale; enqueue it again at ${store.currentProject.revision}.`);
      }
      context.reportProgress(0.15);
      const loaded = await loadPlatformProfile(profilePin, {
        projectRoot: join(store.root, "profiles"),
        userRoot: join(this.#app.userDirectory, "profiles"),
        builtinsRoot: this.#app.profilesRoot,
      });
      if (loaded.profile.kind !== "short" || loaded.profile.duration.maxSeconds === null) {
        throw new Error(`Candidate discovery requires a bounded short profile, received ${profilePin}.`);
      }
      const constraints = jsonRecord(payload?.["constraints"]);
      const durationRecord = jsonRecord(constraints?.["durationSeconds"]);
      const mustIncludeBeats = Array.isArray(constraints?.["mustIncludeBeats"])
        ? constraints["mustIncludeBeats"].filter((id): id is string => typeof id === "string")
        : undefined;
      const candidates = discoverShortCandidates({
        project: store.currentProject,
        transcripts: deliverableTranscripts(await transcriptSidecars(store)),
        profile: profilePin,
        duration: {
          minSeconds: loaded.profile.duration.minSeconds,
          maxSeconds: loaded.profile.duration.maxSeconds,
        },
        ...(typeof payload?.["maxCandidates"] === "number"
          ? { maxCandidates: payload["maxCandidates"] }
          : {}),
        ...(constraints === undefined ? {} : {
          constraints: {
            ...(mustIncludeBeats === undefined ? {} : { mustIncludeBeats }),
            ...(typeof durationRecord?.["min"] === "number" && typeof durationRecord["max"] === "number"
              ? { durationSeconds: { min: durationRecord["min"], max: durationRecord["max"] } }
              : {}),
          },
        }),
      });
      context.reportProgress(0.85);
      const path = await writeCandidateCache(store.root, revision, candidates);
      context.reportProgress(1);
      return { path, count: candidates.length };
    });
    const registerDerivedSidecar = async (sidecar: SidecarRef): Promise<void> => {
      resultValue(await new OperationEngine(store.currentProject, {
        appVersion: this.#app.appVersion,
        committer: store,
        auditSink: this.#app.auditLog,
      }).execute([{
        op: "sidecar.register",
        params: { name: sidecar.name, sidecar },
      }], {
        baseRevision: store.currentProject.revision,
        origin: "system",
        dryRun: false,
        recordUndo: false,
        instruction: { kind: "ui-direct", text: `Register derived sidecar ${sidecar.name}` },
      }));
    };
    jobs.registerExecutor("reframe", async (job, context) => {
      const payload = jsonRecord(job.payload);
      const deliverableId = payload?.["deliverableId"];
      if (typeof deliverableId !== "string") throw new Error("Reframe payload needs a deliverableId.");
      const initial = store.currentProject;
      const deliverable = initial.deliverables.find(({ id }) => id === deliverableId);
      const sequence = initial.sequences.find(({ id }) => id === deliverable?.sequenceId);
      if (deliverable?.kind !== "short" || sequence === undefined) {
        throw new Error(`Short deliverable ${deliverableId} is unavailable.`);
      }
      const assetIds = [...new Set(sequence.clips.map(({ asset }) => asset))].sort();
      const tracking: Record<string, SubjectTrackAnalysis | undefined> = {};
      for (const [index, assetId] of assetIds.entries()) {
        if (context.signal.aborted) throw new Error("Reframe cancelled.");
        const current = store.currentProject;
        const asset = current.assets.find(({ id }) => id === assetId);
        if (asset === undefined) throw new Error(`Reframe asset ${assetId} is unavailable.`);
        const relativePath = subjectTrackSidecarPath(asset.id);
        const reference = current.sidecars.find(({ schema, path }) =>
          schema === "guyditor.analysis/v1" && path === relativePath);
        let existing: SubjectTrackAnalysis | undefined;
        if (reference !== undefined) {
          try {
            const text = await readFile(join(store.root, relativePath), "utf8");
            const hash = createHash("sha256").update(text).digest("hex");
            const parsed = parseSubjectTrackAnalysis(text);
            if (
              hash === reference.sha256 &&
              parsed.sourceHash.replace(/^sha256:/u, "") === asset.sha256
            ) existing = parsed;
          } catch {
            existing = undefined;
          }
        }
        if (existing === undefined) {
          const tracked = await this.#app.mlworker.runTask("track", {
            taskId: `${job.jobId}-${String(index)}`,
            videoPath: isAbsolute(asset.path) ? asset.path : resolve(store.root, asset.path),
            sampleEvery: 3,
          }, {
            signal: context.signal,
            onProgress: ({ progress }) => context.reportProgress(
              (index + progress) / Math.max(1, assetIds.length) * 0.7,
            ),
          });
          if (!tracked.ok) throw tracked.error;
          existing = createSubjectTrackAnalysis({
            assetId: asset.id,
            sourceHash: asset.sha256,
            params: { sampleEvery: 3 },
            toolVersions: {
              mlworker: "0.0.0",
              mediapipe: (tracked.value as unknown as MlworkerTrackResult).engine.version,
            },
            createdAt: new Date().toISOString(),
            result: tracked.value as unknown as MlworkerTrackResult,
          });
          const written = await writeSubjectTrackAnalysis(store.root, existing);
          await registerDerivedSidecar({
            name: `analysis-${asset.id}-subject-track`,
            path: written.path,
            schema: "guyditor.analysis/v1",
            sha256: written.sha256,
            generatedBy: { tool: "mlworker/mediapipe", version: existing.data === undefined ? "unknown" :
              (tracked.value as unknown as MlworkerTrackResult).engine.version, job: job.jobId },
            inputs: [{ asset: asset.id, sha256: asset.sha256 }],
          });
        }
        tracking[asset.id] = existing;
        context.reportProgress((index + 1) / Math.max(1, assetIds.length) * 0.7);
      }
      const current = store.currentProject;
      const profile = await loadPlatformProfile(deliverable.profile, {
        projectRoot: join(store.root, "profiles"),
        userRoot: join(this.#app.userDirectory, "profiles"),
        builtinsRoot: this.#app.profilesRoot,
        ...(deliverable.profileOverrides === undefined ? {} : { overrides: deliverable.profileOverrides }),
      });
      const sceneBoundaries: Record<string, number[] | undefined> = {};
      for (const assetId of assetIds) {
        const reference = current.sidecars.find(({ schema, path }) =>
          schema === "guyditor.analysis/v1" && path === `sidecars/analysis/${assetId}.scene.shots.json`);
        if (reference === undefined) continue;
        try {
          const value = JSON.parse(await readFile(join(store.root, reference.path), "utf8")) as unknown;
          const data = jsonRecord(jsonRecord(value)?.["data"]);
          const boundaries = data?.["boundaries"];
          if (Array.isArray(boundaries)) {
            sceneBoundaries[assetId] = boundaries.filter((frame): frame is number =>
              typeof frame === "number" && Number.isSafeInteger(frame) && frame >= 0);
          }
        } catch {
          sceneBoundaries[assetId] = undefined;
        }
      }
      const framingPath = `sidecars/framing/${deliverable.id}.framing.json`;
      const previousReference = current.sidecars.find(({ schema, path }) =>
        schema === "guyditor.framing/v1" && path === framingPath);
      const previous = previousReference === undefined
        ? undefined
        : parseFramingSidecar(await readFile(join(store.root, previousReference.path), "utf8"));
      const sidecar = deriveFramingSidecar({
        project: current,
        deliverableId,
        profile: profile.profile,
        tracking,
        sceneBoundaries,
        ...(previous === undefined ? {} : { previous }),
      });
      sidecar.sourceRevision = formatRevision(parseRevision(current.revision) + 1);
      context.reportProgress(0.85);
      const trackReferences = current.sidecars.filter(({ path }) =>
        assetIds.some((assetId) => path === subjectTrackSidecarPath(assetId)));
      const framingReference = await writeFramingSidecar(store.root, sidecar, [
        ...assetIds.map((assetId) => {
          const asset = current.assets.find(({ id }) => id === assetId)!;
          return { asset: asset.id, sha256: asset.sha256 };
        }),
        ...trackReferences.map((reference) => ({ sidecar: reference.name, sha256: reference.sha256 })),
      ]);
      await registerDerivedSidecar({
        ...framingReference,
        generatedBy: { tool: "@guyditor/deliver", version: "0.0.0", job: job.jobId },
      });
      const previewDirectory = join(store.root, ".guyditor/cache/reframe", deliverable.id);
      await mkdir(previewDirectory, { recursive: true });
      const previewStrips: Array<{ decisionId: string; path: string }> = [];
      for (const [index, decision] of sidecar.decisions.entries()) {
        if (context.signal.aborted) throw new Error("Reframe cancelled.");
        const clip = sequence?.clips.find(({ id }) => id === decision.shot.clipId);
        const asset = current.assets.find(({ id }) => id === clip?.asset);
        if (asset === undefined) {
          throw new Error(`Framing preview asset for ${decision.decisionId} is unavailable.`);
        }
        const name = `${decision.decisionId}.svg`;
        await renderFramingPreviewStrip({
          decision,
          sourcePath: isAbsolute(asset.path) ? asset.path : resolve(store.root, asset.path),
          outputPath: join(previewDirectory, name),
          signal: context.signal,
        });
        previewStrips.push({ decisionId: decision.decisionId, path: name });
        context.reportProgress(0.88 + (index + 1) / Math.max(1, sidecar.decisions.length) * 0.1);
      }
      await writeFile(
        join(previewDirectory, "preview-strip.json"),
        `${JSON.stringify({
          format: "guyditor.reframe-preview/v1",
          decisions: sidecar.decisions.map(({ decisionId, shot, crop, mode }) => ({
            decisionId,
            mode,
            stripPath: previewStrips.find((strip) => strip.decisionId === decisionId)?.path,
            frames: [
              shot.source.start.frames,
              Math.floor((shot.source.start.frames + shot.source.end.frames) / 2),
              Math.max(shot.source.start.frames, shot.source.end.frames - 1),
            ],
            motionPath: crop?.keyframes.map(({ at, rect }) => ({ frame: at.frames, rect })) ?? [],
          })),
        }, null, 2)}\n`,
        "utf8",
      );
      context.reportProgress(1);
      return { deliverableId, framingPath: framingReference.path, decisionCount: sidecar.decisions.length };
    });
    const media = new MediaEngine({ jobQueue: jobs, mlworker: this.#app.mlworker });
    registerKeyQcExecutor(jobs);
    const matte = new MatteService({
      store,
      jobs,
      mlworker: this.#app.mlworker,
      execute: (request) => this.#execute(request),
    });
    const compositor = new CompositorModel({
      onKeyQcRun: matte.onKeyQcRun,
      onMatteGenerate: matte.onMatteGenerate,
    });
    const transcript = new TranscriptEngine({
      appVersion: this.#app.appVersion,
      project: store,
      alignmentJobs: {
        queue: jobs,
        hasAlignCapability: () => this.#app.mlworker.hello?.capabilities.some(
          ({ task }) => task === "align",
        ) === true,
        audioPath: (assetId) => projectAudioPath(store, assetId),
      },
    });
    const { templates, templateAuthoring } = createProjectTemplateServices({
      userDirectory: this.#app.userDirectory,
      store,
      auditLog: this.#app.auditLog,
    });
    const render = new RenderService({
      projectRoot: store.root,
      store,
      jobQueue: jobs,
      profilesRoot: this.#app.profilesRoot,
      templateRegistry: templates,
      brandDefaults: () => pinnedBrandTemplateDefaults(store, this.#app.skillRegistry),
    });
    const publish = new PublishService({
      projectRoot: store.root,
      project: () => store.currentProject,
      ...(this.#app.profilesRoot === undefined ? {} : { profilesRoot: this.#app.profilesRoot }),
      userProfilesRoot: join(this.#app.userDirectory, "profiles"),
      validateExport: (deliverableId, revision) => render.validateExport(deliverableId, revision),
    });
    jobs.registerExecutor("publish.kit", async (job) => {
      const deliverableId = jsonRecord(job.payload)?.["deliverableId"];
      if (typeof deliverableId !== "string") throw new Error("Upload-kit job needs a deliverableId.");
      const built = await publish.buildKit(deliverableId);
      return {
        path: built.path,
        deliverableId: built.manifest.deliverableId,
        profile: built.manifest.profile,
        revision: built.manifest.revision,
        fileCount: built.manifest.files.length,
      };
    });
    const batch = new BatchExportService({
      queue: jobs,
      revision: () => store.currentProject.revision,
      validate: (deliverableId, revision) => {
        const deliverable = store.currentProject.deliverables.find(({ id }) => id === deliverableId);
        if (deliverable?.status !== "approved") {
          return Promise.resolve({
            outcome: "blocked" as const,
            checks: [{
              status: "fail" as const,
              message: deliverable === undefined
                ? `Deliverable ${deliverableId} does not exist.`
                : `Deliverable ${deliverableId} must be approved and non-stale.`,
              affected: [deliverableId],
            }],
          });
        }
        return validateExportWithRights({
          render,
          store,
          deliverableId,
          revision,
          rightsPolicy: this.#app.rightsPolicy,
        });
      },
      exportOutputSet: (deliverableId, revision) => render.renderOutputSet({
        deliverableId,
        revision,
        outputDir: join(store.root, "exports"),
      }),
      enqueueKitBuild: (deliverableId, dependsOn) => Promise.resolve(jobs.enqueue({
        kind: "publish.kit",
        title: `Build upload kit · ${deliverableId}`,
        cancellable: true,
        dependsOn: [...dependsOn],
        payload: { deliverableId },
      })),
    });
    const adapters = new AdapterRegistry();
    registerBuiltInGenerationAdapters(adapters, this.#app.credentials);
    const kling = this.#app.restyleAdapter;
    if (kling.enabled) {
      const adapter = new KlingRestyleAdapter({
        credentials: this.#app.credentials,
        config: {
          apiKeyRef: kling.apiKeyRef,
          model: kling.model,
          costPerSecond: kling.costPerSecond,
          concurrency: kling.concurrency,
          ...(kling.baseUrl === undefined ? {} : { baseUrl: kling.baseUrl }),
        },
      });
      adapters.register(adapter);
      adapters.configure(adapter.descriptor.adapterId, {
        enabled: true,
        apiKeyRef: kling.apiKeyRef,
        model: kling.model,
        costPerSecond: kling.costPerSecond,
        concurrency: kling.concurrency,
        ...(kling.baseUrl === undefined ? {} : { baseUrl: kling.baseUrl }),
      });
    }
    const restyle = new RestyleExecutionService({
      projectStore: store,
      operationEngine: {
        createProposal: (input) => this.#coreEngine(this.#requireProject()).createProposal(input),
      },
      adapters,
      jobs,
      costMeter: this.#app.costMeter,
    });
    const generation = new GenerationExecutionService({
      projectStore: store,
      operationEngine: {
        createProposal: (input) => this.#coreEngine(this.#requireProject()).createProposal(input),
      },
      adapters,
      jobs,
      costMeter: this.#app.costMeter,
    });
    restyleRuntime.service = restyle;
    const unsubscribeJobs = jobs.onChange(({ kind, job }) => {
      if (kind === "job.progress") {
        this.publisher.publishProgress({
          jobId: job.jobId,
          progress: job.progress,
          ...(job.etaSeconds === undefined ? {} : { etaSeconds: job.etaSeconds }),
        });
      } else {
        this.publisher.publish({ kind: "job.state", job: publicJobStatus(job) });
        if (job.state === "done" && job.kind === "ingest") {
          this.publisher.publish({
            kind: "project.revision",
            revision: store.currentProject.revision,
          });
        }
        if (job.state === "done" && job.kind === "assist.fillers.detect") {
          void this.#createFillerProposal(job).catch(() => undefined);
        }
        if (job.state === "done" && job.kind === "transcribe") {
          void this.#createTranscriptFromJob(job).catch(() => undefined);
        }
        if (job.state === "done" && job.kind === "keyqc.analyze") {
          void this.#writeCaptureGuidance(job).catch(() => undefined);
        }
        if (job.state === "done" && job.kind === "reframe") {
          this.publisher.publish({
            kind: "project.revision",
            revision: store.currentProject.revision,
          });
        }
        if (job.state === "done" && job.kind === "restyle.generate") {
          const proposalId = jsonRecord(job.payload)?.["proposalId"];
          if (typeof proposalId === "string") {
            this.publisher.publish({ kind: "proposal.updated", proposalId });
          }
        }
      }
    });
    registerFillerDetectionExecutor(jobs, {
      project: store,
      audioPath: (assetId) => projectAudioPath(store, assetId),
      loadPeaks: async (assetId) => {
        const asset = store.currentProject.assets.find(({ id }) => id === assetId);
        return asset === undefined ? undefined : loadPeaks(store.root, asset);
      },
    });
    const capture = new CaptureWatcher({
      project: store,
      media,
      jobQueue: jobs,
      onTakeSeeded: (assetId, take) => this.#seedCaptureTake(assetId, take),
      importMarkerFile: (path, sessionId) => this.#importTakeMarkerFile(path, sessionId),
      onIngested: (assetIds) => {
        this.publisher.publish({ kind: "watcher.ingested", assetIds: [...assetIds] });
        this.publisher.publish({
          kind: "project.revision",
          revision: store.currentProject.revision,
        });
      },
    });
    const takeComparisons = new TakeComparisonService({
      project: store,
      jobs,
      skillRegistry: this.#app.skillRegistry,
      operationEngine: () => this.#coreEngine(this.#requireProject()),
      onRevision: (revision) => this.publisher.publish({ kind: "project.revision", revision }),
      onProposal: (proposalId) => this.publisher.publish({ kind: "proposal.updated", proposalId }),
    });
    this.#project = {
      store,
      jobs,
      media,
      capture,
      transcript,
      annotations,
      compositor,
      matte,
      otio,
      render,
      publish,
      batch,
      templates,
      templateAuthoring,
      adapters,
      generation,
      restyle,
      takeComparisons,
      ...recovery,
      unsubscribeJobs,
    };
    await capture.start(store.currentProject.watchFolders ?? []);
    return this.snapshot();
  }

  public resolveService(service: ServiceName): IpcService | undefined {
    const project = this.#project;
    switch (service) {
      case "ProjectStore":
        return {
          openDialog: async () => {
            const selected = await this.#chooseProject?.();
            return selected === undefined ? null : this.openProject(selected);
          },
          pickTemplatePackage: async () => await this.#chooseTemplate?.() ?? null,
          open: ({ path }: { path: string }) => this.openProject(path),
          getSnapshot: () => this.snapshot(),
          listHistory: () => project === undefined ? [] : history(project.store),
          listProposals: () => project === undefined ? [] : activeProposals(project.store),
          readTranscript: () => project === undefined ? [] : transcriptSidecars(project.store),
          revealProject: () => {
            const path = join(this.#requireProject().store.root, "episode.guyditor.yaml");
            this.#revealPath?.(path);
            return { path };
          },
          openMaster: async () => {
            const path = join(this.#requireProject().store.root, "episode.guyditor.yaml");
            const error = await this.#openPath?.(path);
            if (error !== undefined && error.length > 0) throw new Error(error);
            return { path };
          },
        };
      case "SkillRegistry":
        return skillRegistryService({
          appVersion: this.#app.appVersion,
          ...(project === undefined ? {} : { project: project.store }),
          registry: this.#app.skillRegistry,
          requireProject: () => this.#requireProject().store,
          publishRevision: (revision) => this.publisher.publish({ kind: "project.revision", revision }),
        });
      case "OperationEngine":
        return project === undefined ? undefined : {
          execute: (request: ExecuteRequest) => this.#execute(request),
          resolveNavigation: async ({ target, scope }: {
            target: Parameters<OperationEngine["resolveNavigation"]>[1];
            scope?: string;
          }) => {
            const sidecars = await transcriptSidecars(project.store);
            const resolvers = new AnchorResolverRegistry();
            resolvers.registerWordLookup(createTranscriptWordLookup(sidecars));
            project.annotations.registerAnchorResolver(resolvers, project.store);
            const engine = this.#coreEngine(project, resolvers);
            return resultValue(await engine.resolveNavigation(
              project.store.currentProject,
              target,
              scope,
            ));
          },
          resolveAnchor: async ({ anchor, scope }: { anchor: string; scope?: string }) => {
            const sidecars = await transcriptSidecars(project.store);
            const resolvers = new AnchorResolverRegistry();
            resolvers.registerWordLookup(createTranscriptWordLookup(sidecars));
            project.annotations.registerAnchorResolver(resolvers, project.store);
            return resultValue(await resolveAnchor(
              project.store.currentProject,
              anchor,
              scope,
              resolvers.dependencies(),
            ));
          },
          acceptProposal: ({ proposalId }: { proposalId: string }) =>
            this.#acceptProposal(proposalId),
          rejectProposal: ({ proposalId }: { proposalId: string }) =>
            this.#rejectProposal(proposalId),
          supersedeProposal: ({ proposalId, instruction }: {
            proposalId: string;
            instruction: string;
          }) => this.#supersedeProposal(proposalId, instruction),
          listJumpCuts: ({ sequenceId }: { sequenceId: string }) =>
            findJumpCutWarnings(project.store.currentProject, sequenceId),
          proposeJumpCutConcealment: (params: {
            sequenceId: string;
            beforeClipId?: string;
            config?: Partial<JumpCutConcealmentConfig>;
            faceTracks?: Record<string, FaceTrackAvailability>;
          }) => this.#proposeJumpCutConcealment(params),
        };
      case "JobQueue":
        return {
          list: (filter: JobFilter) => project?.jobs.list(filter).map(publicJobStatus) ?? [],
          overview: () => project?.jobs.overview() ?? Promise.resolve(emptyJobOverview()),
          cancel: ({ jobId }: { jobId: string }) =>
            publicJobStatus(resultValue(this.#requireProject().jobs.cancel(jobId))),
          retry: ({ jobId }: { jobId: string }) =>
            publicJobStatus(resultValue(this.#requireProject().jobs.retry(jobId))),
        };
      case "MediaEngine":
        return project === undefined ? undefined : {
          ingest: ({ paths }: { paths: string[] }) => publicJobStatus(project.media.ingest(
            project.store,
            { sources: paths.map((path) => ({ path })), via: "manual" },
          )),
          pickAndIngest: async () => {
            const paths = await this.#chooseMedia?.() ?? [];
            return paths.length === 0
              ? null
              : publicJobStatus(project.media.ingest(
                  project.store,
                  { sources: paths.map((path) => ({ path })), via: "manual" },
                ));
          },
          resolveProxy: async ({ assetId }: { assetId: string }) => {
            const asset = project.store.currentProject.assets.find(({ id }) => id === assetId);
            if (asset === undefined) throw new Error(`Asset ${assetId} does not exist.`);
            const paths = proxyCachePaths(project.store.root, asset, "edit");
            if (paths === undefined) return null;
            try {
              await access(paths.media);
              return { path: paths.media, url: pathToFileURL(paths.media).href };
            } catch {
              return null;
            }
          },
          readPeaks: async ({ assetId }: { assetId: string }) => {
            const asset = project.store.currentProject.assets.find(({ id }) => id === assetId);
            if (asset === undefined) throw new Error(`Asset ${assetId} does not exist.`);
            return await loadPeaks(project.store.root, asset) ?? null;
          },
          estimateCacheUse: () => project.media.estimateCacheUse(project.store),
          mlworkerState: () => ({
            state: this.#app.mlworker.state,
            capabilities: this.#app.mlworker.hello?.capabilities ?? [],
          }),
          importPickup: async ({ path, slug }: { path: string; slug: string }) => {
            const imported = await project.media.importPickup(project.store, path, slug);
            return { path: imported.path, job: publicJobStatus(imported.job) };
          },
        };
      case "TranscriptEngine":
        return project === undefined ? undefined : {
          importSubtitles: async ({ path }: { path: string }) =>
            resultValue(await project.transcript.importSubtitles(path)),
          findWord: async ({ wordId }: { wordId: string }) =>
            resultValue(await project.transcript.findWord(wordId)),
          resolveWord: async ({ wordId }: { wordId: string }) =>
            resultValue(await project.transcript.resolveWord(wordId)),
          enqueueFillerDetection: ({ assetIds }: { assetIds?: string[] }) =>
            publicJobStatus(enqueueFillerDetection(
              project.jobs,
              assetIds === undefined ? {} : { assetIds },
            )),
          proposePickup: (params: {
            targetAssetId: string;
            pickupAssetId: string;
            fromWord: string;
            toWord: string;
            roomTonePaddingMs?: number;
          }) => this.#proposePickup(params),
        };
      case "CaptureWatcher":
        return project === undefined ? undefined : {
          list: () => project.capture.configs,
          configure: async ({ watchFolders }: { watchFolders: WatchFolderConfig[] }) => {
            const result = await this.#execute({
              operations: [{ op: "project.watchFolders.set", params: { watchFolders } }],
              intent: "direct",
              label: "Update capture watch folders",
            });
            await project.capture.start(watchFolders);
            return { watchFolders: project.capture.configs, revision: result.revision };
          },
          reconcile: async () => {
            await project.capture.reconcile();
            return { watching: project.capture.configs.length };
          },
          listTakes: () => this.#takeSidecars(),
          listTakeComparisons: () => project.takeComparisons.list(),
          compareTakes: ({ takeIds }: { takeIds: string[] }) =>
            project.takeComparisons.compare(takeIds),
          selectTake: ({ comparisonId, takeId }: { comparisonId: string; takeId: string }) =>
            project.takeComparisons.proposeSelection(comparisonId, takeId),
        };
      case "CompositorModel":
        return project === undefined ? undefined : {
          arrangements: () => project.compositor.arrangements(),
          matteCandidates: ({ clipId }: { clipId: string }) => project.matte.candidates(clipId),
          acceptMatteCandidate: ({ clipId, jobId }: { clipId: string; jobId: string }) =>
            project.matte.accept(clipId, jobId),
          keyQcReport: ({ clipId }: { clipId: string }) => this.#readAnalysis<KeyQcReport>(
            `${clipId}.keyqc.json`,
          ),
          captureGuidance: ({ assetId }: { assetId: string }) => this.#readAnalysis(
            `${assetId}.capture.json`,
          ),
        };
      case "AnnotationService":
        return project === undefined ? undefined : {
          list: async () => resultValue(await project.annotations.list(project.store)),
          get: async ({ annotationId }: { annotationId: string }) =>
            resultValue(await project.annotations.get(project.store, annotationId)),
          contextPackage: async ({ annotationId }: { annotationId: string }) => {
            const sidecars = await transcriptSidecars(project.store);
            return resultValue(await buildAnnotationContext({
              store: project.store,
              transcript: createAnnotationTranscriptSource(sidecars),
            }, annotationId));
          },
        };
      case "AdapterRegistry":
        return project === undefined ? undefined : {
          list: () => project.adapters.restyleAdapters().map((adapter) => ({
            descriptor: structuredClone(adapter.descriptor),
            constraints: structuredClone(adapter.constraints),
            configuration: project.adapters.configuration(adapter.descriptor.adapterId),
          })),
        };
      case "GenerationService":
        return project === undefined ? undefined : generationService({
          store: project.store,
          media: project.media,
          adapters: project.adapters,
          generation: project.generation,
          rightsPolicy: this.#app.rightsPolicy,
          acceptProposal: (proposalId) => this.#acceptProposal(proposalId),
        });
      case "DeliverableService":
        return project === undefined ? undefined : {
          publishState: ({ deliverableId }: { deliverableId: string }) => {
            const deliverable = project.store.currentProject.deliverables
              .find(({ id }) => id === deliverableId);
            if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
            return structuredClone(deliverable.publish ?? {});
          },
          draftMetadata: async ({ deliverableId }: { deliverableId: string }) => {
            const deliverable = project.store.currentProject.deliverables
              .find(({ id }) => id === deliverableId);
            if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
            const transcript = await publishTranscript(project.store, deliverableId);
            const metadata = draftPublishMetadata({
              deliverableId,
              profile: deliverable.profile,
              language: transcript.language,
              transcript: transcript.text,
              beats: project.store.currentProject.beats.map(({ chapter, name }) => chapter?.title ?? name),
            });
            const [transcriptFile, metadataFile] = await Promise.all([
              project.publish.writeText(deliverableId, "transcript", transcript.text),
              project.publish.writeMetadata(metadata),
            ]);
            await this.#execute({
              operations: [
                { op: "deliverable.metadata.set", params: { deliverableId, metadata } },
                {
                  op: "deliverable.publish.files.set",
                  params: {
                    deliverableId,
                    files: mergedPublishFiles(deliverable, [transcriptFile, metadataFile]),
                  },
                },
              ],
              intent: "direct",
              label: `Draft publish metadata · ${deliverable.name}`,
            });
            return metadata;
          },
          saveMetadata: async ({ deliverableId, metadata }: {
            deliverableId: string;
            metadata: PublishMetadata;
          }) => {
            const deliverable = project.store.currentProject.deliverables
              .find(({ id }) => id === deliverableId);
            if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
            const edited: PublishMetadata = {
              ...structuredClone(metadata),
              deliverableId,
              profile: deliverable.profile,
              status: "draft",
            };
            delete edited.approvedRevision;
            const metadataFile = await project.publish.writeMetadata(edited);
            await this.#execute({
              operations: [
                { op: "deliverable.metadata.set", params: { deliverableId, metadata: edited } },
                {
                  op: "deliverable.publish.files.set",
                  params: {
                    deliverableId,
                    files: mergedPublishFiles(deliverable, [metadataFile]),
                  },
                },
              ],
              intent: "direct",
              label: `Edit publish metadata · ${deliverable.name}`,
            });
            return edited;
          },
          generateChapters: async ({ deliverableId }: { deliverableId: string }) => {
            const current = project.store.currentProject;
            const deliverable = current.deliverables.find(({ id }) => id === deliverableId);
            if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
            const loaded = await loadPlatformProfile(deliverable.profile, {
              projectRoot: join(project.store.root, "profiles"),
              userRoot: join(this.#app.userDirectory, "profiles"),
              builtinsRoot: this.#app.profilesRoot,
              ...(deliverable.profileOverrides === undefined
                ? {}
                : { overrides: deliverable.profileOverrides }),
            });
            if (loaded.profile.chapters === null) {
              throw new Error(`${loaded.profile.displayName} does not support chapters.`);
            }
            const sidecars = await transcriptSidecars(project.store);
            const resolvers = new AnchorResolverRegistry();
            resolvers.registerWordLookup(createTranscriptWordLookup(sidecars));
            const beats = [];
            for (const beat of current.beats) {
              if (beat.chapter === undefined) continue;
              const resolution = resultValue(await resolveAnchor(
                current,
                beat.anchor,
                deliverable.sequenceId,
                resolvers.dependencies(),
              ));
              if (resolution.status === "resolved" && resolution.timeline !== undefined) {
                beats.push({
                  beatId: beat.id,
                  title: beat.chapter.title,
                  startSeconds: secondsAt(resolution.timeline),
                });
              }
            }
            const generated = generateChapterList({
              deliverableId,
              revision: current.revision,
              beats,
              rules: loaded.profile.chapters,
            });
            const chapters = {
              ...generated.list,
              textSha256: createHash("sha256").update(generated.text).digest("hex"),
              ...(generated.warnings.length === 0 ? {} : { warnings: generated.warnings }),
            };
            const chapterFiles = await project.publish.writeChapters(chapters);
            await this.#execute({
              operations: [
                { op: "deliverable.chapters.set", params: { deliverableId, chapters } },
                {
                  op: "deliverable.publish.files.set",
                  params: {
                    deliverableId,
                    files: mergedPublishFiles(deliverable, chapterFiles),
                  },
                },
              ],
              intent: "direct",
              label: `Generate chapters · ${deliverable.name}`,
            });
            return { ...chapters, errors: generated.errors };
          },
          approvePublish: async ({ deliverableId, targets }: {
            deliverableId: string;
            targets: Array<"metadata" | "chapters">;
          }) => {
            const deliverable = project.store.currentProject.deliverables
              .find(({ id }) => id === deliverableId);
            if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
            const approvedRevision = formatRevision(parseRevision(project.store.currentProject.revision) + 1);
            const publishFiles: PublishFileResult[] = [];
            if (targets.includes("metadata")) {
              if (deliverable.publish?.metadata === undefined) throw new Error("Draft metadata before approval.");
              publishFiles.push(await project.publish.writeMetadata({
                ...deliverable.publish.metadata,
                status: "approved",
                approvedRevision,
              }));
            }
            if (targets.includes("chapters")) {
              const chapters = deliverable.publish?.chapters;
              const loaded = await loadPlatformProfile(deliverable.profile, {
                projectRoot: join(project.store.root, "profiles"),
                userRoot: join(this.#app.userDirectory, "profiles"),
                builtinsRoot: this.#app.profilesRoot,
              });
              if (chapters === undefined || loaded.profile.chapters === null ||
                  chapters.chapters.length < loaded.profile.chapters.minCount) {
                throw new Error("Generate a profile-valid chapter list before approval.");
              }
              publishFiles.push(...await project.publish.writeChapters({
                ...chapters,
                status: "approved",
                approvedRevision,
              }));
            }
            await this.#execute({
              operations: [
                { op: "deliverable.publish.approve", params: { deliverableId, targets } },
                {
                  op: "deliverable.publish.files.set",
                  params: {
                    deliverableId,
                    files: mergedPublishFiles(deliverable, publishFiles),
                  },
                },
              ],
              intent: "direct",
              label: `Approve publish assets · ${deliverable.name}`,
            });
            const approved = project.store.currentProject.deliverables
              .find(({ id }) => id === deliverableId)?.publish;
            return structuredClone(approved ?? {});
          },
          selectThumbnail: async ({ deliverableId, composition }: {
            deliverableId: string;
            composition: string | null;
          }) => this.#execute({
            operations: [{ op: "deliverable.thumbnail.select", params: { deliverableId, composition } }],
            intent: "direct",
            label: composition === null ? "Clear publish thumbnail" : `Select thumbnail ${composition}`,
          }),
          writeTextExports: async ({ deliverableId, targets }: {
            deliverableId: string;
            targets: Array<"transcript" | "chapters" | "metadata">;
          }) => {
            if (targets.includes("transcript")) {
              const transcript = await publishTranscript(project.store, deliverableId);
              await project.publish.writeText(deliverableId, "transcript", transcript.text);
            }
            const files = await project.publish.writeTextExports(deliverableId, targets);
            const deliverable = project.store.currentProject.deliverables
              .find(({ id }) => id === deliverableId);
            if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
            await this.#execute({
              operations: [{
                op: "deliverable.publish.files.set",
                params: { deliverableId, files: mergedPublishFiles(deliverable, files) },
              }],
              intent: "direct",
              label: `Register text exports · ${deliverable.name}`,
            });
            return files;
          },
          previewOtioExport: (params: OtioExportOptions) => project.otio.preview(params),
          exportOtio: (params: OtioExportOptions) => project.otio.export(params),
          renderOutputSet: async ({ deliverableId }: { deliverableId: string }) => {
            const result = await project.render.renderOutputSet({
              deliverableId,
              revision: project.store.currentProject.revision,
              outputDir: join(project.store.root, "exports"),
            });
            return { ...result, job: publicJobStatus(project.jobs.get(result.jobId)!) };
          },
          buildKit: ({ deliverableId }: { deliverableId: string }) => publicJobStatus(
            project.jobs.enqueue({
              kind: "publish.kit",
              title: `Build upload kit · ${deliverableId}`,
              cancellable: true,
              payload: { deliverableId },
            }),
          ),
          batchExport: (params: { deliverableIds: string[]; buildKits?: boolean }) =>
            project.batch.exportBatch(params),
          batchResult: ({ jobId }: { jobId: string }) => project.batch.result(jobId),
          retryBatch: ({ jobId }: { jobId: string }) => project.batch.retryBatch(jobId),
          profiles: async () => Promise.all([
            "youtube-longform@1.0.0",
            "youtube-shorts@1.0.0",
            "tiktok@1.0.0",
            "instagram-reels@1.0.0",
          ].map(async (pin) => (await loadPlatformProfile(pin, {
            projectRoot: join(project.store.root, "profiles"),
            userRoot: join(this.#app.userDirectory, "profiles"),
            builtinsRoot: this.#app.profilesRoot,
          })).profile)),
          candidates: () => candidateCache(project.store),
          discoverCandidates: (params: {
            profile: string;
            maxCandidates?: number;
            constraints?: {
              mustIncludeBeats?: string[];
              durationSeconds?: { min: number; max: number };
            };
          }) => publicJobStatus(project.jobs.enqueue({
            kind: "candidates",
            title: `Discover short candidates · ${params.profile}`,
            cancellable: true,
            payload: {
              profile: params.profile,
              revision: project.store.currentProject.revision,
              ...(params.maxCandidates === undefined ? {} : { maxCandidates: params.maxCandidates }),
              ...(params.constraints === undefined ? {} : { constraints: params.constraints }),
            },
          })),
          derive: async (params: {
            name: string;
            profile: string;
            profileOverrides?: Record<string, unknown>;
            selection?: DerivationSelection;
            candidateId?: string;
          }) => {
            let selection = params.selection;
            if (params.candidateId !== undefined) {
              const candidate = (await candidateCache(project.store))
                .find(({ candidateId }) => candidateId === params.candidateId);
              if (candidate === undefined) throw new Error(`Candidate ${params.candidateId} is unavailable at ${project.store.currentProject.revision}.`);
              selection = { words: candidate.words };
            }
            if (selection === undefined) throw new Error("Derivation requires a selection or candidate.");
            const resolved = resultValue(resolveDerivationSources(
              project.store.currentProject,
              deliverableTranscripts(await transcriptSidecars(project.store)),
              selection,
            ));
            const sessionId = makeId("ses");
            const proposal = resultValue(await this.#coreEngine(project).createProposal({
              operations: [{
                op: "deliverable.derive",
                params: {
                  kind: "short",
                  name: params.name,
                  profile: params.profile,
                  ...(params.profileOverrides === undefined ? {} : { profileOverrides: params.profileOverrides }),
                  from: structuredClone(selection),
                  ...(params.candidateId === undefined ? {} : { candidateId: params.candidateId }),
                  resolvedSources: resolved,
                },
              }],
              instruction: { kind: "user-text", text: `Derive ${params.name}` },
              actor: { kind: "agent", id: sessionId, model: "deliverable-service" },
              sessionId,
              reason: {
                text: `Review the independent ${params.profile} sequence derived from the selected long-form source ranges.`,
                sources: [{ kind: "instruction", ref: params.candidateId ?? "manual-selection" }],
              },
              addresses: [],
            }));
            this.publisher.publish({ kind: "proposal.updated", proposalId: proposal.id });
            return proposal;
          },
          refresh: async ({ deliverableId }: { deliverableId: string }) => {
            const proposal = resultValue(await createRefreshProposal({
              project: project.store.currentProject,
              transcripts: deliverableTranscripts(await transcriptSidecars(project.store)),
              deliverableId,
              history: await history(project.store),
              createProposal: (request) => this.#coreEngine(project).createProposal(request),
              attachPreview: async (ready) => project.jobs.enqueue({
                kind: "render.preview",
                title: `Refresh preview · ${deliverableId}`,
                cancellable: true,
                payload: {
                  proposalId: ready.id,
                  deliverableId,
                  revision: project.store.currentProject.revision,
                },
              }).jobId,
              updateProposal: (ready) => project.store.updateProposal(ready),
            }));
            this.publisher.publish({ kind: "proposal.updated", proposalId: proposal.id });
            return proposal;
          },
          restylePlan: async ({ deliverableId }: { deliverableId: string }) =>
            acceptedRestylePlan(project.store, deliverableId),
          createRestylePlan: async (params: {
            deliverableId: string;
            adapterId?: string;
            coverage: "full" | RestyleFrameRange[];
            prompt: string;
            negativePrompt?: string;
            seed?: number;
            providerSettings?: Record<string, unknown>;
          }) => {
            const adapter = params.adapterId === undefined
              ? project.adapters.restyleAdapters()[0]
              : project.adapters.resolveRestyle(params.adapterId);
            if (adapter === undefined) {
              throw new Error("No enabled restyle adapter is available.");
            }
            const plan = resultValue(createRestylePlan({
              project: project.store.currentProject,
              deliverableId: params.deliverableId,
              coverage: params.coverage,
              adapterId: adapter.descriptor.adapterId,
              model: adapter.descriptor.models[0]?.id ?? "kling-video-o1",
              constraints: adapter.constraints,
              prompt: params.prompt,
              ...(params.negativePrompt === undefined
                ? {}
                : { negativePrompt: params.negativePrompt }),
              ...(params.seed === undefined ? {} : { seed: params.seed }),
              providerSettings: structuredClone(params.providerSettings ?? {}),
              createdAt: new Date().toISOString(),
              signals: await planningSignals(project.store, params.deliverableId),
            }));
            const sessionId = makeId("ses");
            const proposal = resultValue(await this.#coreEngine(project).createProposal({
              operations: [{
                op: "restyle.plan.create",
                params: { deliverableId: params.deliverableId, plan },
              }],
              instruction: { kind: "user-text", text: params.prompt },
              actor: { kind: "agent", id: sessionId, model: "restyle-planner" },
              sessionId,
              reason: {
                text: `Review the ${String(plan.chunks.length)}-chunk restyle plan before generation.`,
                sources: [{ kind: "instruction", ref: params.prompt }],
              },
              addresses: [],
            }));
            this.publisher.publish({ kind: "proposal.updated", proposalId: proposal.id });
            return { plan, proposal };
          },
          startRestyle: async ({
            deliverableId,
            confirmToken,
          }: { deliverableId: string; confirmToken?: string }) => {
            const plan = await acceptedRestylePlan(project.store, deliverableId);
            if (plan === null) throw new Error(`Deliverable ${deliverableId} has no accepted restyle plan.`);
            return project.restyle.startPlan({
              plan,
              context: {
                sessionId: makeId("ses"),
                projectId: project.store.currentProject.project.id,
                taskId: plan.id,
                initiator: "creator",
              },
              ...(confirmToken === undefined ? {} : { confirmToken }),
            });
          },
          setRestyleSeamTreatment: async (params: {
            deliverableId: string;
            seamId: string;
            treatment: RestyleSeamTreatment;
          }) => {
            const plan = await acceptedRestylePlan(project.store, params.deliverableId);
            if (plan === null) {
              throw new Error(`Deliverable ${params.deliverableId} has no accepted restyle plan.`);
            }
            if (!plan.seams.some(({ id }) => id === params.seamId)) {
              throw new Error(`Restyle seam ${params.seamId} is not in plan ${plan.id}.`);
            }
            const sessionId = makeId("ses");
            const proposal = resultValue(await this.#coreEngine(project).createProposal({
              operations: [{
                op: "seam.treatment.set",
                params: {
                  deliverableId: params.deliverableId,
                  plan,
                  seamId: params.seamId,
                  treatment: structuredClone(params.treatment),
                },
              }],
              instruction: {
                kind: "user-text",
                text: `Set ${params.seamId} treatment to ${params.treatment.kind}`,
              },
              actor: { kind: "agent", id: sessionId, model: "restyle-seam-editor" },
              sessionId,
              reason: {
                text: `Review the ${params.treatment.kind} treatment for ${params.seamId}.`,
                sources: [{ kind: "instruction", ref: params.seamId }],
              },
              addresses: [],
            }));
            this.publisher.publish({ kind: "proposal.updated", proposalId: proposal.id });
            return { proposal };
          },
        };
      case "RenderService":
        return project === undefined ? undefined : {
          cacheStats: () => project.render.cacheStats(),
          captionFrame: (params: Parameters<RenderService["captionFrame"]>[0]) =>
            project.render.captionFrame(params),
          framingFrame: (params: Parameters<RenderService["framingFrame"]>[0]) =>
            project.render.framingFrame(params),
          graphicsFrame: (params: Parameters<RenderService["graphicsFrame"]>[0]) =>
            project.render.graphicsFrame(params),
          templateCatalog: () => project.render.templateCatalog(),
          templateFrame: (params: Parameters<RenderService["templateFrame"]>[0]) =>
            project.render.templateFrame(params),
          templateFreeze: (params: Parameters<RenderService["templateFreeze"]>[0]) =>
            project.render.templateFreeze(params),
          renderExport: (params: Parameters<RenderService["renderExport"]>[0]) =>
            project.render.renderExport(params),
          renderDiagnostic: (params: Parameters<RenderService["renderDiagnostic"]>[0]) =>
            project.render.renderDiagnostic(params),
          validateExport: ({ deliverableId, revision }: {
            deliverableId: string;
            revision: string;
          }) => validateExportWithRights({
            render: project.render,
            store: project.store,
            deliverableId,
            revision,
            rightsPolicy: this.#app.rightsPolicy,
          }),
          exportReport: () => latestExportReport(project.store),
        };
      case "TemplateAuthoringService":
        return project === undefined
          ? undefined
          : templateAuthoringIpc(project.templateAuthoring);
      case "AuditLog":
        return {
          readSession: ({ sessionId }: { sessionId: string }) => this.#app.auditLog.readSession(sessionId),
        };
      case "CostMeter":
        return {
          status: () => this.#app.costMeter.status(project?.store.currentProject.project.id ?? "unopened"),
        };
      case "BackupService":
        return project === undefined ? undefined : recoveryService(project);
      default:
        return undefined;
    }
  }

  public snapshot(): {
    revision: string;
    master: ProjectStore["currentProject"];
    sidecarIndex: ProjectStore["currentProject"]["sidecars"];
    projectPath: string;
  } {
    const project = this.#requireProject();
    return {
      revision: project.store.currentProject.revision,
      master: structuredClone(project.store.currentProject),
      sidecarIndex: structuredClone(project.store.currentProject.sidecars),
      projectPath: project.store.root,
    };
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#project?.backupScheduler?.quit().catch(() => undefined);
    this.#closeProject();
    this.publisher.dispose();
    this.#app.forgetWindow(this);
  }

  async #execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const project = this.#requireProject();
    const context = {
      origin: "ui" as const,
      dryRun: false,
      recordUndo: false,
      instruction: { kind: "ui-direct" as const, text: request.label },
      ...(request.intent === "undo" && request.undoOf !== undefined
        ? { undoOf: request.undoOf }
        : {}),
      ...(request.intent === "redo" && request.undoOf !== undefined
        ? { redoOf: request.undoOf }
        : {}),
      ...(request.divergence === undefined ? {} : { divergence: request.divergence }),
    };
    const containsTranscript = request.operations.some(({ op }) =>
      op.startsWith("transcript.") || op.startsWith("caption.") || op === "pickup.splice");
    const containsAnnotation = request.operations.some(({ op }) => op.startsWith("annotation."));
    let result: OperationBatchResult;
    if (containsTranscript) {
      result = resultValue(await project.transcript.execute(
        project.store,
        request.operations,
        context,
      ));
    } else if (containsAnnotation) {
      result = resultValue(await project.annotations.execute(
        project.store,
        request.operations,
        context,
      ));
    } else {
      const engine = this.#coreEngine(project);
      result = resultValue(await engine.execute(request.operations, {
        baseRevision: project.store.currentProject.revision,
        origin: "ui",
        dryRun: false,
        recordUndo: false,
        instruction: context.instruction,
        ...(context.undoOf === undefined ? {} : { undoOf: context.undoOf }),
        ...(context.redoOf === undefined ? {} : { redoOf: context.redoOf }),
        ...(context.divergence === undefined ? {} : { divergence: context.divergence }),
      }));
    }
    const txnId = result.transactionId;
    if (txnId === undefined) throw new Error("Accepted operation did not produce a transaction ID.");
    const revision = project.store.currentProject.revision;
    this.publisher.publish({ kind: "project.revision", revision });
    project.backupScheduler?.acceptedRevision();
    return { txnId, revision, inverse: inverseOperations(result) };
  }

  #coreEngine(
    project: ProjectServices,
    anchorResolvers?: AnchorResolverRegistry,
    committer: OperationCommitter = project.store,
  ): OperationEngine {
    return new OperationEngine(project.store.currentProject, {
      appVersion: this.#app.appVersion,
      committer,
      proposalStore: project.store,
      templateProvider: project.templates,
      operationDispatcher: project.compositor.dispatchOperation,
      auditSink: this.#app.auditLog,
      ...(anchorResolvers === undefined ? {} : { anchorResolvers }),
    });
  }

  async #acceptProposal(proposalId: string): Promise<Proposal> {
    const project = this.#requireProject();
    const shortsBefore = new Set(project.store.currentProject.deliverables
      .filter(({ kind }) => kind === "short")
      .map(({ id }) => id));
    let current = resultValue(await project.store.readProposal(proposalId));
    if (
      current.baseRevision !== project.store.currentProject.revision &&
      current.operations.length > 0 &&
      current.operations.every(({ op }) =>
        op === "restyle.segment.approve" || op === "clip.split" || op === "clip.punchin.set")
    ) {
      const rebased = resultValue(await this.#coreEngine(project).supersedeProposal(
        current.id,
        {
          operations: current.operations.map(({ op, params }) => ({ op, params })),
          instruction: structuredClone(current.instruction),
          actor: structuredClone(current.actor),
          ...(current.sessionId === undefined ? {} : { sessionId: current.sessionId }),
          reason: {
            text: `${current.reason.text} Rebased over independently approved restyle chunks.`,
            sources: [...current.reason.sources],
          },
          addresses: [...current.addresses],
        },
      ));
      this.publisher.publish({ kind: "proposal.updated", proposalId: current.id });
      this.publisher.publish({ kind: "proposal.updated", proposalId: rebased.id });
      current = rebased;
    }
    const proposal = current.operations.some(({ op }) => op === "pickup.splice")
      ? resultValue(await project.transcript.acceptProposal(
          project.store,
          current.id,
          "creator",
        ))
      : resultValue(await this.#coreEngine(project, undefined, {
          commit: (model, transaction) =>
            project.annotations.commitAccepted(project.store, model, transaction),
        }).acceptProposal(
          current.id,
          "creator",
        ));
    const reframeIds = new Set([
      ...project.store.currentProject.deliverables
        .filter(({ id, kind }) => kind === "short" && !shortsBefore.has(id))
        .map(({ id }) => id),
      ...current.operations.flatMap(({ op, params }) =>
        op === "deliverable.refresh" && typeof params["deliverableId"] === "string"
          ? [params["deliverableId"]]
          : []),
    ]);
    for (const deliverableId of reframeIds) {
      project.jobs.enqueue({
        kind: "reframe",
        title: `Recompose vertical framing · ${deliverableId}`,
        cancellable: true,
        payload: { deliverableId },
      });
    }
    this.publisher.publish({ kind: "proposal.updated", proposalId: current.id });
    this.publisher.publish({
      kind: "project.revision",
      revision: project.store.currentProject.revision,
    });
    return proposal;
  }

  async #rejectProposal(proposalId: string): Promise<Proposal> {
    const project = this.#requireProject();
    const proposal = resultValue(await this.#coreEngine(project).rejectProposal(
      proposalId,
      "creator",
    ));
    this.publisher.publish({ kind: "proposal.updated", proposalId });
    return proposal;
  }

  async #supersedeProposal(proposalId: string, instruction: string): Promise<Proposal> {
    const project = this.#requireProject();
    const current = resultValue(await project.store.readProposal(proposalId));
    const proposal = resultValue(await this.#coreEngine(project).supersedeProposal(proposalId, {
      operations: current.operations.map(({ op, params }) => ({ op, params })),
      instruction: { kind: "user-text", text: instruction },
      actor: { kind: "human", id: "creator" },
      reason: {
        text: instruction,
        sources: [{ kind: "instruction", ref: proposalId }],
      },
      addresses: current.addresses,
    }));
    this.publisher.publish({ kind: "proposal.updated", proposalId });
    this.publisher.publish({ kind: "proposal.updated", proposalId: proposal.id });
    return proposal;
  }

  async #proposeJumpCutConcealment(params: {
    sequenceId: string;
    beforeClipId?: string;
    config?: Partial<JumpCutConcealmentConfig>;
    faceTracks?: Record<string, FaceTrackAvailability>;
  }): Promise<ReturnType<typeof planJumpCutConcealment> & { proposal?: Proposal }> {
    const project = this.#requireProject();
    const config: JumpCutConcealmentConfig = {
      ...structuredClone(DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG),
      ...params.config,
      minPunchDurationFrames: {
        ...DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG.minPunchDurationFrames,
        ...params.config?.minPunchDurationFrames,
      },
    };
    const warnings = findJumpCutWarnings(project.store.currentProject, params.sequenceId)
      .filter(({ boundary }) => params.beforeClipId === undefined ||
        boundary.beforeClip === params.beforeClipId);
    const plan = planJumpCutConcealment({
      project: project.store.currentProject,
      sequenceId: params.sequenceId,
      warnings,
      config,
      faceTracks: params.faceTracks ?? {},
    });
    if (plan.kind !== "proposal") return plan;
    const proposal = resultValue(await this.#coreEngine(project).createProposal({
      operations: plan.operations,
      instruction: {
        kind: "skill-policy",
        text: "Review jump-cut concealment (policy supplied directly; editorial-skill integration lands in M4)",
      },
      actor: { kind: "tool", id: "assist.jumpcuts.conceal" },
      reason: {
        text: "Conceal flagged same-source jump cuts without silently changing the accepted timeline.",
        sources: plan.reasons.map(({ evidence }) => ({
          kind: "media-evidence" as const,
          ref: evidence,
        })),
      },
      addresses: [],
      warnings,
    }));
    this.publisher.publish({ kind: "proposal.updated", proposalId: proposal.id });
    return { ...plan, proposal };
  }

  async #proposePickup(params: {
    targetAssetId: string;
    pickupAssetId: string;
    fromWord: string;
    toWord: string;
    roomTonePaddingMs?: number;
  }): Promise<unknown> {
    const project = this.#requireProject();
    resultValue(await project.transcript.realign(project.store, {
      assetId: params.pickupAssetId,
    }));
    const sidecars = await transcriptSidecars(project.store);
    const target = sidecars.find(({ assetId }) => assetId === params.targetAssetId);
    const pickup = sidecars.find(({ assetId }) => assetId === params.pickupAssetId);
    if (target === undefined || pickup === undefined) {
      throw new Error("Both the original and pickup assets must have canonical transcripts.");
    }
    const pickupWords = pickup.segments.flatMap(({ words }) => words.flatMap((wordId) => {
      const word = pickup.words[wordId];
      return word === undefined || word.state !== "active" ? [] : [word];
    }));
    const firstPickup = pickupWords[0];
    const lastPickup = pickupWords.at(-1);
    if (firstPickup === undefined || lastPickup === undefined) {
      throw new Error("The pickup transcript has no active aligned words.");
    }
    const confidences = pickupWords.flatMap(({ confidence }) =>
      confidence === null ? [] : [confidence]);
    const confidence = confidences.length === 0
      ? 0
      : confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
    const targetFrom = target.words[params.fromWord];
    const targetTo = target.words[params.toWord];
    if (targetFrom === undefined || targetTo === undefined) {
      throw new Error(`Pickup target ${params.fromWord}..${params.toWord} is not in ${params.targetAssetId}.`);
    }
    const plan = await planPickupSplice({
      project: project.store.currentProject,
      transcript: target,
      pickupTranscript: pickup,
      wordRange: { fromWord: params.fromWord, toWord: params.toWord },
      pickupAssetId: params.pickupAssetId,
      pickupRange: { in: firstPickup.start, out: lastPickup.end },
      alignmentConfidence: confidence,
      ...(params.roomTonePaddingMs === undefined
        ? {}
        : { roomTonePaddingMs: params.roomTonePaddingMs }),
      evaluateContinuity: () => assessSourceRangeContinuity(
        project.store.currentProject,
        {
          assetId: params.targetAssetId,
          start: targetFrom.start,
          end: targetTo.end,
        },
        {
          sidecars,
          loadPeaks: async (assetId) => {
            const asset = project.store.currentProject.assets.find(({ id }) => id === assetId);
            return asset === undefined ? undefined : loadPeaks(project.store.root, asset);
          },
        },
      ),
    });
    if (plan.kind !== "proposal") return plan;
    const captionWarning = {
      code: "caption-realign-required" as const,
      severity: "info" as const,
      boundary: {},
      evidence: `Pickup timing changes ${params.fromWord}..${params.toWord}; ${String(plan.captionUpdates.length)} enabled caption tracks require realignment.`,
      suggestion: "Review caption breaks and timing with the pickup preview before acceptance.",
    };
    const proposal = resultValue(await project.transcript.createProposal(project.store, {
      operations: [plan.operation],
      instruction: { kind: "ui-direct", text: "Review imported pickup splice" },
      actor: { kind: "tool", id: "pickup.import" },
      reason: {
        text: "Replace the selected flawed words with the force-aligned corrective recording.",
        sources: [{ kind: "media-evidence", ref: params.pickupAssetId }],
      },
      addresses: [],
      warnings: [...plan.warnings, captionWarning],
    }));
    this.publisher.publish({ kind: "proposal.updated", proposalId: proposal.id });
    return { ...plan, warnings: [...plan.warnings, captionWarning], proposal };
  }

  async #takeSidecars(): Promise<TakeMarkerSidecar[]> {
    const project = this.#requireProject();
    return Promise.all(project.store.currentProject.sidecars
      .filter(({ schema }) => schema === "guyditor.take-markers/v1")
      .map(async ({ path }) => parseTakeMarkerSidecar(
        await readFile(join(project.store.root, path), "utf8"),
      )));
  }

  async #takeSidecar(assetId: string): Promise<TakeMarkerSidecar> {
    const existing = (await this.#takeSidecars()).find((sidecar) => sidecar.assetId === assetId);
    return existing ?? {
      format: "guyditor.take-markers/v1",
      assetId,
      markers: [],
      takes: [],
    };
  }

  async #persistTakeSidecar(sidecar: TakeMarkerSidecar): Promise<void> {
    const project = this.#requireProject();
    const content = serializeTakeMarkerSidecar(sidecar);
    const relativePath = `sidecars/takes/${sidecar.assetId}.takes.json`;
    await mkdir(join(project.store.root, "sidecars/takes"), { recursive: true });
    await writeFile(join(project.store.root, relativePath), content, "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    resultValue(await this.#coreEngine(project).execute([
      {
        op: "asset.markers.attach",
        params: {
          assetId: sidecar.assetId,
          markerIds: sidecar.markers.map(({ id }) => id),
          sidecar: { path: relativePath, sha256 },
        },
      },
      {
        op: "asset.takes.set",
        params: {
          assetId: sidecar.assetId,
          takeIds: sidecar.takes.map(({ id }) => id),
          sidecar: { path: relativePath, sha256 },
        },
      },
    ], {
      baseRevision: project.store.currentProject.revision,
      origin: "system",
      dryRun: false,
      recordUndo: false,
      instruction: { kind: "ui-direct", text: "Attach capture take metadata" },
    }));
  }

  async #seedCaptureTake(
    assetId: string,
    seed: { id: string; index: number },
  ): Promise<void> {
    const project = this.#requireProject();
    const asset = project.store.currentProject.assets.find(({ id }) => id === assetId);
    if (asset === undefined) throw new Error(`Capture asset ${assetId} is unavailable.`);
    const sidecar = await this.#takeSidecar(assetId);
    if (sidecar.takes.some(({ id }) => id === seed.id)) return;
    const timing = assetTiming(asset, project.store.currentProject.settings.timeline.fps);
    sidecar.takes.push({
      id: seed.id,
      assetId,
      index: seed.index,
      range: { start: 0, end: timing.endFrame, fps: timing.fps },
      quality: "unrated",
      notes: [],
      sourceMarkerIds: [],
    });
    await this.#persistTakeSidecar(sidecar);
  }

  async #importTakeMarkerFile(markerPath: string, sessionId: string): Promise<void> {
    const project = this.#requireProject();
    const markerName = basename(markerPath).toLocaleLowerCase("en");
    const specificName = markerName === "markers.json" || markerName === "notes.txt"
      ? undefined
      : markerName.slice(0, -".markers.json".length);
    const assets = project.store.currentProject.assets.filter((asset) => {
      if (asset.session !== sessionId) return false;
      if (specificName === undefined) return true;
      const mediaName = basename(asset.path).toLocaleLowerCase("en");
      return mediaName === specificName || mediaName.slice(0, -extname(mediaName).length) === specificName;
    });
    const text = await readFile(markerPath, "utf8");
    let changed = false;
    for (const asset of assets) {
      const timing = assetTiming(asset, project.store.currentProject.settings.timeline.fps);
      const imported = markerName.endsWith(".json")
        ? importJsonTakeMarkers(text, {
            assetId: asset.id,
            fps: timing.fps,
            assetEndFrame: timing.endFrame,
            idFactory: makeId,
            ...(asset.captureTime === undefined
              ? {}
              : { captureStart: asset.captureTime.value }),
          })
        : importTakeNotes(text, {
            assetId: asset.id,
            fps: timing.fps,
            assetEndFrame: timing.endFrame,
            idFactory: makeId,
          });
      const existing = await this.#takeSidecar(asset.id);
      const fingerprints = new Set(existing.markers.map(markerFingerprint));
      if (imported.markers.every((marker) => fingerprints.has(markerFingerprint(marker)))) continue;
      await this.#persistTakeSidecar({
        ...existing,
        markers: [...existing.markers, ...imported.markers],
        takes: imported.takes.length === 0
          ? existing.takes
          : [...existing.takes, ...imported.takes],
      });
      changed = true;
    }
    if (changed) {
      this.publisher.publish({
        kind: "project.revision",
        revision: project.store.currentProject.revision,
      });
    }
  }

  async #createTranscriptFromJob(job: JobRecord): Promise<void> {
    const parsed = transcriptionFromJob(job);
    if (parsed === undefined) return;
    const project = this.#requireProject();
    const created = await project.transcript.createFromTranscription(
      project.store,
      parsed.assetId,
      parsed.result,
    );
    if (!created.ok) {
      if (created.error.code === "E_TRANSCRIPT_EXISTS") return;
      throw created.error;
    }
    const asset = project.store.currentProject.assets.find(({ id }) => id === parsed.assetId);
    if (asset !== undefined) {
      const timing = assetTiming(asset, project.store.currentProject.settings.timeline.fps);
      const spoken = detectSpokenTakeMarkers(created.value.sidecar, {
        fps: timing.fps,
        idFactory: makeId,
      });
      if (spoken.length > 0) {
        const existing = await this.#takeSidecar(asset.id);
        const fingerprints = new Set(existing.markers.map(markerFingerprint));
        existing.markers.push(...spoken.filter((marker) =>
          !fingerprints.has(markerFingerprint(marker))));
        await this.#persistTakeSidecar(existing);
      }
    }
    this.publisher.publish({
      kind: "project.revision",
      revision: project.store.currentProject.revision,
    });
  }

  async #createFillerProposal(job: JobRecord): Promise<void> {
    const project = this.#requireProject();
    const detected = parseFillerDetectionResult(job.payload);
    if (detected.candidates.length === 0) return;
    const workspace = resultValue(await loadTranscriptWorkspace(project.store, (prefix) => {
      if (prefix === "seg" || prefix === "spk") {
        return `${prefix}_${makeId("txn").slice(4)}`;
      }
      return makeId(prefix);
    }));
    const resolvers = new AnchorResolverRegistry();
    resolvers.registerWordLookup(createTranscriptWordLookup(workspace.sidecars));
    const engine = new OperationEngine(project.store.currentProject, {
      appVersion: this.#app.appVersion,
      committer: project.store,
      proposalStore: project.store,
      operationDispatcher: workspace.dispatcher,
      templateProvider: project.templates,
      anchorResolvers: resolvers,
      auditSink: this.#app.auditLog,
    });
    const proposal = resultValue(await compileFillerProposal(detected.candidates, {
      engine,
      selectedCandidateIds: detected.candidates.map(({ id }) => id),
      idFactory: makeId,
    }));
    this.publisher.publish({ kind: "proposal.updated", proposalId: proposal.id });
  }

  async #readAnalysis<Value>(filename: string): Promise<Value | null> {
    const path = join(this.#requireProject().store.root, "sidecars/analysis", filename);
    try {
      return JSON.parse(await readFile(path, "utf8")) as Value;
    } catch {
      return null;
    }
  }

  async #writeCaptureGuidance(job: JobRecord): Promise<void> {
    const project = this.#requireProject();
    const payload = job.payload as unknown as KeyQcJobPayload;
    const asset = project.store.currentProject.assets.find(({ id }) => id === payload.assetId);
    const report = await this.#readAnalysis<KeyQcReport>(`${payload.clipId}.keyqc.json`);
    if (asset === undefined || report === null) return;
    const probe = await probeMedia(isAbsolute(asset.path) ? asset.path : resolve(project.store.root, asset.path));
    await writeCaptureGuidanceReport(project.store.root, buildCaptureGuidanceReport({
      assetId: asset.id,
      keyIntendedFraction: 1,
      probe,
      qcReport: report,
    }));
  }

  #requireProject(): ProjectServices {
    if (this.#project === undefined) {
      throw {
        code: "E_PROJECT_NOT_OPEN",
        message: "Open a Guyditor project first.",
        affected: [],
        acceptedStateChanged: false,
        retry: "none",
      };
    }
    return this.#project;
  }

  #closeProject(): void {
    const project = this.#project;
    this.#project = undefined;
    if (project === undefined) return;
    project.backupScheduler?.close();
    project.unsubscribeJobs();
    void project.capture.close();
    project.jobs.close();
  }
}
