import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  OperationEngine,
  createProject,
  parseProjectYaml,
} from "../../core/src/index.js";
import type {
  IdPrefix,
  JobRecord,
  JsonValue,
  RestylePlan,
  Result,
} from "../../core/src/index.js";
import { createRestylePlan } from "../../deliver/src/index.js";
import {
  AdapterRegistry,
  AuditLog,
  CostMeter,
  FileCredentialStore,
  KlingRestyleAdapter,
  RestyleExecutionService,
} from "./index.js";
import type {
  BudgetConfig,
  RestyleStartResult,
} from "./index.js";
import type { KlingApi, KlingApiTask } from "./adapters/kling-api.js";

const roots: string[] = [];
const NOW = new Date("2026-07-19T10:00:00.000Z");
const FIXTURE_PROJECT = resolve(".fixtures/projects/basic/episode.guyditor.yaml");
const SECRET = "kling-live-secret-never-serialize";
const NO_BUDGETS: BudgetConfig = {
  task: { warnUsd: null, capUsd: null },
  episode: { warnUsd: null, capUsd: null },
  cumulative: { warnUsd: null, capUsd: null },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

async function directory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function ids(): (prefix: IdPrefix) => string {
  const ordinals = new Map<IdPrefix, number>();
  const fixed: Partial<Record<IdPrefix, string>> = {
    ast: "ast_llllllllll",
    lyr: "lyr_llllllllll",
    gfx: "gfx_llllllllll",
  };
  return (prefix) => {
    if (fixed[prefix] !== undefined) return fixed[prefix]!;
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    const character = String.fromCharCode("a".charCodeAt(0) + ordinal);
    return `${prefix}_${character.repeat(10)}`;
  };
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for restyle state.");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function allTextFiles(root: string): Promise<string> {
  const chunks: string[] = [];
  const walk = async (directoryPath: string): Promise<void> => {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const path = join(directoryPath, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        try {
          chunks.push(await readFile(path, "utf8"));
        } catch {
          // Binary project artifacts are intentionally not interpreted as text.
        }
      }
    }
  };
  await walk(root);
  return chunks.join("\n");
}

interface Harness {
  projectRoot: string;
  userDir: string;
  engine: OperationEngine;
  plan: RestylePlan;
  queue: JobQueue;
  service: RestyleExecutionService;
  meter: CostMeter;
  audit: AuditLog;
}

