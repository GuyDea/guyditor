import { create } from "zustand";

interface SelectionState {
  selectedClipId: string | null;
  selectedLayerId: string | null;
  selectClip: (id: string | null) => void;
  selectLayer: (id: string | null) => void;
}

interface TimelineViewState {
  zoomPixelsPerFrame: number;
  scrollOffsetFrames: number;
  setZoom: (pixelsPerFrame: number) => void;
  setScrollOffset: (frames: number) => void;
}

interface WorkspaceState {
  jobsPanelWidth: number;
  jobsPanelCollapsed: boolean;
  setJobsPanelWidth: (width: number) => void;
  toggleJobsPanel: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedClipId: null,
  selectedLayerId: null,
  selectClip: (selectedClipId) => set({ selectedClipId }),
  selectLayer: (selectedLayerId) => set({ selectedLayerId }),
}));

export const useTimelineViewStore = create<TimelineViewState>((set) => ({
  zoomPixelsPerFrame: 4,
  scrollOffsetFrames: 0,
  setZoom: (zoomPixelsPerFrame) => set({
    zoomPixelsPerFrame: Math.min(64, Math.max(0.25, zoomPixelsPerFrame)),
  }),
  setScrollOffset: (scrollOffsetFrames) => set({
    scrollOffsetFrames: Math.max(0, Math.round(scrollOffsetFrames)),
  }),
}));

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  jobsPanelWidth: 320,
  jobsPanelCollapsed: false,
  setJobsPanelWidth: (jobsPanelWidth) => set({
    jobsPanelWidth: Math.min(520, Math.max(240, jobsPanelWidth)),
  }),
  toggleJobsPanel: () => set((state) => ({
    jobsPanelCollapsed: !state.jobsPanelCollapsed,
  })),
}));
