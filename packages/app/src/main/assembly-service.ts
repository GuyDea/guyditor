import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeId } from "../../../core/src/index.js";
import type {
  IdFactory,
  JobRecord,
  JobStatus,
  OperationEngine,
  ProjectStore,
} from "../../../core/src/index.js";
import {
  assemblySystemPrompt,
  ASSEMBLY_OUTPUT_TOKEN_ESTIMATE,
  createLlmAdapter as defaultAdapterFactory,
  estimateUsd,
  messageText,
  resolveRate,
  SessionManager,
} from "../../../agent/src/index.js";
import type { AuditLog, CostEstimate, CostMeter, CostContext, createLlmAdapter } from "../../../agent/src/index.js";
import {
  ASSEMBLY_REPLY_SCHEMA,
  assemblySidecarRef,
  compileAssemblyPlan,
  createAssemblySession,
  enqueueFillerDetection,
  GENTLE_FILLER_RULE_SET,
  parseAssemblySession,
  estimateTokens,
  reviewMarkerAnnotations,
  serializeAssemblySession,
} from "../../../transcript/src/index.js";
import type {
  AssemblyEvidence,
  AssemblyProvider,
  CompiledCut,
  AssemblySession,
  ReplyContext,
  ScriptChoice,
} from "../../../transcript/src/index.js";

import type { GdEventWithoutSeq } from "../shared/ipc.js";
import type { AiSettingsService } from "./ai-settings-service.js";
import { attachContextFiles, detachContextFile } from "./assembly-files.js";
import type { PrepareDeps } from "./assembly-prepare.js";
import { assemblyTarget, compileContext, keptRanges, proposalReason, rederiveStarts } from "./assembly-proposal.js";
import { llmMessages, runAssemblyTurn, TurnError } from "./assembly-turn.js";
import { registerDerivedSidecar } from "./derived-sidecar.js";
import { publicJobStatus } from "./job-status.js";
import { transcriptSidecars } from "./project-readers.js";
import type { ProjectServices } from "./project-services.js";

export type AssemblySessionView = Omit<AssemblySession, "evidence"> & {
  evidence: Omit<AssemblyEvidence, "text"> | null;
};

export interface AssemblyServiceOptions {
  project: Pick<ProjectServices, "jobs" | "captureMetadata" | "annotations">;
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
  /** The native multi-file picker; absent in tests and headless runs. */
  pickFiles?: () => Promise<string[]>;
}

export type SendInput = {
  sessionId: string;
  text?: string;
  optionIndex?: number;
  questionId?: string;
  confirmToken?: string;
  acknowledgeExternal?: boolean;
};
export type SendResult =
  | { kind: "turn"; session: AssemblySessionView }
  | { kind: "confirm-cost"; message: string; confirmToken: string; estimatedUsd: number; estimated: boolean }
  | { kind: "blocked"; message: string }
  | { kind: "acknowledge-external"; provider: AssemblyProvider; notice: string };

