import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AnchorResolverRegistry,
  AnnotationService,
  absoluteSeconds,
  buildAnnotationContext,
  DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG,
  findJumpCutWarnings,
  formatRevision,
  JobQueue,
  makeId,
  OperationEngine,
  openProject as openCoreProject,
  parseRevision,
  parseRestylePlan,
  planJumpCutConcealment,
  resolveAnchor,
} from "../../../core/src/index.js";
import type {
  FaceTrackAvailability, JumpCutConcealmentConfig, JobFilter, JobOverview, JobRecord,
  OperationBatchResult, OperationCommitter, OperationInput, Proposal, ProjectStore, Result,
  RestyleFrameRange, RestylePlan, RestyleSeamTreatment, RightsPolicy, SidecarRef,
  WatchFolderConfig,
} from "../../../core/src/index.js";
import {
  buildCaptureGuidanceReport,
  CaptureWatcher,
  createSubjectTrackAnalysis,
  loadPeaks,
  MediaEngine,
  MLWORKER_LANE,
  MlworkerSupervisor,
  probeMedia,
  proxyCachePaths,
  registerKeyQcExecutor,
  createStoragePreflight,
  parseSubjectTrackAnalysis,
  subjectTrackSidecarPath,
  TimelineFrameService,
  writeSubjectTrackAnalysis,
  writeCaptureGuidanceReport,
  StorageAccountant,
} from "../../../media/src/index.js";
import type { KeyQcJobPayload, KeyQcReport, MlworkerTrackResult, SubjectTrackAnalysis } from "../../../media/src/index.js";
import {
  createAnnotationTranscriptSource,
  createTranscriptWordLookup,
  detectSpokenTakeMarkers,
  enqueueFillerDetection,
  planPickupSplice,
  registerFillerDetectionExecutor,
  TranscriptEngine,
} from "../../../transcript/src/index.js";
import { assessSourceRangeContinuity } from "../../../transcript/src/continuity.js";
import type { TranscribeResult } from "../../../transcript/src/index.js";
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
  generateChapterList,
  loadPlatformProfile,
  parseFramingSidecar,
  PublishService,
  resolveDerivationSources,
  writeCandidateCache,
  writeFramingSidecar,
} from "../../../deliver/src/index.js";
import type {
  DerivationSelection,
  OtioExportOptions,
  PublishMetadata,
  PublishFileResult,
  ShortCandidate,
} from "../../../deliver/src/index.js";

import type {
  ExecuteRequest,
  ExecuteResult,
  ServiceName,
} from "../shared/ipc.js";
import type { IpcService } from "./rpc.js";
import type { WindowEventPublisher } from "./events.js";
import {
  deliverableTranscripts,
  publishTranscript,
} from "./deliverable-transcript.js";
import { validateExportWithRights } from "./export-validation.js";
import {
  generationService,
  registerBuiltInGenerationAdapters,
} from "./generation-service.js";
import { skillRegistryService } from "./skill-service.js";
import { AssemblyService } from "./assembly-service.js";
import { isRebaseSafeAssemblyProposal } from "./assembly-proposal.js";
import { registerAssemblyPrepareExecutor } from "./assembly-prepare.js";
import { publicJobStatus } from "./job-status.js";
import { TakeComparisonService } from "./take-comparison-service.js";
import {
  createRecoveryServices,
  recoveryService,
} from "./recovery-service.js";
import { ProjectWorkspaceStateStore } from "./project-workspace-state.js";
import { registerDerivedSidecar as registerDerivedSidecarFor } from "./derived-sidecar.js";
import { planningSignals } from "./restyle-planning-signals.js";
import { createFillerProposal } from "./filler-follow-up.js";
import type { ProjectServices } from "./project-services.js";
import { createProjectDialog } from "./project-creation.js";
import { history, transcriptSidecars } from "./project-readers.js";
import {
  groupJumpCutProposalOperations,
  jumpCutProposalEvidence,
} from "./jump-cut-proposal-operations.js";
import { MatteService } from "./matte-service.js";
import type { MatteProjectGuard } from "./matte-service.js";
import { prepareMatteCommit } from "./matte-prepared-commit.js";
import { OtioService } from "./otio-service.js";
import { CaptureProjectMetadata } from "./capture-project-metadata.js";
import { ProjectContextCoordinator } from "./project-context-coordinator.js";
import { TaskScope } from "./task-scope.js";
import {
  createProjectTemplateServices,
  templateAuthoringIpc,
} from "./template-authoring-service.js";
import { AiSettingsService } from "./ai-settings-service.js";
import { WorkspaceLayoutService } from "./workspace-layout-service.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import type { AiSettings, UserSettings } from "./settings.js";

