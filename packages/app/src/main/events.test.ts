import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JobProgressThrottle } from "./events.js";

describe("JobProgressThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("emits job progress no more than ten times per second per job", () => {
    const emitted: Array<{ jobId: string; progress: number }> = [];
    const throttle = new JobProgressThrottle((event) => emitted.push(event));

    for (let index = 0; index < 20; index += 1) {
      throttle.publish({ jobId: "job_aaaaaaaaaa", progress: index / 20 });
    }
    throttle.publish({ jobId: "job_bbbbbbbbbb", progress: 0.5 });

    expect(emitted).toHaveLength(2);
    vi.advanceTimersByTime(99);
    expect(emitted).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual([
      { jobId: "job_aaaaaaaaaa", progress: 0 },
      { jobId: "job_bbbbbbbbbb", progress: 0.5 },
      { jobId: "job_aaaaaaaaaa", progress: 0.95 },
    ]);
  });
});
