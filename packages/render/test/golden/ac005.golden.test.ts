import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobQueue, openProject } from "../../../core/src/index.js";
import type { ChromaKeyParams, JobRecord, KeySettings, Result } from "../../../core/src/index.js";
import {
  applyChromaKeyAlpha,
  extractRgbaFrame,
  runKeyQc,
} from "../../../media/src/index.js";
import type { KeyQcReport, RgbaFrame } from "../../../media/src/index.js";
import {
  exportOutputPath,
  RenderService,
} from "../../src/index.js";
import { dhashFrame, hammingDistance } from "./dhash.js";

interface Ac005Manifest {
  id: "AC-005";
  project: string;
  deliverable: string;
  sampleFrame: number;
  edgeGreenExcessMax: number;
  backgroundAlphaMax: number;
  frames: Array<{ frame: number; dhash: string; maxDistance: number }>;
}

const FIXTURE_ROOT = resolve(".fixtures/projects/ac005");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
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
      reject(new Error(`Timed out waiting for AC-005 render ${jobId}.`));
    }, 180_000);
    const unsubscribe = queue.onChange(({ job }) => {
      if (job.jobId !== jobId ||
          (job.state !== "done" && job.state !== "failed" && job.state !== "cancelled")) return;
      clearTimeout(timeout);
      unsubscribe();
      resolveJob(job);
    });
  });
}

function alphaAt(frame: RgbaFrame, x: number, y: number): number {
  return frame.data[(y * frame.width + x) * 4 + 3]! / 255;
}

function backgroundAlphaPeak(matte: RgbaFrame): number {
  let peak = 0;
  for (let y = 0; y < matte.height; y += 48) {
    for (let x = 0; x < matte.width; x += 48) {
      if (x >= 400 && x <= 1_040 && y >= 100 && y <= 620) continue;
      peak = Math.max(peak, alphaAt(matte, x, y));
    }
  }
  return peak;
}

