import { describe, expect, it } from "vitest";

import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import type { JobOverview } from "../../shared/ipc.js";
import {
  overviewStatusText,
  overviewWaitingCount,
  useJobsStore,
} from "./jobs.js";
import { useProjectMirror } from "./project-mirror.js";
import { useUndoStore } from "./undo.js";
import {
  usePreviewStore,
  useSelectionStore,
  useWorkspaceStore,
} from "./view-state.js";
import {
  assignPanel,
  clampSplitterValue,
  createDefaultLayout,
  parseLayout,
  reorderPanel,
} from "./layout-state.js";

describe("workspace renderer state", () => {
  it("mirrors the global overview and derives active, waiting, and idle copy", () => {
    const overview: JobOverview = {
      running: [{
        jobId: "job_aaaaaaaaaa",
        kind: "proxy.generate",
        state: "running",
        progress: 0.4,
        dependsOn: [],
        title: "Generate proxy",
        cancellable: true,
        createdAt: "2026-07-19T10:00:00.000Z",
      }],
      queued: [],
      retryable: [],
      waitingOnCreator: {
        proposals: [{
          proposalId: "prp_aaaaaaaaaa",
          title: "Review proposal",
          createdAt: "2026-07-19T10:01:00.000Z",
        }],
        annotations: [{
          annotationId: "ann_aaaaaaaaaa",
          code: "VAL-400",
          message: "Resolve annotation",
        }],
        confirmations: [],
      },
      waitingOnExternal: [],
      aggregateFraction: 0.4,
      idle: false,
    };
    useJobsStore.getState().replaceOverview(overview);

    expect(useJobsStore.getState().overview).toEqual(overview);
    expect(overviewWaitingCount(overview)).toBe(2);
    expect(overviewStatusText(overview)).toBe("1 active · 40%");

    const idle = {
      ...overview,
      running: [],
      waitingOnCreator: { proposals: [], annotations: [], confirmations: [] },
      aggregateFraction: 1,
      idle: true,
    };
    expect(overviewStatusText(idle)).toBe(
      "idle — no background work, nothing awaiting review",
    );

    expect(overviewStatusText({
      ...idle,
      retryable: [{
        jobId: "job_bbbbbbbbbb",
        kind: "proxy.generate",
        state: "failed",
        progress: 0.4,
        dependsOn: [],
        title: "Failed proxy",
        cancellable: true,
        createdAt: "2026-07-19T10:02:00.000Z",
      }],
      idle: false,
    })).toBe("1 job needs attention");
  });

  it("replaces the read-only project mirror as a whole snapshot", () => {
    const master = projectFixture();
    useProjectMirror.getState().replace({
      revision: master.revision,
      master,
      sidecarIndex: master.sidecars,
      projectPath: "/project",
    });

    expect(useProjectMirror.getState().snapshot?.master.project.name).toBe("Fixture");
    expect(useProjectMirror.getState().snapshot?.revision).toBe("rev_00001");
  });

  it("keeps panel, selection, and preview choices in Zustand view state", () => {
    useWorkspaceStore.getState().resetLayout();
    useWorkspaceStore.getState().togglePanel("media");
    useSelectionStore.getState().selectWord("w000042");
    usePreviewStore.getState().setPlayhead({ frames: 12, fps: "24/1" });
    usePreviewStore.getState().setSettled(false);

    expect(useWorkspaceStore.getState().collapsed.media).toBe(true);
    expect(useSelectionStore.getState().selectedWordId).toBe("w000042");
    expect(usePreviewStore.getState()).toMatchObject({
      playhead: { frames: 12, fps: "24/1" },
      settled: false,
      quality: "proxy",
    });
  });

  it("assigns panels between regions and keeps every panel in exactly one region", () => {
    const moved = assignPanel(createDefaultLayout(), "transcript", "right-top", 1);

    expect(moved.regions["center-bottom"].panelIds).toEqual([]);
    expect(moved.regions["right-top"]).toEqual({
      panelIds: ["agent", "transcript"],
      activePanelId: "transcript",
    });
    expect(Object.values(moved.regions).flatMap(({ panelIds }) => panelIds)
      .filter((panelId) => panelId === "transcript")).toHaveLength(1);
  });

  it("reorders tabs within a region without duplicating a panel", () => {
    const stacked = assignPanel(createDefaultLayout(), "transcript", "right-top", 1);
    const reordered = reorderPanel(stacked, "right-top", "transcript", 0);

    expect(reordered.regions["right-top"]).toEqual({
      panelIds: ["transcript", "agent"],
      activePanelId: "transcript",
    });
  });

  it("clamps every splitter to its supported range", () => {
    expect(clampSplitterValue("left", -100)).toBe(190);
    expect(clampSplitterValue("right", 9_999)).toBe(520);
    expect(clampSplitterValue("center-horizontal", 0.01)).toBe(0.25);
    expect(clampSplitterValue("right-horizontal", 0.99)).toBe(0.75);
    expect(clampSplitterValue("timeline", 10)).toBe(96);
    expect(clampSplitterValue("status", -1_000)).toBe(96);
    expect(clampSplitterValue("status", 1_000)).toBe(220);
  });

  it("resets the live workspace layout to a fresh default", () => {
    useWorkspaceStore.getState().assignPanel("transcript", "right-top", 1);
    useWorkspaceStore.getState().setSplitter("left", 410);
    useWorkspaceStore.getState().togglePanel("agent");

    useWorkspaceStore.getState().resetLayout();

    expect(useWorkspaceStore.getState().layout).toEqual(createDefaultLayout());
  });

  it("preserves auxiliary panel collapse state across dock layout mutations", () => {
    useWorkspaceStore.getState().togglePanel("broll");

    useWorkspaceStore.getState().setSplitter("left", 320);

    expect(useWorkspaceStore.getState().collapsed.broll).toBe(true);
    useWorkspaceStore.getState().togglePanel("broll");
  });

  it("falls back to the default for absent, older, or malformed schemas", () => {
    const fallback = createDefaultLayout();

    expect(parseLayout(undefined)).toEqual(fallback);
    expect(parseLayout({ schema: "layout/v0" })).toEqual(fallback);
    expect(parseLayout({
      ...fallback,
      regions: {
        ...fallback.regions,
        left: { panelIds: ["media", "media"], activePanelId: "media" },
      },
    })).toEqual(fallback);
  });

  it("caps direct undo history at 200 and clears redo on a new action", () => {
    useUndoStore.getState().clear();
    for (let index = 0; index < 201; index += 1) {
      useUndoStore.getState().record({
        txnId: "txn_aaaaaaaaaa",
        label: `Edit ${String(index)}`,
        ops: [{ op: "clip.remove", params: { clipId: "clp_aaaaaaaaaa", closeGap: true } }],
        inverse: [{ op: "clip.insert", params: {} }],
      });
    }
    expect(useUndoStore.getState().undo).toHaveLength(200);

    const undone = useUndoStore.getState().beginUndo();
    expect(undone?.label).toBe("Edit 200");
    if (undone !== undefined) useUndoStore.getState().finishUndo(undone);
    expect(useUndoStore.getState().redo).toHaveLength(1);

    useUndoStore.getState().record({
      txnId: "txn_bbbbbbbbbb",
      label: "A newer edit",
      ops: [],
      inverse: [],
    });
    expect(useUndoStore.getState().redo).toHaveLength(0);
  });
});
