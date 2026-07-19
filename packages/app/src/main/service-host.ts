import { cpus } from "node:os";
import { existsSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AnchorResolverRegistry,
  AnnotationService,
  buildAnnotationContext,
  JobQueue,
  makeId,
  OperationEngine,
  openProject as openCoreProject,
} from "../../../core/src/index.js";
import type {
  JobFilter,
  JobOverview,
  JobRecord,
  OperationBatchResult,
  OperationCommitter,
  OperationInput,
  Proposal,
  ProjectStore,
  Result,
  TransactionRecord,
} from "../../../core/src/index.js";
import {
  loadPeaks,
  MediaEngine,
  MlworkerSupervisor,
  proxyCachePaths,
} from "../../../media/src/index.js";
import {
  compileFillerProposal,
  createAnnotationTranscriptSource,
  createTranscriptWordLookup,
  enqueueFillerDetection,
  parseFillerDetectionResult,
  parseTranscriptSidecar,
  registerFillerDetectionExecutor,
  TranscriptEngine,
} from "../../../transcript/src/index.js";
import { loadTranscriptWorkspace } from "../../../transcript/src/operations.js";
import { RenderService, TemplateRegistry } from "../../../render/src/index.js";
import type { ExportReport } from "../../../render/src/index.js";
import { AuditLog, CostMeter } from "../../../agent/src/index.js";
import type { BudgetConfig } from "../../../agent/src/index.js";

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
  transcript: TranscriptEngine;
  annotations: AnnotationService;
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
    this.#project = {
      store,
      jobs,
      media,
      transcript,
      annotations,
      render,
      templates,
      unsubscribeJobs,
    };
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
          acceptProposal: ({ proposalId }: { proposalId: string }) =>
            this.#acceptProposal(proposalId),
          rejectProposal: ({ proposalId }: { proposalId: string }) =>
            this.#rejectProposal(proposalId),
          supersedeProposal: ({ proposalId, instruction }: {
            proposalId: string;
            instruction: string;
          }) => this.#supersedeProposal(proposalId, instruction),
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
      op.startsWith("transcript.") || op.startsWith("caption."));
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
      auditSink: this.#app.auditLog,
      ...(anchorResolvers === undefined ? {} : { anchorResolvers }),
    });
  }

  async #acceptProposal(proposalId: string): Promise<Proposal> {
    const project = this.#requireProject();
    const proposal = resultValue(await this.#coreEngine(project, undefined, {
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
    project.jobs.close();
  }
}