interface AppHostSettings {
  auditRetentionDays: number;
  budgets: BudgetConfig;
  maxConcurrentJobs: number | "auto";
  rightsRequirementLevel?: RightsPolicy["requirementLevel"];
  restyleAdapter?: KlingAdapterConfig & { enabled: boolean };
  ai?: AiSettings;
  externalCalls?: UserSettings["network"]["externalCalls"];
  encryptionAvailable?: boolean;
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
  chooseNewProject?: () => Promise<string | undefined>;
  chooseMedia?: () => Promise<string[]>;
  chooseContextFiles?: () => Promise<string[]>;
  chooseTemplate?: () => Promise<string | undefined>;
  revealPath?: (path: string) => void;
  openPath?: (path: string) => Promise<string>;
  afterMattePrepare?: (guard: MatteProjectGuard) => Promise<void>;
  afterProjectBoundStart?: (projectRoot: string) => Promise<void>;
  afterProjectFollowUpStart?: (
    projectRoot: string,
    kind: string,
  ) => Promise<void>;
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

export class AppServiceHost {
  public readonly auditLog: AuditLog;
  public readonly costMeter: CostMeter;
  public readonly mlworker: MlworkerSupervisor;
  public readonly credentials: CredentialStore;
  public readonly aiSettings: AiSettingsService;
  public readonly workspaceLayout: WorkspaceLayoutService;
  public readonly skillRegistry: SkillRegistry;
  readonly #options: AppServiceHostOptions;
  readonly #windows = new Set<WindowServiceHost>();

