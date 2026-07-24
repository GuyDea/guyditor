import { create } from "zustand";

import type { FrameTime, KeySettings } from "../../../../core/src/index.js";
import {
  activatePanel as activateLayoutPanel,
  assignPanel as assignLayoutPanel,
  createDefaultLayout,
  createDefaultLayouts,
  LAYOUT_SCHEMA,
  loadProjectLayouts,
  reorderPanel as reorderLayoutPanel,
  saveProjectLayouts,
  setSplitter as setLayoutSplitter,
} from "./layout-state.js";
import {
  panelRegion,
  togglePanelFromRail as toggleLayoutPanelFromRail,
} from "./tool-rail.js";
import type {
  DockPanelId,
  DockRegionId,
  SplitterId,
  WorkflowLayouts,
  WorkflowPhase,
  WorkspaceLayout,
} from "./layout-state.js";

export type DiagnosticBackground = "none" | "black" | "white" | "saturated" | "checkerboard";

export type PanelId = DockPanelId;

interface SelectionState {
  selectedClipId: string | null;
  selectedLayerId: string | null;
  selectedWordId: string | null;
  selectedAnnotationId: string | null;
  selectedDeliverableId: string | null;
  wordRange: { fromWord: string; toWord: string } | null;
  selectClip: (id: string | null) => void;
  selectLayer: (id: string | null) => void;
  selectWord: (id: string | null) => void;
  selectAnnotation: (id: string | null) => void;
  selectDeliverable: (id: string | null) => void;
  setWordRange: (range: SelectionState["wordRange"]) => void;
}

interface TimelineViewState {
  zoomPixelsPerFrame: number;
  scrollOffsetFrames: number;
  viewportWidth: number;
  trackHeight: number;
  snapping: boolean;
  setZoom: (pixelsPerFrame: number) => void;
  setScrollOffset: (frames: number) => void;
  setViewportWidth: (pixels: number) => void;
  toggleSnapping: () => void;
}

interface WorkspaceState {
  layout: WorkspaceLayout;
  layouts: Record<WorkflowPhase, WorkspaceLayout>;
  activePhase: WorkflowPhase;
  projectKey: string | null;
  railCollapsed: Record<PanelId, boolean>;
  flashingPanel: PanelId | null;
  focusedPanel: PanelId;
  leftWidth: number;
  rightWidth: number;
  statusHeight: number;
  jobsPanelWidth: number;
  setProjectKey: (projectKey: string) => void;
  setPhase: (phase: WorkflowPhase) => void;
  togglePanel: (panel: PanelId) => void;
  expandPanel: (panel: PanelId) => void;
  clearPanelFlash: (panel: PanelId) => void;
  focusPanel: (panel: PanelId) => void;
  assignPanel: (
    panel: DockPanelId,
    region: DockRegionId,
    targetIndex?: number,
  ) => void;
  reorderPanel: (
    region: DockRegionId,
    panel: DockPanelId,
    targetIndex: number,
  ) => void;
  activatePanel: (region: DockRegionId, panel: DockPanelId) => void;
  setSplitter: (splitter: SplitterId, value: number, persistChange?: boolean) => void;
  resetLayout: () => void;
  resetAllLayouts: () => void;
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  setJobsPanelWidth: (width: number) => void;
}

interface PreviewState {
  playhead: FrameTime;
  playing: boolean;
  quality: "proxy";
  settled: boolean;
  warning: string | null;
  loopRange: { start: number; end: number } | null;
  diagnosticBackground: DiagnosticBackground;
  previewKeySettings: KeySettings | null;
  setPlayhead: (playhead: FrameTime) => void;
  setPlaying: (playing: boolean) => void;
  setSettled: (settled: boolean) => void;
  setWarning: (warning: string | null) => void;
  setLoopRange: (range: PreviewState["loopRange"]) => void;
  setDiagnosticBackground: (background: DiagnosticBackground) => void;
  setPreviewKeySettings: (settings: KeySettings | null) => void;
}

interface TranscriptViewState {
  scrollTop: number;
  followPlayhead: boolean;
  correctionDraft: string;
  setScrollTop: (scrollTop: number) => void;
  toggleFollow: () => void;
  setCorrectionDraft: (correctionDraft: string) => void;
}