const MAX_TURNS = 12;
const SESSION_ID = /^asb_[a-z2-7]{10}$/u;
const PREPARABLE: readonly AssemblySession["status"][] = ["created", "failed"];
/** A planned session keeps talking: a new reply replaces the plan. */
const SENDABLE: readonly AssemblySession["status"][] = ["conversing", "planned"];
let tempCounter = 0;

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
  readonly #audit: SessionManager;
  readonly #sending = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  public constructor(options: AssemblyServiceOptions) {
    this.#options = options;
    this.#audit = new SessionManager(options.auditLog);
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

  /** Rewrites the session file and re-registers the sidecar (registering an existing name replaces it). Call inside #serialized. */
  async #persist(session: AssemblySession): Promise<AssemblySession> {
    const next: AssemblySession = { ...session, updatedAt: (this.#options.now?.() ?? new Date()).toISOString() };
    const text = serializeAssemblySession(next);
    await mkdir(join(this.#options.store.root, "sidecars/assembly"), { recursive: true });
    // tmp + rename: a crash mid-write never leaves a truncated session behind.
    tempCounter += 1;
    const temporary = `${this.#sessionPath(next.id)}.tmp-${String(process.pid)}-${String(tempCounter)}`;
    await writeFile(temporary, text, "utf8");
    await rename(temporary, this.#sessionPath(next.id));
    await registerDerivedSidecar(
      { appVersion: this.#options.appVersion, auditSink: this.#options.auditLog },
      this.#options.store,
      assemblySidecarRef(next, text),
    );
    this.#options.publish({ kind: "assembly.updated", sessionId: next.id });
    return next;
  }

  #update(id: string, change: (current: AssemblySession) => AssemblySession): Promise<AssemblySession> {
    return this.#serialized(async () => this.#persist(change(await this.#read(id))));
  }

  #liveJob(sessionId: string): JobRecord | undefined {
    return this.#options.project.jobs.list({ kind: "assembly.prepare", state: ["queued", "running"] })
      .find(({ payload }) =>
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
        && payload["sessionId"] === sessionId);
  }

  public prepareDeps(): PrepareDeps {
    return {
      store: this.#options.store,
      readSession: (id) => this.#read(id),
      updateSession: (id, change) => this.#update(id, change),
      transcripts: () => transcriptSidecars(this.#options.store),
      markers: async (assetId) =>
        (await this.#options.project.captureMetadata.list())
          .filter((sidecar) => sidecar.assetId === assetId)
          .flatMap(({ markers }) => markers),
      jobs: this.#options.project.jobs,
      settings: () => this.#sessionSettings(),
    };
  }

  /** The current AI settings as a session records them; `GUYDITOR_ASSEMBLY_STUB=1` swaps in the stub provider. */
  #sessionSettings(): AssemblySession["settings"] {
    const { aiSettings } = this.#options;
    const { provider, model, effort, tightening } = aiSettings.current();
    if ((this.#options.environment ?? process.env)["GUYDITOR_ASSEMBLY_STUB"] === "1") {
      return { provider: "stub", model, effort, tightening, transport: "api" };
    }
    return { provider, model, effort, tightening, transport: aiSettings.transport(provider) };
  }

  public async list(): Promise<AssemblySessionView[]> {
    const refs = this.#options.store.currentProject.sidecars
      .filter(({ schema }) => schema === "guyditor.assembly/v1");
    const sessions = (await Promise.all(refs.map(async ({ path }) => {
      try {
        return [parseAssemblySession(await readFile(join(this.#options.store.root, path), "utf8"))];
      } catch {
        return []; // a corrupt or missing file must not hide the other sessions
      }
    }))).flat();
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(assemblyView);
  }

  public async get(sessionId: string): Promise<AssemblySessionView> {
    return assemblyView(await this.#read(sessionId));
  }

  #checkAssets(assetIds: readonly string[]): void {
    if (assetIds.length === 0) throw invalidInput("at least one asset is required");
    if (new Set(assetIds).size !== assetIds.length) throw invalidInput("an asset is listed twice");
    for (const assetId of assetIds) {
      const asset = this.#options.store.currentProject.assets.find(({ id }) => id === assetId);
      if (asset === undefined) throw invalidInput(`asset ${assetId} does not exist`);
      if (asset.kind !== "video" && asset.kind !== "audio") {
        throw invalidInput(`asset ${assetId} is ${asset.kind}, not speech-bearing`);
      }
    }
  }

  public async create(input: { assetIds: string[] }): Promise<AssemblySessionView> {
    this.#checkAssets(input.assetIds);
    const session = createAssemblySession({
      id: (this.#options.idFactory ?? makeId)("asb"),
      now: (this.#options.now?.() ?? new Date()).toISOString(),
      settings: this.#sessionSettings(),
      assetIds: input.assetIds,
    });
    await this.#serialized(() => this.#persist(session));
    return assemblyView(session);
  }

  /** Reads a session whose inputs may still change: only before Analyze, or after a failed one. Call inside #serialized. */
  async #readEditable(sessionId: string): Promise<AssemblySession> {
    const session = await this.#read(sessionId);
    if (!PREPARABLE.includes(session.status)) {
      throw new Error(
        `E_ASSEMBLY_STATE: session ${sessionId} is ${session.status}; inputs can only change before Analyze (Start over to change them)`,
      );
    }
    return session;
  }

  #editInputs(
    sessionId: string,
    change: (session: AssemblySession) => Promise<Partial<AssemblySession["inputs"]>> | Partial<AssemblySession["inputs"]>,
  ): Promise<AssemblySessionView> {
    return this.#serialized(async () => {
      const session = await this.#readEditable(sessionId);
      const inputs = { ...session.inputs, ...await change(session) };
      return assemblyView(await this.#persist({ ...session, inputs }));
    });
  }

  public pickContextFiles(): Promise<string[]> {
    return this.#options.pickFiles?.() ?? Promise.resolve([]);
  }

  /** Copies the files into the session (labels `F<n>`, never reused). */
  public addFiles(sessionId: string, paths: string[]): Promise<AssemblySessionView> {
    return this.#editInputs(sessionId, (session) => attachContextFiles(this.#options.store.root, session, paths));
  }

  /** Drops a file and its copy; removing the chosen script falls back to automatic detection. */
  public removeFile(sessionId: string, label: string): Promise<AssemblySessionView> {
    return this.#serialized(async () => {
      const session = await this.#readEditable(sessionId);
      const file = session.inputs.files.find((candidate) => candidate.label === label);
      if (file === undefined) throw invalidInput(`no attached file ${label}`);
      const { script } = session.inputs;
      const next = await this.#persist({
        ...session,
        inputs: {
          ...session.inputs,
          files: session.inputs.files.filter((candidate) => candidate !== file),
          script: script.mode === "label" && script.label === label ? { mode: "auto" } : script,
        },
      });
      // After the persist: a crash in between leaves an orphan copy, never a listed file without one.
      await detachContextFile(this.#options.store.root, file);
      return assemblyView(next);
    });
  }

  public setScript(sessionId: string, script: ScriptChoice): Promise<AssemblySessionView> {
    return this.#editInputs(sessionId, ({ inputs }) => {
      if (script.mode === "label" && !inputs.files.some(({ label, kind }) => label === script.label && kind === "text")) {
        throw invalidInput(`${script.label} is not an attached text file`);
      }
      return { script };
    });
  }

  public setAssets(sessionId: string, assetIds: string[]): Promise<AssemblySessionView> {
    return this.#editInputs(sessionId, () => {
      this.#checkAssets(assetIds);
      return { assetIds: [...assetIds] };
    });
  }

  public prepare(sessionId: string): Promise<JobStatus> {
    return this.#serialized(async () => {
      const session = await this.#read(sessionId);
      // An interrupted run leaves "preparing" behind with no live job; that is recoverable.
      const recoverable = session.status === "preparing" && this.#liveJob(sessionId) === undefined;
      if (!PREPARABLE.includes(session.status) && !recoverable) {
        throw new Error(`E_ASSEMBLY_STATE: session ${sessionId} is ${session.status} and cannot be prepared`);
      }
      await this.#persist({ ...session, status: "preparing", error: null });
      try {
        return publicJobStatus(this.#options.project.jobs.enqueue({
          kind: "assembly.prepare",
          title: "Analyze footage for assembly",
          payload: { sessionId },
          cancellable: true,
        }));
      } catch (error: unknown) {
        await this.#persist(session);
        throw error;
      }
    });
  }

  /** The creator's words for this turn: free text, or the option they picked from the last questions reply. */
  #userText(session: AssemblySession, input: SendInput): string {
    if (input.optionIndex === undefined) {
      const text = input.text?.trim() ?? "";
      if (text === "") throw invalidInput("a message is required");
      return text;
    }
    const last = session.messages.at(-1)?.reply;
    const question = last?.status === "questions"
      ? last.questions.find(({ id }) => id === input.questionId)
      : undefined;
    const option = question?.options?.[input.optionIndex];
    if (option === undefined) throw invalidInput("that option does not belong to the open question");
    return option;
  }

  #replyContext(session: AssemblySession, evidence: AssemblyEvidence): Promise<ReplyContext> {
    const assetIds = evidence.assets.map(({ assetId }) => assetId);
    return transcriptSidecars(this.#options.store).then((sidecars) => {
      const words: ReplyContext["words"] = new Map();
      for (const sidecar of sidecars.filter(({ assetId }) => assetIds.includes(assetId))) {
        // Canonical order is transcript position: corrections mint fresh ids that do not sort by time.
        sidecar.segments.flatMap(({ words: ids }) => ids).forEach((id, order) => {
          const word = sidecar.words[id];
          if (word !== undefined) words.set(id, { assetId: sidecar.assetId, state: word.state, order });
        });
      }
      return { words, scriptBlocks: evidence.scriptBlocks, assetIds };
    });
  }

  public async send(input: SendInput): Promise<SendResult> {
    const session = await this.#read(input.sessionId);
    if (!SENDABLE.includes(session.status) || session.evidence === null) {
      throw new Error(`E_ASSEMBLY_STATE: session ${session.id} is ${session.status} and cannot take a message`);
    }
    const userText = this.#userText(session, input);
    if (this.#sending.has(session.id)) throw new Error(`E_ASSEMBLY_STATE: session ${session.id} is already working`);
    this.#sending.add(session.id);
    try {
      return await this.#sendGuarded(session, session.evidence, input, userText);
    } finally {
      this.#sending.delete(session.id);
    }
  }

  async #sendGuarded(
    start: AssemblySession,
    evidence: AssemblyEvidence,
    input: SendInput,
    userText: string,
  ): Promise<SendResult> {
    const { aiSettings, store, costMeter } = this.#options;
    let session = start;
    const { provider, model } = session.settings;
    const stub = provider === "stub";
    const externalCalls = aiSettings.externalCalls();
    if (!stub) {
      if (externalCalls === "block") {
        return { kind: "blocked", message: "External AI calls are blocked in settings." };
      }
      if (externalCalls === "ask" && !session.externalAcknowledged) {
        if (input.acknowledgeExternal !== true) {
          return {
            kind: "acknowledge-external",
            provider,
            notice: `Sends the transcript and script text to ${provider}. Never audio or video.`,
          };
        }
        session = await this.#update(session.id, (current) => ({ ...current, externalAcknowledged: true }));
      }
    }
    let apiKey = "";
    if (!stub) {
      apiKey = (await aiSettings.apiKey(provider)) ?? "";
      if (apiKey === "") throw new Error(`E_AI_KEY_MISSING: no API key for ${provider}`);
    }
    const adapter = (this.#options.adapterFactory ?? defaultAdapterFactory)(provider, { apiKey });
    const projectId = store.currentProject.project.id;
    let auditSessionId = session.auditSessionId;
    if (auditSessionId === null) {
      auditSessionId = this.#audit.open({
        projectId,
        director: { profileId: "assembly", modelLabel: `${provider}/${model}`, locality: stub ? "local" : "remote" },
        policySnapshot: { externalCalls },
      }).sessionId;
      const opened = auditSessionId;
      session = await this.#update(session.id, (current) => ({ ...current, auditSessionId: opened }));
    }
    const system = assemblySystemPrompt();
    const { rate, estimated } = resolveRate(aiSettings.current().rates, provider, model);
    const history = llmMessages({
      ...session,
      messages: [...session.messages, { role: "user", content: userText, reply: null, usage: null, at: "" }],
    }).map(messageText).join("");
    const units = { inputTokens: estimateTokens(system + history), outputTokens: ASSEMBLY_OUTPUT_TOKEN_ESTIMATE };
    const estimate: CostEstimate = {
      adapterId: `llm.${provider}`,
      currency: "USD",
      amount: estimateUsd(rate, units),
      units,
      confidence: estimated ? "heuristic" : "pricebook",
    };
    const context: CostContext = { sessionId: auditSessionId, projectId, taskId: session.id, initiator: "creator" };
    const verdict = costMeter.preflight(estimate, context, input.confirmToken);
    if (verdict.verdict === "blocked") return { kind: "blocked", message: verdict.message };
    if (verdict.verdict === "warn") {
      return {
        kind: "confirm-cost",
        message: verdict.message,
        confirmToken: verdict.confirmToken,
        estimatedUsd: estimate.amount,
        estimated,
      };
    }
    const startedAt = performance.now();
    const record = (outcome: "ok" | "error", usage: { inputTokens: number; outputTokens: number }, actualUsd: number) =>
      costMeter.record({
        context,
        estimate,
        provider,
        purpose: "assembly",
        dataClassesSent: ["prompt", "transcript"],
        payloadSummary: { promptChars: system.length + history.length, transcriptWords: evidence.segments.reduce((n, { text }) => n + text.split(/\s+/u).length, 0) },
        units: usage,
        actualUsd,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
      });
    try {
      const replyContext = await this.#replyContext(session, evidence);
      const result = await runAssemblyTurn(session, userText, {
        adapter,
        system,
        schema: ASSEMBLY_REPLY_SCHEMA,
        context: replyContext,
        maxTurns: MAX_TURNS,
        now: () => (this.#options.now?.() ?? new Date()).toISOString(),
        price: (usage) => ({ usd: estimateUsd(rate, usage), estimated }),
      });
      record("ok", result.usage, estimateUsd(rate, result.usage));
      const turn = await this.#update(session.id, (current) =>
        SENDABLE.includes(current.status)
          ? { ...current, messages: result.session.messages, status: result.session.status, plan: result.session.plan, error: null }
          : current);
      return { kind: "turn", session: assemblyView(turn) };
    } catch (error: unknown) {
      if (!(error instanceof TurnError)) throw error;
      const failure = error;
      record("error", failure.usage, estimateUsd(rate, failure.usage));
      await this.#update(session.id, (current) => SENDABLE.includes(current.status)
        ? { ...current, messages: failure.session.messages, error: failure.message }
        : current);
      throw new Error(failure.kind === "provider" ? `E_ASSEMBLY_PROVIDER: ${failure.message}` : failure.message);
    }
  }

  public createProposal(sessionId: string): Promise<{ proposalId: string; session: AssemblySessionView }> {
    return this.#serialized(async () => {
      const session = await this.#read(sessionId);
      if (session.status === "proposed") {
        throw new Error(`E_ASSEMBLY_STATE: session ${sessionId} already has proposal ${session.proposalId ?? ""}`);
      }
      const { plan, evidence } = session;
      if (session.status !== "planned" || plan === null || evidence === null) {
        throw new Error(`E_ASSEMBLY_NOT_PLANNED: session ${sessionId} is ${session.status}; it has no plan to propose`);
      }
      const { store } = this.#options;
      const compiled = compileAssemblyPlan(
        plan,
        compileContext(store.currentProject, session, await transcriptSidecars(store)),
      );
      if (!compiled.ok) throw new Error(`${compiled.error.code}: ${compiled.error.message}`);
      const { provider, model } = session.settings;
      const created = await this.#options.engine().createProposal({
        operations: compiled.value.operations,
        instruction: { kind: "user-text", text: plan.summary },
        actor: { kind: "agent", id: `${provider}:${model}`, model },
        ...(session.auditSessionId === null ? {} : { sessionId: session.auditSessionId }),
        reason: {
          text: proposalReason(plan),
          sources: [
            { kind: "media-evidence", ref: evidence.sha256 },
            { kind: "instruction", ref: session.id },
          ],
        },
        addresses: [],
      });
      if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
      const next = await this.#persist({
        ...session,
        status: "proposed",
        proposalId: created.value.id,
        compiled: compiled.value.cuts,
      });
      return { proposalId: created.value.id, session: assemblyView(next) };
    });
  }

  /** Newest-first lookup of the session that owns a proposal; unreadable session files are skipped. */
  async #sessionForProposal(proposalId: string): Promise<AssemblySession | undefined> {
    const { store } = this.#options;
    const refs = store.currentProject.sidecars.filter(({ schema }) => schema === "guyditor.assembly/v1");
    for (const { path } of refs) {
      try {
        const candidate = parseAssemblySession(await readFile(join(store.root, path), "utf8"));
        if (candidate.proposalId === proposalId) return candidate;
      } catch { /* a corrupt or missing file cannot own this proposal */ }
    }
    return undefined;
  }

  /** Review markers for flagged cuts, then the gentle tightening job when it applies. Returns the job id. */
  async #followUp(session: AssemblySession, cuts: CompiledCut[]): Promise<string | null> {
    const { store, project } = this.#options;
    const target = assemblyTarget(store.currentProject);
    const { provider, model } = session.settings;
    const markers = reviewMarkerAnnotations(rederiveStarts(store.currentProject, target.sequenceId, cuts), {
      sequenceId: target.sequenceId,
      deliverableId: target.deliverableId,
      aspect: target.aspect,
      authorId: `${provider}:${model}`,
      now: (this.#options.now?.() ?? new Date()).toISOString(),
      idFactory: (prefix) => (this.#options.idFactory ?? makeId)(prefix),
    });
    if (markers.length > 0) {
      // Agent-origin batches may only commit through a proposal; the marker authorship is in the literal.
      const marked = await project.annotations.execute(
        store,
        markers.map((annotation) => ({ op: "annotation.create", params: { annotation } })),
        { origin: "system", dryRun: false },
      );
      if (!marked.ok) throw new Error(`${marked.error.code}: ${marked.error.message}`);
    }
    if ((session.plan?.tightening ?? session.settings.tightening) !== "gentle") return null;
    return enqueueFillerDetection(project.jobs, {
      assetIds: [...new Set(cuts.map(({ assetId }) => assetId))],
      fillerRules: GENTLE_FILLER_RULE_SET,
      scope: { assemblySessionId: session.id, keptRanges: keptRanges(cuts, await transcriptSidecars(store)) },
    }).jobId;
  }

  /** Acceptance hook. Never throws: the proposal is already accepted, so failures are recorded on the session. */
  public onProposalAccepted(proposalId: string): Promise<void> {
    return this.#serialized(async () => {
      try {
        const found = await this.#sessionForProposal(proposalId);
        if (found?.status !== "proposed" || found.compiled === null) return;
        if (found.auditSessionId !== null) {
          try { this.#audit.close(found.auditSessionId); } catch { /* not open in this run */ }
        }
        let next: AssemblySession = { ...found, status: "accepted" };
        try {
          next = { ...next, tighteningJobId: await this.#followUp(found, found.compiled) };
        } catch (error: unknown) {
          next = { ...next, error: `E_ASSEMBLY_FOLLOW_UP: ${error instanceof Error ? error.message : String(error)}` };
        }
        await this.#persist(next);
      } catch { /* nothing more can be recorded; the accept must still succeed */ }
    });
  }

  /** Reject/supersede hook: back to the conversation with the plan kept. Never throws. */
  public onProposalRejected(proposalId: string): Promise<void> {
    return this.#serialized(async () => {
      try {
        const found = await this.#sessionForProposal(proposalId);
        if (found?.status !== "proposed") return;
        await this.#persist({ ...found, status: "conversing", proposalId: null, compiled: null });
      } catch { /* the reject itself must still succeed */ }
    });
  }

  public async abandon(sessionId: string): Promise<AssemblySessionView> {
    const abandoned = await this.#update(sessionId, (current) => ({ ...current, status: "abandoned" }));
    if (abandoned.auditSessionId !== null) {
      try { this.#audit.close(abandoned.auditSessionId); } catch { /* not open in this run */ }
    }
    const live = this.#liveJob(sessionId);
    if (live !== undefined) this.#options.project.jobs.cancel(live.jobId);
    return this.get(sessionId);
  }

  public surface(): Record<string, (params: never) => unknown> {
    return {
      list: () => this.list(),
      create: (params: { assetIds: string[] }) => this.create(params),
      prepare: ({ sessionId }: { sessionId: string }) => this.prepare(sessionId),
      get: ({ sessionId }: { sessionId: string }) => this.get(sessionId),
      send: (params: SendInput) => this.send(params),
      abandon: ({ sessionId }: { sessionId: string }) => this.abandon(sessionId),
      createProposal: ({ sessionId }: { sessionId: string }) => this.createProposal(sessionId),
      pickContextFiles: () => this.pickContextFiles(),
      addFiles: ({ sessionId, paths }: { sessionId: string; paths: string[] }) => this.addFiles(sessionId, paths),
      removeFile: ({ sessionId, label }: { sessionId: string; label: string }) => this.removeFile(sessionId, label),
      setScript: ({ sessionId, script }: { sessionId: string; script: ScriptChoice }) => this.setScript(sessionId, script),
      setAssets: ({ sessionId, assetIds }: { sessionId: string; assetIds: string[] }) => this.setAssets(sessionId, assetIds),
    };
  }
}
