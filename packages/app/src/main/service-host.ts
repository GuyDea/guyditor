import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AnchorResolverRegistry,
  AnnotationService,
  buildAnnotationContext,
  convertTimeRounding,
  DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG,
  findJumpCutWarnings,
  JobQueue,
  makeId,
  OperationEngine,
  openProject as openCoreProject,
  parseTakeMarkerSidecar,
  planJumpCutConcealment,
  resolveAnchor,
  serializeTakeMarkerSidecar,
} from "../../../core/src/index.js";
import type {
  Asset,
  FaceTrackAvailability,
  JumpCutConcealmentConfig,
  JobFilter,
  JobOverview,
  JobRecord,
  OperationBatchResult,
  OperationCommitter,
  OperationInput,
  Proposal,
  ProjectStore,
  Result,
  TakeMarkerSidecar,
  TransactionRecord,
  WatchFolderConfig,
} from "../../../core/src/index.js";
import {
  buildCaptureGuidanceReport,
  CaptureWatcher,
  enqueueKeyQc,
  loadPeaks,
  MediaEngine,
  MlworkerSupervisor,
  probeMedia,
  proxyCachePaths,
  registerKeyQcExecutor,
  writeCaptureGuidanceReport,
} from "../../../media/src/index.js";
import type { KeyQcJobPayload, KeyQcReport } from "../../../media/src/index.js";
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
} from "../../../transcript/src/index.js";
import { assessSourceRangeContinuity } from "../../../transcript/src/continuity.js";
import type { TranscribeResult } from "../../../transcript/src/index.js";
import { loadTranscriptWorkspace } from "../../../transcript/src/operations.js";
import { RenderService, TemplateRegistry } from "../../../render/src/index.js";
import type { ExportReport } from "../../../render/src/index.js";
import { AuditLog, CostMeter } from "../../../agent/src/index.js";
import type { BudgetConfig } from "../../../agent/src/index.js";
import { CompositorModel } from "../../../compositor/src/index.js";

import type {
  ExecuteRequest,
  ExecuteResult,
  JobStatus,
  ServiceName,
} from "../shared/ipc.js";
import type { IpcService } from "./rpc.js";
import type { WindowEventPublisher } from "./events.js";

interface AppHostSettings {
  auditRetentionDays: number;
  budgets: BudgetConfig;
  maxConcurrentJobs: number | "auto";
}

export interface AppServiceHostOptions {
  appVersion: string;
  userDirectory: string;
  settings: AppHostSettings;
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
  revealPath?: (path: string) => void;
  openPath?: (path: string) => Promise<string>;
}

interface ProjectServices {
  store: ProjectStore;
  jobs: JobQueue;
  media: MediaEngine;
  capture: CaptureWatcher;
  transcript: TranscriptEngine;
  annotations: AnnotationService;
  compositor: CompositorModel;
  render: RenderService;
  templates: TemplateRegistry;
  unsubscribeJobs: () => void;
}

