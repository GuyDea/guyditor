import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  configureLayoutSaver,
  usePreviewStore,
  useSelectionStore,
  useWorkspaceStore,
} from "./view-state.js";
import { WORKFLOW_PHASES } from "./layout-state.js";
import { presetLayout } from "./layout-presets.js";
import { findGroup, firstGroup, groupOf, placedPanels } from "./layout-tree.js";
import type { LayoutNode } from "./layout-tree.js";
import { panelBadgeCounts, phaseBadgeCounts } from "../workflow-phases.js";

afterEach(() => {
  useSelectionStore.setState({
    selectedClipId: null,
    selectedLayerId: null,
    selectedWordId: null,
    selectedAnnotationId: null,
    selectedDeliverableId: null,
    wordRange: null,
  });
});

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

  it("maps only JobOverview data into phase badges", () => {
    const overview: JobOverview = {
      running: [{
        jobId: "job_cccccccccc",
        kind: "ingest",
        state: "running",
        progress: 0.4,
        dependsOn: [],
        title: "Ingest source",
        cancellable: false,
        createdAt: "2026-07-23T10:00:00.000Z",
      }],
      queued: [{
        jobId: "job_dddddddddd",
        kind: "proxy.generate",
        state: "queued",
        progress: 0,
        dependsOn: ["job_cccccccccc"],
        dependencyChain: [],
        title: "Generate proxy",
        cancellable: true,
        createdAt: "2026-07-23T10:00:01.000Z",
      }],
      retryable: [{
        jobId: "job_eeeeeeeeee",
        kind: "render.export",
        state: "failed",
        progress: 0.6,
        dependsOn: [],
        title: "Export primary",
        cancellable: true,
        createdAt: "2026-07-23T10:00:02.000Z",
      }],
      waitingOnCreator: {
        proposals: [
          {
            proposalId: "prp_ffffffffff",
            title: "Review the selected pause and filler candidates",
            createdAt: "2026-07-23T10:01:00.000Z",
          },
          {
            proposalId: "prp_gggggggggg",
            title: "Review color adjustments",
            createdAt: "2026-07-23T10:02:00.000Z",
          },
        ],
        annotations: [{
          annotationId: "ann_hhhhhhhhhh",
          code: "VAL-400",
          message: "Resolve title placement",
        }],
        confirmations: [{
          confirmToken: "confirm_budget",
          taskId: "render-primary",
          level: "task",
          message: "Confirm export budget",
          estimatedUsd: 2.5,
          createdAt: "2026-07-23T10:03:00.000Z",
        }],
      },
      waitingOnExternal: [],
      aggregateFraction: 0.2,
      idle: false,
    };

    expect(phaseBadgeCounts(overview)).toEqual({
      ingest: 2,
      cut: 1,
      polish: 0,
      review: 3,
      publish: 2,
    });
    expect(panelBadgeCounts(overview)).toEqual({
      agent: 2,
      assemble: 0,
      broll: 0,
      graphics: 0,
      help: 0,
      inspector: 0,
      media: 2,
      preview: 1,
      publish: 2,
      skills: 0,
      status: 2,
      storage: 0,
      timeline: 0,
      transcript: 1,
    });
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
    useWorkspaceStore.getState().setPhase("ingest");
    useWorkspaceStore.getState().resetLayout();
    useWorkspaceStore.getState().closeTab("media");
    useSelectionStore.getState().selectWord("w000042");
    usePreviewStore.getState().setPlayhead({ frames: 12, fps: "24/1" });
    usePreviewStore.getState().setSettled(false);

    expect(placedPanels(useWorkspaceStore.getState().layout)).not.toContain("media");
    expect(useSelectionStore.getState().selectedWordId).toBe("w000042");
    expect(usePreviewStore.getState()).toMatchObject({
      playhead: { frames: 12, fps: "24/1" },
      settled: false,
      quality: "proxy",
    });
  });

  it("atomically activates a deliverable and clears sequence-scoped selection", () => {
    useSelectionStore.setState({
      selectedClipId: "clp_aaaaaaaaaa",
      selectedLayerId: "lyr_aaaaaaaaaa",
      selectedWordId: "w000001",
      selectedAnnotationId: "ann_aaaaaaaaaa",
      selectedDeliverableId: "dlv_aaaaaaaaaa",
      wordRange: { fromWord: "w000001", toWord: "w000002" },
    });

    useSelectionStore.getState().activateDeliverable("dlv_bbbbbbbbbb");

    expect(useSelectionStore.getState()).toMatchObject({
      selectedDeliverableId: "dlv_bbbbbbbbbb",
      selectedClipId: null,
      selectedLayerId: null,
      selectedWordId: null,
      selectedAnnotationId: null,
      wordRange: null,
    });
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

function shape(node: LayoutNode | null): unknown {
  if (node === null) return null;
  if (node.kind === "group") return [...node.panelIds];
  return { [node.direction]: node.children.map(shape) };
}

describe("workspace layout store", () => {
  const save = vi.fn();

  beforeEach(() => {
    configureLayoutSaver(() => undefined);
    useWorkspaceStore.getState().hydrateLayouts(null);
    save.mockReset();
    configureLayoutSaver(save);
  });

  function groupId(panel: Parameters<typeof groupOf>[1]): string {
    const group = groupOf(useWorkspaceStore.getState().layout, panel);
    if (group === null) throw new Error(`${panel} is not placed.`);
    return group.id;
  }

  it("hydrates garbage into the presets without saving", () => {
    useWorkspaceStore.getState().hydrateLayouts({ activePhase: 7, layouts: "x" });

    for (const phase of WORKFLOW_PHASES) {
      expect(shape(useWorkspaceStore.getState().layouts[phase].root))
        .toEqual(shape(presetLayout(phase).root));
    }
    expect(useWorkspaceStore.getState().activePhase).toBe("cut");
    expect(save).not.toHaveBeenCalled();
  });

  it("commits a split when a panel is picked and saves the whole document", () => {
    const store = useWorkspaceStore.getState();
    store.openPicker({ mode: "split", groupId: groupId("preview"), side: "right" });
    useWorkspaceStore.getState().choosePanel("inspector");

    const state = useWorkspaceStore.getState();
    expect(shape(state.layout.root)).toEqual({
      column: [
        { row: [{ column: [{ row: [["preview"], ["inspector"]] }, ["transcript"]] }, ["agent", "assemble"]] },
        ["timeline"],
      ],
    });
    expect(state.picker).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({ activePhase: "cut" });
    expect(Object.keys(save.mock.calls[0]![0].layouts as object).sort())
      .toEqual([...WORKFLOW_PHASES].sort());
  });

  it("leaves the layout untouched when the picker is cancelled", () => {
    const before = shape(useWorkspaceStore.getState().layout.root);
    useWorkspaceStore.getState().openPicker({ mode: "split", groupId: groupId("preview"), side: "down" });
    useWorkspaceStore.getState().cancelPicker();

    expect(shape(useWorkspaceStore.getState().layout.root)).toEqual(before);
    expect(useWorkspaceStore.getState().picker).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("cancels an open picker when the phase changes", () => {
    useWorkspaceStore.getState().openPicker({ mode: "split", groupId: groupId("preview"), side: "right" });
    useWorkspaceStore.getState().setPhase("polish");

    expect(useWorkspaceStore.getState().picker).toBeNull();
    expect(shape(useWorkspaceStore.getState().layout.root))
      .toEqual(shape(presetLayout("polish").root));
  });

  it("reveals into the first group after the last-used group was closed", () => {
    useWorkspaceStore.getState().focusPanel("agent");
    useWorkspaceStore.getState().closeGroup(groupId("agent"));
    useWorkspaceStore.getState().revealPanel("inspector");

    const state = useWorkspaceStore.getState();
    expect(groupOf(state.layout, "inspector")?.id).toBe(firstGroup(state.layout)?.id);
    expect(state.flashingPanel).toBe("inspector");
  });

  it("reveals into the group the user last clicked into", () => {
    useWorkspaceStore.getState().focusPanel("transcript");
    useWorkspaceStore.getState().revealPanel("inspector");

    expect(groupId("inspector")).toBe(groupId("transcript"));
    expect(useWorkspaceStore.getState().focusedPanel).toBe("inspector");
  });

  it("activates an already placed panel without flashing it", () => {
    useWorkspaceStore.getState().revealPanel("assemble");

    const state = useWorkspaceStore.getState();
    expect(findGroup(state.layout, groupId("assemble"))?.activePanelId).toBe("assemble");
    expect(state.flashingPanel).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves divider moves only when asked to persist", () => {
    const root = useWorkspaceStore.getState().layout.root;
    if (root?.kind !== "split") throw new Error("Cut preset root should be a split.");

    useWorkspaceStore.getState().resizeSplit(root.id, 0, -40, 1000, false);
    expect(save).not.toHaveBeenCalled();
    useWorkspaceStore.getState().resizeSplit(root.id, 0, -40, 1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("adds a root group from the empty workspace picker", () => {
    const store = useWorkspaceStore.getState();
    for (const panel of placedPanels(store.layout)) useWorkspaceStore.getState().closeTab(panel);
    expect(useWorkspaceStore.getState().layout.root).toBeNull();

    useWorkspaceStore.getState().openPicker({ mode: "root" });
    useWorkspaceStore.getState().choosePanel("help");

    expect(shape(useWorkspaceStore.getState().layout.root)).toEqual(["help"]);
  });

  it("moves a dragged tab into another group", () => {
    useWorkspaceStore.getState().moveTab("timeline", groupId("preview"), 0);

    expect(groupId("timeline")).toBe(groupId("preview"));
    expect(placedPanels(useWorkspaceStore.getState().layout).filter((panel) => panel === "timeline"))
      .toHaveLength(1);
  });

  it("resets the active phase or every phase to presets", () => {
    useWorkspaceStore.getState().closeGroup(groupId("timeline"));
    useWorkspaceStore.getState().setPhase("review");
    useWorkspaceStore.getState().closeGroup(groupId("agent"));

    useWorkspaceStore.getState().resetLayout();
    expect(shape(useWorkspaceStore.getState().layout.root)).toEqual(shape(presetLayout("review").root));
    expect(placedPanels(useWorkspaceStore.getState().layouts.cut)).not.toContain("timeline");

    useWorkspaceStore.getState().resetAllLayouts();
    expect(useWorkspaceStore.getState().activePhase).toBe("review");
    expect(placedPanels(useWorkspaceStore.getState().layouts.cut)).toContain("timeline");
  });
});
