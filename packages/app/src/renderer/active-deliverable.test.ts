import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import {
  activateDeliverable,
  applyDeliverableSelection,
  resolveActiveDeliverable,
} from "./active-deliverable.js";
import { useUndoStore } from "./state/undo.js";
import {
  usePreviewStore,
  useSelectionStore,
  useTimelineViewStore,
  useWorkspaceStore,
} from "./state/view-state.js";

const PRIMARY_DELIVERABLE_ID = "dlv_aaaaaaaaaa";
const SHORT_DELIVERABLE_ID = "dlv_bbbbbbbbbb";
const MISSING_DELIVERABLE_ID = "dlv_cccccccccc";

function projectWithShort() {
  const project = projectFixture();
  project.deliverables.push({
    id: SHORT_DELIVERABLE_ID,
    kind: "short",
    name: "Portrait short",
    profile: "youtube-shorts@1.0.0",
    sequenceId: "seq_bbbbbbbbbb",
    status: "draft",
  });
  return project;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function resetRendererState(): void {
  useSelectionStore.setState({
    selectedClipId: null,
    selectedLayerId: null,
    selectedWordId: null,
    selectedAnnotationId: null,
    selectedDeliverableId: null,
    wordRange: null,
  });
  usePreviewStore.setState({
    playhead: { frames: 0, fps: "24/1" },
    playing: false,
    settled: true,
    warning: null,
    loopRange: null,
    diagnosticBackground: "none",
    previewKeySettings: null,
  });
  useTimelineViewStore.setState({
    zoomPixelsPerFrame: 4,
    scrollOffsetFrames: 0,
  });
  useUndoStore.getState().clear();
}

beforeEach(resetRendererState);

afterEach(() => {
  resetRendererState();
  vi.restoreAllMocks();
});

describe("active deliverable", () => {
  it("resolves a live selected deliverable", () => {
    const project = projectWithShort();

    expect(resolveActiveDeliverable(project, SHORT_DELIVERABLE_ID))
      .toBe(project.deliverables[1]);
  });

  it("falls back only to the primary deliverable for null or stale selection", () => {
    const project = projectWithShort();

    expect(resolveActiveDeliverable(project, null).id).toBe(PRIMARY_DELIVERABLE_ID);
    expect(resolveActiveDeliverable(project, MISSING_DELIVERABLE_ID).id)
      .toBe(PRIMARY_DELIVERABLE_ID);
  });

  it("throws instead of guessing when the configured primary is missing", () => {
    const project = projectWithShort();
    project.settings.primaryDeliverable = MISSING_DELIVERABLE_ID;

    expect(() => resolveActiveDeliverable(project, null))
      .toThrow(`Primary deliverable ${MISSING_DELIVERABLE_ID} does not exist.`);
  });

  it("validates the target before changing local state or persisting", async () => {
    const project = projectWithShort();
    const persist = vi.fn().mockResolvedValue(undefined);
    const setNotice = vi.fn();
    useSelectionStore.setState({
      selectedDeliverableId: PRIMARY_DELIVERABLE_ID,
      selectedClipId: "clp_aaaaaaaaaa",
    });
    usePreviewStore.setState({
      playing: true,
      playhead: { frames: 19, fps: "24/1" },
    });

    await expect(activateDeliverable(
      project,
      MISSING_DELIVERABLE_ID,
      setNotice,
      persist,
    )).rejects.toThrow(`Deliverable ${MISSING_DELIVERABLE_ID} does not exist.`);

    expect(persist).not.toHaveBeenCalled();
    expect(setNotice).not.toHaveBeenCalled();
    expect(useSelectionStore.getState()).toMatchObject({
      selectedDeliverableId: PRIMARY_DELIVERABLE_ID,
      selectedClipId: "clp_aaaaaaaaaa",
    });
    expect(usePreviewStore.getState()).toMatchObject({
      playing: true,
      playhead: { frames: 19, fps: "24/1" },
    });
  });

  it("atomically resets preview and sequence navigation while preserving view context", () => {
    const project = projectWithShort();
    project.settings.timeline.fps = "30/1";
    useSelectionStore.setState({
      selectedClipId: "clp_aaaaaaaaaa",
      selectedLayerId: "lyr_aaaaaaaaaa",
      selectedWordId: "w000001",
      selectedAnnotationId: "ann_aaaaaaaaaa",
      selectedDeliverableId: PRIMARY_DELIVERABLE_ID,
      wordRange: { fromWord: "w000001", toWord: "w000002" },
    });
    usePreviewStore.setState({
      playing: true,
      playhead: { frames: 72, fps: "24/1" },
      settled: true,
      warning: "Showing an old frame",
      loopRange: { start: 12, end: 24 },
      diagnosticBackground: "checkerboard",
      previewKeySettings: {
        schema: "guyditor/key@1",
        mode: "chroma",
        chroma: {
          keyColor: "#00B140",
          tolerance: 0.35,
          softness: 0.12,
          preBlur: 1.5,
          edge: { erodePx: 1, featherPx: 2 },
          spill: { mode: "despill", strength: 0.6 },
        },
        masks: [],
      },
    });
    useTimelineViewStore.setState({
      zoomPixelsPerFrame: 8,
      scrollOffsetFrames: 40,
    });
    useUndoStore.getState().record({
      txnId: "txn_aaaaaaaaaa",
      label: "Existing edit",
      ops: [],
      inverse: [],
    });
    const undoBefore = structuredClone(useUndoStore.getState().undo);
    const layoutBefore = useWorkspaceStore.getState().layout;
    const previewNotifications = vi.fn();
    const unsubscribe = usePreviewStore.subscribe(previewNotifications);

    const selected = (() => {
      try {
        return applyDeliverableSelection(project, SHORT_DELIVERABLE_ID);
      } finally {
        unsubscribe();
      }
    })();

    expect(selected.id).toBe(SHORT_DELIVERABLE_ID);
    expect(previewNotifications).toHaveBeenCalledOnce();
    expect(useSelectionStore.getState()).toMatchObject({
      selectedDeliverableId: SHORT_DELIVERABLE_ID,
      selectedClipId: null,
      selectedLayerId: null,
      selectedWordId: null,
      selectedAnnotationId: null,
      wordRange: null,
    });
    expect(usePreviewStore.getState()).toMatchObject({
      playing: false,
      playhead: { frames: 0, fps: "30/1" },
      quality: "proxy",
      settled: false,
      warning: null,
      loopRange: null,
      diagnosticBackground: "checkerboard",
      previewKeySettings: null,
    });
    expect(useTimelineViewStore.getState()).toMatchObject({
      zoomPixelsPerFrame: 8,
      scrollOffsetFrames: 0,
    });
    expect(useWorkspaceStore.getState().layout).toBe(layoutBefore);
    expect(useUndoStore.getState().undo).toEqual(undoBefore);
  });

  it("keeps the local switch and reports an actionable autosave failure", async () => {
    const project = projectWithShort();
    const setNotice = vi.fn();
    let selectionAtPersist: string | null = null;
    const persist = vi.fn(() => {
      selectionAtPersist = useSelectionStore.getState().selectedDeliverableId;
      return Promise.reject(new Error("disk full"));
    });
    useSelectionStore.setState({
      selectedDeliverableId: PRIMARY_DELIVERABLE_ID,
    });

    await activateDeliverable(
      project,
      SHORT_DELIVERABLE_ID,
      setNotice,
      persist,
    );

    expect(selectionAtPersist).toBe(SHORT_DELIVERABLE_ID);
    expect(useSelectionStore.getState().selectedDeliverableId)
      .toBe(SHORT_DELIVERABLE_ID);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(SHORT_DELIVERABLE_ID);
    expect(setNotice).toHaveBeenCalledOnce();
    expect(setNotice).toHaveBeenCalledWith(
      "Switched to Portrait short, but workspace autosave failed: disk full",
    );
  });

  it("replaces a failed autosave notice after a successful same-item retry", async () => {
    const project = projectWithShort();
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    let notice = "";
    const setNotice = vi.fn((message: string) => {
      notice = message;
    });
    useSelectionStore.setState({
      selectedDeliverableId: PRIMARY_DELIVERABLE_ID,
    });

    await activateDeliverable(
      project,
      SHORT_DELIVERABLE_ID,
      setNotice,
      persist,
    );
    expect(notice).toBe(
      "Switched to Portrait short, but workspace autosave failed: disk full",
    );

    await activateDeliverable(
      project,
      SHORT_DELIVERABLE_ID,
      setNotice,
      persist,
    );

    expect(persist).toHaveBeenCalledTimes(2);
    expect(notice).toBe("Switched to Portrait short.");
  });

  it("retries persistence without resetting navigation when reselecting the active item", async () => {
    const project = projectWithShort();
    applyDeliverableSelection(project, SHORT_DELIVERABLE_ID);
    useSelectionStore.setState({
      selectedClipId: "clp_aaaaaaaaaa",
      selectedWordId: "w000001",
      wordRange: { fromWord: "w000001", toWord: "w000002" },
    });
    usePreviewStore.setState({
      playing: true,
      playhead: { frames: 7, fps: "24/1" },
      loopRange: { start: 3, end: 11 },
    });
    useTimelineViewStore.setState({
      zoomPixelsPerFrame: 12,
      scrollOffsetFrames: 5,
    });
    const selectionBefore = {
      selectedClipId: useSelectionStore.getState().selectedClipId,
      selectedWordId: useSelectionStore.getState().selectedWordId,
      wordRange: useSelectionStore.getState().wordRange,
    };
    const persist = vi.fn().mockResolvedValue(undefined);
    const setNotice = vi.fn();

    await activateDeliverable(
      project,
      SHORT_DELIVERABLE_ID,
      setNotice,
      persist,
    );

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(SHORT_DELIVERABLE_ID);
    expect(setNotice).toHaveBeenCalledOnce();
    expect(setNotice).toHaveBeenCalledWith("Switched to Portrait short.");
    expect(useSelectionStore.getState()).toMatchObject(selectionBefore);
    expect(usePreviewStore.getState()).toMatchObject({
      playing: true,
      playhead: { frames: 7, fps: "24/1" },
      loopRange: { start: 3, end: 11 },
    });
    expect(useTimelineViewStore.getState()).toMatchObject({
      zoomPixelsPerFrame: 12,
      scrollOffsetFrames: 5,
    });
  });

  it("ignores an older failed switch after a newer switch succeeds", async () => {
    const project = projectWithShort();
    const shortPersist = deferred<unknown>();
    const primaryPersist = deferred<unknown>();
    const persist = vi.fn((deliverableId: string) => deliverableId === SHORT_DELIVERABLE_ID
      ? shortPersist.promise
      : primaryPersist.promise);
    const notices: string[] = [];
    const setNotice = vi.fn((message: string) => {
      notices.push(message);
    });
    useSelectionStore.setState({
      selectedDeliverableId: PRIMARY_DELIVERABLE_ID,
    });

    const switchToShort = activateDeliverable(
      project,
      SHORT_DELIVERABLE_ID,
      setNotice,
      persist,
    );
    const switchToPrimary = activateDeliverable(
      project,
      PRIMARY_DELIVERABLE_ID,
      setNotice,
      persist,
    );

    expect(useSelectionStore.getState().selectedDeliverableId)
      .toBe(PRIMARY_DELIVERABLE_ID);
    primaryPersist.resolve(undefined);
    await switchToPrimary;
    shortPersist.reject(new Error("short autosave failed"));
    await switchToShort;

    expect(notices).toEqual(["Switched to master."]);
    expect(useSelectionStore.getState().selectedDeliverableId)
      .toBe(PRIMARY_DELIVERABLE_ID);
  });

  it("lets direct hydration invalidate an older pending failure", async () => {
    const project = projectWithShort();
    const pendingPersist = deferred<unknown>();
    const setNotice = vi.fn();
    useSelectionStore.setState({
      selectedDeliverableId: PRIMARY_DELIVERABLE_ID,
    });
    const pendingSwitch = activateDeliverable(
      project,
      SHORT_DELIVERABLE_ID,
      setNotice,
      vi.fn(() => pendingPersist.promise),
    );

    applyDeliverableSelection(project, PRIMARY_DELIVERABLE_ID);
    pendingPersist.reject(new Error("obsolete autosave failure"));
    await pendingSwitch;

    expect(setNotice).not.toHaveBeenCalled();
    expect(useSelectionStore.getState().selectedDeliverableId)
      .toBe(PRIMARY_DELIVERABLE_ID);
  });

  it("does not supersede a pending request when an invalid target is rejected", async () => {
    const project = projectWithShort();
    const pendingPersist = deferred<unknown>();
    const persist = vi.fn(() => pendingPersist.promise);
    const setNotice = vi.fn();
    useSelectionStore.setState({
      selectedDeliverableId: PRIMARY_DELIVERABLE_ID,
    });
    const pendingSwitch = activateDeliverable(
      project,
      SHORT_DELIVERABLE_ID,
      setNotice,
      persist,
    );

    await expect(activateDeliverable(
      project,
      MISSING_DELIVERABLE_ID,
      setNotice,
      persist,
    )).rejects.toThrow(`Deliverable ${MISSING_DELIVERABLE_ID} does not exist.`);
    pendingPersist.reject(new Error("latest autosave failed"));
    await pendingSwitch;

    expect(persist).toHaveBeenCalledOnce();
    expect(setNotice).toHaveBeenCalledOnce();
    expect(setNotice).toHaveBeenCalledWith(
      "Switched to Portrait short, but workspace autosave failed: latest autosave failed",
    );
  });
});
