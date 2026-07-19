import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AnchorResolverRegistry,
  JobQueue,
  OperationEngine,
  createProject,
  makeId,
} from "../../core/src/index.js";
import type {
  IdPrefix,
  ProjectStore,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import {
  MlworkerSupervisor,
  registerMlworkerJobExecutors,
} from "../../media/src/index.js";

import { createTranscriptWordLookup } from "./anchor-lookup.js";
import { TranscriptEngine } from "./engine.js";
import {
  compileFillerProposal,
  enqueueFillerDetection,
  parseFillerDetectionResult,
  registerFillerDetectionExecutor,
} from "./fillers.js";
import { loadTranscriptWorkspace } from "./operations.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const WORKER_ROOT = path.join(REPOSITORY_ROOT, "workers/mlworker");
const PYTHON = path.join(WORKER_ROOT, ".venv/bin/python");
const AUDIO = path.join(REPOSITORY_ROOT, ".fixtures/speech-48k-20s.wav");
const MANIFEST = path.join(REPOSITORY_ROOT, ".fixtures/manifest.json");
const AVAILABLE = existsSync(PYTHON) && existsSync(AUDIO) && existsSync(MANIFEST);
const roots: string[] = [];
const queues: JobQueue[] = [];
const supervisors: MlworkerSupervisor[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(supervisors.splice(0).map(async (supervisor) => supervisor.stop()));
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(`${settled.error.code}: ${settled.error.message}`);
  return settled.value;
}

function domainId(prefix: IdPrefix | "seg" | "spk"): string {
  if (prefix === "seg") return "seg_aaaaaaaaaa";
  if (prefix === "spk") return "spk_aaaaaaaaaa";
  return makeId(prefix);
}

async function project(): Promise<{ store: ProjectStore; transcript: TranscriptEngine }> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-filler-job-"));
  roots.push(root);
  const model = projectFixture();
  model.assets[0]!.kind = "audio";
  model.assets[0]!.path = AUDIO;
  model.assets[0]!.probe = {
    duration: { samples: 960_000, rate: 48_000 },
    audio: { rate: 48_000, channels: 1 },
  };
  delete model.assets[0]!.video;
  model.assets[0]!.audio = [{
    index: 0,
    codec: "pcm_s16le",
    sampleRate: 48_000,
    channels: 1,
    layout: "mono",
  }];
  model.sequences[0]!.clips = [{
    id: "clp_aaaaaaaaaa",
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: 0, fps: "24/1" },
      out: { frames: 480, fps: "24/1" },
    },
  }];
  const store = await valueOf(createProject(root, model));
  const transcript = new TranscriptEngine({
    idFactory: domainId,
    now: () => new Date("2026-07-19T00:00:00Z"),
  });
  await valueOf(transcript.createFromTranscription(store, "ast_aaaaaaaaaa", {
    language: "en",
    languageProbability: 1,
    jobId: "job_aaaaaaaaaa",
    engine: { name: "test", version: "1", model: "fixture" },
    segments: [{
      index: 0,
      start: { samples: 0, rate: 48_000 },
      end: { samples: 960_000, rate: 48_000 },
      text: "one two three four five six seven",
      avgLogprob: 0,
      noSpeechProb: 0,
      words: [
        { text: "one", start: { samples: 24_000, rate: 48_000 }, end: { samples: 48_000, rate: 48_000 }, probability: 1 },
        { text: "two", start: { samples: 120_000, rate: 48_000 }, end: { samples: 139_200, rate: 48_000 }, probability: 1 },
        { text: "three", start: { samples: 192_000, rate: 48_000 }, end: { samples: 216_000, rate: 48_000 }, probability: 1 },
        { text: "four", start: { samples: 408_000, rate: 48_000 }, end: { samples: 427_200, rate: 48_000 }, probability: 1 },
        { text: "five", start: { samples: 499_200, rate: 48_000 }, end: { samples: 528_000, rate: 48_000 }, probability: 1 },
        { text: "six", start: { samples: 720_000, rate: 48_000 }, end: { samples: 739_200, rate: 48_000 }, probability: 1 },
        { text: "seven", start: { samples: 777_600, rate: 48_000 }, end: { samples: 816_000, rate: 48_000 }, probability: 1 },
      ],
    }],
  }));
  return { store, transcript };
}

