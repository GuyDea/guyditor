import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobQueue, OperationEngine, openProject } from "../../../core/src/index.js";
import type { JobRecord, Result } from "../../../core/src/index.js";
import { resolveFfmpeg } from "../../../media/src/index.js";
import { RenderService, exportOutputPath } from "../../src/index.js";
import { dhashFrame, hammingDistance } from "./dhash.js";

interface GoldenManifest {
  id: string;
  project: string;
  deliverable: string;
  frames: Array<{
    at: { frames: number; fps: string };
    dhash: string;
    maxDistance: number;
    reason: string;
  }>;
  toolVersions: { ffmpeg: string; overlayRenderer: string };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true }),
  ));
});

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
      reject(new Error(`Timed out waiting for golden render ${jobId}.`));
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

describe("AC-001 golden composition", () => {
  it("matches four M1-renderable frames within the declared dHash tolerance", async () => {
    const manifest = JSON.parse(await readFile(
      new URL("./ac001.golden.json", import.meta.url),
      "utf8",
    )) as GoldenManifest;
    expect(resolveFfmpeg().version).toBe(manifest.toolVersions.ffmpeg);
    expect(manifest.toolVersions.overlayRenderer).toBe("not-used-m1");

    const root = await mkdtemp(join(tmpdir(), "guyditor-ac001-golden-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, manifest.project);
    await cp(resolve(".fixtures/projects", manifest.project), projectRoot, { recursive: true });
    const store = await valueOf(openProject(projectRoot, { appVersion: "0.0.0-golden" }));
    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-golden",
      committer: store,
      idFactory: (prefix) => `${prefix}_goldenfram`,
    });
    await valueOf(engine.execute([
      {
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: 5, fps: "30/1" },
          snapPolicy: "none",
        },
      },
      {
        op: "clip.trim",
        params: {
          clipId: "clp_bbbbbbbbbb",
          edge: "head",
          delta: { frames: 3, fps: "30/1" },
          snapPolicy: "none",
        },
      },
      { op: "clip.split", params: { clipId: "clp_cccccccccc", at: 18 } },
      { op: "clip.move", params: { clipId: "clp_dddddddddd", toIndex: 0 } },
    ], {
      baseRevision: engine.currentProject.revision,
      dryRun: false,
      origin: "ui",
    }));
    const { queue } = JobQueue.open(join(projectRoot, ".guyditor/jobs.sqlite"), {
      concurrency: 1,
    });
    try {
      const render = new RenderService({
        projectRoot,
        store,
        jobQueue: queue,
        profilesRoot: resolve("profiles"),
      });
      const outputDir = join(root, "exports");
      const { jobId } = await render.renderExport({
        revision: engine.currentProject.revision,
        deliverableId: manifest.deliverable,
        variants: ["clean"],
        outputDir,
      });
      expect(await terminal(queue, jobId)).toMatchObject({ state: "done" });
      const output = exportOutputPath(outputDir, manifest.deliverable, "clean", "mp4");
      const comparisons = manifest.frames.map((frame) => {
        const actual = dhashFrame(output, frame.at.frames);
        return {
          actual,
          expected: frame.dhash,
          distance: hammingDistance(actual, frame.dhash),
          maxDistance: frame.maxDistance,
          reason: frame.reason,
        };
      });
      expect(comparisons.map(({ actual, distance, expected, maxDistance, reason }) => ({
        actual,
        expected,
        withinTolerance: distance <= maxDistance,
        reason,
      }))).toEqual(comparisons.map(({ actual, expected, reason }) => ({
        actual,
        expected,
        withinTolerance: true,
        reason,
      })));
    } finally {
      queue.close();
    }
  }, 150_000);
});
