import { create } from "zustand";

import type { FrameTime, KeySettings } from "../../../../core/src/index.js";
import { WORKFLOW_PHASES } from "./layout-state.js";
import type { DockPanelId, WorkflowPhase } from "./layout-state.js";
import { presetLayout, presetLayouts } from "./layout-presets.js";
import {
  activateTab,
  addTab,
  closeGroup as closeLayoutGroup,
  closeTab as closeLayoutTab,
  groupOf,
  moveTab as moveLayoutTab,
  normalizeLayout,
  normalizeLayoutsDocument,
  resizeSplit as resizeLayoutSplit,
  revealInLayout,
  splitGroup,
} from "./layout-tree.js";
import type { PhaseLayout } from "./layout-tree.js";

/** What one save carries: the active phase plus only the phase layouts that changed. */
export interface LayoutChange {
  activePhase: WorkflowPhase;
  layouts: Partial<Record<WorkflowPhase, PhaseLayout>>;
}

/** Phases (and whether the active phase) changed locally before the stored document loaded. */
export interface LocalLayoutEdits {
  phases: readonly WorkflowPhase[];
  activePhase: boolean;
}

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
  activateDeliverable: (id: string) => void;
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

export type PickerRequest =
  | { mode: "split"; groupId: string; side: "right" | "down" }
  | { mode: "add-tab"; groupId: string }
  | { mode: "root" };

