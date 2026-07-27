import { describe, expect, it, vi } from "vitest";

import type { GdEvent } from "../shared/ipc.js";
import { createGuyditorFacade } from "./facade.js";

describe("createGuyditorFacade", () => {
  it("generates request IDs and unwraps gd:rpc results", async () => {
    const invoke = vi.fn().mockResolvedValue({
      v: 1,
      requestId: "req_aaaaaaaaaa",
      ok: true,
      result: [{ jobId: "job_aaaaaaaaaa" }],
    });
    const facade = createGuyditorFacade({
      invoke,
      on: vi.fn(),
      pathForFile: vi.fn(),
      removeListener: vi.fn(),
      requestId: () => "req_aaaaaaaaaa",
    });

    await expect(facade.call("JobQueue", "list", {})).resolves.toEqual([
      { jobId: "job_aaaaaaaaaa" },
    ]);
    expect(invoke).toHaveBeenCalledWith("gd:rpc", {
      v: 1,
      requestId: "req_aaaaaaaaaa",
      service: "JobQueue",
      method: "list",
      params: {},
    });
  });

  it("filters gd:evt subscriptions by kind and supports unsubscribe", () => {
    let listener: ((event: unknown, payload: GdEvent) => void) | undefined;
    const removeListener = vi.fn();
    const handler = vi.fn();
    const facade = createGuyditorFacade({
      invoke: vi.fn(),
      on: vi.fn((_channel, registered) => { listener = registered; }),
      pathForFile: vi.fn(),
      removeListener,
      requestId: () => "req_aaaaaaaaaa",
    });

    const unsubscribe = facade.on("project.revision", handler);
    listener?.({}, { kind: "job.progress", seq: 1, jobId: "job_aaaaaaaaaa", progress: 0.2 });
    listener?.({}, { kind: "project.revision", seq: 2, revision: "rev_00002" });
    unsubscribe();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      kind: "project.revision",
      seq: 2,
      revision: "rev_00002",
    });
    expect(removeListener).toHaveBeenCalledWith("gd:evt", listener);
  });

  it("resolves native dropped-file paths through the preload boundary", () => {
    const file = { name: "clip.mp4" } as File;
    const pathForFile = vi.fn(() => "/media/clip.mp4");
    const facade = createGuyditorFacade({
      invoke: vi.fn(),
      on: vi.fn(),
      pathForFile,
      removeListener: vi.fn(),
    });

    expect(facade.pathForFile(file)).toBe("/media/clip.mp4");
    expect(pathForFile).toHaveBeenCalledWith(file);
  });
});
