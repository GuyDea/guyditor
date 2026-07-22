import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobQueue, openProject } from "../../../core/src/index.js";
import type { JobRecord, Result, TransactionRecord } from "../../../core/src/index.js";
import {
  framingSidecarReference,
  loadPlatformProfile,
  writeFramingSidecar,
} from "../../../deliver/src/index.js";
import type { FramingSidecar } from "../../../deliver/src/index.js";
import { probeMedia } from "../../../media/src/index.js";
import {
  measureDeliveredLoudness,
  outputSetPaths,
  RenderService,
} from "../../src/index.js";

const FIXTURE_ROOT = resolve(".fixtures/projects/basic");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  if (!settled.ok) throw settled.error;
  return settled.value;
}

async function terminal(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const current = queue.get(jobId);
  if (current?.state === "done" || current?.state === "failed" || current?.state === "cancelled") return current;
  return new Promise<JobRecord>((resolveJob, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for AC-007 output set ${jobId}.`));
    }, 360_000);
    const unsubscribe = queue.onChange(({ job }) => {
      if (job.jobId !== jobId || !["done", "failed", "cancelled"].includes(job.state)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolveJob(job);
    });
  });
}

const TARGETS = [
  { deliverableId: "dlv_bbbbbbbbbb", sequenceId: "seq_bbbbbbbbbb", layerId: "lyr_dddddddddd", profile: "tiktok@1.0.0", letter: "e" },
  { deliverableId: "dlv_cccccccccc", sequenceId: "seq_cccccccccc", layerId: "lyr_eeeeeeeeee", profile: "instagram-reels@1.0.0", letter: "k" },
  { deliverableId: "dlv_dddddddddd", sequenceId: "seq_dddddddddd", layerId: "lyr_ffffffffff", profile: "youtube-shorts@1.0.0", letter: "q" },
] as const;

describe.skipIf(!existsSync(FIXTURE_ROOT))("AC-007 — create short-form derivatives", () => {
  it("exports the canonical burned/clean/subtitle/cover/report set for all vertical profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-ac007-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "project");
    await cp(FIXTURE_ROOT, projectRoot, { recursive: true });
    const store = await valueOf(openProject(projectRoot, { appVersion: "0.0.0-ac007" }));
    const model = structuredClone(store.currentProject);
    model.revision = "rev_00002";
    const source = model.sequences.find(({ id }) => id === "seq_aaaaaaaaaa")!;
    for (const [targetIndex, target] of TARGETS.entries()) {
      const sequence = structuredClone(source);
      sequence.id = target.sequenceId;
      sequence.name = `AC-007 ${target.profile}`;
      sequence.clips.forEach((clip, clipIndex) => {
        const codePoint = target.letter.charCodeAt(0) + clipIndex;
        clip.id = ["clp", String.fromCharCode(codePoint).repeat(10)].join("_");
      });
      model.sequences.push(sequence);
      model.layers.push({
        id: target.layerId,
        kind: "video",
        name: `AC-007 vertical ${String(targetIndex + 1)}`,
        order: 3 + targetIndex,
        enabled: true,
        locked: false,
        sequence: sequence.id,
      });
      const cropWidth = 0.31640625;
      const sidecar: FramingSidecar = {
        format: "guyditor.framing/v1",
        deliverableId: target.deliverableId,
        profile: target.profile,
        sourceRevision: "rev_00002",
        aspect: "9:16",
        requiredTrackAssets: [],
        decisions: sequence.clips.map((clip, index) => ({
          decisionId: `fd_${String(targetIndex + 1)}${String(index + 1).padStart(3, "0")}`,
          shot: { clipId: clip.id, source: { start: clip.source.in, end: clip.source.out } },
          mode: "crop" as const,
          crop: { keyframes: [{
            at: clip.source.in,
            rect: { x: (1 - cropWidth) / 2, y: 0, w: cropWidth, h: 1 },
          }] },
          subjects: [],
          confidence: 1,
          warnings: [],
        })),
      };
      await writeFramingSidecar(projectRoot, sidecar, []);
      model.sidecars.push(framingSidecarReference(sidecar, []));
      model.deliverables.push({
        id: target.deliverableId,
        kind: "short",
        name: `AC-007 ${target.profile}`,
        profile: target.profile,
        sequenceId: target.sequenceId,
        status: "approved",
        approvedRevision: "rev_00002",
        framingOverrides: [{
          id: ["fov", target.letter.repeat(10)].join("_"),
          decisionId: sidecar.decisions[0]!.decisionId,
          crop: { keyframes: structuredClone(sidecar.decisions[0]!.crop!.keyframes) },
          note: "Creator crop correction retained for re-derivation.",
        }],
      });
    }
    const transaction: TransactionRecord = {
      id: "txn_cccccccccc",
      baseRevision: "rev_00001",
      resultRevision: "rev_00002",
      operations: [{ op: "deliverable.derive", params: { profiles: TARGETS.map(({ profile }) => profile) }, summary: "Prepare AC-007 shorts" }],
      instruction: { kind: "ui-direct" },
      actor: { kind: "tool", id: "ac007" },
      versions: { app: "0.0.0-ac007", schema: "guyditor/v1", skills: [], presets: [], tools: [] },
      acceptance: { status: "accepted", by: "ac007", at: "2026-07-22T00:00:00.000Z" },
      orphanedAnchors: [],
      addresses: [],
    };
    await valueOf(store.commit(model, transaction));
    expect(store.currentProject.deliverables.filter(({ kind }) => kind === "short"))
      .toHaveLength(3);
    expect(store.currentProject.deliverables.filter(({ kind }) => kind === "short")
      .every(({ framingOverrides }) => framingOverrides?.length === 1)).toBe(true);

    const outputDir = join(root, "exports");
    const { queue } = JobQueue.open(join(projectRoot, ".guyditor/jobs.sqlite"), { concurrency: 3 });
    try {
      const render = new RenderService({
        projectRoot,
        store,
        jobQueue: queue,
        profilesRoot: resolve("profiles"),
      });
      const queued = await Promise.all(TARGETS.map((target) => render.renderOutputSet({
        revision: store.currentProject.revision,
        deliverableId: target.deliverableId,
        outputDir,
      })));
      const completed = await Promise.all(queued.map(({ jobId }) => terminal(queue, jobId)));
      expect(completed.map(({ state, error }) => ({ state, error }))).toEqual([
        { state: "done", error: undefined },
        { state: "done", error: undefined },
        { state: "done", error: undefined },
      ]);

      for (const target of TARGETS) {
        const loaded = await loadPlatformProfile(target.profile, { builtinsRoot: resolve("profiles") });
        const paths = outputSetPaths(outputDir, target.deliverableId, "mp4");
        for (const path of [paths.videoBurned, paths.videoClean, paths.srt, paths.vtt, paths.report]) {
          expect((await stat(path)).isFile(), path).toBe(true);
        }
        const [burned, clean] = await Promise.all([probeMedia(paths.videoBurned), probeMedia(paths.videoClean)]);
        for (const probe of [burned, clean]) {
          expect(probe.video).toMatchObject({
            width: 1080,
            height: 1920,
            fps: loaded.profile.video.fps.default,
            codec: loaded.profile.video.codec,
          });
        }
        const loudness = await measureDeliveredLoudness(paths.videoClean);
        expect(Math.abs(loudness.integratedLufs - loaded.profile.audio.loudness.integratedLufs))
          .toBeLessThanOrEqual(loaded.profile.audio.loudness.toleranceLu);
        const covers = (await readdir(paths.coversDir)).filter((name) => /^cover-[0-9]{2}\.jpg$/u.test(name));
        expect(covers).toHaveLength(6);
        expect(JSON.parse(await readFile(paths.report, "utf8"))).toMatchObject({
          outputSet: {
            videoBurned: paths.videoBurned,
            videoClean: paths.videoClean,
            srt: paths.srt,
            vtt: paths.vtt,
            coverCandidates: expect.arrayContaining([join(paths.coversDir, "cover-01.jpg")]),
          },
        });
      }
    } finally {
      queue.close();
    }
  }, 400_000);
});
