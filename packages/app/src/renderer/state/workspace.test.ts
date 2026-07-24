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
  createDefaultLayouts,
  DOCK_PANEL_IDS,
  LEGACY_LAYOUT_STORAGE_KEY,
  LAYOUT_STORAGE_KEY,
  loadProjectLayouts,
  parseLayout,
  reorderPanel,
  WORKFLOW_PHASES,
} from "./layout-state.js";
import { panelBadgeCounts, phaseBadgeCounts } from "../workflow-phases.js";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function legacyLayout(left = 250): Record<string, unknown> {
  return {
    schema: "layout/v1",
    regions: {
      left: { panelIds: ["media"], activePanelId: "media" },
      "center-top": { panelIds: ["preview"], activePanelId: "preview" },
      "center-bottom": { panelIds: ["transcript"], activePanelId: "transcript" },
      "right-top": { panelIds: ["agent"], activePanelId: "agent" },
      "right-bottom": { panelIds: ["inspector"], activePanelId: "inspector" },
      "bottom-timeline": { panelIds: ["timeline"], activePanelId: "timeline" },
      "bottom-status": { panelIds: ["status"], activePanelId: "status" },
    },
    splitters: {
      left,
      right: 310,
      "center-horizontal": 0.58,
      "right-horizontal": 0.56,
      timeline: 170,
      status: 132,
    },
    collapsed: {
      media: false,
      preview: false,
      transcript: false,
      inspector: false,
      agent: false,
      timeline: false,
      status: false,
    },
  };
}

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
    useWorkspaceStore.getState().togglePanel("media");
    useSelectionStore.getState().selectWord("w000042");
    usePreviewStore.getState().setPlayhead({ frames: 12, fps: "24/1" });
    usePreviewStore.getState().setSettled(false);

    expect(useWorkspaceStore.getState().railCollapsed.media).toBe(true);
    expect(useSelectionStore.getState().selectedWordId).toBe("w000042");
    expect(usePreviewStore.getState()).toMatchObject({
      playhead: { frames: 12, fps: "24/1" },
      settled: false,
      quality: "proxy",
    });
  });

  it("assigns panels between regions and keeps every panel in exactly one region", () => {
    const moved = assignPanel(createDefaultLayout("cut"), "transcript", "right-top", 1);

    expect(moved.regions["right-top"].panelIds).toContain("transcript");
    expect(moved.regions["right-top"].activePanelId).toBe("transcript");
    expect(Object.values(moved.regions).flatMap(({ panelIds }) => panelIds)
      .filter((panelId) => panelId === "transcript")).toHaveLength(1);
  });

  it("reorders tabs within a region without duplicating a panel", () => {
    const stacked = assignPanel(createDefaultLayout("cut"), "transcript", "right-top", 1);
    const reordered = reorderPanel(stacked, "right-top", "transcript", 0);

    expect(reordered.regions["right-top"].panelIds[0]).toBe("transcript");
    expect(reordered.regions["right-top"].activePanelId).toBe("transcript");
  });

  it("creates five curated defaults while keeping every panel rail-reachable", () => {
    const defaults = createDefaultLayouts();
    const expandedByPhase = {
      ingest: ["media", "status", "storage"],
      cut: ["preview", "transcript", "agent", "timeline"],
      polish: ["preview", "transcript", "inspector", "agent", "graphics"],
      review: ["media", "preview", "agent"],
      publish: ["status", "publish"],
    };

    expect(defaults.activePhase).toBe("cut");
    for (const phase of WORKFLOW_PHASES) {
      const layout = defaults.layouts[phase];
      const panels = Object.values(layout.regions).flatMap(({ panelIds }) => panelIds);
      expect(panels.sort()).toEqual([...expandedByPhase[phase]].sort());
      expect(new Set(panels).size).toBe(panels.length);
      expect(Object.keys(layout.railCollapsed).sort()).toEqual([...DOCK_PANEL_IDS].sort());
      expect(panels.every((panelId) => !layout.railCollapsed[panelId])).toBe(true);
    }
  });

  it("keeps Help rail-collapsed by default until it is added to a phase", () => {
    const defaults = createDefaultLayouts();

    expect(DOCK_PANEL_IDS).toContain("help");
    for (const phase of WORKFLOW_PHASES) {
      expect(defaults.layouts[phase].railCollapsed.help).toBe(true);
      expect(Object.values(defaults.layouts[phase].regions)
        .flatMap(({ panelIds }) => panelIds)).not.toContain("help");
    }
  });

  it("loads layouts persisted before Amendment 006 without losing their panels", () => {
    const complete = createDefaultLayouts();
    for (const phase of WORKFLOW_PHASES) {
      for (const panelId of DOCK_PANEL_IDS.filter((candidate) => candidate !== "help")) {
        const present = Object.values(complete.layouts[phase].regions)
          .some(({ panelIds }) => panelIds.includes(panelId));
        if (!present) {
          complete.layouts[phase] = assignPanel(complete.layouts[phase], panelId, "left");
        }
      }
    }
    const prior = structuredClone(complete) as unknown as {
      activePhase: string;
      layouts: Record<string, {
        collapsed: Record<string, boolean>;
        railCollapsed?: Record<string, boolean>;
        regions: Record<string, { activePanelId: string | null; panelIds: string[] }>;
        schema: string;
        splitters: Record<string, number>;
      }>;
      schema: string;
    };
    for (const phase of WORKFLOW_PHASES) {
      const layout = prior.layouts[phase]!;
      layout.collapsed = { ...layout.railCollapsed };
      delete layout.railCollapsed;
      delete layout.collapsed["help"];
    }
    prior.layouts.cut!.splitters.left = 377;
    const storage = memoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        schema: "layout/v2",
        projects: { "/project": prior },
      }),
    });

    const migrated = loadProjectLayouts("/project", storage);

    expect(migrated.layouts.cut.splitters.left).toBe(377);
    for (const phase of WORKFLOW_PHASES) {
      expect(migrated.layouts[phase].railCollapsed.help).toBe(true);
      for (const regionId of Object.keys(prior.layouts[phase]!.regions)) {
        expect(migrated.layouts[phase].regions[
          regionId as keyof typeof migrated.layouts[typeof phase]["regions"]
        ].panelIds.filter((panelId) => panelId !== "help"))
          .toEqual(prior.layouts[phase]!.regions[regionId]!.panelIds);
      }
      expect(migrated.layouts[phase].regions["right-bottom"].panelIds).toContain("help");
    }
  });

  it("migrates layout/v1 into Cut while the other phases use v2 defaults", () => {
    const storage = memoryStorage({
      [LEGACY_LAYOUT_STORAGE_KEY]: JSON.stringify({
        schema: "layout/v1",
        projects: {
          "/project": legacyLayout(377),
        },
      }),
    });

    const migrated = loadProjectLayouts("/project", storage);

    expect(migrated.schema).toBe("layout/v2");
    expect(migrated.activePhase).toBe("cut");
    expect(migrated.layouts.cut.splitters.left).toBe(377);
    expect(migrated.layouts.cut.regions.left.panelIds[0]).toBe("media");
    expect(migrated.layouts.cut.regions["center-bottom"].activePanelId).toBe("transcript");
    expect(migrated.layouts.ingest).toEqual(createDefaultLayout("ingest"));
    expect(migrated.layouts.review).toEqual(createDefaultLayout("review"));
  });

  it("clamps every splitter to its supported range", () => {
    expect(clampSplitterValue("left", -100)).toBe(220);
    expect(clampSplitterValue("right", 9_999)).toBe(520);
    expect(clampSplitterValue("right", -100)).toBe(280);
    expect(clampSplitterValue("center-horizontal", 0.01)).toBe(0.25);
    expect(clampSplitterValue("right-horizontal", 0.99)).toBe(0.75);
    expect(clampSplitterValue("timeline", 10)).toBe(112);
    expect(clampSplitterValue("status", -1_000)).toBe(112);
    expect(clampSplitterValue("status", 1_000)).toBe(220);
  });

  it("resets the live workspace layout to a fresh default", () => {
    useWorkspaceStore.getState().setPhase("cut");
    useWorkspaceStore.getState().assignPanel("transcript", "right-top", 1);
    useWorkspaceStore.getState().setSplitter("left", 410);
    useWorkspaceStore.getState().togglePanel("agent");

    useWorkspaceStore.getState().resetLayout();

    expect(useWorkspaceStore.getState().layout).toEqual(createDefaultLayout("cut"));
  });

  it("resets only the active phase and can reset all five phases", () => {
    useWorkspaceStore.getState().resetAllLayouts();
    useWorkspaceStore.getState().setPhase("cut");
    useWorkspaceStore.getState().setSplitter("left", 333);
    useWorkspaceStore.getState().setPhase("review");
    useWorkspaceStore.getState().setSplitter("right", 444);

    useWorkspaceStore.getState().resetLayout();

    expect(useWorkspaceStore.getState().layout).toEqual(createDefaultLayout("review"));
    expect(useWorkspaceStore.getState().layouts.cut.splitters.left).toBe(333);

    useWorkspaceStore.getState().resetAllLayouts();

    expect(useWorkspaceStore.getState().activePhase).toBe("review");
    for (const phase of WORKFLOW_PHASES) {
      expect(useWorkspaceStore.getState().layouts[phase]).toEqual(createDefaultLayout(phase));
    }
  });

  it("falls back to the default for absent, older, or malformed schemas", () => {
    const fallback = createDefaultLayout("cut");

    expect(parseLayout(undefined, "cut")).toEqual(fallback);
    expect(parseLayout({ schema: "layout/v0" }, "cut")).toEqual(fallback);
    expect(parseLayout({
      ...fallback,
      regions: {
        ...fallback.regions,
        left: { panelIds: ["media", "media"], activePanelId: "media" },
      },
    }, "cut")).toEqual(fallback);
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
