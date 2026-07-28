import { describe, expect, it, vi } from "vitest";

import type { IpcSurface } from "../shared/ipc.js";
import { createRpcDispatcher } from "./rpc.js";
import { IPC_SURFACES } from "./surfaces.js";

const surface: IpcSurface = {
  service: "JobQueue",
  methods: {
    list: {
      paramsSchema: {
        type: "object",
        properties: {
          state: { enum: ["queued", "running", "done", "failed", "cancelled"] },
        },
        additionalProperties: false,
      },
      resultSchema: { type: "array" },
      budgetMs: 20,
    },
  },
};

const structuralUniqueSurface: IpcSurface = {
  service: "JobQueue",
  methods: {
    list: {
      paramsSchema: {
        type: "object",
        required: ["values"],
        properties: {
          values: {
            type: "array",
            uniqueItems: true,
            items: { type: "object" },
          },
        },
        additionalProperties: false,
      },
      resultSchema: { type: "array" },
      budgetMs: 20,
    },
  },
};

const timelineFrameParams = {
  assetId: "ast_aaaaaaaaaa",
  sourceFrames: [12],
  height: 96,
};

function timelineFrameDispatcher(result: unknown): {
  dispatch: ReturnType<typeof createRpcDispatcher>;
  resolveTimelineFrames: ReturnType<typeof vi.fn>;
} {
  const resolveTimelineFrames = vi.fn(() => result);
  return {
    dispatch: createRpcDispatcher(IPC_SURFACES, (service) =>
      service === "MediaEngine" ? { resolveTimelineFrames } : undefined),
    resolveTimelineFrames,
  };
}

