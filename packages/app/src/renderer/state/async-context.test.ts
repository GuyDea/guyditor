import { describe, expect, it } from "vitest";

import {
  beginContextRequest,
  claimContextResponse,
  createContextRequestGate,
  invalidateContextRequests,
  isContextRequestCurrent,
  isContextRequestLatest,
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

  it("does not change word selection until the latest scoped navigation resolves", async () => {
    const gate = createContextRequestGate();
    const first = deferred<number>();
    const second = deferred<number>();
    let context = "project-a:short-a";
    let selectedWord = "wrd_existing";
    let frame = 0;

    async function navigate(
      wordId: string,
      requestContext: string,
      resolution: Promise<number>,
    ): Promise<void> {
      const request = beginContextRequest(gate, requestContext);
      const resolvedFrame = await resolution;
      if (!isContextRequestCurrent(gate, request, context)) return;
      selectedWord = wordId;
      frame = resolvedFrame;
    }

    const oldNavigation = navigate("wrd_old", context, first.promise);
    const latestNavigation = navigate("wrd_latest", context, second.promise);
    expect(selectedWord).toBe("wrd_existing");

    second.resolve(48);
    await latestNavigation;
    expect({ selectedWord, frame }).toEqual({
      selectedWord: "wrd_latest",
      frame: 48,
    });

    first.resolve(12);
    await oldNavigation;
    expect({ selectedWord, frame }).toEqual({
      selectedWord: "wrd_latest",
      frame: 48,
    });

    const changedContext = deferred<number>();
    const staleNavigation = navigate(
      "wrd_other_short",
      context,
      changedContext.promise,
    );
    context = "project-a:short-b";
    changedContext.resolve(96);
    await staleNavigation;
    expect({ selectedWord, frame }).toEqual({
      selectedWord: "wrd_latest",
      frame: 48,
    });
  });

  it("suppresses every field and warning from a stale project hydration", async () => {
    const gate = createContextRequestGate();
    const first = deferred<{
      project: string;
      transcripts: string[];
      warning: string;
    }>();
    const second = deferred<{
      project: string;
      transcripts: string[];
      warning?: string;
    }>();
    let applied = {
      project: "initial",
      transcripts: ["initial"],
      notice: "initial",
    };

    async function hydrate(
      result: Promise<{
        project: string;
        transcripts: string[];
        warning?: string;
      }>,
    ): Promise<void> {
      const request = beginContextRequest(gate, "project-load");
      const loaded = await result;
      if (!isContextRequestLatest(gate, request)) return;
      applied = {
        project: loaded.project,
        transcripts: loaded.transcripts,
        notice: loaded.warning ?? `Opened ${loaded.project}`,
      };
    }

    const staleHydration = hydrate(first.promise);
    const latestHydration = hydrate(second.promise);
    second.resolve({
      project: "project-b",
      transcripts: ["b"],
    });
    await latestHydration;
    first.resolve({
      project: "project-a",
      transcripts: ["a"],
      warning: "stale workspace warning",
    });
    await staleHydration;

    expect(applied).toEqual({
      project: "project-b",
      transcripts: ["b"],
      notice: "Opened project-b",
    });
  });

  it("lets hydration replace an obsolete-project refresh but not a newer same-project refresh", () => {
    const oldProjectGate = createContextRequestGate();
    const hydration = beginContextRequest(oldProjectGate, "project-b");
    const obsoleteRefresh = beginContextRequest(oldProjectGate, "project-a");

    expect(claimContextResponse(
      oldProjectGate,
      hydration,
      "project-b",
    )).toBe(true);
    expect(isContextRequestLatest(oldProjectGate, obsoleteRefresh)).toBe(false);

    const sameProjectGate = createContextRequestGate();
    const staleHydration = beginContextRequest(sameProjectGate, "project-b");
    const newerRefresh = beginContextRequest(sameProjectGate, "project-b");
    expect(claimContextResponse(
      sameProjectGate,
      staleHydration,
      "project-b",
    )).toBe(false);
    expect(isContextRequestLatest(sameProjectGate, newerRefresh)).toBe(true);
  });
});
