import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  OperationEngine,
  canonicalizeYaml,
  createProject,
  openProject,
  parseProjectYaml,
} from "../../../core/src/index.js";
import type { JobRecord, Result } from "../../../core/src/index.js";
import { RenderService, exportOutputPath, exportReportPath } from "../../src/index.js";
import { dhashFrame, hammingDistance } from "./dhash.js";

const temporaryDirectories: string[] = [];
const FRAME = { frames: 1, fps: "30/1" } as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true }),
  ));
});

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  if (!settled.ok) throw settled.error;
  expect(settled.ok).toBe(true);
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
      reject(new Error(`Timed out waiting for determinism render ${jobId}.`));
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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("AC-009 — reproduce a revision", () => {
  it("restores a captioned, graphic, keyed revision and rebuilds it with locked tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-ac009-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "expanded");
    const keyedText = await readFile(resolve(".fixtures/projects/ac005/episode.guyditor.yaml"), "utf8");
    const basicText = await readFile(resolve(".fixtures/projects/basic/episode.guyditor.yaml"), "utf8");
    const captionText = await readFile(resolve(".fixtures/projects/ac003/episode.guyditor.yaml"), "utf8");
    const keyed = parseProjectYaml(keyedText);
    const basic = parseProjectYaml(basicText);
    const captioned = parseProjectYaml(captionText);
    if (!keyed.ok) throw keyed.error;
    if (!basic.ok) throw basic.error;
    if (!captioned.ok) throw captioned.error;
    const model = structuredClone(keyed.value);
    const generatedAsset = basic.value.assets.find(({ id }) => id === "ast_jjjjjjjjjj");
    const generatedSourceAsset = basic.value.assets.find(({ id }) => id === "ast_hhhhhhhhhh");
    const generatedSidecar = basic.value.sidecars.find(({ name }) => name === "generation-frozen");
    const captionTrack = captioned.value.captions[0];
    const captionPreset = captioned.value.presets[0];
    const transcriptReference = basic.value.sidecars.find(({ name }) => name === "transcript-speech");
    if (
      generatedAsset === undefined || generatedSourceAsset === undefined || generatedSidecar === undefined || captionTrack === undefined ||
      captionPreset === undefined || transcriptReference === undefined
    ) throw new Error("Expanded AC-009 fixture inputs are incomplete.");
    model.assets.push(structuredClone(generatedSourceAsset), structuredClone(generatedAsset));
    model.layers.push({
      id: "lyr_dddddddddd",
      kind: "image",
      name: "Frozen generated graphic",
      order: 30,
      enabled: true,
      locked: false,
      items: [{
        id: "clp_dddddddddd",
        asset: generatedAsset.id,
        at: "timeline:seq_aaaaaaaaaa@0",
        duration: { frames: 180, fps: "30/1" },
      }],
    });
    model.captions = [{ ...structuredClone(captionTrack), sourceLayerIds: ["lyr_bbbbbbbbbb"] }];
    model.presets.push(structuredClone(captionPreset));
    model.deliverables[0]!.captionsTrackId = captionTrack.id;
    model.transcript.nextWordOrdinal = basic.value.transcript.nextWordOrdinal;
    const transcript = JSON.parse(await readFile(
      resolve(".fixtures/projects/basic/sidecars/transcript-speech.json"), "utf8",
    )) as Record<string, unknown>;
    transcript["assetId"] = "ast_cccccccccc";
    const serializedTranscript = `${JSON.stringify(transcript, null, 2)}\n`;
    model.sidecars.push(
      structuredClone(generatedSidecar),
      {
        ...structuredClone(transcriptReference),
        sha256: sha256(Buffer.from(serializedTranscript)),
        inputs: [{
          asset: "ast_cccccccccc",
          sha256: model.assets.find(({ id }) => id === "ast_cccccccccc")!.sha256,
        }],
      },
    );
    await valueOf(createProject(projectRoot, model, {
      appVersion: "0.0.0-ac009",
      now: () => new Date("2026-07-19T09:00:00.000Z"),
    }));
    await Promise.all([
      cp(resolve(".fixtures/projects/ac005/sidecars/annotations.yaml"), join(projectRoot, "sidecars/annotations.yaml")),
      cp(resolve(".fixtures/projects/ac005/presets/pre_dddddddddd@1.json"), join(projectRoot, "presets/pre_dddddddddd@1.json")),
      cp(resolve(".fixtures/projects/ac003/presets/pre_aaaaaaaaaa@1.yaml"), join(projectRoot, "presets/pre_aaaaaaaaaa@1.yaml")),
      cp(resolve(".fixtures/projects/basic/sidecars/generated-frozen.json"), join(projectRoot, "sidecars/generated-frozen.json")),
      writeFile(join(projectRoot, "sidecars/transcript-speech.json"), serializedTranscript, "utf8"),
    ]);
    const store = await valueOf(openProject(projectRoot, { appVersion: "0.0.0-ac009" }));
    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-ac009",
      committer: store,
      now: () => new Date("2026-07-19T10:00:00.000Z"),
    });

    const edits = [
      ["clp_aaaaaaaaaa", "tail"],
      ["clp_aaaaaaaaaa", "head"],
      ["clp_aaaaaaaaaa", "tail"],
      ["clp_aaaaaaaaaa", "head"],
      ["clp_aaaaaaaaaa", "tail"],
      ["clp_aaaaaaaaaa", "head"],
      ["clp_aaaaaaaaaa", "tail"],
      ["clp_aaaaaaaaaa", "head"],
      ["clp_aaaaaaaaaa", "tail"],
      ["clp_aaaaaaaaaa", "head"],
    ] as const;
    for (const [clipId, edge] of edits.slice(0, 7)) {
      await valueOf(engine.execute([{
        op: "clip.trim",
        params: { clipId, edge, delta: FRAME },
      }], {
        baseRevision: engine.currentProject.revision,
        dryRun: false,
        origin: "ui",
      }));
    }
    expect(engine.currentProject.revision).toBe("rev_00008");
    expect(engine.currentProject.assets).toContainEqual(expect.objectContaining({
      id: "ast_jjjjjjjjjj",
      kind: "generated",
      provenance: { sidecar: "generation-frozen" },
    }));

    const revisionEightSnapshot = await readFile(
      join(projectRoot, "history/revisions/rev_00008.yaml"),
      "utf8",
    );
    const frozenAssetPath = engine.currentProject.assets.find(
      ({ id }) => id === "ast_jjjjjjjjjj",
    )?.path;
    expect(frozenAssetPath).toBeDefined();
    if (frozenAssetPath === undefined) throw new Error("Frozen generated fixture is missing.");
    const frozenHash = sha256(await readFile(frozenAssetPath));

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
      const firstDir = join(root, "first-export");
      const first = await render.renderExport({
        revision: "rev_00008",
        deliverableId: "dlv_aaaaaaaaaa",
        variants: ["burnin"],
        outputDir: firstDir,
        skipValidationWarnings: true,
      });
      expect(await terminal(queue, first.jobId)).toMatchObject({ state: "done" });
      const firstOutput = exportOutputPath(firstDir, "dlv_aaaaaaaaaa", "burnin", "mp4");
      const firstReport = JSON.parse(await readFile(
        exportReportPath(firstOutput),
        "utf8",
      )) as { revision: string; output: { sha256: string } };
      expect(firstReport.revision).toBe("rev_00008");

      for (const [clipId, edge] of edits.slice(7)) {
        await valueOf(engine.execute([{
          op: "clip.trim",
          params: { clipId, edge, delta: FRAME },
        }], {
          baseRevision: engine.currentProject.revision,
          dryRun: false,
          origin: "ui",
        }));
      }
      expect(engine.currentProject.revision).toBe("rev_00011");

      const restored = await valueOf(engine.restoreRevision("rev_00008"));
      expect(restored.revision).toBe("rev_00012");
      const restoredMaster = await readFile(join(projectRoot, "episode.guyditor.yaml"), "utf8");
      const parsedSnapshot = parseProjectYaml(revisionEightSnapshot);
      expect(parsedSnapshot.ok).toBe(true);
      if (!parsedSnapshot.ok) throw parsedSnapshot.error;
      // §2.11 requires restore to create a forward revision. Apart from that required
      // revision field, the canonical master is byte-identical to the rev_00008 snapshot.
      expect(restoredMaster).toBe(canonicalizeYaml({
        ...parsedSnapshot.value,
        revision: "rev_00012",
      }));

      const secondDir = join(root, "second-export");
      const second = await render.renderExport({
        revision: "rev_00012",
        deliverableId: "dlv_aaaaaaaaaa",
        variants: ["burnin"],
        outputDir: secondDir,
        skipValidationWarnings: true,
      });
      expect(await terminal(queue, second.jobId)).toMatchObject({ state: "done" });
      const secondOutput = exportOutputPath(secondDir, "dlv_aaaaaaaaaa", "burnin", "mp4");
      const secondReport = JSON.parse(await readFile(
        exportReportPath(secondOutput),
        "utf8",
      )) as { revision: string; output: { sha256: string } };
      expect(secondReport.revision).toBe("rev_00012");

      for (const frame of [10, 45, 90, 140]) {
        expect(hammingDistance(dhashFrame(firstOutput, frame), dhashFrame(secondOutput, frame)))
          .toBe(0);
      }
      expect(sha256(await readFile(secondOutput))).toBe(sha256(await readFile(firstOutput)));
      expect(secondReport.output.sha256).toBe(firstReport.output.sha256);
      expect(sha256(await readFile(frozenAssetPath))).toBe(frozenHash);
      const revisionEightLock = JSON.parse(await readFile(
        join(projectRoot, "history/revisions/rev_00008.lock.json"), "utf8",
      )) as Record<string, unknown>;
      const restoredLock = JSON.parse(await readFile(
        join(projectRoot, "history/revisions/rev_00012.lock.json"), "utf8",
      )) as Record<string, unknown>;
      for (const key of ["assets", "presets", "profiles", "sidecars", "tools"] as const) {
        expect(restoredLock[key]).toEqual(revisionEightLock[key]);
      }
      expect(queue.list().filter(({ kind }) => kind.includes("generation"))).toEqual([]);
      expect(queue.list({ kind: "render.export" })).toHaveLength(2);
    } finally {
      queue.close();
    }
  }, 180_000);
});