async function harness(
  budgets: BudgetConfig,
  withShort = false,
  apiFactory?: () => KlingApi,
): Promise<Harness> {
  const projectRoot = await directory("guyditor-restyle-project-");
  const userDir = await directory("guyditor-restyle-user-");
  const parsed = parseProjectYaml(await readFile(FIXTURE_PROJECT, "utf8"));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  if (withShort) {
    parsed.value.sequences.push({
      id: "seq_llllllllll",
      name: "short",
      clips: [{
        id: "clp_llllllllll",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 0, fps: "30/1" },
          out: { frames: 30, fps: "30/1" },
        },
      }],
    });
    parsed.value.layers.push({
      id: "lyr_kkkkkkkkkk",
      kind: "video",
      name: "short",
      order: 3,
      enabled: true,
      locked: false,
      sequence: "seq_llllllllll",
    });
    parsed.value.deliverables.push({
      id: "dlv_llllllllll",
      kind: "short",
      name: "Short",
      profile: "youtube-shorts@1.0.0",
      sequenceId: "seq_llllllllll",
      status: "draft",
      dependencies: [{
        derivativeClipId: "clp_llllllllll",
        source: {
          assetId: "ast_aaaaaaaaaa",
          range: {
            start: { frames: 0, fps: "30/1" },
            end: { frames: 30, fps: "30/1" },
          },
          longformClipId: "clp_aaaaaaaaaa",
        },
      }],
    });
  }
  const store = await valueOf(createProject(projectRoot, parsed.value, {
    idFactory: () => "txn_zzzzzzzzzz",
    now: () => NOW,
  }));
  const idFactory = ids();
  const engine = new OperationEngine(store.currentProject, {
    committer: store,
    proposalStore: store,
    idFactory,
    now: () => NOW,
  });
  const planned = createRestylePlan({
    project: store.currentProject,
    deliverableId: withShort ? "dlv_llllllllll" : "dlv_aaaaaaaaaa",
    coverage: [{ startFrame: 0, endFrame: 30 }],
    adapterId: "adp_klingaaaaa",
    model: "kling-video-o1",
    constraints: {
      maxSegmentSeconds: 10,
      maxResolution: { width: 2048, height: 2048 },
      fpsSupport: ["30/1"],
      costPerSecond: 0.14,
      concurrency: 1,
    },
    prompt: "Watercolor documentary",
    providerSettings: {},
    seed: 7,
    createdAt: NOW.toISOString(),
    signals: { words: [], beats: [], vadSilences: [], lowMotionFrames: [] },
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) throw new Error(planned.error.message);
  const proposal = await valueOf(engine.createProposal({
    operations: [{
      op: "restyle.plan.create",
      params: { deliverableId: planned.value.deliverableId, plan: planned.value },
    }],
    instruction: { kind: "user-text", text: "Restyle the opening" },
    actor: { kind: "agent", id: "ses_aaaaaaaaaa", model: "test-agent" },
    sessionId: "ses_aaaaaaaaaa",
    reason: {
      text: "Create the segmented plan before provider calls.",
      sources: [{ kind: "instruction", ref: "Restyle the opening" }],
    },
    addresses: [],
  }));
  expect(proposal.divergence).toBeUndefined();
  await valueOf(engine.acceptProposal(proposal.id, "creator"));

  const credentials = new FileCredentialStore({ userDir });
  await credentials.set("adp_klingaaaaa", "apiKey", SECRET);
  const audit = new AuditLog({
    userDir,
    now: () => NOW,
    credentialValues: () => credentials.knownValues(),
  });
  const meter = CostMeter.open({ userDir, auditLog: audit, budgets, now: () => NOW });
  const registry = new AdapterRegistry();
  registry.register(new KlingRestyleAdapter({
    credentials,
    config: { apiKeyRef: "apiKey", model: "kling-video-o1" },
    ...(apiFactory === undefined
      ? { stubMode: true }
      : { stubMode: false, apiFactory }),
  }));
  const runtime: { service?: RestyleExecutionService } = {};
  const queue = JobQueue.open(join(projectRoot, ".guyditor/jobs.sqlite"), {
    concurrency: 2,
    overviewSources: { external: () => runtime.service?.externalWaits() ?? [] },
  }).queue;
  const service = new RestyleExecutionService({
    projectStore: store,
    operationEngine: engine,
    adapters: registry,
    jobs: queue,
    costMeter: meter,
    idFactory,
    now: () => NOW,
  });
  runtime.service = service;
  return { projectRoot, userDir, engine, plan: planned.value, queue, service, meter, audit };
}

function jobResult(job: JobRecord): Record<string, unknown> {
  if (typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) {
    throw new Error("Restyle job payload is not an object.");
  }
  return job.payload;
}

function enqueueLegacyRestyle(
  run: Harness,
  context: {
    sessionId: string;
    projectId: string;
    taskId: string;
    initiator: "creator" | "agent";
  },
  divergence?: "graphics",
): JobRecord {
  return run.queue.enqueue({
    kind: "restyle.generate",
    title: "Legacy restyle job",
    cancellable: true,
    payload: {
      plan: structuredClone(run.plan) as unknown as JsonValue,
      chunkId: run.plan.chunks[0]!.id,
      context,
      ...(divergence === undefined ? {} : { divergence }),
    },
  });
}

