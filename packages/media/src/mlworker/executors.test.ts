import type { GuyditorError, JsonValue } from "../../../core/src/index.js";
import { JobQueue } from "../../../core/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { registerMlworkerJobExecutors } from "./executors.js";
import type {
  MlworkerRunOptions,
  MlworkerTaskMethod,
  MlworkerTaskRunner,
} from "./types.js";

const queues: JobQueue[] = [];

afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
});

async function waitForTerminal(queue: JobQueue, jobId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = queue.get(jobId);
    if (job?.state === "done" || job?.state === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${jobId} did not finish`);
}

class RecordingRunner implements MlworkerTaskRunner {
  readonly calls: Array<{ method: MlworkerTaskMethod; params: Record<string, JsonValue> }> = [];
  error?: GuyditorError;

  async runTask(
    method: MlworkerTaskMethod,
    params: Record<string, JsonValue>,
    options: MlworkerRunOptions = {},
  ) {
    this.calls.push({ method, params: structuredClone(params) });
    options.onProgress?.({
      taskId: String(params["taskId"]),
      progress: 0.5,
      stage: method,
    });
    return this.error === undefined
      ? { ok: true as const, value: { method, accepted: true } }
      : { ok: false as const, error: this.error };
  }
}

class BlockingRunner implements MlworkerTaskRunner {
  readonly started: string[] = [];
  readonly #releases: Array<() => void> = [];

  release(): void {
    this.#releases.shift()?.();
  }

  async runTask(method: MlworkerTaskMethod, params: Record<string, JsonValue>) {
    this.started.push(String(params["taskId"]));
    await new Promise<void>((resolve) => this.#releases.push(resolve));
    return { ok: true as const, value: { method } };
  }
}

describe("registerMlworkerJobExecutors", () => {
  it("keeps ML jobs queued while another ML job holds the single worker", async () => {
    const { queue } = JobQueue.open(":memory:", { concurrency: 4 });
    queues.push(queue);
    const runner = new BlockingRunner();
    registerMlworkerJobExecutors(queue, runner);
    const jobs = (["transcribe", "align", "vad"] as const).map((kind) => queue.enqueue({
      kind,
      title: kind,
      cancellable: true,
      payload: { audioPath: "/tmp/audio.wav" },
    }).jobId);

    const deadline = Date.now() + 2_000;
    while (runner.started.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(jobs.map((jobId) => queue.get(jobId)?.state))
      .toEqual(["running", "queued", "queued"]);
    expect(runner.started).toEqual([jobs[0]]);

    runner.release();
    await waitForTerminal(queue, jobs[0]!);
    runner.release();
    await waitForTerminal(queue, jobs[1]!);
    runner.release();
    await waitForTerminal(queue, jobs[2]!);
    expect(runner.started).toEqual(jobs);
  });

  it("maps transcribe, align, vad, and matte jobs to one task runner with queue progress", async () => {
    const { queue } = JobQueue.open(":memory:", { concurrency: 2 });
    queues.push(queue);
    const runner = new RecordingRunner();
    registerMlworkerJobExecutors(queue, runner);

    const transcribe = queue.enqueue({
      kind: "transcribe",
      title: "Transcribe fixture",
      cancellable: true,
      payload: {
        audioPath: "/tmp/audio.wav",
        language: null,
        model: "tiny",
        wordTimestamps: true,
      },
    });
    const vad = queue.enqueue({
      kind: "vad",
      title: "Detect speech",
      cancellable: true,
      payload: { audioPath: "/tmp/audio.wav" },
    });
    const align = queue.enqueue({
      kind: "align",
      title: "Align fixture transcript",
      cancellable: true,
      payload: {
        audioPath: "/tmp/audio.wav",
        language: "en",
        model: "wav2vec2-base-960h",
        segments: [],
      },
    });
    const matte = queue.enqueue({
      kind: "matte",
      title: "Generate presenter matte",
      cancellable: true,
      payload: {
        input: { path: "/tmp/green.mov", frames: { from: 0, to: 23 }, fps: "24/1" },
        params: {
          model: "rvm_mobilenetv3",
          downsampleRatio: 0.5,
          stabilization: { enabled: true, alphaMin: 0.35, motionGain: 4, minSpeckleArea: 0.00001 },
        },
        output: { dir: "/tmp/mattes", format: "ffv1-gray-mkv" },
      },
    });

    expect(await waitForTerminal(queue, transcribe.jobId)).toMatchObject({
      state: "done",
      payload: { method: "transcribe", accepted: true },
    });
    expect(await waitForTerminal(queue, vad.jobId)).toMatchObject({
      state: "done",
      payload: { method: "vad", accepted: true },
    });
    expect(await waitForTerminal(queue, align.jobId)).toMatchObject({
      state: "done",
      payload: { method: "align", accepted: true },
    });
    expect(await waitForTerminal(queue, matte.jobId)).toMatchObject({
      state: "done",
      payload: { method: "matte", accepted: true },
    });
    expect(runner.calls).toEqual([
      {
        method: "transcribe",
        params: {
          taskId: transcribe.jobId,
          audioPath: "/tmp/audio.wav",
          language: null,
          model: "tiny",
          wordTimestamps: true,
        },
      },
      {
        method: "vad",
        params: { taskId: vad.jobId, audioPath: "/tmp/audio.wav" },
      },
      {
        method: "align",
        params: {
          taskId: align.jobId,
          audioPath: "/tmp/audio.wav",
          language: "en",
          model: "wav2vec2-base-960h",
          segments: [],
        },
      },
      {
        method: "matte",
        params: {
          taskId: matte.jobId,
          input: { path: "/tmp/green.mov", frames: { from: 0, to: 23 }, fps: "24/1" },
          params: {
            model: "rvm_mobilenetv3",
            downsampleRatio: 0.5,
            stabilization: { enabled: true, alphaMin: 0.35, motionGain: 4, minSpeckleArea: 0.00001 },
          },
          output: { dir: "/tmp/mattes", format: "ffv1-gray-mkv" },
        },
      },
    ]);
  });

  it("preserves an unavailable-worker envelope on the failed job", async () => {
    const { queue } = JobQueue.open(":memory:");
    queues.push(queue);
    const runner = new RecordingRunner();
    runner.error = {
      code: "E_MLWORKER_DOWN",
      message: "worker unavailable",
      affected: [],
      acceptedStateChanged: false,
      retry: "safe",
      suggestion: "Restart from Settings, use safe mode, or reinstall.",
    };
    registerMlworkerJobExecutors(queue, runner);
    const job = queue.enqueue({
      kind: "vad",
      title: "Detect speech",
      cancellable: true,
      payload: { audioPath: "/tmp/audio.wav" },
    });

    expect(await waitForTerminal(queue, job.jobId)).toMatchObject({
      state: "failed",
      error: {
        code: "E_MLWORKER_DOWN",
        affected: [],
        acceptedStateChanged: false,
        retry: "safe",
      },
    });
  });
});
