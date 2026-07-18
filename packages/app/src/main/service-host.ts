import { cpus } from "node:os";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  AnnotationService,
  JobQueue,
  OperationEngine,
  openProject as openCoreProject,
} from "../../../core/src/index.js";
import type {
  JobFilter,
  JobRecord,
  OperationBatchResult,
  OperationInput,
  ProjectStore,
  Result,
  TransactionRecord,
} from "../../../core/src/index.js";
import { MediaEngine, MlworkerSupervisor } from "../../../media/src/index.js";
import { TranscriptEngine } from "../../../transcript/src/index.js";
import { RenderService } from "../../../render/src/index.js";
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
}

interface ProjectServices {
  store: ProjectStore;
  operationEngine: OperationEngine;
  jobs: JobQueue;
  media: MediaEngine;
  transcript: TranscriptEngine;
  annotations: AnnotationService;
  render: RenderService;
  unsubscribeJobs: () => void;
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
  return result.applied.flatMap(({ inverse }) => inverse);
}

function publicJobStatus(job: JobRecord): JobStatus {
  return {
    jobId: job.jobId,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    ...(job.error === undefined ? {} : { error: job.error }),
    title: job.title,
    cancellable: job.cancellable,
    createdAt: job.createdAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.etaSeconds === undefined ? {} : { etaSeconds: job.etaSeconds }),
  };
}

async function history(store: ProjectStore): Promise<TransactionRecord[]> {
  const contents = await readFile(join(store.root, "history/transactions.jsonl"), "utf8");
  return contents.split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TransactionRecord);
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
}

export class WindowServiceHost {
  public readonly publisher: WindowEventPublisher;
  readonly #app: AppServiceHost;
  readonly #chooseProject: (() => Promise<string | undefined>) | undefined;
  #project: ProjectServices | undefined;
  #closed = false;

  public constructor(app: AppServiceHost, options: WindowServiceHostOptions) {
    this.#app = app;
    this.publisher = options.publisher;
    this.#chooseProject = options.chooseProject;
  }

  public async openProject(projectPath: string): Promise<ReturnType<WindowServiceHost["snapshot"]>> {
    if (this.#closed) throw new Error("Window service host is closed.");
    const opened = await openCoreProject(resolve(projectPath), { appVersion: this.#app.appVersion });
    const store = resultValue(opened);
    this.#closeProject();
    const { queue: jobs } = JobQueue.open(join(store.root, ".guyditor/jobs.sqlite"), {
      concurrency: this.#app.maxConcurrentJobs,
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
    const annotations = new AnnotationService({ appVersion: this.#app.appVersion });
    const operationEngine = new OperationEngine(store.currentProject, {
      appVersion: this.#app.appVersion,
      committer: store,
      auditSink: this.#app.auditLog,
    });
    const render = new RenderService({
      projectRoot: store.root,
      store,
      jobQueue: jobs,
      profilesRoot: this.#app.profilesRoot,
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
      }
    });
    this.#project = {
      store,
      operationEngine,
      jobs,
      media,
      transcript,
      annotations,
      render,
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
        };
      case "OperationEngine":
        return project === undefined ? undefined : {
          execute: (request: ExecuteRequest) => this.#execute(request),
        };
      case "JobQueue":
        return {
          list: (filter: JobFilter) => project?.jobs.list(filter).map(publicJobStatus) ?? [],
          cancel: ({ jobId }: { jobId: string }) =>
            publicJobStatus(resultValue(this.#requireProject().jobs.cancel(jobId))),
          retry: ({ jobId }: { jobId: string }) =>
            publicJobStatus(resultValue(this.#requireProject().jobs.retry(jobId))),
        };
      case "MediaEngine":
        return project === undefined ? undefined : {
          estimateCacheUse: () => project.media.estimateCacheUse(project.store),
          mlworkerState: () => ({
            state: this.#app.mlworker.state,
            capabilities: this.#app.mlworker.hello?.capabilities ?? [],
          }),
        };
      case "TranscriptEngine":
        return project === undefined ? undefined : {
          findWord: async ({ wordId }: { wordId: string }) =>
            resultValue(await project.transcript.findWord(wordId)),
          resolveWord: async ({ wordId }: { wordId: string }) =>
            resultValue(await project.transcript.resolveWord(wordId)),
        };
      case "AnnotationService":
        return project === undefined ? undefined : {
          list: async () => resultValue(await project.annotations.list(project.store)),
          get: async ({ annotationId }: { annotationId: string }) =>
            resultValue(await project.annotations.get(project.store, annotationId)),
        };
      case "RenderService":
        return project === undefined ? undefined : {
          cacheStats: () => project.render.cacheStats(),
          renderExport: (params: Parameters<RenderService["renderExport"]>[0]) =>
            project.render.renderExport(params),
          validateExport: ({ deliverableId, revision }: { deliverableId: string; revision: string }) =>
            project.render.validateExport(deliverableId, revision),
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
    let result: OperationBatchResult;
    if (request.intent === "undo") {
      result = resultValue(await project.operationEngine.undo());
    } else if (request.intent === "redo") {
      result = resultValue(await project.operationEngine.redo());
    } else {
      result = resultValue(await project.operationEngine.execute(request.operations, {
        baseRevision: project.operationEngine.currentProject.revision,
        origin: "ui",
        dryRun: false,
        recordUndo: true,
        ...(request.undoOf === undefined ? {} : { undoOf: request.undoOf }),
      }));
    }
    const txnId = result.transactionId;
    if (txnId === undefined) throw new Error("Accepted operation did not produce a transaction ID.");
    const revision = project.operationEngine.currentProject.revision;
    this.publisher.publish({ kind: "project.revision", revision });
    return { txnId, revision, inverse: inverseOperations(result) };
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
