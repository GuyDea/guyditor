import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditLog, CostMeter, createLlmAdapter, DEFAULT_BUDGETS, LlmAdapterError } from "../../../agent/src/index.js";
import type { BudgetConfig, LlmAdapter, LlmRequest } from "../../../agent/src/index.js";
import { AnnotationService, createProject, JobQueue, OperationEngine, parseAnnotationSidecar } from "../../../core/src/index.js";
import type { ProjectStore, Result } from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import { contextFilePath, serializeTranscriptSidecar, terminalJob } from "../../../transcript/src/index.js";
import { scriptedTranscript } from "../../../transcript/src/assembly/__fixtures__/scripted-transcript.js";

import type { AiSettingsService } from "./ai-settings-service.js";
import { AssemblyService } from "./assembly-service.js";
import { prepareSession, registerAssemblyPrepareExecutor } from "./assembly-prepare.js";
import { registerDerivedSidecar } from "./derived-sidecar.js";
import type { ProjectServices } from "./project-services.js";

const EMPTY_ANNOTATIONS = "format: guyditor.annotations/v1\nannotations: []\n";
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
  provider?: "anthropic" | "openai";
  aiSettings?: Partial<Pick<AiSettingsService, "transport" | "cliBinary" | "apiKey">>;
}

async function harness(options: {
  transcripts?: "both" | "none" | "silent-second";
  now?: () => Date;
  send?: SendOptions;
  proposals?: { tightening: "ask" | "gentle" | "off" };
  pickFiles?: () => Promise<string[]>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "guyditor-assembly-"));
  roots.push(root);
  const model = projectFixture();
  const first = model.assets[0]!;
  model.assets.push({ ...structuredClone(first), id: SECOND, path: "media/b.mov", sha256: "b".repeat(64) });
  if (options.proposals !== undefined) {
    model.skills = [];
    model.sidecars[0]!.inputs = [];
    model.sidecars[0]!.sha256 = createHash("sha256").update(EMPTY_ANNOTATIONS).digest("hex");
  }
  const store = valueOf(await createProject(root, model));
  if (options.proposals !== undefined) {
    await writeFile(join(root, "sidecars/annotations.yaml"), EMPTY_ANNOTATIONS, "utf8");
  }
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
  const annotations = new AnnotationService({ appVersion: "0.0.0-test" });
  const ai = { model: sendOptions?.model ?? "m1" };
  const service = new AssemblyService({
    project: { jobs: queue, captureMetadata: { list: async () => [] }, annotations } as unknown as ProjectServices,
    store,
    engine: () => {
      if (options.proposals === undefined) throw new Error("unused");
      return new OperationEngine(store.currentProject, {
        appVersion: "0.0.0-test",
        committer: store,
        proposalStore: store,
        auditSink: auditLog,
      });
    },
    aiSettings: {
      current: () => ({
        provider: sendOptions?.provider ?? "anthropic", model: ai.model, effort: "medium", tightening: options.proposals?.tightening ?? "ask",
        rates: sendOptions?.rates ?? {},
      }),
      transport: () => "api",
      externalCalls: () => sendOptions?.externalCalls ?? "allow",
      apiKey: () => Promise.resolve("sk-test"),
      ...sendOptions?.aiSettings,
    } as unknown as AiSettingsService,
    auditLog,
    costMeter,
    appVersion: "0.0.0-test",
    publish,
    environment: {},
    ...(sendOptions?.adapterFactory === undefined ? {} : { adapterFactory: sendOptions.adapterFactory }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pickFiles === undefined ? {} : { pickFiles: options.pickFiles }),
  });
  return { root, store, queue, publish, service, auditLog, costMeter, annotations, ai };
}

