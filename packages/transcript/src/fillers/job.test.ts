import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProject, JobQueue, makeId } from "../../../core/src/index.js";
import type { IdPrefix, Result } from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";

import { TranscriptEngine } from "../engine.js";
import { GENTLE_FILLER_RULE_SET } from "./gentle.js";
import { enqueueFillerDetection, parseFillerDetectionResult, registerFillerDetectionExecutor, terminalJob } from "./job.js";
import type { FillerScope } from "./types.js";

const roots: string[] = [];
const queues: JobQueue[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function domainId(prefix: IdPrefix | "seg" | "spk"): string {
  if (prefix === "seg") return "seg_aaaaaaaaaa";
  if (prefix === "spk") return "spk_aaaaaaaaaa";
  return makeId(prefix);
}

const SCOPE: FillerScope = {
  assemblySessionId: "asb_aaaaaaaaaa",
  keptRanges: [{
    assetId: "ast_aaaaaaaaaa",
    start: { samples: 0, rate: 48_000 },
    end: { samples: 480_000, rate: 48_000 },
  }],
};

describe("assist.fillers.detect scope", () => {
  it("executor carries scope into its result", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-filler-scope-"));
    roots.push(root);
    const model = projectFixture();
    model.assets[0]!.kind = "audio";
    model.assets[0]!.probe = { duration: { samples: 960_000, rate: 48_000 }, audio: { rate: 48_000, channels: 1 } };
    delete model.assets[0]!.video;
    model.assets[0]!.audio = [{ index: 0, codec: "pcm_s16le", sampleRate: 48_000, channels: 1, layout: "mono" }];
    const store = valueOf(await createProject(root, model));
    const engine = new TranscriptEngine({ idFactory: domainId, now: () => new Date("2026-07-19T00:00:00Z") });
    const word = (text: string, start: number, end: number) => ({
      text,
      start: { samples: start, rate: 48_000 },
      end: { samples: end, rate: 48_000 },
      probability: 1,
    });
    valueOf(await engine.createFromTranscription(store, "ast_aaaaaaaaaa", {
      language: "en",
      languageProbability: 1,
      jobId: "job_aaaaaaaaaa",
      engine: { name: "test", version: "1", model: "fixture" },
      segments: [{
        index: 0,
        start: { samples: 0, rate: 48_000 },
        end: { samples: 960_000, rate: 48_000 },
        text: "one two",
        avgLogprob: 0,
        noSpeechProb: 0,
        words: [word("one", 24_000, 48_000), word("two", 120_000, 139_200)],
      }],
    }));
    const { queue } = JobQueue.open(":memory:");
    queues.push(queue);
    queue.registerExecutor("vad", () => Promise.resolve({ speech: [{ start: 0.5, end: 1 }], silence: [] }));
    registerFillerDetectionExecutor(queue, { project: store, audioPath: () => "unused.wav" });
    const scoped = enqueueFillerDetection(queue, { scope: SCOPE });
    const done = await terminalJob(queue, scoped.jobId, new AbortController().signal);
    expect(done.state).toBe("done");
    expect(parseFillerDetectionResult(done.payload).scope).toEqual(SCOPE);
    const plain = enqueueFillerDetection(queue);
    const plainDone = await terminalJob(queue, plain.jobId, new AbortController().signal);
    expect(parseFillerDetectionResult(plainDone.payload).scope).toBeUndefined();
  });
});

describe("GENTLE_FILLER_RULE_SET", () => {
  it("shortens pauses instead of removing them", () => {
    expect(GENTLE_FILLER_RULE_SET.pauses.retainMs).toBe(500);
    expect(GENTLE_FILLER_RULE_SET.fillers.remove).toEqual([]);
    expect(GENTLE_FILLER_RULE_SET.fillers.review).toContain("um");
  });
});
