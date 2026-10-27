import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject, JobQueue } from "../../../core/src/index.js";
import type { AuditLog, CostMeter } from "../../../agent/src/index.js";
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
const queues: JobQueue[] = [];
const SECOND = "ast_bbbbbbbbbb";
const FIRST = "ast_aaaaaaaaaa";

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
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

async function harness(options: { transcripts?: "both" | "none" | "silent-second"; now?: () => Date } = {}) {
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
  const service = new AssemblyService({
    project: { jobs: queue, captureMetadata: { list: async () => [] } } as unknown as ProjectServices,
    store,
    engine: () => { throw new Error("unused"); },
    aiSettings: {
      current: () => ({ provider: "anthropic", model: "m1", effort: "medium", tightening: "ask", rates: {} }),
    } as unknown as AiSettingsService,
    auditLog: { record: vi.fn() } as unknown as AuditLog,
    costMeter: {} as unknown as CostMeter,
    appVersion: "0.0.0-test",
    publish,
    environment: {},
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const scriptPath = join(root, "script.md");
  await writeFile(scriptPath, "# Intro\n\nWelcome to the channel. Today we talk about tea.\n", "utf8");
  return { root, store, queue, publish, service, scriptPath };
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

  it("prepare enqueues the job, runs the executor and rejects a second prepare", async () => {
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
    const again = await h.service.prepare(id); // conversing may be re-prepared
    await expect(h.service.prepare(id)).rejects.toThrow("E_ASSEMBLY_STATE");
    await terminalJob(h.queue, again.jobId, new AbortController().signal);
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
});
