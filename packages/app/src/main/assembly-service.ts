import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { makeId } from "../../../core/src/index.js";
import type {
  IdFactory,
  JobStatus,
  OperationEngine,
  ProjectStore,
} from "../../../core/src/index.js";
import type { AuditLog, CostMeter, createLlmAdapter } from "../../../agent/src/index.js";
import {
  assemblySidecarRef,
  createAssemblySession,
  parseAssemblySession,
  serializeAssemblySession,
} from "../../../transcript/src/index.js";
import type { AssemblyEvidence, AssemblySession } from "../../../transcript/src/index.js";

import type { GdEventWithoutSeq } from "../shared/ipc.js";
import type { AiSettingsService } from "./ai-settings-service.js";
import type { PrepareDeps } from "./assembly-prepare.js";
import { registerDerivedSidecar } from "./derived-sidecar.js";
import { publicJobStatus } from "./job-status.js";
import { transcriptSidecars } from "./project-readers.js";
import type { ProjectServices } from "./project-services.js";

export type AssemblySessionView = Omit<AssemblySession, "evidence"> & {
  evidence: Omit<AssemblyEvidence, "text"> | null;
};

export interface AssemblyServiceOptions {
  project: Pick<ProjectServices, "jobs" | "captureMetadata">;
  store: ProjectStore;
  engine: () => Pick<OperationEngine, "createProposal" | "execute">;
  aiSettings: AiSettingsService;
  auditLog: AuditLog;
  costMeter: CostMeter;
  appVersion: string;
  publish: (event: GdEventWithoutSeq) => void;
  now?: () => Date;
  idFactory?: IdFactory;
  adapterFactory?: typeof createLlmAdapter;
  environment?: NodeJS.ProcessEnv;
}

const SESSION_ID = /^asb_[a-z2-7]{10}$/u;
const PREPARABLE: readonly AssemblySession["status"][] = ["created", "failed", "conversing"];

function invalidInput(detail: string): Error {
  return new Error(`E_ASSEMBLY_INVALID_INPUT: ${detail}`);
}

export function assemblyView(session: AssemblySession): AssemblySessionView {
  if (session.evidence === null) return { ...session, evidence: null };
  const { text, ...evidence } = session.evidence;
  void text;
  return { ...session, evidence };
}

export class AssemblyService {
  readonly #options: AssemblyServiceOptions;
  #queue: Promise<unknown> = Promise.resolve();

  public constructor(options: AssemblyServiceOptions) {
    this.#options = options;
  }

  #serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #sessionPath(id: string): string {
    return join(this.#options.store.root, "sidecars/assembly", `${id}.json`);
  }

  async #read(id: string): Promise<AssemblySession> {
    if (!SESSION_ID.test(id)) throw new Error(`E_ASSEMBLY_NOT_FOUND: no assembly session ${id}`);
    let text: string;
    try {
      text = await readFile(this.#sessionPath(id), "utf8");
    } catch {
      throw new Error(`E_ASSEMBLY_NOT_FOUND: no assembly session ${id}`);
    }
    return parseAssemblySession(text);
  }

