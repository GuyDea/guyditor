import { create } from "zustand";

import type { FrameTime, KeySettings } from "../../../../core/src/index.js";

export type DiagnosticBackground = "none" | "black" | "white" | "saturated" | "checkerboard";

export type PanelId =
  | "media"
  | "graphics"
  | "skills"
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
  collapsed: Record<PanelId, boolean>;
  focusedPanel: PanelId;
  leftWidth: number;
  rightWidth: number;
  statusHeight: number;
  jobsPanelWidth: number;
  togglePanel: (panel: PanelId) => void;
  focusPanel: (panel: PanelId) => void;
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
  graphics: false,
  skills: false,
  preview: false,
  transcript: false,
  inspector: false,
  agent: false,
  timeline: false,
  status: false,
  publish: false,
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  collapsed: expandedPanels,
  focusedPanel: "preview",
  leftWidth: 250,
  rightWidth: 310,
  statusHeight: 150,
  jobsPanelWidth: 310,
  togglePanel: (panel) => set((state) => ({
    collapsed: { ...state.collapsed, [panel]: !state.collapsed[panel] },
  })),
  focusPanel: (focusedPanel) => set({ focusedPanel }),
  setLeftWidth: (leftWidth) => set({ leftWidth: Math.min(420, Math.max(190, leftWidth)) }),
  setRightWidth: (rightWidth) => set({
    rightWidth: Math.min(520, Math.max(250, rightWidth)),
    jobsPanelWidth: Math.min(520, Math.max(250, rightWidth)),
  }),
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
