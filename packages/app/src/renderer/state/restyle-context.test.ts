import { describe, expect, it } from "vitest";

import type { RestylePlan } from "../../../../core/src/index.js";
import {
  beginContextRequest,
  createContextRequestGate,
  isContextRequestCurrent,
} from "./async-context.js";
import {
  createRestyleContext,
  keyRestylePlan,
  restylePlanForContext,
  restylePlanMatchesContext,
} from "./restyle-context.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function plan(
  deliverableId: string,
  sequenceId: string,
  id: string,
): RestylePlan {
  return {
    schema: "guyditor.restyle/v1",
    id,
    deliverableId,
    sequenceId,
    sourceAssets: [],
    adapterId: "adapter",
    model: "model",
    createdAt: "2026-07-27T00:00:00.000Z",
    coverage: { mode: "full", ranges: [] },
    constraints: {
      maxSegmentSeconds: 10,
      maxResolution: { width: 1920, height: 1080 },
      fpsSupport: "any",
      costPerSecond: 0,
      concurrency: 1,
    },
    settings: { prompt: "test", providerSettings: {} },
    chunks: [],
    seams: [],
    estimatedCost: { currency: "USD", amount: 0 },
  };
}

describe("restyle context runtime", () => {
  it("keeps reverse deferred results and errors isolated by project path and deliverable", async () => {
    const contextA = createRestyleContext(
      "/project-a",
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
    );
    const contextB = createRestyleContext(
      "/project-b",
      "dlv_aaaaaaaaaa",
      "seq_bbbbbbbbbb",
    );
    const gate = createContextRequestGate();
    let current = contextA;
    let state = keyRestylePlan(contextA, null);

    async function load(
      context: typeof contextA,
      result: Promise<RestylePlan | null>,
    ): Promise<void> {
      current = context;
      const request = beginContextRequest(gate, context.key);
      try {
        const value = await result;
        if (isContextRequestCurrent(gate, request, current.key)) {
          state = keyRestylePlan(context, value);
        }
      } catch {
        if (isContextRequestCurrent(gate, request, current.key)) {
          state = keyRestylePlan(context, null);
        }
      }
    }

    const first = deferred<RestylePlan | null>();
    const second = deferred<RestylePlan | null>();
    const loadA = load(contextA, first.promise);
    const loadB = load(contextB, second.promise);
    const planB = plan("dlv_aaaaaaaaaa", "seq_bbbbbbbbbb", "restyle-b");
    second.resolve(planB);
    await loadB;
    first.reject(new Error("late A"));
    await loadA;

    expect(restylePlanForContext(state, contextA)).toBeNull();
    expect(restylePlanForContext(state, contextB)).toBe(planB);
  });

  it("rejects deliverable or sequence mismatches so they can never be accepted or submitted", () => {
    const context = createRestyleContext(
      "/project",
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
    );
    const wrongDeliverable = plan(
      "dlv_bbbbbbbbbb",
      "seq_aaaaaaaaaa",
      "restyle-wrong-deliverable",
    );
    const wrongSequence = plan(
      "dlv_aaaaaaaaaa",
      "seq_bbbbbbbbbb",
      "restyle-wrong-sequence",
    );

    expect(restylePlanMatchesContext(wrongDeliverable, context)).toBe(false);
    expect(restylePlanMatchesContext(wrongSequence, context)).toBe(false);
    expect(restylePlanForContext(keyRestylePlan(context, wrongDeliverable), context))
      .toBeNull();
    expect(restylePlanForContext(keyRestylePlan(context, wrongSequence), context))
      .toBeNull();
  });
});
