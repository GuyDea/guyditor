import { describe, expect, it } from "vitest";

import {
  beginContextRequest,
  createContextRequestGate,
  invalidateContextRequests,
  isContextRequestCurrent,
} from "./async-context.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("context request gate", () => {
  it("lets only the newest reverse-resolving proposal evidence navigation apply", async () => {
    const gate = createContextRequestGate();
    const applied: string[] = [];
    let selectedDeliverableId: string | null = null;

    async function navigate(
      deliverableId: string,
      activation: Promise<void>,
    ): Promise<void> {
      const request = beginContextRequest(gate, deliverableId);
      selectedDeliverableId = deliverableId;
      await activation;
      if (isContextRequestCurrent(gate, request, selectedDeliverableId)) {
        applied.push(deliverableId);
      }
    }

    const first = deferred<void>();
    const second = deferred<void>();
    const firstNavigation = navigate("dlv_aaaaaaaaaa", first.promise);
    const secondNavigation = navigate("dlv_bbbbbbbbbb", second.promise);
    second.resolve();
    await secondNavigation;
    first.resolve();
    await firstNavigation;

    expect(selectedDeliverableId).toBe("dlv_bbbbbbbbbb");
    expect(applied).toEqual(["dlv_bbbbbbbbbb"]);
  });

  it("applies no evidence selection after an invalid activation or a manual target change", async () => {
    const gate = createContextRequestGate();
    const applied: string[] = [];
    let selectedDeliverableId: string | null = null;

    const invalid = beginContextRequest(gate, "dlv_missing");
    await Promise.reject(new Error("missing")).catch(() => undefined);
    if (isContextRequestCurrent(gate, invalid, selectedDeliverableId)) {
      applied.push("invalid");
    }

    const activation = deferred<void>();
    const request = beginContextRequest(gate, "dlv_aaaaaaaaaa");
    selectedDeliverableId = "dlv_aaaaaaaaaa";
    selectedDeliverableId = "dlv_bbbbbbbbbb";
    activation.resolve();
    await activation.promise;
    if (isContextRequestCurrent(gate, request, selectedDeliverableId)) {
      applied.push("stale");
    }

    expect(applied).toEqual([]);
  });

  it("invalidates older same-context responses and all requests across a context reset", () => {
    const gate = createContextRequestGate();
    const first = beginContextRequest(gate, "same-context");
    const second = beginContextRequest(gate, "same-context");
    expect(isContextRequestCurrent(gate, first, "same-context")).toBe(false);
    expect(isContextRequestCurrent(gate, second, "same-context")).toBe(true);

    invalidateContextRequests(gate);
    expect(isContextRequestCurrent(gate, second, "same-context")).toBe(false);
  });
});