const SCRIPT = "# Intro\n\n> Welcome to the channel. Today we talk about tea.\n";
/** A 1×1 PNG. */
const DOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Writes a file outside the project, where the creator's picker would find it; returns its absolute path. */
async function fixture(h: Awaited<ReturnType<typeof harness>>, name: string, bytes: string | Uint8Array): Promise<string> {
  const path = join(h.root, "outside", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

/** A `%PDF-1.4` buffer of exactly `bytes` bytes. */
function pdfOf(bytes: number): Buffer {
  const pdf = Buffer.alloc(bytes, 0x20);
  pdf.write("%PDF-1.4\n", 0, "latin1");
  return pdf;
}

async function withScript(h: Awaited<ReturnType<typeof harness>>, id: string): Promise<void> {
  await h.service.addFiles(id, [await fixture(h, "script.md", SCRIPT)]);
}

const prepare = (h: Awaited<ReturnType<typeof harness>>, id: string) =>
  prepareSession(h.service.prepareDeps(), id, new AbortController().signal, () => undefined);

describe("AssemblyService", () => {
  it("create registers the session sidecar with no files and an automatic script", async () => {
    const h = await harness();
    const view = await h.service.create({ assetIds: [FIRST, SECOND] });
    const ref = h.store.currentProject.sidecars.find(({ schema }) => schema === "guyditor.assembly/v1");
    expect(ref?.name).toBe(`assembly-${view.id}`);
    expect(view.inputs).toEqual({ assetIds: [FIRST, SECOND], files: [], script: { mode: "auto" }, nextFileLabel: 1 });
    expect(view.status).toBe("created");
    expect(view.settings.provider).toBe("anthropic");
    expect(view.settings.transport).toBe("api");
    expect(h.publish).toHaveBeenCalledWith({ kind: "assembly.updated", sessionId: view.id });
  });

  it("create rejects unknown assets", async () => {
    const h = await harness();
    await expect(h.service.create({ assetIds: ["ast_cccccccccc"] })).rejects.toThrow("E_ASSEMBLY_INVALID_INPUT");
  });

  it("prepare builds evidence and publishes assembly.updated", async () => {
    const h = await harness();
    const { id } = await h.service.create({ assetIds: [FIRST, SECOND] });
    await withScript(h, id);
    h.publish.mockClear();
    const session = await prepare(h, id);
    expect(session.status).toBe("conversing");
    expect(session.evidence?.groups.length).toBeGreaterThanOrEqual(1);
    expect(h.publish).toHaveBeenCalledWith({ kind: "assembly.updated", sessionId: id });
    expect(h.store.currentProject.sidecars.filter(({ schema }) => schema === "guyditor.assembly/v1")).toHaveLength(1);
  });

  it("prepare resolves the script from the attached files, sets roles and lists them in the evidence", async () => {
    const h = await harness();
    const { id } = await h.service.create({ assetIds: [FIRST, SECOND] });
    await h.service.addFiles(id, [await fixture(h, "script.md", SCRIPT), await fixture(h, "dot.png", DOT)]);
    const session = await prepare(h, id);
    expect(session.status).toBe("conversing");
    expect(session.inputs.files[0]?.role).toBe("script");
    expect(session.inputs.files[1]?.role).toBe("context");
    expect(session.evidence?.scriptBlocks.length).toBeGreaterThanOrEqual(1);
    expect(session.evidence?.text).toContain("## Context files");
    expect(session.evidence?.text).toMatch(/### F1 {2}script\.md {3}text {3}\d+ words {3}role: script {3}\(rendered as the script blocks above\)\n/u);
    expect(session.evidence?.text).toContain("### F2  dot.png   image");
    expect(session.evidence?.notes).toContain("script: F1 script.md");

    const again = await h.service.create({ assetIds: [FIRST] });
    await withScript(h, again.id);
    await h.service.setScript(again.id, { mode: "none" });
    const none = await prepare(h, again.id);
    expect(none.evidence?.scriptBlocks).toHaveLength(0);
    expect(none.evidence?.notes).toContain("script: none");
    expect(none.inputs.files[0]?.role).toBe("context");
  });

  it("prepare notes an explicit script without quoted paragraphs", async () => {
    const h = await harness();
    const { id } = await h.service.create({ assetIds: [FIRST] });
    await h.service.addFiles(id, [await fixture(h, "notes.md", "plain words only\n")]);
    await h.service.setScript(id, { mode: "label", label: "F1" });
    const session = await prepare(h, id);
    expect(session.evidence?.scriptBlocks).toHaveLength(0);
    expect(session.evidence?.notes).toEqual(expect.arrayContaining([
      "script: F1 notes.md",
      "F1 notes.md has no quoted paragraphs; no script blocks",
    ]));
    expect(session.inputs.files[0]?.role).toBe("script");
    const text = session.evidence?.text ?? "";
    const contextFiles = text.slice(text.indexOf("## Context files"), text.indexOf("## Footage"));
    expect(contextFiles).toContain(
      "### F1  notes.md   text   3 words   role: script   (chosen as the script but has no quoted paragraphs; shown inline)\nplain words only\n",
    );
  });

  it("prepare fails naming a context file that went missing", async () => {
    const h = await harness();
    const { id } = await h.service.create({ assetIds: [FIRST] });
    await withScript(h, id);
    await rm(join(h.root, contextFilePath(id, "F1", "script.md")));
    const session = await prepare(h, id);
    expect(session.status).toBe("failed");
    expect(session.error).toMatch(/F1/);
  });

  it("prepare re-snapshots the AI settings", async () => {
    const h = await harness();
    const { id } = await h.service.create({ assetIds: [FIRST] });
    h.ai.model = "m2";
    const session = await prepare(h, id);
    expect(session.settings.model).toBe("m2");
    expect(session.settings.transport).toBe("api");
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

  describe("context files", () => {
    const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

    it("addFiles copies, hashes and labels files monotonically", async () => {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST] });
      const added = await h.service.addFiles(id, [await fixture(h, "script.md", SCRIPT), await fixture(h, "notes.md", "notes\n")]);
      expect(added.inputs.files.map(({ label }) => label)).toEqual(["F1", "F2"]);
      expect(added.inputs.nextFileLabel).toBe(3);
      const [script] = added.inputs.files;
      expect(script).toMatchObject({
        name: "script.md", path: `sidecars/context/${id}/F1-script.md`, kind: "text", sent: true, role: "context",
      });
      const copy = await readFile(join(h.root, `sidecars/context/${id}/F1-script.md`));
      expect(copy.toString("utf8")).toBe(SCRIPT);
      expect(script?.sha256).toBe(sha256(copy));
      expect(script?.bytes).toBe(copy.length);

      const removed = await h.service.removeFile(id, "F1");
      expect(removed.inputs.files.map(({ label }) => label)).toEqual(["F2"]);
      await expect(readFile(join(h.root, `sidecars/context/${id}/F1-script.md`))).rejects.toThrow(/ENOENT/);
      const again = await h.service.addFiles(id, [await fixture(h, "script.md", SCRIPT)]);
      expect(again.inputs.files.map(({ label }) => label)).toEqual(["F2", "F3"]);
      expect(again.inputs.nextFileLabel).toBe(4);
      await expect(h.service.removeFile(id, "F1")).rejects.toThrow("E_ASSEMBLY_INVALID_INPUT");
    });

    it("files with the same basename get distinct paths", async () => {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST] });
      const view = await h.service.addFiles(id, [await fixture(h, "a/notes.md", "a\n"), await fixture(h, "b/notes.md", "b\n")]);
      expect(view.inputs.files.map(({ path }) => path)).toEqual([
        `sidecars/context/${id}/F1-notes.md`,
        `sidecars/context/${id}/F2-notes.md`,
      ]);
      expect(await readFile(join(h.root, view.inputs.files[0]!.path), "utf8")).toBe("a\n");
      expect(await readFile(join(h.root, view.inputs.files[1]!.path), "utf8")).toBe("b\n");
    });

    it("refuses attachments beyond the 20 MB turn total with the running total", async () => {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST] });
      await h.service.addFiles(id, [await fixture(h, "big1.pdf", pdfOf(15 * 1_048_576))]);
      await expect(h.service.addFiles(id, [await fixture(h, "big2.pdf", pdfOf(6 * 1_048_576))])).rejects.toThrow(
        "E_ASSEMBLY_FILES_TOO_LARGE: adding big2.pdf (6.0 MB) would put attached files at 21.0 MB; the limit is 20 MB",
      );
      const view = await h.service.get(id);
      expect(view.inputs.files).toHaveLength(1);
      expect(view.inputs.nextFileLabel).toBe(2);
    });

    it("a failing path in a batch attaches none of it", async () => {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST] });
      const missing = join(h.root, "outside", "missing.md");
      await expect(h.service.addFiles(id, [await fixture(h, "notes.md", "n\n"), missing]))
        .rejects.toThrow(`E_ASSEMBLY_INVALID_INPUT: ${missing} is not a readable file`);
      expect((await h.service.get(id)).inputs).toMatchObject({ files: [], nextFileLabel: 1 });
      await expect(readFile(join(h.root, `sidecars/context/${id}/F1-notes.md`))).rejects.toThrow(/ENOENT/);
    });

    it("unsent files are kept and say why", async () => {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST] });
      const view = await h.service.addFiles(id, [await fixture(h, "budget.xlsx", Buffer.from("PK\u0003\u0004sheet", "latin1"))]);
      expect(view.inputs.files[0]).toMatchObject({ name: "budget.xlsx", sent: false, unsentReason: "unsupported type" });
      await expect(readFile(join(h.root, `sidecars/context/${id}/F1-budget.xlsx`))).resolves.toBeDefined();
    });

    it("setScript, removing the chosen script, and setAssets", async () => {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST] });
      await h.service.addFiles(id, [await fixture(h, "script.md", SCRIPT), await fixture(h, "dot.png", DOT)]);
      expect((await h.service.setScript(id, { mode: "label", label: "F1" })).inputs.script)
        .toEqual({ mode: "label", label: "F1" });
      await expect(h.service.setScript(id, { mode: "label", label: "F2" })).rejects.toThrow(/E_ASSEMBLY_INVALID_INPUT/);
      await expect(h.service.setScript(id, { mode: "label", label: "F9" })).rejects.toThrow(/E_ASSEMBLY_INVALID_INPUT/);
      expect((await h.service.removeFile(id, "F1")).inputs.script).toEqual({ mode: "auto" });
      expect((await h.service.setAssets(id, [SECOND])).inputs.assetIds).toEqual([SECOND]);
      await expect(h.service.setAssets(id, ["ast_cccccccccc"])).rejects.toThrow(/E_ASSEMBLY_INVALID_INPUT/);
      await expect(h.service.setAssets(id, [])).rejects.toThrow(/E_ASSEMBLY_INVALID_INPUT/);
      await expect(h.service.setAssets(id, [FIRST, FIRST])).rejects.toThrow(/E_ASSEMBLY_INVALID_INPUT/);
      expect((await h.service.get(id)).inputs.assetIds).toEqual([SECOND]);
    });

    it("inputs are read-only from preparing on", async () => {
      const h = await harness();
      const { id } = await h.service.create({ assetIds: [FIRST] });
      await withScript(h, id);
      await prepare(h, id);
      const path = await fixture(h, "notes.md", "n\n");
      await expect(h.service.addFiles(id, [path])).rejects.toThrow(
        `E_ASSEMBLY_STATE: session ${id} is conversing; inputs can only change before Analyze (Start over to change them)`,
      );
      await expect(h.service.removeFile(id, "F1")).rejects.toThrow(/E_ASSEMBLY_STATE/);
      await expect(h.service.setScript(id, { mode: "none" })).rejects.toThrow(/E_ASSEMBLY_STATE/);
      await expect(h.service.setAssets(id, [SECOND])).rejects.toThrow(/E_ASSEMBLY_STATE/);

      const failed = await harness({ transcripts: "none" });
      const other = await failed.service.create({ assetIds: [FIRST] });
      expect((await prepare(failed, other.id)).status).toBe("failed");
      const added = await failed.service.addFiles(other.id, [await fixture(failed, "notes.md", "n\n")]);
      expect(added.inputs.files.map(({ label }) => label)).toEqual(["F1"]);
    });

    it("pickContextFiles returns the dialog's paths", async () => {
      const picked = await harness({ pickFiles: async () => ["/a.md"] });
      await expect(picked.service.pickContextFiles()).resolves.toEqual(["/a.md"]);
      const plain = await harness();
      await expect(plain.service.pickContextFiles()).resolves.toEqual([]);
    });
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
  const { id } = await h.service.create({ assetIds: [FIRST, SECOND] });
  await withScript(h, id);
  await prepare(h, id);
  return { ...h, id };
}

