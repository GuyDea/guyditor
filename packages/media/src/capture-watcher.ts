import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { watch } from "chokidar";
import type { FSWatcher } from "chokidar";

import { makeId } from "../../core/src/index.js";
import type {
  IdPrefix,
  JobQueue,
  ProjectStore,
  WatchFolderConfig,
} from "../../core/src/index.js";
import type { IngestJobResult, FollowUpJobKind, MediaEngine } from "./ingest.js";

const SESSION_DIRECTORY = /^([0-9]{8})-([0-9]{4})_([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const GUYDITOR_FILE = /^(cam|screen|mic|aux)(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?_([tT])([0-9]{2})(?:_([0-9]{2}))?\.[^.]+$/u;
const MARKER_FILE = /^(?:markers\.json|notes\.txt|.+\.markers\.json)$/u;

export interface CaptureStabilityPolicy {
  awaitWriteFinishMs: number;
  pollIntervalMs: number;
  verifyUnchangedMs: number;
}

export const CAPTURE_STABILITY_POLICY: CaptureStabilityPolicy = {
  awaitWriteFinishMs: 2_000,
  pollIntervalMs: 500,
  verifyUnchangedMs: 3_000,
};

export interface CaptureFileConvention {
  matched: boolean;
  role?: "cam" | "screen" | "mic" | "aux";
  label?: string;
  takeIndex?: number;
  part?: number;
}

export interface CaptureWatcherWarning {
  code: "E_CAPTURE_CONVENTION_UNMATCHED" | "E_CAPTURE_WATCH_FAILED";
  path: string;
  message: string;
}

export interface CaptureWatcherOptions {
  project: ProjectStore;
  media: Pick<MediaEngine, "ingest">;
  jobQueue: JobQueue;
  stability?: CaptureStabilityPolicy;
  idFactory?: (prefix: IdPrefix) => string;
  onIngested?: (assetIds: readonly string[]) => void;
  onTakeSeeded?: (
    assetId: string,
    take: { id: string; index: number },
  ) => Promise<void>;
  importMarkerFile?: (path: string, sessionId: string) => Promise<void>;
  onWarning?: (warning: CaptureWatcherWarning) => void;
}

interface PendingIngest {
  path: string;
  take: { id: string; index: number };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function globPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*/gu, "\u0000")
    .replace(/\*/gu, "[^/]*")
    .replace(/\u0000/gu, ".*")
    .replace(/\?/gu, ".");
  return new RegExp(`^${escaped}$`, "u");
}

function ignored(filePath: string, root: string, custom: readonly string[]): boolean {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  const base = path.basename(filePath);
  if (relative.split("/").some((part) => part.startsWith("."))) return true;
  if (base.endsWith(".part") || base.endsWith(".tmp")) return true;
  return custom.some((pattern) => {
    const target = pattern.includes("/") ? relative : base;
    return globPattern(pattern).test(target);
  });
}

function dateKey(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

export function parseCaptureFilename(filePath: string): CaptureFileConvention {
  const match = GUYDITOR_FILE.exec(path.basename(filePath).toLocaleLowerCase("en"));
  if (match === null) return { matched: false };
  return {
    matched: true,
    role: match[1] as NonNullable<CaptureFileConvention["role"]>,
    ...(match[2] === undefined ? {} : { label: match[2] }),
    takeIndex: Number(match[4]),
    ...(match[5] === undefined ? {} : { part: Number(match[5]) }),
  };
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) return filesBelow(candidate);
    return entry.isFile() ? [candidate] : [];
  }));
  return nested.flat();
}

function ingestResult(value: unknown): IngestJobResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const assets = (value as Record<string, unknown>)["assets"];
  if (!Array.isArray(assets) || !assets.every((asset) =>
    typeof asset === "object" && asset !== null && !Array.isArray(asset) &&
    typeof (asset as Record<string, unknown>)["assetId"] === "string")) return undefined;
  return value as unknown as IngestJobResult;
}