  /** Rewrites the session file and re-registers the sidecar (registering an existing name replaces it). */
  #write(session: AssemblySession): Promise<void> {
    return this.#serialized(async () => {
      const next: AssemblySession = { ...session, updatedAt: (this.#options.now?.() ?? new Date()).toISOString() };
      const text = serializeAssemblySession(next);
      await mkdir(join(this.#options.store.root, "sidecars/assembly"), { recursive: true });
      await writeFile(this.#sessionPath(next.id), text, "utf8");
      await registerDerivedSidecar(
        { appVersion: this.#options.appVersion, auditSink: this.#options.auditLog },
        this.#options.store,
        assemblySidecarRef(next, text),
      );
      this.#options.publish({ kind: "assembly.updated", sessionId: next.id });
    });
  }

  public prepareDeps(): PrepareDeps {
    return {
      store: this.#options.store,
      readSession: (id) => this.#read(id),
      writeSession: (session) => this.#write(session),
      transcripts: () => transcriptSidecars(this.#options.store),
      markers: async (assetId) =>
        (await this.#options.project.captureMetadata.list())
          .filter((sidecar) => sidecar.assetId === assetId)
          .flatMap(({ markers }) => markers),
      jobs: this.#options.project.jobs,
    };
  }

  public async list(): Promise<AssemblySessionView[]> {
    const refs = this.#options.store.currentProject.sidecars
      .filter(({ schema }) => schema === "guyditor.assembly/v1");
    const sessions = await Promise.all(refs.map(async ({ path }) =>
      parseAssemblySession(await readFile(join(this.#options.store.root, path), "utf8"))));
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(assemblyView);
  }

  public async get(sessionId: string): Promise<AssemblySessionView> {
    return assemblyView(await this.#read(sessionId));
  }

  public async create(input: { assetIds: string[]; scriptPath?: string }): Promise<AssemblySessionView> {
    const { store } = this.#options;
    if (input.assetIds.length === 0) throw invalidInput("at least one asset is required");
    for (const assetId of input.assetIds) {
      const asset = store.currentProject.assets.find(({ id }) => id === assetId);
      if (asset === undefined) throw invalidInput(`asset ${assetId} does not exist`);
      if (asset.kind !== "video" && asset.kind !== "audio") {
        throw invalidInput(`asset ${assetId} is ${asset.kind}, not speech-bearing`);
      }
    }
    let scriptBytes: Buffer | undefined;
    if (input.scriptPath !== undefined) {
      try {
        scriptBytes = await readFile(input.scriptPath);
      } catch {
        throw invalidInput(`script ${input.scriptPath} is not a readable file`);
      }
    }
    const id = (this.#options.idFactory ?? makeId)("asb");
    let script: AssemblySession["inputs"]["script"] = null;
    if (scriptBytes !== undefined && input.scriptPath !== undefined) {
      const path = `sidecars/scripts/${id}.script.md`;
      await mkdir(join(store.root, "sidecars/scripts"), { recursive: true });
      await writeFile(join(store.root, path), scriptBytes);
      script = {
        name: basename(input.scriptPath),
        path,
        sha256: createHash("sha256").update(scriptBytes).digest("hex"),
      };
    }
    const { provider, model, effort, tightening } = this.#options.aiSettings.current();
    const stub = (this.#options.environment ?? process.env)["GUYDITOR_ASSEMBLY_STUB"] === "1";
    const session = createAssemblySession({
      id,
      now: (this.#options.now?.() ?? new Date()).toISOString(),
      settings: { provider: stub ? "stub" : provider, model, effort, tightening },
      assetIds: input.assetIds,
      script,
    });
    await this.#write(session);
    return assemblyView(session);
  }

  public async prepare(sessionId: string): Promise<JobStatus> {
    const session = await this.#read(sessionId);
    if (!PREPARABLE.includes(session.status)) {
      throw new Error(`E_ASSEMBLY_STATE: session ${sessionId} is ${session.status} and cannot be prepared`);
    }
    // Mark preparing before enqueueing so a second prepare call is rejected; a fresh start discards messages.
    await this.#write({
      ...session,
      status: "preparing",
      error: null,
      evidence: null,
      messages: [],
      plan: null,
      compiled: null,
    });
    return publicJobStatus(this.#options.project.jobs.enqueue({
      kind: "assembly.prepare",
      title: "Analyze footage for assembly",
      payload: { sessionId },
      cancellable: true,
    }));
  }

  public async abandon(sessionId: string): Promise<AssemblySessionView> {
    await this.#write({ ...await this.#read(sessionId), status: "abandoned" });
    return this.get(sessionId);
  }

  public surface(): Record<string, (params: never) => unknown> {
    return {
      list: () => this.list(),
      create: (params: { assetIds: string[]; scriptPath?: string }) => this.create(params),
      prepare: ({ sessionId }: { sessionId: string }) => this.prepare(sessionId),
      get: ({ sessionId }: { sessionId: string }) => this.get(sessionId),
      abandon: ({ sessionId }: { sessionId: string }) => this.abandon(sessionId),
    };
  }
}