function edgeGreenExcess(composite: RgbaFrame, matte: RgbaFrame): number {
  let total = 0;
  let count = 0;
  for (let y = 0; y < matte.height; y += 1) {
    for (let x = 0; x < matte.width; x += 1) {
      const alpha = alphaAt(matte, x, y);
      if (alpha <= 0.05 || alpha >= 0.95) continue;
      const outputX = Math.min(composite.width - 1, Math.round(x * 1.5));
      const outputY = Math.min(composite.height - 1, Math.round(y * 1.5));
      const offset = (outputY * composite.width + outputX) * 4;
      const red = composite.data[offset]! / 255;
      const green = composite.data[offset + 1]! / 255;
      const blue = composite.data[offset + 2]! / 255;
      total += Math.max(0, green - (red + blue) / 2);
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

function qcPeaks(report: KeyQcReport): Record<string, number> {
  const peak = (key: keyof Omit<KeyQcReport["metrics"][number], "frame">): number =>
    Math.max(0, ...report.metrics.map((metrics) => metrics[key]));
  return {
    haloScore: peak("haloScore"),
    spillScore: peak("spillScore"),
    holeCount: peak("holeCount"),
    holeArea: peak("holeArea"),
    edgeChatter: peak("edgeChatter"),
    detailLoss: peak("detailLoss"),
  };
}

describe.skipIf(!existsSync(FIXTURE_ROOT))("AC-005 keyed presenter sandwich", () => {
  it("keys the fixture, renders all diagnostics, and matches composite goldens", async () => {
    const manifest = JSON.parse(await readFile(
      new URL("./ac005.golden.json", import.meta.url), "utf8",
    )) as Ac005Manifest;
    const root = await mkdtemp(join(tmpdir(), "guyditor-ac005-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, manifest.project);
    await cp(FIXTURE_ROOT, projectRoot, { recursive: true });
    const store = await valueOf(openProject(projectRoot, { appVersion: "0.0.0-ac005" }));
    expect(store.currentProject.layers.slice().sort((left, right) => left.order - right.order)
      .map(({ name }) => name)).toEqual(["background", "presenter", "foreground"]);
    expect(store.currentProject.presets).toContainEqual(expect.objectContaining({
      id: "pre_dddddddddd",
      name: "presenter_sandwich",
      kind: "layout",
      version: 1,
    }));

    const clip = store.currentProject.sequences[0]!.clips[0]!;
    const sourceAsset = store.currentProject.assets.find(({ id }) => id === clip.asset)!;
    const keySettings = clip.effects?.find(({ kind }) => kind === "key")?.params as unknown as KeySettings;
    const chroma = keySettings.chroma as ChromaKeyParams;
    expect(chroma.keyColor).toBe("#00B140");

    const source = await extractRgbaFrame(sourceAsset.path, manifest.sampleFrame, 1280, 720, "30/1");
    const matte = applyChromaKeyAlpha(source, chroma);
    expect(backgroundAlphaPeak(matte)).toBeLessThanOrEqual(manifest.backgroundAlphaMax);

    const qc = await runKeyQc({
      projectRoot,
      sourcePath: sourceAsset.path,
      clipId: clip.id,
      assetId: sourceAsset.id,
      width: 1280,
      height: 720,
      frameCount: 180,
      fps: "30/1",
      keySettings,
    });
    expect(qc).toMatchObject({
      schema: "guyditor.keyqc/v1",
      sampledFrames: Array.from({ length: 15 }, (_, index) => index * 12),
    });
    const peaks = qcPeaks(qc);
    expect(peaks.haloScore).toBeCloseTo(0.344976, 5);
    expect(peaks.spillScore).toBeLessThan(0.05);
    expect(peaks.holeCount).toBe(0);
    expect(peaks.holeArea).toBe(0);
    expect(peaks.edgeChatter).toBeLessThan(0.04);
    expect(peaks.detailLoss).toBeLessThan(0.6);
    expect(qc.warnings.map(({ code }) => code)).toEqual(["halo"]);

    const { queue } = JobQueue.open(join(projectRoot, ".guyditor/jobs-ac005.sqlite"), { concurrency: 1 });
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
        deliverableId: manifest.deliverable,
        variants: ["clean"],
        outputDir,
      });
      expect(await terminal(queue, jobId)).toMatchObject({ state: "done" });
      const compositePath = exportOutputPath(outputDir, manifest.deliverable, "clean", "mp4");
      const comparisons = manifest.frames.map((expected) => {
        const actual = dhashFrame(compositePath, expected.frame);
        return { ...expected, actual, distance: hammingDistance(actual, expected.dhash) };
      });
      expect(comparisons.map(({ actual, distance, dhash, maxDistance }) => ({
        actual, expected: dhash, withinTolerance: distance <= maxDistance,
      }))).toEqual(comparisons.map(({ actual, dhash }) => ({
        actual, expected: dhash, withinTolerance: true,
      })));

      const excessByBackground: Record<string, number> = {};
      for (const background of ["black", "white", "saturated", "checkerboard"] as const) {
        const diagnostic = await render.renderDiagnostic({
          revision: store.currentProject.revision,
          deliverableId: manifest.deliverable,
          inspectedLayerId: "lyr_bbbbbbbbbb",
          diagnosticBackground: background,
          outputDir: join(outputDir, "diagnostics"),
        });
        expect(await terminal(queue, diagnostic.jobId)).toMatchObject({ state: "done" });
        const composite = await extractRgbaFrame(
          diagnostic.outputPath, manifest.sampleFrame, 1920, 1080, "30/1",
        );
        excessByBackground[background] = edgeGreenExcess(composite, matte);
      }
      expect(excessByBackground).toEqual({
        black: expect.any(Number),
        white: expect.any(Number),
        saturated: expect.any(Number),
        checkerboard: expect.any(Number),
      });
      expect(Object.values(excessByBackground).every((value) =>
        value < manifest.edgeGreenExcessMax)).toBe(true);
    } finally {
      queue.close();
    }
  }, 240_000);
});