interface AgentPanelState {
  expandedProposalId: string | null;
  exclusionSet: string[];
  setExpandedProposal: (proposalId: string | null) => void;
  toggleExcluded: (operationKey: string) => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedClipId: null,
  selectedLayerId: null,
  selectedWordId: null,
  selectedAnnotationId: null,
  selectedDeliverableId: null,
  wordRange: null,
  selectClip: (selectedClipId) => set({ selectedClipId }),
  selectLayer: (selectedLayerId) => set({ selectedLayerId }),
  selectWord: (selectedWordId) => set({ selectedWordId }),
  selectAnnotation: (selectedAnnotationId) => set({ selectedAnnotationId }),
  selectDeliverable: (selectedDeliverableId) => set({ selectedDeliverableId }),
  setWordRange: (wordRange) => set({ wordRange }),
}));

export const useTimelineViewStore = create<TimelineViewState>((set) => ({
  zoomPixelsPerFrame: 4,
  scrollOffsetFrames: 0,
  viewportWidth: 900,
  trackHeight: 62,
  snapping: true,
  setZoom: (zoomPixelsPerFrame) => set({
    zoomPixelsPerFrame: Math.min(64, Math.max(0.25, zoomPixelsPerFrame)),
  }),
  setScrollOffset: (scrollOffsetFrames) => set({
    scrollOffsetFrames: Math.max(0, Math.round(scrollOffsetFrames)),
  }),
  setViewportWidth: (viewportWidth) => set({ viewportWidth: Math.max(1, viewportWidth) }),
  toggleSnapping: () => set((state) => ({ snapping: !state.snapping })),
}));

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function persisted(
  projectKey: string | null,
  layouts: WorkflowLayouts,
): void {
  const storage = browserStorage();
  if (projectKey === null || storage === null) return;
  try {
    saveProjectLayouts(projectKey, layouts, storage);
  } catch {
    // Browser storage failures leave the current in-memory view state usable.
  }
}

function layoutFields(
  layout: WorkspaceLayout,
): Pick<
  WorkspaceState,
  "layout" | "railCollapsed" | "leftWidth" | "rightWidth" | "statusHeight" | "jobsPanelWidth"
> {
  return {
    layout,
    railCollapsed: { ...layout.railCollapsed },
    leftWidth: layout.splitters.left,
    rightWidth: layout.splitters.right,
    statusHeight: layout.splitters.status,
    jobsPanelWidth: layout.splitters.right,
  };
}

function workflowDocument(
  activePhase: WorkflowPhase,
  layouts: Record<WorkflowPhase, WorkspaceLayout>,
): WorkflowLayouts {
  return { schema: LAYOUT_SCHEMA, activePhase, layouts };
}

