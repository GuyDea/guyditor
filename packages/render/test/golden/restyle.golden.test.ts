import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  OperationEngine,
  openProject,
  parseRestylePlan,
} from "../../../core/src/index.js";
import type {
  IdPrefix,
  JobRecord,
  Proposal,
  Result,
} from "../../../core/src/index.js";
import { createRestylePlan } from "../../../deliver/src/index.js";
import {
  AdapterRegistry,
  AuditLog,
  CostMeter,
  FileCredentialStore,
  KlingRestyleAdapter,
  RestyleExecutionService,
} from "../../../agent/src/index.js";
import { resolveFfmpeg } from "../../../media/src/index.js";
import { RenderService, exportOutputPath } from "../../src/index.js";
import { dhashFrame, rgbFrameHash } from "./dhash.js";

interface RestyleGoldenManifest {
  id: string;
  project: string;
  deliverable: string;
  filteredFrame: { at: number; dhash: string; rgbHash: string; maxDistance: number };
  untouchedFrame: { at: number; dhash: string; rgbHash: string; maxDistance: number };
  toolVersions: { ffmpeg: string; stubFilter: string };
}

const temporaryDirectories: string[] = [];
const NOW = new Date("2026-07-19T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true }),
  ));
});

function ids(): (prefix: IdPrefix) => string {
  const ordinals = new Map<IdPrefix, number>();
  const alphabet = "bcdefghijklmnopqrstuvwxyz";
  return (prefix) => {
    if (prefix === "ast" || prefix === "lyr" || prefix === "gfx") {
      return `${prefix}_llllllllll`;
    }
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    return `${prefix}_${alphabet[Math.min(ordinal, alphabet.length - 1)]!.repeat(10)}`;
  };
}

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