interface WorkspaceState {
  layouts: Record<WorkflowPhase, PhaseLayout>;
  layout: PhaseLayout;
  activePhase: WorkflowPhase;
  focusedGroupId: string | null;
  focusedPanel: PanelId;
  flashingPanel: PanelId | null;
  picker: PickerRequest | null;
  hydrateLayouts: (stored: unknown, local?: LocalLayoutEdits) => void;
  applyRemoteLayouts: (stored: unknown) => void;
  setPhase: (phase: WorkflowPhase) => void;
  focusPanel: (panel: PanelId) => void;
  revealPanel: (panel: PanelId) => void;
  clearPanelFlash: (panel: PanelId) => void;
  activateTab: (panel: PanelId) => void;
  closeTab: (panel: PanelId) => void;
  closeGroup: (groupId: string) => void;
  openPicker: (request: PickerRequest) => void;
  cancelPicker: () => void;
  choosePanel: (panel: DockPanelId) => void;
  moveTab: (panel: DockPanelId, targetGroupId: string, index?: number) => void;
  resizeSplit: (
    splitId: string,
    dividerIndex: number,
    delta: number,
    containerPx: number,
    persist?: boolean,
  ) => void;
  resetLayout: () => void;
  resetAllLayouts: () => void;
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
  resetForDeliverable: (fps: FrameTime["fps"]) => void;
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
  activateDeliverable: (selectedDeliverableId) => set({
    selectedDeliverableId,
    selectedClipId: null,
    selectedLayerId: null,
    selectedWordId: null,
    selectedAnnotationId: null,
    wordRange: null,
  }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let saveLayouts: (change: LayoutChange) => void = () => undefined;

/** Installs where layout changes are persisted (App wires this to the WorkspaceLayout RPC). */
export function configureLayoutSaver(save: (change: LayoutChange) => void): void {
  saveLayouts = save;
}

const initialLayouts = presetLayouts();

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  /** Replaces the active phase's layout, keeps focus on a live group, and saves. */
  const commit = (
    layout: PhaseLayout,
    extra: Partial<WorkspaceState> = {},
    persist = true,
  ): void => {
    const state = get();
    const layouts = { ...state.layouts, [state.activePhase]: layout };
    const focusedGroupId = groupOf(layout, extra.focusedPanel ?? state.focusedPanel)?.id ??
      state.focusedGroupId;
    set({ layouts, layout, focusedGroupId, ...extra });
    if (persist) saveLayouts({ activePhase: state.activePhase, layouts: { [state.activePhase]: layout } });
  };

  return {
    layouts: initialLayouts.layouts,
    layout: initialLayouts.layouts[initialLayouts.activePhase],
    activePhase: initialLayouts.activePhase,
    focusedGroupId: null,
    focusedPanel: "preview",
    flashingPanel: null,
    picker: null,
    hydrateLayouts: (stored, local = { phases: [], activePhase: false }) => {
      const state = get();
      const document = normalizeLayoutsDocument(stored);
      const layouts = { ...document.layouts };
      for (const phase of local.phases) layouts[phase] = state.layouts[phase];
      const activePhase = local.activePhase ? state.activePhase : document.activePhase;
      set({
        layouts,
        layout: layouts[activePhase],
        activePhase,
        focusedGroupId: null,
        flashingPanel: null,
        picker: null,
      });
    },
    applyRemoteLayouts: (stored) => {
      const { activePhase, layouts: current } = get();
      const incoming = isRecord(stored) && isRecord(stored["layouts"]) ? stored["layouts"] : {};
      const layouts = { ...current };
      for (const phase of WORKFLOW_PHASES) {
        if (!(phase in incoming)) continue;
        layouts[phase] = normalizeLayout(incoming[phase]) ?? presetLayout(phase);
      }
      set({ layouts, layout: layouts[activePhase], picker: null });
    },
    setPhase: (activePhase) => {
      const { layouts } = get();
      set({
        activePhase,
        layout: layouts[activePhase],
        focusedGroupId: null,
        flashingPanel: null,
        picker: null,
      });
      saveLayouts({ activePhase, layouts: {} });
    },
    focusPanel: (focusedPanel) => set((state) => ({
      focusedPanel,
      focusedGroupId: groupOf(state.layout, focusedPanel)?.id ?? state.focusedGroupId,
    })),
    revealPanel: (panel) => {
      const state = get();
      const { layout, added } = revealInLayout(state.layout, panel, state.focusedGroupId);
      commit(layout, {
        focusedPanel: panel,
        flashingPanel: added ? panel : state.flashingPanel,
      });
    },
    clearPanelFlash: (panel) => set((state) => ({
      flashingPanel: state.flashingPanel === panel ? null : state.flashingPanel,
    })),
    activateTab: (panel) => {
      commit(activateTab(get().layout, panel), { focusedPanel: panel });
    },
    closeTab: (panel) => {
      commit(closeLayoutTab(get().layout, panel));
    },
    closeGroup: (groupId) => {
      commit(closeLayoutGroup(get().layout, groupId));
    },
    openPicker: (picker) => set({ picker }),
    cancelPicker: () => set({ picker: null }),
    choosePanel: (panel) => {
      const { layout, picker } = get();
      if (picker === null) return;
      const next = picker.mode === "split"
        ? splitGroup(layout, picker.groupId, picker.side, panel)
        : addTab(layout, picker.mode === "add-tab" ? picker.groupId : null, panel);
      commit(next, { picker: null, focusedPanel: panel });
    },
    moveTab: (panel, targetGroupId, index) => {
      commit(moveLayoutTab(get().layout, panel, targetGroupId, index), { focusedPanel: panel });
    },
    resizeSplit: (splitId, dividerIndex, delta, containerPx, persist = true) => {
      commit(
        resizeLayoutSplit(get().layout, splitId, dividerIndex, delta, containerPx),
        {},
        persist,
      );
    },
    resetLayout: () => {
      commit(presetLayout(get().activePhase), { flashingPanel: null, picker: null });
    },
    resetAllLayouts: () => {
      const { activePhase } = get();
      const document = presetLayouts(activePhase);
      set({
        layouts: document.layouts,
        layout: document.layouts[activePhase],
        focusedGroupId: null,
        flashingPanel: null,
        picker: null,
      });
      saveLayouts(document);
    },
  };
});

export const usePreviewStore = create<PreviewState>((set) => ({
  playhead: { frames: 0, fps: "24/1" },
  playing: false,
  quality: "proxy",
  settled: true,
  warning: null,
  loopRange: null,
  diagnosticBackground: "none",
  previewKeySettings: null,
  resetForDeliverable: (fps) => set({
    playing: false,
    playhead: { frames: 0, fps },
    settled: false,
    warning: null,
    loopRange: null,
    previewKeySettings: null,
  }),
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
