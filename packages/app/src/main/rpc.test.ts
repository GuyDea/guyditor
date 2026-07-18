import { describe, expect, it } from "vitest";

import type { IpcSurface } from "../shared/ipc.js";
import { createRpcDispatcher } from "./rpc.js";

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
});