async function terminal(queue: JobQueue, jobId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = queue.get(jobId);
    if (job?.state === "done" || job?.state === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not finish.`);
}

describe.skipIf(!AVAILABLE)("assist.fillers.detect VAD integration", () => {
  it("finds removable manifest pauses and compiles a review-gated proposal", async () => {
    const { store } = await project();
    const supervisor = new MlworkerSupervisor({
      env: { GUYDITOR_ML_MODEL_DIR: path.join(REPOSITORY_ROOT, ".guyditor/ml-models") },
    });
    supervisors.push(supervisor);
    const { queue } = JobQueue.open(":memory:", { concurrency: 2 });
    queues.push(queue);
    registerMlworkerJobExecutors(queue, supervisor);
    registerFillerDetectionExecutor(queue, {
      project: store,
      audioPath: () => AUDIO,
    });

    const job = enqueueFillerDetection(queue, { assetIds: ["ast_aaaaaaaaaa"] });
    const completed = await terminal(queue, job.jobId);
    expect(completed.state).toBe("done");
    const detected = parseFillerDetectionResult(completed.payload);
    const pauses = detected.candidates.filter(({ kind }) => kind === "pause");
    expect(pauses).toHaveLength(2);

    const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as {
      files: Record<string, { groundTruth?: { silenceMap?: Array<{ start: string; end: string }> } }>;
    };
    const truth = manifest.files["speech-48k-20s.wav"]?.groundTruth?.silenceMap;
    if (truth === undefined) throw new Error("Silence ground truth is missing.");
    const seconds = (value: string): number => {
      const [numerator, denominator] = value.split("/").map(Number);
      if (numerator === undefined || denominator === undefined) throw new Error("Bad rational.");
      return numerator / denominator;
    };
    pauses.forEach((pause, index) => {
      const expected = truth[index];
      if (expected === undefined) throw new Error(`Missing truth interval ${String(index)}.`);
      expect(Math.abs(
        pause.sourceRange.start.samples / pause.sourceRange.start.rate -
        (seconds(expected.start) + 0.1),
      )).toBeLessThanOrEqual(0.15);
      expect(Math.abs(
        pause.sourceRange.end.samples / pause.sourceRange.end.rate -
        (seconds(expected.end) - 0.1),
      )).toBeLessThanOrEqual(0.15);
    });

    const workspace = await valueOf(loadTranscriptWorkspace(store, domainId));
    const anchors = new AnchorResolverRegistry();
    anchors.registerWordLookup(createTranscriptWordLookup(workspace.sidecars));
    const operationEngine = new OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: store,
      operationDispatcher: workspace.dispatcher,
      anchorResolvers: anchors,
      idFactory: makeId,
    });
    const revision = store.currentProject.revision;
    const warnedPauses = pauses.map((pause, index) => index === 0
      ? {
          ...pause,
          warnings: [{
            code: "ambience-jump" as const,
            severity: "warning" as const,
            boundary: {},
            evidence: "Fixture candidate crosses an ambience envelope change.",
          }],
        }
      : pause);
    const proposal = await valueOf(compileFillerProposal(warnedPauses, {
      engine: operationEngine,
      selectedCandidateIds: [pauses[0]!.id],
      idFactory: makeId,
    }));

    expect(proposal).toMatchObject({ status: "ready", riskClass: "normal" });
    expect(proposal.operations.map(({ op }) => op)).toEqual([
      "clip.split",
      "clip.split",
      "clip.remove",
    ]);
    expect(proposal.warnings).toContainEqual(expect.objectContaining({
      code: "ambience-jump",
      evidence: expect.stringContaining("Fixture candidate"),
    }));
    expect(store.currentProject.revision).toBe(revision);
    expect(store.currentProject.sequences[0]!.clips).toHaveLength(1);
  }, 60_000);
});
