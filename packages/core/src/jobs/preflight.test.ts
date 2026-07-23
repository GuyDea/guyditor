import { afterEach, describe, expect, it } from "vitest";

import { makeGuyditorError } from "../errors.js";
import { JobQueue } from "./queue.js";
import type { JobRecord } from "./types.js";

const queues: JobQueue[] = [];

afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
});

async function terminal(queue: JobQueue, jobId: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = queue.get(jobId);
    if (job?.state === "done" || job?.state === "failed") return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Job ${jobId} did not finish.`);
}

describe("JobQueue preflight", () => {
  it("runs the configured preflight before the executor and preserves its error envelope", async () => {
    let executorCalls = 0;
    const { queue } = JobQueue.open(":memory:", {
      preflight: (job) => {
        if (job.kind === "render.export") {
          throw makeGuyditorError("E_STORAGE_INSUFFICIENT", "Need more free space.", {
            retry: "safe",
            suggestion: "Clean 42 bytes of disposable cache.",
          });
        }
      },
    });
    queues.push(queue);
    queue.registerExecutor("render.export", () => {
      executorCalls += 1;
      return Promise.resolve();
    });
    const enqueued = queue.enqueue({
      kind: "render.export",
      title: "Render",
      cancellable: true,
      payload: {},
    });

    const failed = await terminal(queue, enqueued.jobId);

    expect(executorCalls).toBe(0);
    expect(failed).toMatchObject({
      state: "failed",
      error: {
        code: "E_STORAGE_INSUFFICIENT",
        retry: "safe",
        suggestion: "Clean 42 bytes of disposable cache.",
      },
    });
  });
});
