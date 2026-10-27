import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditLog, CostMeter, createLlmAdapter, DEFAULT_BUDGETS, LlmAdapterError } from "../../../agent/src/index.js";
import type { BudgetConfig, LlmAdapter } from "../../../agent/src/index.js";
import { createProject, JobQueue } from "../../../core/src/index.js";
import type { ProjectStore, Result } from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import {
  serializeTranscriptSidecar,
  terminalJob,
} from "../../../transcript/src/index.js";
import { scriptedTranscript } from "../../../transcript/src/assembly/__fixtures__/scripted-transcript.js";

import type { AiSettingsService } from "./ai-settings-service.js";
import { AssemblyService } from "./assembly-service.js";
import { prepareSession, registerAssemblyPrepareExecutor } from "./assembly-prepare.js";
import { registerDerivedSidecar } from "./derived-sidecar.js";
import type { ProjectServices } from "./project-services.js";

const roots: string[] = [];
const closers: (() => void)[] = [];
const queues: JobQueue[] = [];
const SECOND = "ast_bbbbbbbbbb";
const FIRST = "ast_aaaaaaaaaa";

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  for (const close of closers.splice(0)) close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const UTTERANCES = [
  { atMs: 0, text: "welcome to the channel today we talk about tea" },
  { atMs: 6000, text: "first boil the water carefully" },
];

async function addTranscript(
  store: ProjectStore,
  assetId: string,
  utterances: { atMs: number; text: string }[],
  ordinalStart: number,
): Promise<void> {
  const sidecar = scriptedTranscript(assetId, utterances, 48000, ordinalStart);
  // The fixture builder skips the strict id patterns the persisted sidecar enforces.
  sidecar.provenance.jobId = "job_aaaaaaaaaa";
  sidecar.speakers[0]!.id = "spk_aaaaaaaaaa";
  sidecar.segments.forEach((segment, index) => {
    segment.id = `seg_aaaaaaaaa${"abcdefgh"[index]!}`;
    segment.speaker = "spk_aaaaaaaaaa";
  });
  const text = serializeTranscriptSidecar(sidecar);
  const path = `sidecars/transcripts/${assetId}.transcript.json`;
  await mkdir(join(store.root, "sidecars/transcripts"), { recursive: true });
  await writeFile(join(store.root, path), text, "utf8");
  await registerDerivedSidecar(
    { appVersion: "0.0.0-test", auditSink: { record: vi.fn() } as never },
    store,
    {
      name: `transcript-${assetId}`,
      path,
      schema: "guyditor.transcript/v1",
      sha256: createHash("sha256").update(text).digest("hex"),
      inputs: [],
    },
  );
}

interface SendOptions {
  externalCalls: "allow" | "ask" | "block";
  budgets?: BudgetConfig;
  rates?: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  model?: string;
  adapterFactory?: typeof createLlmAdapter;
}

