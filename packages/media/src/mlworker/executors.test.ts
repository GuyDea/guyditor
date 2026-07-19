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

describe("registerMlworkerJobExecutors", () => {
  it("maps transcribe, align, and vad jobs to one task runner with queue progress", async () => {
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
