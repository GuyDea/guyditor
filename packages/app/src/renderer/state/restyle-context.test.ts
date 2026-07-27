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
  restyleConfirmationMatchesContext,
  restyleMutationRequestKey,
  restylePlanForContext,
  restylePlanContractError,
  restylePlanMatchesContext,
  restyleSeamEditorKey,
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
  it("uses the full sequence context for mutation requests and silences reverse stale responses", async () => {
    const contextA = createRestyleContext(
      "/project",
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
    );
    const contextB = createRestyleContext(
      "/project",
      "dlv_aaaaaaaaaa",
      "seq_bbbbbbbbbb",
    );
    const gate = createContextRequestGate();
    let currentKey = restyleMutationRequestKey(contextA, "create");
    let state: RestylePlan | null = null;
    const notices: string[] = [];
    const refreshes: string[] = [];

    async function create(
      context: typeof contextA,
      response: Promise<RestylePlan>,
    ): Promise<void> {
      const key = restyleMutationRequestKey(context, "create");
      currentKey = key;
      const request = beginContextRequest(gate, key);
      try {
        const next = await response;
        if (!isContextRequestCurrent(gate, request, currentKey)) return;
        const contractError = restylePlanContractError(next, context);
        if (contractError !== null) {
          notices.push(contractError);
          return;
        }
        state = next;
        if (!isContextRequestCurrent(gate, request, currentKey)) return;
        refreshes.push(context.key);
        if (isContextRequestCurrent(gate, request, currentKey)) {
          notices.push(`ready:${next.id}`);
        }
      } catch {
        if (isContextRequestCurrent(gate, request, currentKey)) {
          notices.push("current error");
        }
      }
    }

    const first = deferred<RestylePlan>();
    const second = deferred<RestylePlan>();
    const createA = create(contextA, first.promise);
    const createB = create(contextB, second.promise);
    const planB = plan("dlv_aaaaaaaaaa", "seq_bbbbbbbbbb", "restyle-b");
    second.resolve(planB);
    await createB;
    first.resolve(plan("dlv_aaaaaaaaaa", "seq_aaaaaaaaaa", "restyle-a"));
    await createA;

    expect(contextA.key).not.toBe(contextB.key);
    expect(state).toBe(planB);
    expect(refreshes).toEqual([contextB.key]);
    expect(notices).toEqual(["ready:restyle-b"]);
  });

  it("keeps create, start/confirm, and seam generations independent", () => {
    const context = createRestyleContext(
      "/project",
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
    );
    const createGate = createContextRequestGate();
    const startGate = createContextRequestGate();
    const seamGate = createContextRequestGate();
    const createKey = restyleMutationRequestKey(context, "create");
    const startKey = restyleMutationRequestKey(context, "start:restyle-plan");
    const seamKey = restyleMutationRequestKey(context, "seam:restyle-plan:seam-a");
    const createRequest = beginContextRequest(createGate, createKey);
    const firstStart = beginContextRequest(startGate, startKey);
    const seamRequest = beginContextRequest(seamGate, seamKey);
    const confirmStart = beginContextRequest(startGate, startKey);

    expect(isContextRequestCurrent(createGate, createRequest, createKey)).toBe(true);
    expect(isContextRequestCurrent(seamGate, seamRequest, seamKey)).toBe(true);
    expect(isContextRequestCurrent(startGate, firstStart, startKey)).toBe(false);
    expect(isContextRequestCurrent(startGate, confirmStart, startKey)).toBe(true);

    const confirmation = {
      contextKey: context.key,
      sequenceId: context.sequenceId,
      planId: "restyle-plan",
    };
    expect(restyleConfirmationMatchesContext(
      confirmation,
      context,
      "restyle-plan",
    )).toBe(true);
    expect(restyleConfirmationMatchesContext(
      confirmation,
      context,
      "restyle-replacement",
    )).toBe(false);
  });

  it("silences late responses and rejections for every mutation resource identity", async () => {
    const contextA = createRestyleContext(
      "/project-a",
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
    );
    const contextB = createRestyleContext(
      "/project-b",
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
    );

    for (const resource of [
      "create",
      "start:restyle-plan",
      "seam:restyle-plan:seam-a",
    ]) {
      const gate = createContextRequestGate();
      let currentKey = restyleMutationRequestKey(contextA, resource);
      const applied: string[] = [];
      const errors: string[] = [];
      async function settle(
        context: typeof contextA,
        response: Promise<string>,
      ): Promise<void> {
        const key = restyleMutationRequestKey(context, resource);
        currentKey = key;
        const request = beginContextRequest(gate, key);
        try {
          const value = await response;
          if (isContextRequestCurrent(gate, request, currentKey)) {
            applied.push(value);
          }
        } catch {
          if (isContextRequestCurrent(gate, request, currentKey)) {
            errors.push("current error");
          }
        }
      }

      const staleResponse = deferred<string>();
      const latestResponse = deferred<string>();
      const first = settle(contextA, staleResponse.promise);
      const second = settle(contextB, latestResponse.promise);
      latestResponse.resolve("latest");
      await second;
      staleResponse.resolve("stale");
      await first;

      const staleError = deferred<string>();
      const replacement = deferred<string>();
      const third = settle(contextA, staleError.promise);
      const fourth = settle(contextB, replacement.promise);
      replacement.resolve("replacement");
      await fourth;
      staleError.reject(new Error("late"));
      await third;

      expect(applied).toEqual(["latest", "replacement"]);
      expect(errors).toEqual([]);
    }
  });

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

  it("surfaces deliverable or sequence contract mismatches instead of keying them as no plan", () => {
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
    expect(restylePlanContractError(wrongDeliverable, context)).toMatch(/contract/iu);
    expect(restylePlanContractError(wrongSequence, context)).toMatch(/contract/iu);
    expect(() => keyRestylePlan(context, wrongDeliverable)).toThrow(/contract/iu);
    expect(() => keyRestylePlan(context, wrongSequence)).toThrow(/contract/iu);
  });

  it("keys seam editor fields by context, plan, seam identity, canonical treatment, and catalog", () => {
    const contextA = createRestyleContext(
      "/project-a",
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
    );
    const contextB = createRestyleContext(
      "/project-b",
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
    );
    const basePlan = plan(
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
      "restyle-plan-a",
    );
    const otherPlan = { ...basePlan, id: "restyle-plan-b" };
    const seam = {
      id: "seam-same",
      frame: 12,
      boundary: "internal",
      status: "planned",
      treatment: {
        kind: "interstitial",
        templateId: "tpl_a2c3d4e5f6",
        durationFrames: 24,
        params: { title: "Title", accent: "#fff" },
        resumeExact: true,
      },
    } as const;
    const reordered = {
      ...seam,
      treatment: {
        ...seam.treatment,
        params: { accent: "#fff", title: "Title" },
      },
    };
    const catalogA = [{
      id: "tpl_a2c3d4e5f6",
      version: "1.0.0",
      contentHash: "a".repeat(64),
    }];
    const catalogB = [{
      id: "tpl_a2c3d4e5f6",
      version: "1.0.1",
      contentHash: "b".repeat(64),
    }];
    const key = restyleSeamEditorKey(contextA, basePlan, seam, catalogA);

    expect(restyleSeamEditorKey(contextA, basePlan, reordered, catalogA)).toBe(key);
    expect(restyleSeamEditorKey(contextB, basePlan, seam, catalogA)).not.toBe(key);
    expect(restyleSeamEditorKey(contextA, otherPlan, seam, catalogA)).not.toBe(key);
    expect(restyleSeamEditorKey(contextA, basePlan, {
      ...seam,
      frame: 13,
    }, catalogA)).not.toBe(key);
    expect(restyleSeamEditorKey(contextA, basePlan, seam, catalogB)).not.toBe(key);
  });
});