const initialLayouts = createDefaultLayouts();
const initialLayout = initialLayouts.layouts[initialLayouts.activePhase];

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  ...layoutFields(initialLayout),
  layouts: initialLayouts.layouts,
  activePhase: initialLayouts.activePhase,
  projectKey: null,
  flashingPanel: null,
  focusedPanel: "preview",
  setProjectKey: (projectKey) => {
    const storage = browserStorage();
    const projectLayouts = storage === null
      ? createDefaultLayouts()
      : loadProjectLayouts(projectKey, storage);
    set({
      projectKey,
      layouts: projectLayouts.layouts,
      activePhase: projectLayouts.activePhase,
      flashingPanel: null,
      ...layoutFields(projectLayouts.layouts[projectLayouts.activePhase]),
    });
  },
  setPhase: (activePhase) => {
    const state = get();
    const document = workflowDocument(activePhase, state.layouts);
    persisted(state.projectKey, document);
    set({
      activePhase,
      flashingPanel: null,
      ...layoutFields(state.layouts[activePhase]),
    });
  },
  togglePanel: (panel) => {
    const state = get();
    const { layout, expanded } = toggleLayoutPanelFromRail(state.layout, panel);
    const layouts = { ...state.layouts, [state.activePhase]: layout };
    persisted(state.projectKey, workflowDocument(state.activePhase, layouts));
    set({
      layouts,
      flashingPanel: expanded
        ? panel
        : state.flashingPanel === panel ? null : state.flashingPanel,
      ...layoutFields(layout),
    });
  },
  expandPanel: (panel) => {
    const state = get();
    const region = panelRegion(state.layout, panel);
    const alreadyExpanded = region !== null && !state.railCollapsed[panel];
    const result = alreadyExpanded
      ? { layout: activateLayoutPanel(state.layout, region, panel), expanded: false }
      : toggleLayoutPanelFromRail(state.layout, panel);
    const layouts = { ...state.layouts, [state.activePhase]: result.layout };
    persisted(state.projectKey, workflowDocument(state.activePhase, layouts));
    set({
      layouts,
      focusedPanel: panel,
      flashingPanel: result.expanded ? panel : state.flashingPanel,
      ...layoutFields(result.layout),
    });
  },
  clearPanelFlash: (panel) => set((state) => ({
    flashingPanel: state.flashingPanel === panel ? null : state.flashingPanel,
  })),
  focusPanel: (focusedPanel) => set({ focusedPanel }),
  assignPanel: (panel, region, targetIndex) => {
    const state = get();
    const layout = assignLayoutPanel(state.layout, panel, region, targetIndex);
    const layouts = { ...state.layouts, [state.activePhase]: layout };
    persisted(state.projectKey, workflowDocument(state.activePhase, layouts));
    set({ layouts, flashingPanel: null, ...layoutFields(layout) });
  },
  reorderPanel: (region, panel, targetIndex) => {
    const state = get();
    const layout = reorderLayoutPanel(state.layout, region, panel, targetIndex);
    const layouts = { ...state.layouts, [state.activePhase]: layout };
    persisted(state.projectKey, workflowDocument(state.activePhase, layouts));
    set({ layouts, ...layoutFields(layout) });
  },
  activatePanel: (region, panel) => {
    const state = get();
    const layout = activateLayoutPanel(state.layout, region, panel);
    const layouts = { ...state.layouts, [state.activePhase]: layout };
    persisted(state.projectKey, workflowDocument(state.activePhase, layouts));
    set({ layouts, ...layoutFields(layout) });
  },
  setSplitter: (splitter, value, persistChange = true) => {
    const state = get();
    const layout = setLayoutSplitter(state.layout, splitter, value);
    const layouts = { ...state.layouts, [state.activePhase]: layout };
    if (persistChange) {
      persisted(state.projectKey, workflowDocument(state.activePhase, layouts));
    }
    set({ layouts, ...layoutFields(layout) });
  },
  resetLayout: () => {
    const state = get();
    const layout = createDefaultLayout(state.activePhase);
    const layouts = { ...state.layouts, [state.activePhase]: layout };
    persisted(state.projectKey, workflowDocument(state.activePhase, layouts));
    set({ layouts, flashingPanel: null, ...layoutFields(layout) });
  },
  resetAllLayouts: () => {
    const state = get();
    const defaults = createDefaultLayouts(state.activePhase);
    persisted(state.projectKey, defaults);
    set({
      layouts: defaults.layouts,
      activePhase: defaults.activePhase,
      flashingPanel: null,
      ...layoutFields(defaults.layouts[defaults.activePhase]),
    });
  },
  setLeftWidth: (leftWidth) => {
    get().setSplitter("left", leftWidth);
  },
  setRightWidth: (rightWidth) => {
    get().setSplitter("right", rightWidth);
  },
  setJobsPanelWidth: (jobsPanelWidth) => set({
    jobsPanelWidth: Math.min(520, Math.max(240, jobsPanelWidth)),
  }),
}));

export const usePreviewStore = create<PreviewState>((set) => ({
  playhead: { frames: 0, fps: "24/1" },
  playing: false,
  quality: "proxy",
  settled: true,
  warning: null,
  loopRange: null,
  diagnosticBackground: "none",
  previewKeySettings: null,
  setPlayhead: (playhead) => set({ playhead }),
  setPlaying: (playing) => set({ playing }),
  setSettled: (settled) => set({ settled }),
  setWarning: (warning) => set({ warning }),
  setLoopRange: (loopRange) => set({ loopRange }),
  setDiagnosticBackground: (diagnosticBackground) => set({ diagnosticBackground }),
  setPreviewKeySettings: (previewKeySettings) => set({ previewKeySettings }),
}));

export const useTranscriptViewStore = create<TranscriptViewState>((set) => ({
  scrollTop: 0,
  followPlayhead: true,
  correctionDraft: "",
  setScrollTop: (scrollTop) => set({ scrollTop: Math.max(0, scrollTop) }),
  toggleFollow: () => set((state) => ({ followPlayhead: !state.followPlayhead })),
  setCorrectionDraft: (correctionDraft) => set({ correctionDraft }),
}));

export const useAgentPanelStore = create<AgentPanelState>((set) => ({
  expandedProposalId: null,
  exclusionSet: [],
  setExpandedProposal: (expandedProposalId) => set({ expandedProposalId }),
  toggleExcluded: (operationKey) => set((state) => ({
    exclusionSet: state.exclusionSet.includes(operationKey)
      ? state.exclusionSet.filter((entry) => entry !== operationKey)
      : [...state.exclusionSet, operationKey],
  })),
}));