async function terminal(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const current = queue.get(jobId);
  if (current?.state === "done" || current?.state === "failed" || current?.state === "cancelled") {
    return current;
  }
  return new Promise<JobRecord>((resolveJob, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for restyle golden job ${jobId}.`));
    }, 120_000);
    const unsubscribe = queue.onChange(({ job }) => {
      if (
        job.jobId === jobId &&
        (job.state === "done" || job.state === "failed" || job.state === "cancelled")
      ) {
        clearTimeout(timeout);
        unsubscribe();
        resolveJob(job);
      }
    });
  });
}

function proposalId(job: JobRecord): string {
  if (typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) {
    throw new Error("Restyle golden job has no result payload.");
  }
  const value = job.payload["proposalId"];
  if (typeof value !== "string") throw new Error("Restyle golden job has no proposal ID.");
  return value;
}

describe("FR-607/608 Kling stub golden", () => {
  it("filters only the approved chunk in a burnin render and freezes its provenance", async () => {
    const manifest = JSON.parse(await readFile(
      new URL("./restyle.golden.json", import.meta.url),
      "utf8",
    )) as RestyleGoldenManifest;
    expect(resolveFfmpeg().version).toBe(manifest.toolVersions.ffmpeg);
    expect(manifest.toolVersions.stubFilter).toBe("curves+hue-v1");

    const root = await mkdtemp(join(tmpdir(), "guyditor-restyle-golden-"));
    temporaryDirectories.push(root);
    const userDir = join(root, "user");
    const projectRoot = join(root, manifest.project);
    await cp(resolve(".fixtures/projects", manifest.project), projectRoot, { recursive: true });
    const store = await valueOf(openProject(projectRoot, { appVersion: "0.0.0-golden" }));
    const idFactory = ids();
    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-golden",
      committer: store,
      proposalStore: store,
      idFactory,
      now: () => NOW,
    });
    const planned = createRestylePlan({
      project: store.currentProject,
      deliverableId: manifest.deliverable,
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
      prompt: "Cinematic watercolor documentary",
      providerSettings: {},
      seed: 607,
      createdAt: NOW.toISOString(),
      signals: { words: [], beats: [], vadSilences: [], lowMotionFrames: [] },
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw planned.error;
    const planProposal = await valueOf(engine.createProposal({
      operations: [{
        op: "restyle.plan.create",
        params: { deliverableId: manifest.deliverable, plan: planned.value },
      }],
      instruction: { kind: "user-text", text: "Restyle the opening second" },
      actor: { kind: "agent", id: "ses_aaaaaaaaaa", model: "golden" },
      sessionId: "ses_aaaaaaaaaa",
      reason: {
        text: "Exercise the accepted segmented restyle path.",
        sources: [{ kind: "instruction", ref: manifest.id }],
      },
      addresses: [],
    }));
    await valueOf(engine.acceptProposal(planProposal.id, "creator"));

    const credentials = new FileCredentialStore({ userDir });
    const audit = new AuditLog({ userDir, now: () => NOW });
    const meter = CostMeter.open({
      userDir,
      auditLog: audit,
      budgets: {
        task: { warnUsd: null, capUsd: null },
        episode: { warnUsd: null, capUsd: null },
        cumulative: { warnUsd: null, capUsd: null },
      },
      now: () => NOW,
    });
    const registry = new AdapterRegistry();
    registry.register(new KlingRestyleAdapter({
      credentials,
      config: { apiKeyRef: "apiKey", model: "kling-video-o1", concurrency: 1 },
    }));
    const { queue } = JobQueue.open(join(projectRoot, ".guyditor/jobs.sqlite"), {
      concurrency: 1,
    });
    try {
      const restyle = new RestyleExecutionService({
        projectStore: store,
        operationEngine: engine,
        adapters: registry,
        jobs: queue,
        costMeter: meter,
        idFactory,
        now: () => NOW,
      });
      const started = restyle.startPlan({
        plan: planned.value,
        context: {
          sessionId: "ses_aaaaaaaaaa",
          projectId: store.currentProject.project.id,
          taskId: planned.value.id,
          initiator: "creator",
        },
      });
      expect(started.verdict).toBe("enqueued");
      if (started.verdict !== "enqueued") throw new Error(started.message);
      const generated = await terminal(queue, started.jobs[0]!.jobId);
      expect(generated, generated.error?.message).toMatchObject({ state: "done" });
      const approval = await valueOf(engine.acceptProposal(proposalId(generated), "creator"));
      expect(approval).toMatchObject({ status: "accepted" } satisfies Partial<Proposal>);

      const acceptedPlanRef = store.currentProject.sidecars.find(({ schema }) =>
        schema === "guyditor.restyle/v1");
      if (acceptedPlanRef === undefined) throw new Error("Accepted restyle plan sidecar is missing.");
      const acceptedPlan = parseRestylePlan(await readFile(
        join(projectRoot, acceptedPlanRef.path),
        "utf8",
      ));
      expect(acceptedPlan).toMatchObject({
        ok: true,
        value: { chunks: [{ status: "approved", assetId: expect.stringMatching(/^ast_/) }] },
      });
      const frozen = store.currentProject.assets.find(({ kind, provenance }) =>
        kind === "generated" && provenance?.sidecar.startsWith("provenance-"));
      expect(frozen).toBeDefined();
      await expect(readFile(join(projectRoot, frozen!.path))).resolves.not.toHaveLength(0);
      const provenanceRef = store.currentProject.sidecars.find(({ name }) =>
        name === frozen!.provenance!.sidecar);
      const provenance = JSON.parse(await readFile(
        join(projectRoot, provenanceRef!.path),
        "utf8",
      )) as Record<string, unknown>;
      expect(provenance).toMatchObject({
        generation: {
          provider: "Kling AI",
          model: "kling-video-o1",
          sourceRange: { startFrame: 0, endFrame: 30 },
          providerMetadata: { filter: manifest.toolVersions.stubFilter },
        },
        rights: { origin: "generated" },
        contentHash: expect.stringMatching(/^sha256:/),
      });

      const render = new RenderService({
        projectRoot,
        store,
        jobQueue: queue,
        profilesRoot: resolve("profiles"),
      });
      const outputDir = join(root, "exports");
      const renderJob = await render.renderExport({
        revision: store.currentProject.revision,
        deliverableId: manifest.deliverable,
        variants: ["burnin"],
        outputDir,
      });
      const rendered = await terminal(queue, renderJob.jobId);
      expect(rendered, rendered.error?.message).toMatchObject({ state: "done" });
      const output = exportOutputPath(outputDir, manifest.deliverable, "burnin", "mp4");
      const source = store.currentProject.assets.find(({ id }) => id === "ast_aaaaaaaaaa")!.path;
      const filteredHash = dhashFrame(output, manifest.filteredFrame.at);
      const untouchedHash = dhashFrame(output, manifest.untouchedFrame.at);
      expect(filteredHash).toBe(manifest.filteredFrame.dhash);
      expect(untouchedHash).toBe(manifest.untouchedFrame.dhash);
      const filteredRgbHash = rgbFrameHash(output, manifest.filteredFrame.at);
      const untouchedRgbHash = rgbFrameHash(output, manifest.untouchedFrame.at);
      expect(filteredRgbHash).toBe(manifest.filteredFrame.rgbHash);
      expect(untouchedRgbHash).toBe(manifest.untouchedFrame.rgbHash);
      expect(filteredRgbHash).not.toBe(rgbFrameHash(source, manifest.filteredFrame.at));
      expect(untouchedHash).toBe(dhashFrame(source, manifest.untouchedFrame.at));
    } finally {
      queue.close();
      meter.close();
    }
  }, 180_000);
});
