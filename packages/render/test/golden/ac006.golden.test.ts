import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalizeYaml,
  JobQueue,
  openProject,
  OperationEngine,
  resolveAnchor,
} from "../../../core/src/index.js";
import type { JobRecord, Result } from "../../../core/src/index.js";
import { CompositorModel, constraintsFromDrag, pipPlaceOperation, solvePlacement } from "../../../compositor/src/index.js";
import { createTranscriptWordLookup, parseTranscriptSidecar } from "../../../transcript/src/index.js";
import { exportOutputPath, RenderService } from "../../src/index.js";
import { dhashFrame, hammingDistance } from "./dhash.js";

interface Ac006Manifest {
  id: "AC-006";
  project: string;
  deliverable: string;
  anchorFrame: number;
  midpointFrame: number;
  dhash: string;
  maxDistance: number;
}

const FIXTURE_ROOT = resolve(".fixtures/projects/ac006");
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
  if (current?.state === "done" || current?.state === "failed" || current?.state === "cancelled") return current;
  return new Promise<JobRecord>((resolveJob, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for AC-006 render ${jobId}.`));
    }, 180_000);
    const unsubscribe = queue.onChange(({ job }) => {
      if (job.jobId !== jobId || (job.state !== "done" && job.state !== "failed" && job.state !== "cancelled")) return;
      clearTimeout(timeout);
      unsubscribe();
      resolveJob(job);
    });
  });
}

function changedLineCount(before: string, after: string): number {
  const left = before.trimEnd().split("\n");
  const right = after.trimEnd().split("\n");
  const row = new Array<number>(right.length + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const prior = row[rightIndex]!;
      row[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? diagonal + 1
        : Math.max(row[rightIndex]!, row[rightIndex - 1]!);
      diagonal = prior;
    }
  }
  const common = row[right.length]!;
  return left.length + right.length - common * 2;
}

describe.skipIf(!existsSync(FIXTURE_ROOT))("AC-006 semantic PiP movement", () => {
  it("keeps the master diff small and matches the preview midpoint golden", async () => {
    const manifest = JSON.parse(await readFile(
      new URL("./ac006.golden.json", import.meta.url), "utf8",
    )) as Ac006Manifest;
    const temporary = await mkdtemp(join(tmpdir(), "guyditor-ac006-"));
    temporaryDirectories.push(temporary);
    const projectRoot = join(temporary, manifest.project);
    await cp(FIXTURE_ROOT, projectRoot, { recursive: true });
    const store = await valueOf(openProject(projectRoot, { appVersion: "0.0.0-ac006" }));
    const before = canonicalizeYaml(store.currentProject);
    const transcript = parseTranscriptSidecar(await readFile(
      join(projectRoot, "sidecars/transcript-speech.json"), "utf8",
    ));
    const compositor = new CompositorModel();
    const lookup = createTranscriptWordLookup([transcript]);
    expect(await lookup.resolveWord(store.currentProject, "w000123")).toMatchObject({
      ok: true, value: { assetId: "ast_cccccccccc" },
    });
    const resolvedAnchor = await resolveAnchor(
      store.currentProject,
      "word:w000123",
      "seq_aaaaaaaaaa",
      { wordLookup: lookup },
    );
    expect(resolvedAnchor).toMatchObject({
      ok: true,
      value: { status: "resolved", timeline: { frames: manifest.anchorFrame, fps: "30/1" } },
    });
    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-ac006",
      committer: store,
      operationDispatcher: compositor.dispatchOperation,
      anchorResolvers: { wordLookup: lookup },
    });
    const initial = store.currentProject.layers.find(({ id }) => id === "lyr_bbbbbbbbbb")!.pip!;
    const solved = solvePlacement(initial.placement.base, 1920, 1080);
    const draggedPlacement = constraintsFromDrag({ ...solved, x: 0.04 }, 1920, 1080, initial.placement.base);
    const dragOperation = pipPlaceOperation("lyr_bbbbbbbbbb", draggedPlacement);

    const ui = new OperationEngine(store.currentProject, { operationDispatcher: compositor.dispatchOperation });
    const agent = new OperationEngine(store.currentProject, { operationDispatcher: compositor.dispatchOperation });
    const uiDryRun = await ui.execute([dragOperation], {
      baseRevision: store.currentProject.revision, origin: "ui", dryRun: true,
    });
    const agentDryRun = await agent.execute([dragOperation], {
      baseRevision: store.currentProject.revision, origin: "agent", dryRun: true,
    });
    expect(agentDryRun).toEqual(uiDryRun);

    const applied = await engine.execute([
      pipPlaceOperation("lyr_bbbbbbbbbb", {
        anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9",
      }),
      dragOperation,
      {
        op: "pip.preset.apply",
        params: {
          layerId: "lyr_bbbbbbbbbb",
          keyframeId: "kfr_aaaaaaaaaa",
          at: "word:w000123",
          placement: { anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9" },
          presetId: "pre_pipsmoothm",
          version: 1,
          durationFrames: 18,
        },
      },
    ], { baseRevision: store.currentProject.revision, origin: "ui", dryRun: false });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const after = canonicalizeYaml(store.currentProject);
    const lineCount = changedLineCount(before, after);
    expect(lineCount).toBe(20);
    expect(lineCount).toBeLessThanOrEqual(20);
    expect(after).toContain("preset: pre_pipsmoothm");
    expect(after).toContain("version: 1");
    expect(after).toContain("at: word:w000123");
    expect(after).not.toMatch(/atOutputFrame|coordinates|rects:/u);

    const { queue } = JobQueue.open(join(projectRoot, ".guyditor/jobs-ac006.sqlite"), { concurrency: 1 });
    try {
      const render = new RenderService({ projectRoot, store, jobQueue: queue, profilesRoot: resolve("profiles") });
      const outputDir = join(temporary, "exports");
      const { jobId } = await render.renderExport({
        revision: store.currentProject.revision,
        deliverableId: manifest.deliverable,
        variants: ["clean"],
        outputDir,
      });
      const job = await terminal(queue, jobId);
      expect(job).toMatchObject({ state: "done" });
      const output = exportOutputPath(outputDir, manifest.deliverable, "clean", "mp4");
      const actual = dhashFrame(output, manifest.midpointFrame);
      expect({
        actual,
        expected: manifest.dhash,
        withinTolerance: hammingDistance(actual, manifest.dhash) <= manifest.maxDistance,
      }).toEqual({ actual, expected: manifest.dhash, withinTolerance: true });
      expect(manifest.anchorFrame - manifest.midpointFrame).toBe(9);
    } finally {
      queue.close();
    }
  }, 240_000);
});