async function harness(options: {
  transcripts?: "both" | "none" | "silent-second";
  now?: () => Date;
  send?: SendOptions;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "guyditor-assembly-"));
  roots.push(root);
  const model = projectFixture();
  const first = model.assets[0]!;
  model.assets.push({ ...structuredClone(first), id: SECOND, path: "media/b.mov", sha256: "b".repeat(64) });
  const store = valueOf(await createProject(root, model));
  const mode = options.transcripts ?? "both";
  if (mode !== "none") {
    await addTranscript(store, FIRST, UTTERANCES, 1);
    await addTranscript(store, SECOND, mode === "silent-second" ? [] : UTTERANCES, 1000);
  }
  const { queue } = JobQueue.open(":memory:");
  queues.push(queue);
  const publish = vi.fn();
  const sendOptions = options.send;
  const userDir = join(root, "user");
  const auditLog = sendOptions === undefined
    ? { record: vi.fn() } as unknown as AuditLog
    : new AuditLog({ userDir });
  const costMeter = sendOptions === undefined
    ? {} as unknown as CostMeter
    : CostMeter.open({ userDir, auditLog, budgets: sendOptions.budgets ?? DEFAULT_BUDGETS });
  if (sendOptions !== undefined) closers.push(() => costMeter.close());
  const service = new AssemblyService({
    project: { jobs: queue, captureMetadata: { list: async () => [] } } as unknown as ProjectServices,
    store,
    engine: () => { throw new Error("unused"); },
    aiSettings: {
      current: () => ({
        provider: "anthropic", model: sendOptions?.model ?? "m1", effort: "medium", tightening: "ask",
        rates: sendOptions?.rates ?? {},
      }),
      externalCalls: () => sendOptions?.externalCalls ?? "allow",
      apiKey: () => Promise.resolve("sk-test"),
    } as unknown as AiSettingsService,
    auditLog,
    costMeter,
    appVersion: "0.0.0-test",
    publish,
    environment: {},
    ...(sendOptions?.adapterFactory === undefined ? {} : { adapterFactory: sendOptions.adapterFactory }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const scriptPath = join(root, "script.md");
  await writeFile(scriptPath, "# Intro\n\nWelcome to the channel. Today we talk about tea.\n", "utf8");
  return { root, store, queue, publish, service, scriptPath, auditLog };
}

const prepare = (h: Awaited<ReturnType<typeof harness>>, id: string) =>
  prepareSession(h.service.prepareDeps(), id, new AbortController().signal, () => undefined);

describe("AssemblyService", () => {
  it("create copies the script and registers the session sidecar", async () => {
    const h = await harness();
    const view = await h.service.create({ assetIds: [FIRST, SECOND], scriptPath: h.scriptPath });
    const ref = h.store.currentProject.sidecars.find(({ schema }) => schema === "guyditor.assembly/v1");
    expect(ref?.name).toBe(`assembly-${view.id}`);
    const copy = join(h.root, `sidecars/scripts/${view.id}.script.md`);
    const bytes = await readFile(copy);
    expect(view.inputs.script?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(view.status).toBe("created");
    expect(view.settings.provider).toBe("anthropic");
    expect(h.publish).toHaveBeenCalledWith({ kind: "assembly.updated", sessionId: view.id });
  });

  it("create rejects unknown assets and unreadable scripts", async () => {
    const h = await harness();
    await expect(h.service.create({ assetIds: ["ast_cccccccccc"] })).rejects.toThrow("E_ASSEMBLY_INVALID_INPUT");
    await expect(h.service.create({ assetIds: [FIRST], scriptPath: join(h.root, "missing.md") }))
      .rejects.toThrow("E_ASSEMBLY_INVALID_INPUT");
  });

  it("prepare builds evidence and publishes assembly.updated", async () => {
    const h = await harness();
    const { id } = await h.service.create({ assetIds: [FIRST, SECOND], scriptPath: h.scriptPath });
    h.publish.mockClear();
    const session = await prepare(h, id);
    expect(session.status).toBe("conversing");
    expect(session.evidence?.groups.length).toBeGreaterThanOrEqual(1);
    expect(h.publish).toHaveBeenCalledWith({ kind: "assembly.updated", sessionId: id });
    expect(h.store.currentProject.sidecars.filter(({ schema }) => schema === "guyditor.assembly/v1")).toHaveLength(1);
  });

  it("prepare skips a silent clip with a note", async () => {
    const h = await harness({ transcripts: "silent-second" });
    const { id } = await h.service.create({ assetIds: [FIRST, SECOND] });
    const session = await prepare(h, id);
    expect(session.status).toBe("conversing");
    expect(session.evidence?.notes.join("\n")).toMatch(/no speech/);
    expect(session.evidence?.assets).toHaveLength(1);
  });

  it("prepare fails cleanly without transcripts", async () => {
    const h = await harness({ transcripts: "none" });
    const { id } = await h.service.create({ assetIds: [FIRST] });
    const session = await prepare(h, id);
    expect(session.status).toBe("failed");
    expect(session.error).toMatch(/no transcript/);
  });

  it("views omit evidence text", async () => {
    const h = await harness();
    const { id } = await h.service.create({ assetIds: [FIRST] });
    await prepare(h, id);
    const view = await h.service.get(id);
    expect(view.evidence).not.toBeNull();
    expect(view.evidence).not.toHaveProperty("text");
    expect((await h.service.list())[0]!.evidence).not.toHaveProperty("text");
  });

  it("prepare enqueues the job, runs the executor and rejects preparing a conversing session", async () => {
    const h = await harness();
    registerAssemblyPrepareExecutor(h.queue, h.service.prepareDeps());
    const { id } = await h.service.create({ assetIds: [FIRST, SECOND] });
    const status = await h.service.prepare(id);
    expect(status.kind).toBe("assembly.prepare");
    expect(status.title).toBe("Analyze footage for assembly");
    const done = await terminalJob(h.queue, status.jobId, new AbortController().signal);
    expect(done.state).toBe("done");
    expect(done.payload).toEqual({ sessionId: id, status: "conversing" });
    expect((await h.service.get(id)).status).toBe("conversing");
    await expect(h.service.prepare(id)).rejects.toThrow("E_ASSEMBLY_STATE"); // conversing: abandon first
  });

  it("abandon persists and list is newest first", async () => {
    let tick = 0;
    const h = await harness({ now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
    const first = await h.service.create({ assetIds: [FIRST] });
    const second = await h.service.create({ assetIds: [SECOND] });
    expect((await h.service.abandon(first.id)).status).toBe("abandoned");
    const listed = await h.service.list();
    expect(listed.map(({ id }) => id)).toEqual([second.id, first.id]);
    expect(listed[1]!.status).toBe("abandoned");
  });

  describe("waiting for transcription", () => {
    async function waitHarness(neverAppears: boolean) {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST, SECOND] });
      const base = h.service.prepareDeps();
      const all = await base.transcripts();
      const withoutSecond = all.filter(({ assetId }) => assetId !== SECOND);
      let calls = 0;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      h.queue.registerExecutor("transcribe", async () => { await gate; });
      const job = h.queue.enqueue({
        kind: "transcribe", title: "t", payload: { assetId: SECOND }, cancellable: true,
      });
      const deps = {
        ...base,
        transcripts: async () => {
          calls += 1;
          return neverAppears || calls <= 2 ? withoutSecond : all;
        },
        transcriptWait: { intervalMs: 5, deadlineMs: neverAppears ? 40 : 5000 },
      };
      const running = prepareSession(deps, id, new AbortController().signal, () => undefined);
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(1));
      release();
      await terminalJob(h.queue, job.jobId, new AbortController().signal);
      return running;
    }

    it("polls for the sidecar after the transcribe job is done", async () => {
      const session = await waitHarness(false);
      expect(session.status).toBe("conversing");
      expect(session.evidence?.assets.map(({ assetId }) => assetId)).toContain(SECOND);
      expect(session.evidence?.notes.join("\n") ?? "").not.toMatch(/no transcript/);
    });

    it("notes the missing transcript once the deadline passes", async () => {
      const session = await waitHarness(true);
      expect(session.status).toBe("conversing");
      expect(session.evidence?.notes.join("\n")).toMatch(/no transcript/);
    });
  });

  describe("prepare guards and races", () => {
    it("concurrent prepare calls enqueue exactly one job", async () => {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST] });
      const results = await Promise.allSettled([h.service.prepare(id), h.service.prepare(id)]);
      expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(String(rejected.reason)).toContain("E_ASSEMBLY_STATE");
      expect(h.queue.list({ kind: "assembly.prepare" })).toHaveLength(1);
    });

    it("recovers a session stranded in preparing with no live job", async () => {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST] });
      await h.service.prepareDeps().updateSession(id, (current) => ({ ...current, status: "preparing" }));
      await expect(h.service.prepare(id)).resolves.toMatchObject({ kind: "assembly.prepare" });
    });

    async function gatedPrepare() {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST, SECOND] });
      const base = h.service.prepareDeps();
      const all = await base.transcripts();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      h.queue.registerExecutor("transcribe", async () => { await gate; });
      const job = h.queue.enqueue({
        kind: "transcribe", title: "t", payload: { assetId: SECOND }, cancellable: true,
      });
      const controller = new AbortController();
      const deps = {
        ...base,
        transcripts: async () => all.filter(({ assetId }) => assetId !== SECOND),
        transcriptWait: { intervalMs: 5, deadlineMs: 30 },
      };
      const running = prepareSession(deps, id, controller.signal, () => undefined);
      await vi.waitFor(() => expect(h.queue.get(job.jobId)?.state).toBe("running"));
      return { h, id, job, controller, running, release };
    }

    it("aborting a prepare leaves the user's transcribe job alone", async () => {
      const { h, id, job, controller, running, release } = await gatedPrepare();
      controller.abort();
      const session = await running;
      expect(session.status).toBe("failed");
      expect(["queued", "running"]).toContain(h.queue.get(job.jobId)?.state);
      expect((await h.service.get(id)).status).toBe("failed");
      release();
      await terminalJob(h.queue, job.jobId, new AbortController().signal);
    });

    it("an abandon during preparation is not overwritten", async () => {
      const { h, id, job, running, release } = await gatedPrepare();
      await h.service.abandon(id);
      release();
      await terminalJob(h.queue, job.jobId, new AbortController().signal);
      expect((await running).status).toBe("abandoned");
      expect((await h.service.get(id)).status).toBe("abandoned");
    });

    it("abandon cancels the live prepare job", async () => {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST] });
      const status = await h.service.prepare(id);
      await h.service.abandon(id);
      expect(h.queue.get(status.jobId)?.state).toBe("cancelled");
    });
  });
});

