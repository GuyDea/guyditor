import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  openProject,
} from "../../../core/src/index.js";
import type { JobRecord, Result, TransactionRecord } from "../../../core/src/index.js";
import {
  framingSidecarReference,
  writeFramingSidecar,
} from "../../../deliver/src/index.js";
import type { FramingSidecar } from "../../../deliver/src/index.js";
import { probeMedia } from "../../../media/src/index.js";
import { exportOutputPath, RenderService } from "../../src/index.js";
import { dhashFrame, hammingDistance, rgbFrameHash } from "./dhash.js";

interface VerticalGolden {
  id: string;
  project: string;
  deliverable: string;
  frame: number;
  dhash: string;
  rgbHash: string;
  maxDistance: number;
}

const FIXTURE_ROOT = resolve(".fixtures/projects/basic");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function terminal(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const current = queue.get(jobId);
  if (current?.state === "done" || current?.state === "failed" || current?.state === "cancelled") return current;
  return new Promise<JobRecord>((resolveJob, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for vertical golden ${jobId}.`));
    }, 180_000);
    const unsubscribe = queue.onChange(({ job }) => {
      if (job.jobId !== jobId || (job.state !== "done" && job.state !== "failed" && job.state !== "cancelled")) return;
      clearTimeout(timeout);
      unsubscribe();
      resolveJob(job);
    });
  });
}

describe.skipIf(!existsSync(FIXTURE_ROOT))("FR-803 vertical export golden", () => {
  it("renders the short fixture at 1080x1920 through shot crop lowering", async () => {
    const manifest = JSON.parse(await readFile(
      new URL("./vertical.golden.json", import.meta.url), "utf8",
    )) as VerticalGolden;
    const root = await mkdtemp(join(tmpdir(), "guyditor-vertical-golden-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, manifest.project);
    await cp(FIXTURE_ROOT, projectRoot, { recursive: true });
    const store = await valueOf(openProject(projectRoot, { appVersion: "0.0.0-vertical-golden" }));
    const model = structuredClone(store.currentProject);
    model.revision = "rev_00002";
    const sourceSequence = model.sequences.find(({ id }) => id === "seq_aaaaaaaaaa")!;
    const sequence = structuredClone(sourceSequence);
    sequence.id = "seq_bbbbbbbbbb";
    sequence.name = "vertical golden";
    sequence.clips.forEach((clip, index) => {
      clip.id = ["clp_eeeeeeeeee", "clp_ffffffffff", "clp_gggggggggg", "clp_hhhhhhhhhh"][index]!;
    });
    model.sequences.push(sequence);
    model.layers.push({
      id: "lyr_dddddddddd",
      kind: "video",
      name: "Vertical golden video",
      order: 3,
      enabled: true,
      locked: false,
      sequence: sequence.id,
    });
    const deliverable = {
      id: manifest.deliverable,
      kind: "short" as const,
      name: "vertical golden",
      profile: "youtube-shorts@1.0.0",
      sequenceId: sequence.id,
      status: "draft" as const,
    };
    model.deliverables.push(deliverable);
    const cropWidth = 0.31640625;
    const sidecar: FramingSidecar = {
      format: "guyditor.framing/v1",
      deliverableId: deliverable.id,
      profile: deliverable.profile,
      sourceRevision: "rev_00002",
      aspect: "9:16",
      requiredTrackAssets: [],
      decisions: sequence.clips.map((clip, index) => ({
        decisionId: `fd_${String(index + 1).padStart(4, "0")}`,
        shot: {
          clipId: clip.id,
          source: { start: clip.source.in, end: clip.source.out },
        },
        mode: "crop" as const,
        crop: { keyframes: [{
          at: clip.source.in,
          rect: { x: (1 - cropWidth) / 2, y: 0, w: cropWidth, h: 1 },
        }] },
        subjects: [],
        confidence: 0,
        warnings: [],
      })),
    };
    await writeFramingSidecar(projectRoot, sidecar, []);
    model.sidecars.push(framingSidecarReference(sidecar, []));
    const transaction: TransactionRecord = {
      id: "txn_verticalgd",
      baseRevision: "rev_00001",
      resultRevision: "rev_00002",
      operations: [{
        op: "deliverable.vertical.fixture",
        params: { deliverableId: deliverable.id },
        summary: "Prepare vertical render golden",
      }],
      instruction: { kind: "ui-direct" },
      actor: { kind: "tool", id: "golden" },
      versions: {
        app: "0.0.0-vertical-golden",
        schema: "guyditor/v1",
        skills: model.skills.map(({ id, version }) => ({ id, version })),
        presets: model.presets.map(({ id, version }) => ({ id, version })),
        tools: [],
      },
      acceptance: {
        status: "accepted",
        by: "golden",
        at: "2026-07-22T00:00:00.000Z",
      },
      orphanedAnchors: [],
      addresses: [],
    };
    await valueOf(store.commit(model, transaction));
    const { queue } = JobQueue.open(join(projectRoot, ".guyditor/jobs.sqlite"), { concurrency: 1 });
    try {
      const render = new RenderService({
        projectRoot,
        store,
        jobQueue: queue,
        profilesRoot: resolve("profiles"),
      });
      const outputDir = join(root, "exports");
      const { jobId } = await render.renderExport({
        revision: store.currentProject.revision,
        deliverableId: deliverable.id,
        variants: ["clean"],
        outputDir,
      });
      const completed = await terminal(queue, jobId);
      expect(completed, completed.error?.message).toMatchObject({ state: "done" });
      const output = exportOutputPath(outputDir, deliverable.id, "clean", "mp4");
      const probe = await probeMedia(output);
      expect(probe.video).toMatchObject({ width: 1080, height: 1920 });
      const actual = dhashFrame(output, manifest.frame);
      expect({ actual, withinTolerance: hammingDistance(actual, manifest.dhash) <= manifest.maxDistance })
        .toEqual({ actual: manifest.dhash, withinTolerance: true });
      expect(rgbFrameHash(output, manifest.frame)).toBe(manifest.rgbHash);
    } finally {
      queue.close();
    }
  }, 200_000);
});
