import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  RenderService,
  TemplateRegistry,
  exportOutputPath,
  renderGraphicFrame,
  renderGraphicOverlaySequence,
} from "../../src/index.js";
import { rgbFrameHash } from "./dhash.js";

interface RestyleGoldenManifest {
  id: string;
  project: string;
  deliverable: string;
  filteredFrames: Array<{ at: number; sourceAt: number; rgbHash: string }>;
  interstitialFrame: { at: number; rgbHash: string; overlayPngSha256: string };
  exactResume: {
    outputFrames: [number, number];
    generatedFrames: [number, number];
    maxRegionMae: number;
  };
  punchInFrame: { at: number; sourceAt: number; level: number; rgbHash: string };
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
  const alphabet = "lmnopqrstuvwxyz234567abcdefghijk";
  return (prefix) => {
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

function frameRegion(filePath: string, frame: number): Buffer {
  const ffmpeg = resolveFfmpeg();
  const result = spawnSync(ffmpeg.path, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    filePath,
    "-vf",
    `select=eq(n\\,${String(frame)}),crop=260:150:0:0,scale=130:75:flags=neighbor,format=rgb24`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "pipe:1",
  ], { encoding: null, maxBuffer: 1024 * 1024, shell: false });
  if (result.error !== undefined || result.status !== 0 || result.stdout.length !== 130 * 75 * 3) {
    throw new Error(`Could not extract frame-counter region ${String(frame)} from ${filePath}.`);
  }
  return result.stdout;
}

function meanAbsoluteError(left: Buffer, right: Buffer): number {
  expect(left.length).toBe(right.length);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index]! - right[index]!);
  }
  return difference / left.length;
}