describe("createRpcDispatcher", () => {
  it("rejects params that do not match the method manifest", async () => {
    const dispatch = createRpcDispatcher([surface], () => ({ list: () => [] }));

    const response = await dispatch({
      v: 1,
      requestId: "req_aaaaaaaaaa",
      service: "JobQueue",
      method: "list",
      params: { state: "lost" },
    });

    expect(response).toEqual({
      v: 1,
      requestId: "req_aaaaaaaaaa",
      ok: false,
      error: {
        code: "E_IPC_SCHEMA",
        message: expect.stringContaining("state"),
        affected: [],
        acceptedStateChanged: false,
        retry: "none",
      },
    });
  });

  it("dispatches a valid request to the declared service method", async () => {
    const dispatch = createRpcDispatcher([surface], () => ({
      list: (params: unknown) => [{ params }],
    }));

    const response = await dispatch({
      v: 1,
      requestId: "req_bbbbbbbbbb",
      service: "JobQueue",
      method: "list",
      params: { state: "running" },
    });

    expect(response).toEqual({
      v: 1,
      requestId: "req_bbbbbbbbbb",
      ok: true,
      result: [{ params: { state: "running" } }],
    });
  });

  it("preserves a structured stale-project error from a service", async () => {
    const dispatch = createRpcDispatcher([surface], () => ({
      list: () => {
        throw {
          code: "E_PROJECT_CONTEXT_STALE",
          message: "The requested project is no longer open.",
          affected: ["/projects/alpha"],
          acceptedStateChanged: false,
          retry: "safe",
        };
      },
    }));

    const response = await dispatch({
      v: 1,
      requestId: "req_cccccccccc",
      service: "JobQueue",
      method: "list",
      params: {},
    });

    expect(response).toEqual({
      v: 1,
      requestId: "req_cccccccccc",
      ok: false,
      error: {
        code: "E_PROJECT_CONTEXT_STALE",
        message: "The requested project is no longer open.",
        affected: ["/projects/alpha"],
        acceptedStateChanged: false,
        retry: "safe",
      },
    });
  });

  it("rejects timeline frame requests over the declared maximum", async () => {
    const { dispatch, resolveTimelineFrames } = timelineFrameDispatcher([]);

    const response = await dispatch({
      v: 1,
      requestId: "req_dddddddddd",
      service: "MediaEngine",
      method: "resolveTimelineFrames",
      params: {
        ...timelineFrameParams,
        sourceFrames: Array.from({ length: 13 }, (_, index) => index),
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "E_IPC_SCHEMA",
        message: expect.stringContaining("/sourceFrames"),
      },
    });
    expect(resolveTimelineFrames).not.toHaveBeenCalled();
  });

  it("rejects structurally duplicate timeline frame requests", async () => {
    const { dispatch, resolveTimelineFrames } = timelineFrameDispatcher([]);

    const response = await dispatch({
      v: 1,
      requestId: "req_eeeeeeeeee",
      service: "MediaEngine",
      method: "resolveTimelineFrames",
      params: { ...timelineFrameParams, sourceFrames: [12, 12] },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "E_IPC_SCHEMA",
        message: expect.stringContaining("/sourceFrames/1"),
      },
    });
    expect(resolveTimelineFrames).not.toHaveBeenCalled();
  });

  it("compares unique array items as structural JSON values", async () => {
    const list = vi.fn(() => []);
    const dispatch = createRpcDispatcher(
      [structuralUniqueSurface],
      () => ({ list }),
    );

    const response = await dispatch({
      v: 1,
      requestId: "req_iiiiiiiiii",
      service: "JobQueue",
      method: "list",
      params: {
        values: [
          { nested: { value: 1 }, labels: ["a", "b"] },
          { labels: ["a", "b"], nested: { value: 1 } },
        ],
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "E_IPC_SCHEMA",
        message: expect.stringContaining("/values/1"),
      },
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("dispatches valid bounded timeline frame requests", async () => {
    const { dispatch, resolveTimelineFrames } = timelineFrameDispatcher([]);

    const response = await dispatch({
      v: 1,
      requestId: "req_ffffffffff",
      service: "MediaEngine",
      method: "resolveTimelineFrames",
      params: timelineFrameParams,
    });

    expect(response).toMatchObject({ ok: true, result: [] });
    expect(resolveTimelineFrames).toHaveBeenCalledOnce();
    expect(resolveTimelineFrames).toHaveBeenCalledWith(timelineFrameParams);
  });

  it.each([
    {
      label: "malformed entries",
      result: [{ sourceFrame: 12 }],
      path: "/0/url",
    },
    {
      label: "native path properties",
      result: [{ sourceFrame: 12, url: null, path: "/tmp/frame.jpg" }],
      path: "/0/path",
    },
    {
      label: "non-file URLs",
      result: [{ sourceFrame: 12, url: "https://example.test/frame.jpg" }],
      path: "/0/url",
    },
    {
      label: "native path strings",
      result: [{ sourceFrame: 12, url: "/tmp/frame.jpg" }],
      path: "/0/url",
    },
    {
      label: "oversized result arrays",
      result: Array.from({ length: 13 }, (_, sourceFrame) => ({
        sourceFrame,
        url: null,
      })),
      path: "/",
    },
  ])("rejects timeline frame $label", async ({ result, path }) => {
    const { dispatch } = timelineFrameDispatcher(result);

    const response = await dispatch({
      v: 1,
      requestId: "req_gggggggggg",
      service: "MediaEngine",
      method: "resolveTimelineFrames",
      params: timelineFrameParams,
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "E_IPC_RESULT_SCHEMA",
        message: expect.stringContaining(path),
      },
    });
  });

  it("accepts cache-owned timeline frame URLs and null misses", async () => {
    const result = [
      { sourceFrame: 12, url: "file:///project/.guyditor/cache/frame.jpg" },
      { sourceFrame: 24, url: null },
    ];
    const { dispatch } = timelineFrameDispatcher(result);

    const response = await dispatch({
      v: 1,
      requestId: "req_hhhhhhhhhh",
      service: "MediaEngine",
      method: "resolveTimelineFrames",
      params: timelineFrameParams,
    });

    expect(response).toEqual({
      v: 1,
      requestId: "req_hhhhhhhhhh",
      ok: true,
      result,
    });
  });
});