const stubFactory: typeof createLlmAdapter = () => createLlmAdapter("stub", { apiKey: "" });
const SEND_RATES = { "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 } };

async function conversing(send: SendOptions) {
  const h = await harness({ send: { adapterFactory: stubFactory, ...send } });
  const { id } = await h.service.create({ assetIds: [FIRST, SECOND], scriptPath: h.scriptPath });
  await prepare(h, id);
  return { ...h, id };
}

describe("AssemblyService.send", () => {
  it("blocks when externalCalls is block", async () => {
    const h = await conversing({ externalCalls: "block" });
    await expect(h.service.send({ sessionId: h.id, text: "go" })).resolves.toMatchObject({ kind: "blocked" });
    expect((await h.service.get(h.id)).messages).toHaveLength(0);
  });

  it("asks for acknowledgement once when externalCalls is ask", async () => {
    const h = await conversing({ externalCalls: "ask" });
    const first = await h.service.send({ sessionId: h.id, text: "go" });
    expect(first).toMatchObject({ kind: "acknowledge-external", provider: "anthropic" });
    const second = await h.service.send({ sessionId: h.id, text: "go", acknowledgeExternal: true });
    expect(second.kind).toBe("turn");
    expect((await h.service.get(h.id)).externalAcknowledged).toBe(true);
    const third = await h.service.send({ sessionId: h.id, text: "again" });
    expect(third.kind).toBe("turn");
  });

  it("surfaces a cost warning and proceeds with the token", async () => {
    const h = await conversing({
      externalCalls: "allow",
      model: "claude-sonnet-5-5",
      rates: SEND_RATES,
      budgets: { ...DEFAULT_BUDGETS, task: { warnUsd: 0, capUsd: null } },
    });
    const warned = await h.service.send({ sessionId: h.id, text: "go" });
    expect(warned).toMatchObject({ kind: "confirm-cost", estimated: false });
    if (warned.kind !== "confirm-cost") throw new Error("expected confirm-cost");
    expect(warned.estimatedUsd).toBeGreaterThan(0);
    expect((await h.service.get(h.id)).messages).toHaveLength(0);
    const result = await h.service.send({ sessionId: h.id, text: "go", confirmToken: warned.confirmToken });
    expect(result.kind).toBe("turn");
  });

  it("records external.call and cost.charge in the audit log", async () => {
    const h = await conversing({ externalCalls: "allow", model: "claude-sonnet-5-5", rates: SEND_RATES });
    const result = await h.service.send({ sessionId: h.id, text: "go" });
    if (result.kind !== "turn") throw new Error("expected turn");
    const auditId = result.session.auditSessionId!;
    expect(auditId).toMatch(/^ses_/u);
    const records = h.auditLog.readSession(auditId).records;
    const call = records.find((record) => record.type === "external.call");
    expect(call).toMatchObject({ provider: "anthropic", purpose: "assembly", outcome: "ok" });
    expect((call as { dataClassesSent: string[] }).dataClassesSent).toContain("transcript");
    expect(records.some((record) => record.type === "cost.charge")).toBe(true);
    expect(result.session.messages.at(-1)?.usage?.usd).toBeGreaterThan(0);
  });

  it("keeps the session conversing on a provider error", async () => {
    let calls = 0;
    const flaky: typeof createLlmAdapter = () => {
      const stub = createLlmAdapter("stub", { apiKey: "" });
      return {
        provider: "anthropic",
        listModels: () => stub.listModels(),
        complete: (request) => {
          calls += 1;
          if (calls === 1) return Promise.reject(new LlmAdapterError("429", 429, true));
          return stub.complete(request);
        },
      } satisfies LlmAdapter;
    };
    const h = await conversing({ externalCalls: "allow", adapterFactory: flaky });
    await expect(h.service.send({ sessionId: h.id, text: "go" })).rejects.toThrow(/E_ASSEMBLY_PROVIDER/);
    const view = await h.service.get(h.id);
    expect(view.status).toBe("conversing");
    expect(view.error).toMatch(/429/);
    expect(view.messages.map(({ role }) => role)).toEqual(["user"]);
    const retry = await h.service.send({ sessionId: h.id, text: "go" });
    expect(retry.kind).toBe("turn");
    expect((await h.service.get(h.id)).error).toBeNull();
    const call = h.auditLog.readSession(view.auditSessionId!).records.filter((r) => r.type === "external.call");
    expect(call.map((r) => (r as { outcome: string }).outcome)).toEqual(["error", "ok"]);
  });

  it("rejects an option with no question to answer and empty text", async () => {
    const h = await conversing({ externalCalls: "allow" });
    await expect(h.service.send({ sessionId: h.id, optionIndex: 9, questionId: "Q1" }))
      .rejects.toThrow("E_ASSEMBLY_INVALID_INPUT");
    await expect(h.service.send({ sessionId: h.id, text: "  " })).rejects.toThrow("E_ASSEMBLY_INVALID_INPUT");
  });

  it("rejects send outside conversing and closes the audit session on abandon", async () => {
    const h = await conversing({ externalCalls: "allow" });
    const asked = await h.service.send({ sessionId: h.id, text: "go" });
    if (asked.kind !== "turn") throw new Error("expected turn");
    expect(asked.session.status).toBe("conversing");
    const answered = await h.service.send({ sessionId: h.id, optionIndex: 0, questionId: "Q1" });
    expect(answered.kind).toBe("turn");
    const sent = await h.service.get(h.id);
    expect(sent.messages.filter(({ role }) => role === "user").map(({ content }) => content).at(-1))
      .toBe("Instruction, drop it");
    expect(sent.status).toBe("planned");
    expect(sent.plan).not.toBeNull();
    await expect(h.service.send({ sessionId: h.id, text: "more" })).rejects.toThrow("E_ASSEMBLY_STATE");
    await h.service.abandon(h.id);
    const types = h.auditLog.readSession(sent.auditSessionId!).records.map((r) => r.type);
    expect(types).toContain("session.end");
  });

  it("a re-prepare clears stale conversation data", async () => {
    const h = await conversing({ externalCalls: "allow" });
    await h.service.send({ sessionId: h.id, text: "go" });
    await h.service.prepareDeps().updateSession(h.id, (current) => ({ ...current, status: "failed" }));
    const again = await prepare(h, h.id);
    expect(again).toMatchObject({ messages: [], plan: null, compiled: null, proposalId: null, error: null });
  });

  const PLAN_OF = (fromWord: string, toWord: string) => ({
    status: "plan", summary: "s", tightening: null, flags: [],
    cuts: [{ scriptBlock: null, scriptSentences: null, assetId: FIRST, fromWord, toWord, reason: "r" }],
  });
  const adapterOf = (complete: LlmAdapter["complete"]): typeof createLlmAdapter => () => ({
    provider: "anthropic", complete, listModels: () => Promise.resolve([]),
  });
  const ok = (reply: unknown) => Promise.resolve({ reply, usage: { inputTokens: 1000, outputTokens: 100 } });

  it("orders words by transcript position, not id ordinal", async () => {
    const replies = [PLAN_OF("w000004", "w000099"), PLAN_OF("w000004", "w000099"), PLAN_OF("w000001", "w000004")];
    const h = await conversing({
      externalCalls: "allow",
      adapterFactory: adapterOf(() => ok(replies.shift())),
    });
    const path = join(h.root, `sidecars/transcripts/${FIRST}.transcript.json`);
    const sidecar = JSON.parse(await readFile(path, "utf8")) as {
      words: Record<string, unknown>; segments: { words: string[] }[];
    };
    sidecar.words["w000099"] = sidecar.words["w000003"];
    delete sidecar.words["w000003"];
    sidecar.segments[0]!.words = sidecar.segments[0]!.words.map((id) => id === "w000003" ? "w000099" : id);
    await writeFile(path, JSON.stringify(sidecar), "utf8");
    // w000099 sits between w000002 and w000004, so w000004 -> w000099 is reversed (both replies rejected).
    await expect(h.service.send({ sessionId: h.id, text: "go" })).rejects.toThrow(/E_ASSEMBLY_REPLY_INVALID/);
    const valid = await h.service.send({ sessionId: h.id, text: "again" });
    expect(valid.kind).toBe("turn");
    expect((await h.service.get(h.id)).status).toBe("planned");
  });

  it("records the first attempt's spend when the retry hits a provider error", async () => {
    let calls = 0;
    const h = await conversing({
      externalCalls: "allow", model: "claude-sonnet-5-5", rates: SEND_RATES,
      adapterFactory: adapterOf(() => {
        calls += 1;
        return calls === 1 ? ok({ status: "nope" }) : Promise.reject(new LlmAdapterError("503", 503, true));
      }),
    });
    await expect(h.service.send({ sessionId: h.id, text: "go" })).rejects.toThrow(/E_ASSEMBLY_PROVIDER/);
    const records = h.auditLog.readSession((await h.service.get(h.id)).auditSessionId!).records;
    const call = records.find((record) => record.type === "external.call") as unknown as
      { outcome: string; units: { inputTokens: number }; costUsd: { actual?: number } };
    expect(call.outcome).toBe("error");
    expect(call.units.inputTokens).toBe(1000);
    expect(call.costUsd.actual).toBeGreaterThan(0);
  });

  it("rejects a concurrent send with one audit session and one adapter call", async () => {
    let calls = 0;
    const h = await conversing({
      externalCalls: "allow",
      adapterFactory: adapterOf(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { reply: PLAN_OF("w000001", "w000002"), usage: { inputTokens: 1, outputTokens: 1 } };
      }),
    });
    const results = await Promise.allSettled([
      h.service.send({ sessionId: h.id, text: "go" }),
      h.service.send({ sessionId: h.id, text: "go" }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("E_ASSEMBLY_STATE");
    expect(calls).toBe(1);
    const view = await h.service.get(h.id);
    const starts = h.auditLog.readSession(view.auditSessionId!).records.filter((r) => r.type === "session.start");
    expect(starts).toHaveLength(1);
  });
});
