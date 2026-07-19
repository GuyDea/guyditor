import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  OperationEngine,
  canonicalizeYaml,
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
  it("restores rev_00008 and re-exports it with distance-0 frames and no generation job", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-ac009-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "basic");
    await cp(resolve(".fixtures/projects/basic"), projectRoot, { recursive: true });
    const store = await valueOf(openProject(projectRoot, { appVersion: "0.0.0-ac009" }));
    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-ac009",
      committer: store,
      now: () => new Date("2026-07-19T10:00:00.000Z"),
    });

    const edits = [
      ["clp_aaaaaaaaaa", "tail"],
      ["clp_bbbbbbbbbb", "head"],
      ["clp_cccccccccc", "tail"],
      ["clp_dddddddddd", "head"],
      ["clp_aaaaaaaaaa", "head"],
      ["clp_bbbbbbbbbb", "tail"],
      ["clp_cccccccccc", "head"],
      ["clp_dddddddddd", "tail"],
      ["clp_aaaaaaaaaa", "tail"],
      ["clp_bbbbbbbbbb", "head"],
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
        variants: ["clean"],
        outputDir: firstDir,
      });
      expect(await terminal(queue, first.jobId)).toMatchObject({ state: "done" });
      const firstOutput = exportOutputPath(firstDir, "dlv_aaaaaaaaaa", "clean", "mp4");
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
        variants: ["clean"],
        outputDir: secondDir,
      });
      expect(await terminal(queue, second.jobId)).toMatchObject({ state: "done" });
      const secondOutput = exportOutputPath(secondDir, "dlv_aaaaaaaaaa", "clean", "mp4");
      const secondReport = JSON.parse(await readFile(
        exportReportPath(secondOutput),
        "utf8",
      )) as { revision: string; output: { sha256: string } };
      expect(secondReport.revision).toBe("rev_00012");

      for (const frame of [30, 150, 270, 360]) {
        expect(hammingDistance(dhashFrame(firstOutput, frame), dhashFrame(secondOutput, frame)))
          .toBe(0);
      }
      expect(sha256(await readFile(secondOutput))).toBe(sha256(await readFile(firstOutput)));
      expect(secondReport.output.sha256).toBe(firstReport.output.sha256);
      expect(sha256(await readFile(frozenAssetPath))).toBe(frozenHash);
      expect(queue.list().filter(({ kind }) => kind.includes("generation"))).toEqual([]);
      expect(queue.list({ kind: "render.export" })).toHaveLength(2);
    } finally {
      queue.close();
    }
  }, 180_000);
});
