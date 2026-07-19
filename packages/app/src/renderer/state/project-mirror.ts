import { create } from "zustand";

import type { ProjectSnapshot } from "../../shared/ipc.js";

interface ProjectMirrorState {
  snapshot: ProjectSnapshot | null;
  replace: (snapshot: ProjectSnapshot | null) => void;
}

export const useProjectMirror = create<ProjectMirrorState>((set) => ({
  snapshot: null,
  replace: (snapshot) => set({ snapshot: snapshot === null ? null : structuredClone(snapshot) }),
}));