describe("FR-607/608/609 Kling stub golden", () => {
  it("completes plan, generation, seam approval, exact resume, and punch-in in one burnin workflow", async () => {
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
    const templateRegistry = new TemplateRegistry({
      builtinsRoot: resolve("templates"),
      userRoot: join(userDir, "templates"),
      projectRoot: join(projectRoot, "templates"),
    });
    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-golden",
      committer: store,
      proposalStore: store,
      idFactory,
      now: () => NOW,
      templateProvider: templateRegistry,
    });
    const planned = createRestylePlan({
      project: store.currentProject,
      deliverableId: manifest.deliverable,
      coverage: [{ startFrame: 0, endFrame: 60 }],
      adapterId: "adp_klingaaaaa",
      model: "kling-video-o1",
      constraints: {
        maxSegmentSeconds: 1,
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
    expect(planned.value.chunks.map(({ sourceRange }) => sourceRange)).toEqual([
      { startFrame: 0, endFrame: 30 },
      { startFrame: 30, endFrame: 60 },
    ]);
    expect(planned.value.seams).toMatchObject([
      {
        frame: 30,
        boundary: "internal",
        treatment: {
          kind: "interstitial",
          templateId: "tpl_d2e3f4g5h6",
          durationFrames: 30,
          resumeExact: true,
        },
      },
      {
        frame: 60,
        boundary: "restyled-to-untouched",
        treatment: { kind: "punch-in" },
      },
    ]);
    const planProposal = await valueOf(engine.createProposal({
      operations: [{
        op: "restyle.plan.create",
        params: { deliverableId: manifest.deliverable, plan: planned.value },
      }],
      instruction: { kind: "user-text", text: "Restyle the opening second" },
      actor: { kind: "agent", id: "ses_aaaaaaaaaa", model: "golden" },
      sessionId: "ses_aaaaaaaaaa",
      reason: {
        text: "Exercise the accepted segmented restyle and seam path.",
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
      for (const startedJob of started.jobs) {
        const generated = await terminal(queue, startedJob.jobId);
        expect(generated, generated.error?.message).toMatchObject({ state: "done" });
        let proposal = await valueOf(store.readProposal(proposalId(generated)));
        if (proposal.baseRevision !== store.currentProject.revision) {
          proposal = await valueOf(engine.supersedeProposal(proposal.id, {
            operations: proposal.operations.map(({ op, params }) => ({ op, params })),
            instruction: structuredClone(proposal.instruction),
            actor: structuredClone(proposal.actor),
            ...(proposal.sessionId === undefined ? {} : { sessionId: proposal.sessionId }),
            reason: {
              text: `${proposal.reason.text} Rebased for sequential golden approval.`,
              sources: [...proposal.reason.sources],
            },
            addresses: [...proposal.addresses],
          }));
        }
        const approval = await valueOf(engine.acceptProposal(proposal.id, "creator"));
        expect(approval).toMatchObject({ status: "accepted" } satisfies Partial<Proposal>);
      }

      const acceptedPlanRef = store.currentProject.sidecars.find(({ schema }) =>
        schema === "guyditor.restyle/v1");
      if (acceptedPlanRef === undefined) throw new Error("Accepted restyle plan sidecar is missing.");
      const acceptedPlan = parseRestylePlan(await readFile(
        join(projectRoot, acceptedPlanRef.path),
        "utf8",
      ));
      expect(acceptedPlan).toMatchObject({
        ok: true,
        value: {
          chunks: [
            { status: "approved", assetId: expect.stringMatching(/^ast_/) },
            { status: "approved", assetId: expect.stringMatching(/^ast_/) },
          ],
          seams: [
            { status: "applied", treatment: { kind: "interstitial", resumeExact: true } },
            { status: "applied", treatment: { kind: "punch-in" } },
          ],
        },
      });
      if (!acceptedPlan.ok) throw acceptedPlan.error;
      const frozen = acceptedPlan.value.chunks.map((chunk) =>
        store.currentProject.assets.find(({ id }) => id === chunk.assetId));
      expect(frozen).toHaveLength(2);
      expect(frozen.every((asset) => asset?.kind === "generated")).toBe(true);
      await Promise.all(frozen.map((asset) =>
        expect(readFile(join(projectRoot, asset!.path))).resolves.not.toHaveLength(0)));
      const provenanceRef = store.currentProject.sidecars.find(({ name }) =>
        name === frozen[0]!.provenance!.sidecar);
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

      const seam = acceptedPlan.value.seams.find(({ boundary }) => boundary === "internal")!;
      const graphicOptions = {
        project: store.currentProject,
        sequenceId: acceptedPlan.value.sequenceId,
        registry: templateRegistry,
        width: store.currentProject.settings.timeline.width,
        height: store.currentProject.settings.timeline.height,
        fps: store.currentProject.settings.timeline.fps,
        brand: { palette: {} },
      };
      const painted = await renderGraphicFrame({ ...graphicOptions, frame: seam.frame });
      const overlayPlan = await renderGraphicOverlaySequence({
        ...graphicOptions,
        cacheRoot: join(root, "seam-overlay"),
      });
      if (overlayPlan === undefined) throw new Error("Applied seam did not paint an overlay.");
      expect(overlayPlan).toMatchObject({ atOutputFrame: 30, durationFrames: 30 });
      const cachedFirstFrame = await readFile(
        overlayPlan.pathPattern.replace("%08d", "00000000"),
      );
      expect(cachedFirstFrame.equals(painted)).toBe(true);
      expect(createHash("sha256").update(painted).digest("hex"))
        .toBe(manifest.interstitialFrame.overlayPngSha256);

      const sequence = store.currentProject.sequences.find(({ id }) => id === acceptedPlan.value.sequenceId)!;
      const punchClip = sequence.clips.find(({ punchIn }) => punchIn?.level === manifest.punchInFrame.level);
      expect(punchClip?.punchIn).toEqual({
        level: manifest.punchInFrame.level,
        anchor: { x: 0.5, y: 0.5 },
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
      const actualHashes = {
        filtered: manifest.filteredFrames.map((frame) => rgbFrameHash(output, frame.at)),
        interstitial: rgbFrameHash(output, manifest.interstitialFrame.at),
        punchIn: rgbFrameHash(output, manifest.punchInFrame.at),
      };
      expect(actualHashes).toEqual({
        filtered: manifest.filteredFrames.map(({ rgbHash }) => rgbHash),
        interstitial: manifest.interstitialFrame.rgbHash,
        punchIn: manifest.punchInFrame.rgbHash,
      });
      for (const [index, frame] of manifest.filteredFrames.entries()) {
        expect(actualHashes.filtered[index]).not.toBe(rgbFrameHash(source, frame.sourceAt));
      }
      expect(actualHashes.punchIn)
        .not.toBe(rgbFrameHash(source, manifest.punchInFrame.sourceAt));

      const secondGenerated = join(projectRoot, frozen[1]!.path);
      const [resume0, resume1] = manifest.exactResume.outputFrames;
      const [generated0, generated1] = manifest.exactResume.generatedFrames;
      const outputRegion0 = frameRegion(output, resume0);
      const outputRegion1 = frameRegion(output, resume1);
      const generatedRegion0 = frameRegion(secondGenerated, generated0);
      const generatedRegion1 = frameRegion(secondGenerated, generated1);
      const correct0 = meanAbsoluteError(outputRegion0, generatedRegion0);
      const incorrect0 = meanAbsoluteError(outputRegion0, generatedRegion1);
      const correct1 = meanAbsoluteError(outputRegion1, generatedRegion1);
      const incorrect1 = meanAbsoluteError(outputRegion1, generatedRegion0);
      expect(correct0).toBeLessThanOrEqual(manifest.exactResume.maxRegionMae);
      expect(correct1).toBeLessThanOrEqual(manifest.exactResume.maxRegionMae);
      expect(correct0).toBeLessThan(incorrect0);
      expect(correct1).toBeLessThan(incorrect1);
    } finally {
      queue.close();
      meter.close();
    }
  }, 180_000);
});