function resultValue<Value>(result: Result<Value>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function builtinsRoot(): string {
  const candidates = [
    resolve("templates"),
    resolve("../..", "templates"),
    resolve(import.meta.dirname, "../../../../templates"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
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
    .filter((name) => name.endsWith(".export-report.json"))
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
  readonly #options: AppServiceHostOptions;
  readonly #windows = new Set<WindowServiceHost>();

  public constructor(options: AppServiceHostOptions) {
    this.#options = options;
    this.auditLog = new AuditLog({
      userDir: options.userDirectory,
      retention: { retentionDays: options.settings.auditRetentionDays },
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
}

export class WindowServiceHost {
  public readonly publisher: WindowEventPublisher;
  readonly #app: AppServiceHost;
  readonly #chooseProject: (() => Promise<string | undefined>) | undefined;
  readonly #chooseMedia: (() => Promise<string[]>) | undefined;
  readonly #revealPath: ((path: string) => void) | undefined;
  readonly #openPath: ((path: string) => Promise<string>) | undefined;
  #project: ProjectServices | undefined;
  #closed = false;

  public constructor(app: AppServiceHost, options: WindowServiceHostOptions) {
    this.#app = app;
    this.publisher = options.publisher;
    this.#chooseProject = options.chooseProject;
    this.#chooseMedia = options.chooseMedia;
    this.#revealPath = options.revealPath;
    this.#openPath = options.openPath;
  }

  public async openProject(projectPath: string): Promise<ReturnType<WindowServiceHost["snapshot"]>> {
    if (this.#closed) throw new Error("Window service host is closed.");
    const opened = await openCoreProject(resolve(projectPath), { appVersion: this.#app.appVersion });
    const store = resultValue(opened);
    this.#closeProject();
    const annotations = new AnnotationService({ appVersion: this.#app.appVersion });
    const { queue: jobs } = JobQueue.open(join(store.root, ".guyditor/jobs.sqlite"), {
      concurrency: this.#app.maxConcurrentJobs,
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
      },
    });
    const media = new MediaEngine({ jobQueue: jobs, mlworker: this.#app.mlworker });
    registerKeyQcExecutor(jobs);
    const compositor = new CompositorModel({
      onKeyQcRun: ({ project, clipId, shotBoundaries }) => {
        const clip = project.sequences.flatMap(({ clips }) => clips).find(({ id }) => id === clipId);
        if (clip === undefined) throw new Error(`Clip ${clipId} does not exist.`);
        const asset = project.assets.find(({ id }) => id === clip.asset);
        const key = clip.effects?.find(({ kind }) => kind === "key");
        if (asset === undefined || key === undefined) {
          throw new Error(`Clip ${clipId} has no keyed source asset.`);
        }
        enqueueKeyQc(jobs, {
          projectRoot: store.root,
          sourcePath: isAbsolute(asset.path) ? asset.path : resolve(store.root, asset.path),
          clipId,
          assetId: asset.id,
          width: asset.video?.width ?? asset.image?.width ?? project.settings.timeline.width,
          height: asset.video?.height ?? asset.image?.height ?? project.settings.timeline.height,
          frameCount: Math.max(1, clip.source.out.frames - clip.source.in.frames),
          fps: clip.source.in.fps,
          keySettings: key.params as unknown as KeyQcJobPayload["keySettings"],
          shotBoundaries,
        });
      },
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
    const templates = new TemplateRegistry({
      builtinsRoot: builtinsRoot(),
      userRoot: join(this.#app.userDirectory, "templates"),
      projectRoot: join(store.root, "templates"),
      compiledRoot: join(this.#app.userDirectory, "templates", ".compiled"),
    });
    const render = new RenderService({
      projectRoot: store.root,
      store,
      jobQueue: jobs,
      profilesRoot: this.#app.profilesRoot,
      templateRegistry: templates,
    });
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
    this.#project = {
      store,
      jobs,
      media,
      capture,
      transcript,
      annotations,
      compositor,
      render,
      templates,
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
        };
      case "CompositorModel":
        return project === undefined ? undefined : {
          arrangements: () => project.compositor.arrangements(),
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
      case "RenderService":
        return project === undefined ? undefined : {
          cacheStats: () => project.render.cacheStats(),
          captionFrame: (params: Parameters<RenderService["captionFrame"]>[0]) =>
            project.render.captionFrame(params),
          graphicsFrame: (params: Parameters<RenderService["graphicsFrame"]>[0]) =>
            project.render.graphicsFrame(params),
          templateCatalog: () => project.render.templateCatalog(),
          templateFrame: (params: Parameters<RenderService["templateFrame"]>[0]) =>
            project.render.templateFrame(params),
          renderExport: (params: Parameters<RenderService["renderExport"]>[0]) =>
            project.render.renderExport(params),
          renderDiagnostic: (params: Parameters<RenderService["renderDiagnostic"]>[0]) =>
            project.render.renderDiagnostic(params),
          validateExport: ({ deliverableId, revision }: { deliverableId: string; revision: string }) =>
            project.render.validateExport(deliverableId, revision),
          exportReport: () => latestExportReport(project.store),
        };
      case "AuditLog":
        return {
          readSession: ({ sessionId }: { sessionId: string }) => this.#app.auditLog.readSession(sessionId),
        };
      case "CostMeter":
        return {
          status: () => this.#app.costMeter.status(project?.store.currentProject.project.id ?? "unopened"),
        };
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
      }));
    }
    const txnId = result.transactionId;
    if (txnId === undefined) throw new Error("Accepted operation did not produce a transaction ID.");
    const revision = project.store.currentProject.revision;
    this.publisher.publish({ kind: "project.revision", revision });
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
    const current = resultValue(await project.store.readProposal(proposalId));
    const proposal = current.operations.some(({ op }) => op === "pickup.splice")
      ? resultValue(await project.transcript.acceptProposal(
          project.store,
          proposalId,
          "creator",
        ))
      : resultValue(await this.#coreEngine(project, undefined, {
          commit: (model, transaction) =>
            project.annotations.commitAccepted(project.store, model, transaction),
        }).acceptProposal(
          proposalId,
          "creator",
        ));
    this.publisher.publish({ kind: "proposal.updated", proposalId });
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
    project.unsubscribeJobs();
    void project.capture.close();
    project.jobs.close();
  }
}