describe("AssemblyService.send", () => {
  it("the external notice names attached files", async () => {
    const h = await conversing({ externalCalls: "ask" });
    const asked = await h.service.send({ sessionId: h.id, text: "go" });
    expect(asked).toMatchObject({
      kind: "acknowledge-external",
      notice: "Sends the transcript, the conversation and the files you attach to anthropic. Never your footage.",
    });
  });

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

  it("takes a message from planned, rejects send once abandoned and closes the audit session", async () => {
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
    // A planned session keeps talking; the new reply replaces the plan.
    const revised = await h.service.send({ sessionId: h.id, text: "more" });
    if (revised.kind !== "turn") throw new Error("expected turn");
    expect(revised.session.messages.filter(({ role }) => role === "user").at(-1)?.content).toBe("more");
    expect(revised.session.messages.length).toBeGreaterThan(sent.messages.length);
    await h.service.abandon(h.id);
    await expect(h.service.send({ sessionId: h.id, text: "again" })).rejects.toThrow("E_ASSEMBLY_STATE");
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

  /** A 2-page PDF as far as the page counter is concerned. */
  const TWO_PAGES = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF\n", "latin1");

  function capturing(reply: unknown = PLAN_OF("w000001", "w000002"), reportedUsd?: number) {
    const requests: LlmRequest[] = [];
    const factory = vi.fn<typeof createLlmAdapter>(() => ({
      provider: "anthropic",
      listModels: () => Promise.resolve([]),
      complete: (request) => {
        requests.push(request);
        return Promise.resolve({ reply, usage: { inputTokens: 0, outputTokens: 0 }, ...(reportedUsd === undefined ? {} : { reportedUsd }) });
      },
    }));
    return { requests, factory };
  }

  async function withImageAndPdf(send: SendOptions) {
    const h = await harness({ send });
    const { id } = await h.service.create({ assetIds: [FIRST, SECOND] });
    await h.service.addFiles(id, [await fixture(h, "dot.png", DOT), await fixture(h, "two.pdf", TWO_PAGES)]);
    await prepare(h, id);
    return { ...h, id };
  }

  it("sends image and pdf bytes as parts, counts them in the estimate and audits the frames class", async () => {
    const adapter = capturing();
    const h = await withImageAndPdf({ externalCalls: "allow", adapterFactory: adapter.factory });
    const preflight = vi.spyOn(h.costMeter, "preflight");
    const result = await h.service.send({ sessionId: h.id, text: "go" });
    expect(result.kind).toBe("turn");
    const parts = adapter.requests[0]!.messages[0]!.content;
    expect(parts.map(({ type }) => type)).toEqual(["text", "image", "pdf"]);
    expect(parts[1]).toEqual({ type: "image", mime: "image/png", data: expect.anything() as unknown, label: "F1", name: "dot.png" });
    expect(Buffer.from((parts[1] as { data: Uint8Array }).data).equals(DOT)).toBe(true);
    expect(parts[2]).toMatchObject({ type: "pdf", mime: "application/pdf", label: "F2", name: "two.pdf" });
    expect(Buffer.from((parts[2] as { data: Uint8Array }).data).equals(TWO_PAGES)).toBe(true);
    expect((preflight.mock.calls[0]![0].units as { inputTokens: number }).inputTokens).toBeGreaterThanOrEqual(1600 + 4000);
    const view = await h.service.get(h.id);
    const call = h.auditLog.readSession(view.auditSessionId!).records.find((record) => record.type === "external.call") as unknown as
      { provider: string; dataClassesSent: string[]; payloadSummary: { frames?: number } };
    expect(call.provider).toBe("anthropic");
    expect(call.dataClassesSent).toContain("frames");
    expect(call.payloadSummary.frames).toBe(2);
  });

  it("a missing attachment fails the turn readably and keeps the session sendable", async () => {
    const adapter = capturing();
    const h = await withImageAndPdf({ externalCalls: "allow", adapterFactory: adapter.factory });
    const png = join(h.root, contextFilePath(h.id, "F1", "dot.png"));
    await rm(png);
    await expect(h.service.send({ sessionId: h.id, text: "go" }))
      .rejects.toThrow(/E_ASSEMBLY_FILE_MISSING: F1 dot.png is missing from sidecars\/context\//);
    expect(adapter.requests).toHaveLength(0);
    const view = await h.service.get(h.id);
    expect(view.status).toBe("conversing");
    expect(view.messages).toHaveLength(0);
    await writeFile(png, DOT);
    await expect(h.service.send({ sessionId: h.id, text: "go" })).resolves.toMatchObject({ kind: "turn" });
  });

  it.each([["anthropic", "claude", "claude-cli"], ["openai", "codex", "codex-cli"]] as const)(
    "cli transport needs no key, quotes zero, records the reported cost and labels the audit %s %s %s",
    async (provider, cli, label) => {
      const adapter = capturing(PLAN_OF("w000001", "w000002"), 0.42);
      const h = await harness({
        send: {
          externalCalls: "allow", provider, model: "claude-sonnet-5-5", rates: SEND_RATES, adapterFactory: adapter.factory,
          aiSettings: { transport: () => "cli", cliBinary: () => `/x/${cli}`, apiKey: () => Promise.resolve(undefined) },
        },
      });
      const { id } = await h.service.create({ assetIds: [FIRST, SECOND] });
      await prepare(h, id);
      const preflight = vi.spyOn(h.costMeter, "preflight");
      const result = await h.service.send({ sessionId: id, text: "go" });
      if (result.kind !== "turn") throw new Error("expected turn");
      const cwd = join(h.root, "sidecars/context", id);
      expect(adapter.factory).toHaveBeenCalledWith(provider, {
        apiKey: "", transport: "cli", cli: { binary: `/x/${cli}`, cwd },
      });
      expect(preflight.mock.calls[0]![0]).toMatchObject({ adapterId: `llm.${label}`, amount: 0, confidence: "quote" });
      expect(result.session.messages.at(-1)?.usage).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0.42, estimated: false });
      const records = h.auditLog.readSession(result.session.auditSessionId!).records;
      const call = records.find((record) => record.type === "external.call") as unknown as { provider: string; adapterId: string };
      expect(call.provider).toBe(label);
      expect(call.adapterId).toBe(`llm.${label}`);
      const charge = records.find((record) => record.type === "cost.charge") as unknown as { costUsd: number };
      expect(charge.costUsd).toBe(0.42);
      expect(records.find((record) => record.type === "session.start")).toMatchObject({
        director: { modelLabel: `${label}/claude-sonnet-5-5` },
      });
      expect((await stat(cwd)).isDirectory()).toBe(true);
    },
  );
});

describe("AssemblyService proposals", () => {
  const PLAN = (tightening: "gentle" | "off" | null) => ({
    status: "plan", summary: "Two lines.", tightening,
    flags: [{ cutIndex: 0, kind: "stitch", note: "joins two takes" }],
    cuts: [{ scriptBlock: null, scriptSentences: null, assetId: FIRST, fromWord: "w000001", toWord: "w000004", reason: "opening" }],
  });
  const adapter = (reply: unknown): typeof createLlmAdapter => () => ({
    provider: "anthropic",
    complete: () => Promise.resolve({ reply, usage: { inputTokens: 10, outputTokens: 10 } }),
    listModels: () => Promise.resolve([]),
  });

  async function planned(tightening: "ask" | "gentle" | "off", plan = PLAN(null)) {
    const h = await harness({
      send: { externalCalls: "allow", adapterFactory: adapter(plan) },
      proposals: { tightening },
    });
    const { id } = await h.service.create({ assetIds: [FIRST, SECOND] });
    await withScript(h, id);
    await prepare(h, id);
    await h.service.send({ sessionId: id, text: "go" });
    return { ...h, id };
  }

  it("createProposal appends clips after existing ones with a reason", async () => {
    const h = await planned("ask");
    const { proposalId, session } = await h.service.createProposal(h.id);
    expect(session.status).toBe("proposed");
    expect(session.proposalId).toBe(proposalId);
    expect(session.compiled?.[0]).toMatchObject({ index: 2, timelineStart: { frames: 48, fps: "24/1" } });
    const proposal = valueOf(await h.store.readProposal(proposalId));
    expect(proposal.operations[0]).toMatchObject({ op: "clip.insert", params: { index: 2 } });
    expect(proposal.riskClass).toBe("normal");
    expect(proposal.reason.text).toBe("Two lines.");
    expect(proposal.reason.sources.map(({ kind }) => kind)).toEqual(["media-evidence", "instruction"]);
    expect(proposal.actor).toMatchObject({ kind: "agent", id: "anthropic:m1" });
    await expect(h.service.createProposal(h.id)).rejects.toThrow("E_ASSEMBLY_STATE");
  });

  it("truncates a long summary to 280 characters with an ellipsis", async () => {
    const h = await planned("ask", { ...PLAN(null), summary: "x".repeat(400) });
    const { proposalId } = await h.service.createProposal(h.id);
    const proposal = valueOf(await h.store.readProposal(proposalId));
    expect([...proposal.reason.text]).toHaveLength(280);
    expect(proposal.reason.text.endsWith("…")).toBe(true);
  });

  it("rejects createProposal before a plan", async () => {
    const h = await harness({ proposals: { tightening: "ask" } });
    const { id } = await h.service.create({ assetIds: [FIRST] });
    await expect(h.service.createProposal(id)).rejects.toThrow(/E_ASSEMBLY_NOT_PLANNED/);
  });

  it("acceptance marks flagged cuts and enqueues scoped gentle tightening", async () => {
    const h = await planned("gentle");
    const { proposalId } = await h.service.createProposal(h.id);
    await h.service.onProposalAccepted(proposalId);
    const view = await h.service.get(h.id);
    expect(view.status).toBe("accepted");
    const sidecar = parseAnnotationSidecar(await readFile(join(h.root, "sidecars/annotations.yaml"), "utf8"));
    expect(sidecar.annotations).toHaveLength(1);
    expect(sidecar.annotations[0]).toMatchObject({
      author: { kind: "agent", id: "anthropic:m1" },
      body: "stitch: joins two takes",
      anchor: { kind: "timeline", frame: { frames: 48, fps: "24/1" } },
    });
    const jobs = h.queue.list({ kind: "assist.fillers.detect" });
    expect(jobs).toHaveLength(1);
    expect(view.tighteningJobId).toBe(jobs[0]!.jobId);
    const payload = jobs[0]!.payload as { assetIds: string[]; scope: { assemblySessionId: string; keptRanges: { assetId: string }[] } };
    expect(payload.assetIds).toEqual([FIRST]);
    expect(payload.scope.assemblySessionId).toBe(h.id);
    expect(payload.scope.keptRanges).toHaveLength(1);
    await h.service.onProposalAccepted(proposalId); // idempotent
    expect(h.queue.list({ kind: "assist.fillers.detect" })).toHaveLength(1);
  });

  it("tightening off enqueues nothing", async () => {
    const h = await planned("gentle", PLAN("off"));
    const { proposalId } = await h.service.createProposal(h.id);
    await h.service.onProposalAccepted(proposalId);
    expect((await h.service.get(h.id)).status).toBe("accepted");
    expect(h.queue.list({ kind: "assist.fillers.detect" })).toHaveLength(0);
    await h.service.onProposalAccepted("prp_zzzzzzzzzz"); // unknown proposals are ignored
  });

  it("a failing marker commit still accepts and records E_ASSEMBLY_FOLLOW_UP", async () => {
    const h = await planned("gentle");
    const { proposalId } = await h.service.createProposal(h.id);
    vi.spyOn(h.annotations, "execute").mockRejectedValue(new Error("disk full"));
    await expect(h.service.onProposalAccepted(proposalId)).resolves.toBeUndefined();
    const view = await h.service.get(h.id);
    expect(view.status).toBe("accepted");
    expect(view.error).toMatch(/E_ASSEMBLY_FOLLOW_UP: disk full/);
    expect(h.queue.list({ kind: "assist.fillers.detect" })).toHaveLength(0);
  });

  it("a rejected proposal returns the session to conversing with the plan kept", async () => {
    const h = await planned("off");
    const { proposalId } = await h.service.createProposal(h.id);
    await expect(h.service.onProposalRejected(proposalId)).resolves.toBeUndefined();
    const view = await h.service.get(h.id);
    expect(view).toMatchObject({ status: "conversing", proposalId: null, compiled: null });
    expect(view.plan?.summary).toBe("Two lines.");
    await expect(h.service.onProposalRejected("prp_zzzzzzzzzz")).resolves.toBeUndefined();
  });

  it("list skips a truncated sibling session file", async () => {
    const h = await harness();
    const good = await h.service.create({ assetIds: [FIRST] });
    const bad = await h.service.create({ assetIds: [SECOND] });
    const ref = h.store.currentProject.sidecars.find(({ path }) => path.includes(bad.id))!;
    await writeFile(join(h.root, ref.path), "{\"id\": \"as", "utf8");
    expect((await h.service.list()).map(({ id }) => id)).toEqual([good.id]);
  });

  it("a corrupt session file does not break acceptance of another proposal", async () => {
    const h = await planned("off");
    const { proposalId } = await h.service.createProposal(h.id);
    const refs = h.store.currentProject.sidecars.filter(({ schema }) => schema === "guyditor.assembly/v1");
    await writeFile(join(h.root, refs[0]!.path), "{ not json", "utf8");
    const other = await h.service.create({ assetIds: [SECOND] });
    await expect(h.service.onProposalAccepted(proposalId)).resolves.toBeUndefined();
    expect((await h.service.get(other.id)).status).toBe("created");
  });
});
