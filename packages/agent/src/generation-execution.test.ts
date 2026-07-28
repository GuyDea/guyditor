import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  OperationEngine,
  createProject,
} from "../../core/src/index.js";
import type {
  IdPrefix,
  JobRecord,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { compileRenderGraph } from "../../render/src/index.js";
import type {
  RenderProfile,
  ToolchainManifest,
} from "../../render/src/index.js";
import {
  AdapterRegistry,
  AuditLog,
  CostMeter,
  DeterministicGenerationAdapter,
  GenerationCandidateStore,
  GenerationExecutionService,
} from "./index.js";
import type {
  BudgetConfig,
  GenerationStartResult,
} from "./index.js";
import type { BrollProviderAdapter } from "./adapters/types.js";

const roots: string[] = [];
const NOW = new Date("2026-07-23T10:00:00.000Z");
const NO_BUDGETS: BudgetConfig = {
  task: { warnUsd: null, capUsd: null },
  episode: { warnUsd: null, capUsd: null },
  cumulative: { warnUsd: null, capUsd: null },
};
const PROFILE: RenderProfile = {
  id: "youtube-shorts",
  version: "1.0.0",
  video: { codec: "libx264", crf: 18, pixelFormat: "yuv420p" },
  audio: { codec: "aac", bitrate: "192k" },
  container: "mp4",
};
const TOOLCHAIN: ToolchainManifest = {
  ffmpeg: { version: "test", buildSha256: "a".repeat(64) },
  ffprobe: { version: "test", buildSha256: "b".repeat(64) },
  renderPackage: "0.0.0",
  overlayRenderer: {
    version: "test",
    canvasVersion: "test",
    fontHashes: {},
  },
  encoderThreads: 1,
  os: "linux",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

function ids(): (prefix: IdPrefix) => string {
  const ordinals = new Map<IdPrefix, number>();
  return (prefix) => {
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    const character = String.fromCharCode(109 + ordinal);
    return `${prefix}_${character.repeat(10)}`;
  };
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function waitForJob(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const started = Date.now();
  while (true) {
    const job = queue.get(jobId);
    if (job?.state === "done" || job?.state === "failed") return job;
    if (Date.now() - started > 20_000) throw new Error("Timed out waiting for generation job.");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
}

describe("FR-604/605/606 B-roll generation lifecycle", () => {
  it("runs request through review, freezes and renders, then regenerates to a new asset", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "guyditor-generation-project-"));
    const userDir = await mkdtemp(join(tmpdir(), "guyditor-generation-user-"));
    roots.push(projectRoot, userDir);
    const project = projectFixture();
    project.skills.push({
      id: "skl_bbbbbbbbbb",
      name: "brand_visual",
      version: "2.0.0",
      path: "skills/brand_visual/2.0.0/",
      contentHash: "b".repeat(64),
    });
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "short",
      clips: [{
        id: "clp_cccccccccc",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 0, fps: "24/1" },
          out: { frames: 12, fps: "24/1" },
        },
      }],
    });
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "video",
      name: "short",
      order: 1,
      enabled: true,
      locked: false,
      sequence: "seq_bbbbbbbbbb",
    });
    project.deliverables.push({
      id: "dlv_bbbbbbbbbb",
      kind: "short",
      name: "Short",
      profile: "youtube-shorts@1.0.0",
      sequenceId: "seq_bbbbbbbbbb",
      status: "draft",
      dependencies: [{
        derivativeClipId: "clp_cccccccccc",
        source: {
          assetId: "ast_aaaaaaaaaa",
          range: {
            start: { frames: 0, fps: "24/1" },
            end: { frames: 12, fps: "24/1" },
          },
          longformClipId: "clp_aaaaaaaaaa",
        },
      }],
    });
    const store = await valueOf(createProject(projectRoot, project, { now: () => NOW }));
    const idFactory = ids();
    const engine = new OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: store,
      idFactory,
      now: () => NOW,
    });
    const audit = new AuditLog({ userDir, now: () => NOW });
    const meter = CostMeter.open({ userDir, auditLog: audit, budgets: NO_BUDGETS, now: () => NOW });
    const registry = new AdapterRegistry();
    const adapter = new DeterministicGenerationAdapter();
    registry.register(adapter);
    const queue = JobQueue.open(join(projectRoot, ".guyditor/jobs.sqlite")).queue;
    const service = new GenerationExecutionService({
      projectStore: store,
      operationEngine: engine,
      adapters: registry,
      jobs: queue,
      costMeter: meter,
      idFactory,
      now: () => NOW,
    });
    const context = {
      sessionId: "ses_aaaaaaaaaa",
      projectId: project.project.id,
      taskId: "generate-broll-1",
      initiator: "creator" as const,
    };
    const requested = await service.request({
      adapterId: adapter.descriptor.adapterId,
      context,
      request: {
        requestId: "01K0GENERATIONREQUEST1",
        mode: "video",
        model: "ffmpeg-synth-v1",
        prompt: "Slow orbit around a cobalt glass sculpture",
        width: 320,
        height: 180,
        durationFrames: 12,
        fps: "24/1",
        seed: 17,
        count: 1,
        providerSettings: {},
      },
    });
    expect(requested).toMatchObject({ verdict: "enqueued", estimate: { amount: 0 } });
    if (requested.verdict !== "enqueued") throw new Error("Generation was not enqueued.");
    const done = await waitForJob(queue, requested.job.jobId);
    expect(done, done.error?.message).toMatchObject({
      state: "done",
      payload: {
        status: "waiting-for-review",
        adapterHandle: {
          adapterId: "adp_stubgenaaa",
          providerJobId: "stub-01K0GENERATIONREQUEST1",
        },
      },
    });
    const [candidate] = service.reviewQueue();
    expect(new GenerationCandidateStore({ projectRoot }).list()).toHaveLength(1);
    expect(candidate).toMatchObject({
      candidateId: `${requested.job.jobId}/0`,
      status: "review",
      provenance: {
        generation: {
          adapterId: "adp_stubgenaaa",
          adapterVersion: "1.0.0",
          settingsSchemaHash: expect.stringMatching(/^sha256:/),
        },
      },
      review: {
        state: "open",
        brandVisualSkill: { id: "skl_bbbbbbbbbb", version: "2.0.0" },
      },
    });
    if (candidate === undefined) throw new Error("No generation candidate.");
    await service.addAgentObservation(candidate.candidateId, "visual-artifacts", "No obvious warp detected.");
    expect(service.candidate(candidate.candidateId)?.review.checklist.items.find(({ id }) =>
      id === "visual-artifacts")).toMatchObject({
      state: "pending",
      agentObservation: "No obvious warp detected.",
    });
    for (const item of candidate.review.checklist.items) {
      await service.recordCreatorJudgment(candidate.candidateId, item.id, "pass", "Checked by creator.");
    }
    await service.resolveReview(candidate.candidateId);
    const proposal = await valueOf(service.acceptCandidate(candidate.candidateId, {
      sequenceId: "seq_bbbbbbbbbb",
      atFrame: 24,
      durationFrames: 12,
    }));
    expect(proposal.divergence).toBe("graphics");
    await valueOf(engine.acceptProposal(proposal.id, "creator"));
    const firstAsset = engine.currentProject.assets.at(-1)!;
    expect(firstAsset).toMatchObject({
      kind: "generated",
      path: expect.stringMatching(/^media\/generated\/ast_/),
      rights: {
        origin: "generated",
        providerTermsUrl: "https://guyditor.dev/terms/deterministic-stub",
      },
    });
    await expect(readFile(join(projectRoot, firstAsset.path))).resolves.not.toHaveLength(0);

    const removedRegistry = new AdapterRegistry();
    expect(removedRegistry.generationAvailability("adp_stubgenaaa").available).toBe(false);
    const graph = compileRenderGraph({
      project: engine.currentProject,
      revision: engine.currentProject.revision,
      deliverableId: "dlv_bbbbbbbbbb",
      variant: "clean",
      quality: "high",
      profile: PROFILE,
      profileSha256: "c".repeat(64),
      toolchain: TOOLCHAIN,
    });
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "source",
        params: expect.objectContaining({ path: firstAsset.path }),
      }),
    ]));
    expect(JSON.stringify(graph)).not.toContain("adp_stubgenaaa");

    const regenerated: GenerationStartResult = await service.regenerate(candidate.candidateId, {
      requestId: "01K0GENERATIONREQUEST2",
      context: { ...context, taskId: "generate-broll-2" },
    });
    expect(regenerated.verdict).toBe("enqueued");
    if (regenerated.verdict !== "enqueued") throw new Error("Regeneration was not enqueued.");
    await waitForJob(queue, regenerated.job.jobId);
    const secondCandidate = service.reviewQueue().find(({ candidateId }) =>
      candidateId.startsWith(`${regenerated.job.jobId}/`));
    if (secondCandidate === undefined) throw new Error("No regenerated candidate.");
    for (const item of secondCandidate.review.checklist.items) {
      await service.recordCreatorJudgment(secondCandidate.candidateId, item.id, "pass", "Checked again.");
    }
    await service.resolveReview(secondCandidate.candidateId);
    const secondProposal = await valueOf(service.acceptCandidate(secondCandidate.candidateId, {
      sequenceId: "seq_aaaaaaaaaa",
      atFrame: 48,
      durationFrames: 12,
    }));
    await valueOf(engine.acceptProposal(secondProposal.id, "creator"));
    const secondAsset = engine.currentProject.assets.at(-1)!;
    expect(secondAsset.id).not.toBe(firstAsset.id);
    expect(secondAsset.sha256).toBe(firstAsset.sha256);

    queue.close();
    meter.close();
  }, 30_000);

  it("refuses text overlay settings before cost or enqueue", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "guyditor-generation-guard-"));
    const userDir = await mkdtemp(join(tmpdir(), "guyditor-generation-guard-user-"));
    roots.push(projectRoot, userDir);
    const store = await valueOf(createProject(projectRoot, projectFixture()));
    const engine = new OperationEngine(store.currentProject);
    const audit = new AuditLog({ userDir });
    const meter = CostMeter.open({ userDir, auditLog: audit, budgets: NO_BUDGETS });
    const registry = new AdapterRegistry();
    registry.register(new DeterministicGenerationAdapter());
    const queue = JobQueue.open(join(projectRoot, ".guyditor/jobs.sqlite")).queue;
    const service = new GenerationExecutionService({
      projectStore: store,
      operationEngine: engine,
      adapters: registry,
      jobs: queue,
      costMeter: meter,
    });

    await expect(service.request({
      adapterId: "adp_stubgenaaa",
      context: {
        sessionId: "ses_aaaaaaaaaa",
        projectId: "prj_aaaaaaaaaa",
        taskId: "guard",
        initiator: "creator",
      },
      request: {
        requestId: "01K0GENERATIONGUARD",
        mode: "video",
        model: "ffmpeg-synth-v1",
        prompt: "Chart background",
        width: 320,
        height: 180,
        durationFrames: 12,
        fps: "24/1",
        count: 1,
        providerSettings: { textOverlay: "37%" },
      },
    })).resolves.toMatchObject({
      verdict: "refused",
      error: {
        code: "E_GENERATION_TEXT_OVERLAY",
        suggestion: expect.stringMatching(/programmatic-animation/),
      },
    });
    expect(queue.list({ kind: "broll.generate" })).toEqual([]);
    queue.close();
    meter.close();
  });

  it("audits and charges a provider call that fails after the prompt was sent", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "guyditor-generation-fail-"));
    const userDir = await mkdtemp(join(tmpdir(), "guyditor-generation-fail-user-"));
    roots.push(projectRoot, userDir);
    const store = await valueOf(createProject(projectRoot, projectFixture()));
    const engine = new OperationEngine(store.currentProject);
    const audit = new AuditLog({ userDir });
    const meter = CostMeter.open({ userDir, auditLog: audit, budgets: NO_BUDGETS });
    const stub = new DeterministicGenerationAdapter();
    const failing: BrollProviderAdapter = {
      descriptor: {
        ...stub.descriptor,
        provider: "Failing provider",
        dataClassesSent: ["prompt", "metadata"],
      },
      estimateCost: (request) => stub.estimateCost(request),
      submit: (request, signal) => stub.submit(request, signal),
      poll: () => Promise.resolve({
        state: "failed" as const,
        error: "provider quota exhausted",
        retry: "safe" as const,
      }),
      fetchResult: () => Promise.reject(new Error("no result")),
    };
    const registry = new AdapterRegistry();
    registry.register(failing);
    const queue = JobQueue.open(join(projectRoot, ".guyditor/jobs.sqlite")).queue;
    const service = new GenerationExecutionService({
      projectStore: store,
      operationEngine: engine,
      adapters: registry,
      jobs: queue,
      costMeter: meter,
      sleep: () => Promise.resolve(),
    });

    const started: GenerationStartResult = await service.request({
      adapterId: stub.descriptor.adapterId,
      context: {
        sessionId: "ses_aaaaaaaaaa",
        projectId: "prj_aaaaaaaaaa",
        taskId: "generate-failing",
        initiator: "creator",
      },
      request: {
        requestId: "01K0GENERATIONFAILS",
        mode: "video",
        model: "ffmpeg-synth-v1",
        prompt: "Chart background",
        width: 320,
        height: 180,
        durationFrames: 12,
        fps: "24/1",
        count: 1,
        providerSettings: {},
      },
    });
    if (started.verdict !== "enqueued") throw new Error("Generation was not enqueued.");
    const finished = await waitForJob(queue, started.job.jobId);
    expect(finished.state).toBe("failed");

    expect(audit.readSession("ses_aaaaaaaaaa").records
      .filter(({ type }) => type === "external.call")).toEqual([
      expect.objectContaining({
        type: "external.call",
        provider: "Failing provider",
        purpose: "broll.generate",
        outcome: "error",
        dataClassesSent: ["prompt", "metadata"],
      }),
    ]);
    // The stub prices at zero, so assert the charge was reconciled at all
    // rather than a particular amount.
    expect(audit.readSession("ses_aaaaaaaaaa").records
      .filter(({ type }) => type === "cost.charge")).toHaveLength(1);
    queue.close();
    meter.close();
  });
});
