import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobQueue, ProjectStore } from "../../core/src/index.js";
import type { JobRecord, Result } from "../../core/src/index.js";
import { MediaEngine } from "./ingest.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];
const queues: JobQueue[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function terminal(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const deadline = Date.now() + 10_000;
  while (true) {
    const job = queue.get(jobId);
    if (job?.state === "done" || job?.state === "failed") return job;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${jobId}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("pickup file import", () => {
  it("copies an immutable original into media/pickups and ingests it through the pickup pipeline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guyditor-pickup-"));
    temporaryDirectories.push(root);
    const store = await valueOf(ProjectStore.createProject(
      path.join(root, "project"),
      { name: "Pickup import" },
      { profilesDirectory: path.join(REPOSITORY_ROOT, "profiles") },
    ));
    const { queue } = JobQueue.open(path.join(store.root, ".guyditor/jobs.sqlite"));
    queues.push(queue);
    const engine = new MediaEngine({
      jobQueue: queue,
      followUpJobs: [],
      now: () => new Date("2026-07-19T10:11:12Z"),
    });
    const source = path.join(REPOSITORY_ROOT, ".fixtures/speech-48k-20s.wav");
    const sourceBefore = await stat(source, { bigint: true });

    const imported = await engine.importPickup(store, source, "Correct 2019");
    expect(imported.path).toBe(path.join(
      store.root,
      "media/pickups/20260719-101112_correct-2019.wav",
    ));
    const ingest = await terminal(queue, imported.job.jobId);
    expect(ingest.state).toBe("done");
    expect(await readFile(imported.path)).toEqual(await readFile(source));
    const sourceAfter = await stat(source, { bigint: true });
    expect(sourceAfter.mtimeNs).toBe(sourceBefore.mtimeNs);
    expect(store.currentProject.assets[0]).toMatchObject({
      path: "media/pickups/20260719-101112_correct-2019.wav",
      ingest: { via: "pickup" },
    });
    expect(queue.list().map(({ kind }) => kind).sort()).toEqual([
      "ingest", "peaks.generate", "proxy.generate", "transcribe",
    ]);
  }, 15_000);
});
