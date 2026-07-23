import { create } from "zustand";

import type { FrameTime, KeySettings } from "../../../../core/src/index.js";
import {
  activatePanel as activateLayoutPanel,
  assignPanel as assignLayoutPanel,
  createDefaultLayout,
  DOCK_PANEL_IDS,
  loadProjectLayout,
  reorderPanel as reorderLayoutPanel,
  saveProjectLayout,
  setCollapsed,
  setSplitter as setLayoutSplitter,
} from "./layout-state.js";
import type {
  DockPanelId,
  DockRegionId,
  SplitterId,
  WorkspaceLayout,
} from "./layout-state.js";

export type DiagnosticBackground = "none" | "black" | "white" | "saturated" | "checkerboard";

export type PanelId =
  | "media"
  | "broll"
  | "graphics"
  | "skills"
  | "storage"
  | "preview"
  | "transcript"
  | "inspector"
  | "agent"
  | "timeline"
  | "status"
  | "publish";

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
  projectKey: string | null;
  collapsed: Record<PanelId, boolean>;
  focusedPanel: PanelId;
  leftWidth: number;
  rightWidth: number;
  statusHeight: number;
  jobsPanelWidth: number;
  setProjectKey: (projectKey: string) => void;
  togglePanel: (panel: PanelId) => void;
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

const expandedPanels: Record<PanelId, boolean> = {
  media: false,
  broll: false,
  graphics: false,
  skills: false,
  storage: false,
  preview: false,
  transcript: false,
  inspector: false,
  agent: false,
  timeline: false,
  status: false,
  publish: false,
};

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function isDockPanel(panel: PanelId): panel is DockPanelId {
  return (DOCK_PANEL_IDS as readonly string[]).includes(panel);
}

function persisted(
  projectKey: string | null,
  layout: WorkspaceLayout,
): void {
  const storage = browserStorage();
  if (projectKey === null || storage === null) return;
  try {
    saveProjectLayout(projectKey, layout, storage);
  } catch {
    // Browser storage failures leave the current in-memory view state usable.
  }
}

function layoutFields(
  layout: WorkspaceLayout,
  currentCollapsed?: Record<PanelId, boolean>,
): Pick<
  WorkspaceState,
  "layout" | "collapsed" | "leftWidth" | "rightWidth" | "statusHeight" | "jobsPanelWidth"
> {
  return {
    layout,
    collapsed: { ...expandedPanels, ...currentCollapsed, ...layout.collapsed },
    leftWidth: layout.splitters.left,
    rightWidth: layout.splitters.right,
    statusHeight: layout.splitters.status,
    jobsPanelWidth: layout.splitters.right,
  };
}

const initialLayout = createDefaultLayout();

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  ...layoutFields(initialLayout),
  projectKey: null,
  focusedPanel: "preview",
  setProjectKey: (projectKey) => {
    const storage = browserStorage();
    const layout = storage === null
      ? createDefaultLayout()
      : loadProjectLayout(projectKey, storage);
    set({ projectKey, ...layoutFields(layout, get().collapsed) });
  },
  togglePanel: (panel) => {
    const state = get();
    const collapsed = !state.collapsed[panel];
    if (!isDockPanel(panel)) {
      set({ collapsed: { ...state.collapsed, [panel]: collapsed } });
      return;
    }
    const layout = setCollapsed(state.layout, panel, collapsed);
    persisted(state.projectKey, layout);
    set(layoutFields(layout, state.collapsed));
  },
  focusPanel: (focusedPanel) => set({ focusedPanel }),
  assignPanel: (panel, region, targetIndex) => {
    const state = get();
    const layout = assignLayoutPanel(state.layout, panel, region, targetIndex);
    persisted(state.projectKey, layout);
    set(layoutFields(layout, state.collapsed));
  },
  reorderPanel: (region, panel, targetIndex) => {
    const state = get();
    const layout = reorderLayoutPanel(state.layout, region, panel, targetIndex);
    persisted(state.projectKey, layout);
    set(layoutFields(layout, state.collapsed));
  },
  activatePanel: (region, panel) => {
    const state = get();
    const layout = activateLayoutPanel(state.layout, region, panel);
    persisted(state.projectKey, layout);
    set(layoutFields(layout, state.collapsed));
  },
  setSplitter: (splitter, value, persistChange = true) => {
    const state = get();
    const layout = setLayoutSplitter(state.layout, splitter, value);
    if (persistChange) persisted(state.projectKey, layout);
    set(layoutFields(layout, state.collapsed));
  },
  resetLayout: () => {
    const state = get();
    const layout = createDefaultLayout();
    persisted(state.projectKey, layout);
    set(layoutFields(layout, state.collapsed));
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