  public constructor(options: AppServiceHostOptions) {
    this.#options = options;
    this.credentials = options.credentials ?? new FileCredentialStore({
      userDir: options.userDirectory,
    });
    this.workspaceLayout = new WorkspaceLayoutService({ userDirectory: options.userDirectory });
    this.aiSettings = new AiSettingsService({
      userDirectory: options.userDirectory,
      credentials: this.credentials,
      initial: options.settings.ai ?? structuredClone(DEFAULT_SETTINGS.ai),
      externalCalls: options.settings.externalCalls ?? DEFAULT_SETTINGS.network.externalCalls,
      encryptionAvailable: options.settings.encryptionAvailable ?? false,
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
  readonly #chooseNewProject: (() => Promise<string | undefined>) | undefined;
  readonly #chooseMedia: (() => Promise<string[]>) | undefined;
  readonly #chooseContextFiles: (() => Promise<string[]>) | undefined;
  readonly #chooseTemplate: (() => Promise<string | undefined>) | undefined;
  readonly #revealPath: ((path: string) => void) | undefined;
  readonly #openPath: ((path: string) => Promise<string>) | undefined;
  readonly #afterMattePrepare: WindowServiceHostOptions["afterMattePrepare"];
  readonly #afterProjectFollowUpStart:
    WindowServiceHostOptions["afterProjectFollowUpStart"];
  readonly #projectContext: ProjectContextCoordinator;
  #project: ProjectServices | undefined;
  #closed = false;

  public constructor(app: AppServiceHost, options: WindowServiceHostOptions) {
    this.#app = app;
    this.publisher = options.publisher;
    this.#chooseProject = options.chooseProject;
    this.#chooseNewProject = options.chooseNewProject;
    this.#chooseMedia = options.chooseMedia;
    this.#chooseContextFiles = options.chooseContextFiles;
    this.#chooseTemplate = options.chooseTemplate;
    this.#revealPath = options.revealPath;
    this.#openPath = options.openPath;
    this.#afterMattePrepare = options.afterMattePrepare;
    this.#afterProjectFollowUpStart = options.afterProjectFollowUpStart;
    this.#projectContext = new ProjectContextCoordinator({
      activeProject: () => this.#project,
      createEngine: (project) => this.#coreEngine(project),
      afterStart: async (store) => { await options.afterProjectBoundStart?.(store.root); },
    });
  }

  public openProject(
    projectPath: string,
    options: { initializeWorkspace?: boolean } = {},
  ): Promise<ReturnType<WindowServiceHost["snapshot"]>> {
    return this.#projectContext.serialize(() => this.#openProject(projectPath, options));
  }

  async #openProject(
    projectPath: string,
    options: { initializeWorkspace?: boolean },
  ): Promise<ReturnType<WindowServiceHost["snapshot"]>> {
    if (this.#closed) throw new Error("Window service host is closed.");
    const path = resolve(projectPath);
    if (this.#project !== undefined && resolve(this.#project.store.root) === path) {
      await this.#deactivateProject();
    }
    const opened = await openCoreProject(path, { appVersion: this.#app.appVersion });
    const store = resultValue(opened);
    await this.#deactivateProject();
    const workspace = new ProjectWorkspaceStateStore(store.root);
    if (options.initializeWorkspace === true) {
      await workspace.initialize(store.currentProject);
    }
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
    const registerDerivedSidecar = (sidecar: SidecarRef): Promise<void> =>
      registerDerivedSidecarFor({
        appVersion: this.#app.appVersion,
        auditSink: this.#app.auditLog,
      }, store, sidecar);
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
    }, { lane: MLWORKER_LANE });
    const media = new MediaEngine({
      jobQueue: jobs,
      mlworker: this.#app.mlworker,
      project: store,
    });
    const timelineFrames = new TimelineFrameService();
    registerKeyQcExecutor(jobs);
    const matte = new MatteService({
      store,
      jobs,
      mlworker: this.#app.mlworker,
      prepare: (request, guard) => {
        const project = this.#projectContext.require(store);
        return prepareMatteCommit({
          request,
          guard,
          project,
          activeProject: () => this.#project,
          createEngine: (committer) => this.#coreEngine(project, undefined, committer),
          onAccepted: (revision) => {
            project.backupScheduler?.acceptedRevision();
            this.publisher.publish({ kind: "project.revision", revision });
          },
        });
      },
      ...(this.#afterMattePrepare === undefined
        ? {}
        : { afterPrepare: this.#afterMattePrepare }),
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
        createProposal: (input) => this.#projectContext.engine(store).createProposal(input),
      },
      adapters,
      jobs,
      costMeter: this.#app.costMeter,
    });
    const generation = new GenerationExecutionService({
      projectStore: store,
      operationEngine: {
        createProposal: (input) => this.#projectContext.engine(store).createProposal(input),
      },
      adapters,
      jobs,
      costMeter: this.#app.costMeter,
    });
    restyleRuntime.service = restyle;
    const openedProject: { value?: ProjectServices } = {};
    const followUps = new TaskScope();
    const runFollowUp = (
      job: JobRecord,
      task: (project: ProjectServices, job: JobRecord) => Promise<void>,
    ): void => {
      void followUps.run(async () => {
        const project = openedProject.value;
        if (project === undefined) {
          throw new Error("Project services are not initialized.");
        }
        await this.#afterProjectFollowUpStart?.(project.store.root, job.kind);
        await task(project, job);
      }).catch(() => undefined);
    };
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
          runFollowUp(job, (project, completed) => createFillerProposal({
            appVersion: this.#app.appVersion,
            auditSink: this.#app.auditLog,
            publish: (event) => this.publisher.publish(event),
          }, project, completed));
        }
        if (job.state === "done" && job.kind === "transcribe") {
          runFollowUp(job, (project, completed) =>
            this.#createTranscriptFromJob(project, completed));
        }
        if (job.state === "done" && job.kind === "keyqc.analyze") {
          runFollowUp(job, (project, completed) =>
            this.#writeCaptureGuidance(project, completed));
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
    const captureMetadata = new CaptureProjectMetadata({
      store,
      engine: () => {
        if (openedProject.value === undefined) {
          throw new Error("Capture project services are not initialized.");
        }
        return this.#coreEngine(openedProject.value);
      },
      publishRevision: (revision) =>
        this.publisher.publish({ kind: "project.revision", revision }),
    });
    const capture = new CaptureWatcher({
      project: store,
      media,
      jobQueue: jobs,
      onTakeSeeded: (assetId, take) => captureMetadata.seedTake(assetId, take),
      importMarkerFile: (path, sessionId) =>
        captureMetadata.importMarkerFile(path, sessionId),
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
      operationEngine: () => this.#projectContext.engine(store),
      onRevision: (revision) =>
        this.publisher.publish({ kind: "project.revision", revision }),
      onProposal: (proposalId) =>
        this.publisher.publish({ kind: "proposal.updated", proposalId }),
    });
    const assembly = new AssemblyService({
      project: { jobs, captureMetadata, annotations },
      store,
      engine: () => this.#projectContext.engine(store),
      aiSettings: this.#app.aiSettings,
      auditLog: this.#app.auditLog,
      costMeter: this.#app.costMeter,
      appVersion: this.#app.appVersion,
      publish: (event) => this.publisher.publish(event),
      pickFiles: () => this.#chooseContextFiles?.() ?? Promise.resolve([]),
    });
    registerAssemblyPrepareExecutor(jobs, assembly.prepareDeps());
    openedProject.value = {
      store,
      workspace,
      jobs,
      media,
      timelineFrames,
      capture,
      captureMetadata,
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
      assembly,
      followUps,
      ...recovery,
      unsubscribeJobs,
    };
    try {
      await capture.start(store.currentProject.watchFolders ?? []);
      this.#project = openedProject.value;
      return this.snapshot();
    } catch (error: unknown) {
      await this.#disposeProject(openedProject.value).catch(() => undefined);
      throw error;
    }
  }

  public resolveService(service: ServiceName): IpcService | undefined {
    const project = this.#project;
    const resolved = this.#resolveService(service, project);
    if (
      resolved === undefined ||
      project === undefined ||
      service === "ProjectStore" ||
      service === "AuditLog" ||
      service === "CostMeter" ||
      service === "AiSettings" ||
      service === "WorkspaceLayout"
    ) return resolved;
    return this.#bindProjectService(project, resolved);
  }

  #resolveService(
    service: ServiceName,
    project: ProjectServices | undefined,
  ): IpcService | undefined {
    switch (service) {
      case "ProjectStore":
        return {
          createDialog: () => createProjectDialog(
            this.#chooseNewProject,
            (path) => this.openProject(path, { initializeWorkspace: true }),
            this.#app.appVersion,
            this.#app.profilesRoot,
          ),
          openDialog: async () => {
            const selected = await this.#chooseProject?.();
            return selected === undefined ? null : this.openProject(selected);
          },
          pickTemplatePackage: async () => await this.#chooseTemplate?.() ?? null,
          open: ({ path }: { path: string }) => this.openProject(path),
          getSnapshot: () => this.snapshot(),
          getWorkspaceState: ({ projectPath }: { projectPath: string }) => {
            const current = this.#projectContext.requirePath(projectPath);
            return current.workspace.load(current.store.currentProject);
          },
          setActiveDeliverable: ({ projectPath, deliverableId }: {
            projectPath: string;
            deliverableId: string;
          }) => {
            const current = this.#projectContext.requirePath(projectPath);
            return current.workspace.setActiveDeliverable(
              current.store.currentProject,
              deliverableId,
            );
          },
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
          resolveTimelineFrames: async ({
            assetId,
            sourceFrames,
            height,
          }: {
            assetId: string;
            sourceFrames: number[];
            height: 96;
          }) => {
            const asset = project.store.currentProject.assets.find(({ id }) => id === assetId);
            if (asset === undefined) throw new Error(`Asset ${assetId} does not exist.`);
            const frames = await project.timelineFrames.resolve(
              project.store.root,
              asset,
              sourceFrames,
              height,
            );
            return frames.map(({ sourceFrame, path }) => ({
              sourceFrame,
              url: path === null ? null : pathToFileURL(path).href,
            }));
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
          listTakes: () => project.captureMetadata.list(),
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
            project,
            `${clipId}.keyqc.json`,
          ),
          captureGuidance: ({ assetId }: { assetId: string }) => this.#readAnalysis(
            project,
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
      case "Assembly":
        return project === undefined ? undefined : project.assembly.surface();
      case "TemplateAuthoringService":
        return project === undefined
          ? undefined
          : templateAuthoringIpc(project.templateAuthoring);
      case "AiSettings":
        return this.#app.aiSettings.surface();
      case "WorkspaceLayout":
        return this.#app.workspaceLayout.surface();
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

  #bindProjectService(
    project: ProjectServices,
    service: IpcService,
  ): IpcService {
    return Object.fromEntries(Object.entries(service).map(([name, implementation]) => [
      name,
      typeof implementation !== "function"
        ? implementation
        : async (...args: unknown[]) => this.#projectContext.run(
            project.store,
            async () => Reflect.apply(implementation, service, args) as unknown,
          ),
    ]));
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

  public close(): Promise<void> {
    return this.#projectContext.serialize(async () => {
      if (this.#closed) return;
      this.#closed = true;
      await this.#project?.backupScheduler?.quit().catch(() => undefined);
      await this.#deactivateProject();
      this.publisher.dispose();
      this.#app.forgetWindow(this);
    });
  }

  async #execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const project = this.#requireProject();
    return this.#projectContext.run(
      project.store,
      (current) => this.#executeInProject(current, request),
    );
  }

  async #executeInProject(
    project: ProjectServices,
    request: ExecuteRequest,
  ): Promise<ExecuteResult> {
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
      (isRebaseSafeAssemblyProposal(current, project.store.currentProject) || current.operations.every(({ op }) =>
        op === "restyle.segment.approve" ||
        op === "clip.split" ||
        op === "clip.punchin.set" ||
        op === "clip.source.switch" ||
        op === "transition.set"))
    ) {
      const rebased = resultValue(await this.#coreEngine(project).supersedeProposal(
        current.id,
        {
          operations: current.operations.map(({ op, params }) => ({ op, params })),
          instruction: structuredClone(current.instruction),
          actor: structuredClone(current.actor),
          ...(current.sessionId === undefined ? {} : { sessionId: current.sessionId }),
          reason: {
            text: `${current.reason.text} Rebased over independently approved proposal edits.`,
            sources: [...current.reason.sources],
          },
          addresses: [...current.addresses],
          ...(current.warnings === undefined
            ? {}
            : { warnings: structuredClone(current.warnings) }),
          ...(current.divergence === undefined ? {} : { divergence: current.divergence }),
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
    await project.assembly.onProposalAccepted(proposalId);
    return proposal;
  }

  async #rejectProposal(proposalId: string): Promise<Proposal> {
    const project = this.#requireProject();
    const proposal = resultValue(await this.#coreEngine(project).rejectProposal(
      proposalId,
      "creator",
    ));
    this.publisher.publish({ kind: "proposal.updated", proposalId });
    await project.assembly.onProposalRejected(proposalId);
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
      ...(current.divergence === undefined ? {} : { divergence: current.divergence }),
    }));
    this.publisher.publish({ kind: "proposal.updated", proposalId });
    this.publisher.publish({ kind: "proposal.updated", proposalId: proposal.id });
    await project.assembly.onProposalRejected(proposalId);
    return proposal;
  }

  async #proposeJumpCutConcealment(params: {
    sequenceId: string;
    beforeClipId?: string;
    config?: Partial<JumpCutConcealmentConfig>;
    faceTracks?: Record<string, FaceTrackAvailability>;
  }): Promise<ReturnType<typeof planJumpCutConcealment> & {
    proposal?: Proposal;
    proposals?: Proposal[];
  }> {
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
    const proposals: Proposal[] = [];
    for (const group of groupJumpCutProposalOperations(
      project.store.currentProject,
      plan.operations,
    )) {
      const evidence = jumpCutProposalEvidence(group, plan.reasons, warnings);
      const proposal = resultValue(await this.#coreEngine(project).createProposal({
        operations: group.operations,
        instruction: {
          kind: "skill-policy",
          text: "Review jump-cut concealment (policy supplied directly; editorial-skill integration lands in M4)",
        },
        actor: { kind: "tool", id: "assist.jumpcuts.conceal" },
        reason: {
          text: "Conceal flagged same-source jump cuts without silently changing the accepted timeline.",
          sources: evidence.sources,
        },
        addresses: [],
        warnings: evidence.warnings,
        ...(group.divergence === undefined ? {} : { divergence: group.divergence }),
      }));
      proposals.push(proposal);
      this.publisher.publish({ kind: "proposal.updated", proposalId: proposal.id });
    }
    return {
      ...plan,
      ...(proposals.length === 1 ? { proposal: proposals[0] } : {}),
      proposals,
    };
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

  async #createTranscriptFromJob(
    project: ProjectServices,
    job: JobRecord,
  ): Promise<void> {
    const parsed = transcriptionFromJob(job);
    if (parsed === undefined) return;
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
      const timing = project.captureMetadata.timing(asset.id);
      const spoken = detectSpokenTakeMarkers(created.value.sidecar, {
        fps: timing.fps,
        idFactory: makeId,
      });
      if (spoken.length > 0) {
        await project.captureMetadata.addMarkers(asset.id, spoken);
      }
    }
    this.publisher.publish({
      kind: "project.revision",
      revision: project.store.currentProject.revision,
    });
  }

  async #readAnalysis<Value>(
    project: ProjectServices,
    filename: string,
  ): Promise<Value | null> {
    const path = join(project.store.root, "sidecars/analysis", filename);
    try {
      return JSON.parse(await readFile(path, "utf8")) as Value;
    } catch {
      return null;
    }
  }

  async #writeCaptureGuidance(
    project: ProjectServices,
    job: JobRecord,
  ): Promise<void> {
    const payload = job.payload as unknown as KeyQcJobPayload;
    const asset = project.store.currentProject.assets.find(({ id }) => id === payload.assetId);
    const report = await this.#readAnalysis<KeyQcReport>(
      project,
      `${payload.clipId}.keyqc.json`,
    );
    if (asset === undefined || report === null) return;
    const probe = await probeMedia(isAbsolute(asset.path) ? asset.path : resolve(project.store.root, asset.path));
    await writeCaptureGuidanceReport(project.store.root, buildCaptureGuidanceReport({
      assetId: asset.id,
      keyIntendedFraction: 1,
      probe,
      qcReport: report,
    }));
  }

  #requireProject(): ProjectServices { return this.#projectContext.current(); }

  async #deactivateProject(): Promise<void> {
    const project = this.#project;
    if (project === undefined) return;
    await this.#projectContext.deactivate(project, () => this.#closeProject());
  }

  async #closeProject(): Promise<void> {
    const project = this.#project;
    if (project === undefined) return;
    try {
      await this.#disposeProject(project);
    } finally {
      if (this.#project === project) this.#project = undefined;
    }
  }

  async #disposeProject(project: ProjectServices): Promise<void> {
    project.backupScheduler?.close();
    project.unsubscribeJobs();
    try {
      await project.followUps.close();
      await project.capture.close();
    } finally {
      project.jobs.close();
    }
  }
}