describe("FR-607/608 restyle execution", () => {
  it("executes the Kling stub, exposes external progress, proposes approval, and freezes on acceptance", async () => {
    const run = await harness(NO_BUDGETS);
    const context = {
      sessionId: "ses_aaaaaaaaaa",
      projectId: "prj_aaaaaaaaaa",
      taskId: run.plan.id,
      initiator: "creator" as const,
    };

    const started: RestyleStartResult = run.service.startPlan({ plan: run.plan, context });
    expect(started).toMatchObject({ verdict: "enqueued", estimate: { amount: 0.14 } });
    if (started.verdict !== "enqueued") throw new Error("Restyle plan was not enqueued.");
    expect(started.jobs).toHaveLength(1);
    expect(started.jobs[0]!.payload).not.toHaveProperty("divergence");
    let sawExternal = false;
    await waitFor(async () => {
      const overview = await run.queue.overview();
      sawExternal ||= overview.waitingOnExternal.some((wait) =>
        wait.provider === "Kling AI" && wait.spendUsd === 0.14 && wait.elapsedSeconds === 0);
      const state = run.queue.get(started.jobs[0]!.jobId)?.state;
      return state === "done" || state === "failed" || state === "cancelled";
    });
    expect(sawExternal).toBe(true);
    const done = run.queue.get(started.jobs[0]!.jobId)!;
    expect(done, done.error?.message).toMatchObject({ state: "done" });
    expect(jobResult(done)).toMatchObject({
      status: "waiting-for-approval",
      proposalId: expect.stringMatching(/^prp_/),
      providerJobId: expect.stringMatching(/^stub-/),
      actualCostUsd: 0,
    });

    const proposalId = String(jobResult(done)["proposalId"]);
    const accepted = await valueOf(run.engine.acceptProposal(proposalId, "creator"));
    expect(accepted.operations.map(({ op }) => op)).toEqual([
      "restyle.segment.approve",
      "clip.split",
      "clip.punchin.set",
    ]);
    const frozen = run.engine.currentProject.assets.find(({ id }) => id === "ast_llllllllll");
    expect(frozen).toMatchObject({
      kind: "generated",
      path: "media/generated/ast_llllllllll.mp4",
      provenance: { sidecar: "provenance-ast_llllllllll" },
      rights: { origin: "generated", restrictions: [] },
    });
    expect(run.engine.currentProject.layers.at(-1)).toMatchObject({
      id: "lyr_llllllllll",
      items: [{
        id: "gfx_llllllllll",
        asset: "ast_llllllllll",
        at: "timeline:seq_aaaaaaaaaa@0",
        duration: { frames: 30, fps: "30/1" },
      }],
    });
    expect(run.engine.currentProject.sequences[0]!.clips.slice(0, 2)).toMatchObject([
      { id: "clp_aaaaaaaaaa", source: { out: { frames: 30, fps: "30/1" } } },
      { source: { in: { frames: 30, fps: "30/1" } }, punchIn: { level: 1.12 } },
    ]);
    await expect(readFile(join(run.projectRoot, frozen!.path))).resolves.not.toHaveLength(0);
    expect(await allTextFiles(run.projectRoot)).not.toContain(SECRET);
    expect(await allTextFiles(join(run.userDir, "audit"))).not.toContain(SECRET);
    expect(run.meter.statusForTask(context.projectId, context.taskId)).toMatchObject({
      taskUsd: 0,
      estimated: { taskUsd: 0.14 },
    });
    run.queue.close();
    run.meter.close();
  }, 30_000);

  it("reclassifies a pre-upgrade short job with no stored divergence", async () => {
    const run = await harness(NO_BUDGETS, true);
    const context = {
      sessionId: "ses_aaaaaaaaaa",
      projectId: "prj_aaaaaaaaaa",
      taskId: run.plan.id,
      initiator: "creator" as const,
    };

    const queued = enqueueLegacyRestyle(run, context);
    expect(queued.payload).not.toHaveProperty("divergence");
    await waitFor(() => {
      const state = run.queue.get(queued.jobId)?.state;
      return state === "done" || state === "failed" || state === "cancelled";
    });
    const done = run.queue.get(queued.jobId)!;
    expect(done, done.error?.message).toMatchObject({ state: "done" });
    const proposalId = String(jobResult(done)["proposalId"]);
    const accepted = await valueOf(run.engine.acceptProposal(proposalId, "creator"));
    expect(accepted.divergence).toBe("graphics");
    run.queue.close();
    run.meter.close();
  }, 30_000);

  it("discards a stale graphics payload when the accepted target is longform", async () => {
    const run = await harness(NO_BUDGETS);
    const context = {
      sessionId: "ses_aaaaaaaaaa",
      projectId: "prj_aaaaaaaaaa",
      taskId: run.plan.id,
      initiator: "creator" as const,
    };

    const queued = enqueueLegacyRestyle(run, context, "graphics");
    expect(queued.payload).toMatchObject({ divergence: "graphics" });
    await waitFor(() => {
      const state = run.queue.get(queued.jobId)?.state;
      return state === "done" || state === "failed" || state === "cancelled";
    });
    const done = run.queue.get(queued.jobId)!;
    expect(done, done.error?.message).toMatchObject({ state: "done" });
    const proposalId = String(jobResult(done)["proposalId"]);
    const accepted = await valueOf(run.engine.acceptProposal(proposalId, "creator"));
    expect(accepted.divergence).toBeUndefined();
    run.queue.close();
    run.meter.close();
  }, 30_000);

  it("blocks the whole plan before enqueueing or calling the adapter when the budget is tiny", async () => {
    const run = await harness({
      ...NO_BUDGETS,
      task: { warnUsd: null, capUsd: 0.01 },
    });
    const result = run.service.startPlan({
      plan: run.plan,
      context: {
        sessionId: "ses_aaaaaaaaaa",
        projectId: "prj_aaaaaaaaaa",
        taskId: run.plan.id,
        initiator: "creator",
      },
    });

    expect(result).toMatchObject({ verdict: "blocked", level: "task" });
    expect(run.queue.list({ kind: "restyle.generate" })).toEqual([]);
    expect(run.audit.readSession("ses_aaaaaaaaaa").records.filter(({ type }) =>
      type === "budget.event")).toEqual([
      expect.objectContaining({ type: "budget.event", kind: "cap_block", projectedUsd: 0.14 }),
    ]);
    run.queue.close();
    run.meter.close();
  });

  it("audits and charges a provider call that fails after the video was sent", async () => {
    const failingApi: KlingApi = {
      submitVideoToVideo: () => Promise.resolve<KlingApiTask>({
        taskId: "kling-task-fail",
        state: "queued",
        progress: 0,
        providerMetadata: {},
      }),
      getTask: () => Promise.resolve<KlingApiTask>({
        taskId: "kling-task-fail",
        state: "failed",
        progress: 0,
        error: "content moderation rejected the segment",
        providerMetadata: {},
      }),
      downloadResult: () => Promise.reject(new Error("no result")),
      cancel: () => Promise.resolve(),
    };
    const run = await harness(NO_BUDGETS, false, () => failingApi);
    const context = {
      sessionId: "ses_aaaaaaaaaa",
      projectId: "prj_aaaaaaaaaa",
      taskId: run.plan.id,
      initiator: "creator" as const,
    };

    const started = run.service.startPlan({ plan: run.plan, context });
    if (started.verdict !== "enqueued") throw new Error("Restyle plan was not enqueued.");
    const queued = started.jobs[0]!;
    await waitFor(() => run.queue.get(queued.jobId)?.state === "failed");

    // The bytes reached the provider, so the call owes a disclosure record even
    // though nothing came back.
    const records = run.audit.readSession("ses_aaaaaaaaaa").records;
    const external = records.filter(({ type }) => type === "external.call");
    expect(external).toEqual([
      expect.objectContaining({
        type: "external.call",
        provider: "Kling AI",
        purpose: "restyle.generate",
        outcome: "error",
        dataClassesSent: ["video", "prompt", "metadata"],
      }),
    ]);
    expect(records.some(({ type }) => type === "cost.charge")).toBe(true);
    expect(run.meter.statusForTask("prj_aaaaaaaaaa", run.plan.id).taskUsd).toBeCloseTo(0.14, 5);
    run.queue.close();
    run.meter.close();
  }, 30_000);

  it("records a single external call when the provider call is cancelled", async () => {
    let polls = 0;
    const slowApi: KlingApi = {
      submitVideoToVideo: () => Promise.resolve<KlingApiTask>({
        taskId: "kling-task-slow",
        state: "queued",
        progress: 0,
        providerMetadata: {},
      }),
      getTask: () => {
        polls += 1;
        return Promise.resolve<KlingApiTask>({
          taskId: "kling-task-slow",
          state: "running",
          progress: 0.1,
          providerMetadata: {},
        });
      },
      downloadResult: () => Promise.reject(new Error("no result")),
      cancel: () => Promise.resolve(),
    };
    const run = await harness(NO_BUDGETS, false, () => slowApi);
    const context = {
      sessionId: "ses_aaaaaaaaaa",
      projectId: "prj_aaaaaaaaaa",
      taskId: run.plan.id,
      initiator: "creator" as const,
    };

    const started = run.service.startPlan({ plan: run.plan, context });
    if (started.verdict !== "enqueued") throw new Error("Restyle plan was not enqueued.");
    const queued = started.jobs[0]!;
    await waitFor(() => polls > 0);
    expect(run.queue.cancel(queued.jobId).ok).toBe(true);
    // JobQueue.cancel marks the record synchronously, so wait for the executor
    // itself to unwind rather than for the job state.
    await waitFor(() => run.audit.readSession("ses_aaaaaaaaaa").records
      .some(({ type }) => type === "external.call"));

    expect(run.audit.readSession("ses_aaaaaaaaaa").records
      .filter(({ type }) => type === "external.call")).toEqual([
      expect.objectContaining({ type: "external.call", outcome: "cancelled" }),
    ]);
    run.queue.close();
    run.meter.close();
  }, 30_000);
});