export class CaptureWatcher {
  readonly #project: ProjectStore;
  readonly #media: Pick<MediaEngine, "ingest">;
  readonly #queue: JobQueue;
  readonly #stability: CaptureStabilityPolicy;
  readonly #idFactory: (prefix: IdPrefix) => string;
  readonly #onIngested: ((assetIds: readonly string[]) => void) | undefined;
  readonly #onTakeSeeded: CaptureWatcherOptions["onTakeSeeded"];
  readonly #importMarkerFile: CaptureWatcherOptions["importMarkerFile"];
  readonly #onWarning: CaptureWatcherOptions["onWarning"];
  readonly #watchers: FSWatcher[] = [];
  readonly #sessionIds = new Map<string, string>();
  readonly #nextTakeBySession = new Map<string, number>();
  readonly #registered = new Set<string>();
  readonly #processing = new Set<string>();
  readonly #pendingJobs = new Map<string, PendingIngest>();
  #lastIngestJobId: string | undefined;
  #configs: WatchFolderConfig[] = [];
  readonly #unsubscribeJobs: () => void;

  public constructor(options: CaptureWatcherOptions) {
    this.#project = options.project;
    this.#media = options.media;
    this.#queue = options.jobQueue;
    this.#stability = options.stability ?? CAPTURE_STABILITY_POLICY;
    this.#idFactory = options.idFactory ?? makeId;
    this.#onIngested = options.onIngested;
    this.#onTakeSeeded = options.onTakeSeeded;
    this.#importMarkerFile = options.importMarkerFile;
    this.#onWarning = options.onWarning;
    for (const asset of this.#project.currentProject.assets) {
      const absolute = path.resolve(this.#project.root, asset.path);
      this.#registered.add(absolute);
      if (asset.session !== undefined) this.#sessionIds.set(path.dirname(absolute), asset.session);
    }
    this.#unsubscribeJobs = this.#queue.onChange(({ kind, job }) => {
      if (kind !== "job.state") return;
      const pending = this.#pendingJobs.get(job.jobId);
      if (pending === undefined || (job.state !== "done" && job.state !== "failed" && job.state !== "cancelled")) return;
      this.#pendingJobs.delete(job.jobId);
      if (job.state !== "done") {
        this.#processing.delete(pending.path);
        this.#warning("E_CAPTURE_WATCH_FAILED", pending.path, `Capture ingest ${job.jobId} ended as ${job.state}.`);
        return;
      }
      const result = ingestResult(job.payload);
      const assetIds = result?.assets.map(({ assetId }) => assetId) ?? [];
      this.#processing.delete(pending.path);
      this.#registered.add(pending.path);
      if (assetIds.length > 0) {
        void Promise.all(assetIds.map((assetId) =>
          this.#onTakeSeeded?.(assetId, pending.take),
        )).then(() => this.#onIngested?.(assetIds)).catch((error: unknown) => {
          this.#warning(
            "E_CAPTURE_WATCH_FAILED",
            pending.path,
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    });
  }

  public get configs(): readonly WatchFolderConfig[] {
    return structuredClone(this.#configs);
  }

  public async start(configs: readonly WatchFolderConfig[]): Promise<void> {
    await this.stop();
    this.#configs = configs.map((config) => structuredClone(config));
    for (const config of this.#configs) {
      const root = path.resolve(config.path);
      const watcher = watch(root, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: this.#stability.awaitWriteFinishMs,
          pollInterval: this.#stability.pollIntervalMs,
        },
        ignored: (candidate) => ignored(candidate, root, config.ignore ?? []),
      });
      watcher.on("add", (candidate) => {
        void this.#handleStable(path.resolve(candidate), config).catch((error: unknown) => {
          this.#processing.delete(path.resolve(candidate));
          this.#warning(
            "E_CAPTURE_WATCH_FAILED",
            candidate,
            error instanceof Error ? error.message : String(error),
          );
        });
      });
      watcher.on("error", (error) => {
        this.#warning(
          "E_CAPTURE_WATCH_FAILED",
          root,
          error instanceof Error ? error.message : String(error),
        );
      });
      this.#watchers.push(watcher);
      await new Promise<void>((resolveReady) => watcher.once("ready", () => resolveReady()));
    }
    await this.reconcile();
  }

  public async stop(): Promise<void> {
    const current = this.#watchers.splice(0);
    await Promise.all(current.map(async (watcher) => watcher.close()));
  }

  public close(): Promise<void> {
    this.#unsubscribeJobs();
    return this.stop();
  }

  public async reconcile(): Promise<void> {
    for (const config of this.#configs) {
      const root = path.resolve(config.path);
      const candidates = await filesBelow(root);
      candidates.sort((left, right) =>
        Number(MARKER_FILE.test(path.basename(left).toLocaleLowerCase("en"))) -
        Number(MARKER_FILE.test(path.basename(right).toLocaleLowerCase("en"))));
      for (const candidate of candidates) {
        if (ignored(candidate, root, config.ignore ?? [])) continue;
        await this.#handleStable(path.resolve(candidate), config);
      }
    }
  }

  async #verifyStable(candidate: string): Promise<void> {
    while (true) {
      const before = await stat(candidate);
      await sleep(this.#stability.verifyUnchangedMs);
      const after = await stat(candidate);
      if (before.size === after.size) return;
    }
  }

  async #sessionFor(
    candidate: string,
    config: WatchFolderConfig,
  ): Promise<string> {
    const root = path.resolve(config.path);
    const relativeParts = path.relative(root, candidate).split(path.sep);
    const sessionPart = config.convention === "guyditor"
      ? relativeParts.find((part) => SESSION_DIRECTORY.test(part))
      : undefined;
    const candidateStat = await stat(candidate);
    const key = sessionPart === undefined
      ? `${root}/unsorted-${dateKey(candidateStat.mtime)}`
      : path.join(root, sessionPart);
    const existing = this.#sessionIds.get(key);
    if (existing !== undefined) return existing;
    const id = this.#idFactory("ses");
    this.#sessionIds.set(key, id);
    return id;
  }

  #followUps(config: WatchFolderConfig): FollowUpJobKind[] {
    return [
      ...(config.autoJobs.proxy ? ["proxy.generate" as const] : []),
      "peaks.generate",
      ...(config.autoJobs.analysis ? ["vad" as const] : []),
      ...(config.autoJobs.transcription ? ["transcribe" as const] : []),
    ];
  }

  async #handleStable(candidate: string, config: WatchFolderConfig): Promise<void> {
    if (this.#registered.has(candidate) || this.#processing.has(candidate)) return;
    this.#processing.add(candidate);
    await this.#verifyStable(candidate);
    const sessionId = await this.#sessionFor(candidate, config);
    if (MARKER_FILE.test(path.basename(candidate).toLocaleLowerCase("en"))) {
      await this.#importMarkerFile?.(candidate, sessionId);
      this.#processing.delete(candidate);
      this.#registered.add(candidate);
      return;
    }
    if (!config.autoIngest) {
      this.#processing.delete(candidate);
      return;
    }
    const parsed = config.convention === "guyditor"
      ? parseCaptureFilename(candidate)
      : { matched: false };
    if (config.convention === "guyditor" && !parsed.matched) {
      this.#warning(
        "E_CAPTURE_CONVENTION_UNMATCHED",
        candidate,
        "File does not match the guyditor capture naming convention; ingesting into the session anyway.",
      );
    }
    const nextTake = this.#nextTakeBySession.get(sessionId) ?? 1;
    const takeIndex = parsed.takeIndex ?? nextTake;
    this.#nextTakeBySession.set(sessionId, Math.max(nextTake, takeIndex + 1));
    const takeId = this.#idFactory("tak");
    const job = this.#media.ingest(this.#project, {
      sources: [{
        path: candidate,
        session: sessionId,
        takes: [takeId],
        speechBearing: parsed.role !== "screen",
      }],
      via: "watch",
      followUpJobs: this.#followUps(config),
    }, this.#lastIngestJobId === undefined ? [] : [this.#lastIngestJobId]);
    this.#lastIngestJobId = job.jobId;
    this.#pendingJobs.set(job.jobId, {
      path: candidate,
      take: { id: takeId, index: takeIndex },
    });
  }

  #warning(code: CaptureWatcherWarning["code"], warningPath: string, message: string): void {
    this.#onWarning?.({ code, path: warningPath, message });
  }
}
