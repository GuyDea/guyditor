import { create } from "zustand";

export interface HelpModeState {
  /** True while help mode intercepts the app's clicks, keys and drags. */
  active: boolean;
  /** Help-entry key of the open popup, or null when no popup is shown. */
  openKey: string | null;
  /** One-shot request to reveal a manual heading; `nonce` makes repeats distinguishable. */
  manualRequest: { heading: string; nonce: number } | null;
  toggle: () => void;
  open: (key: string) => void;
  close: () => void;
  exit: () => void;
  requestManual: (heading: string) => void;
  consumeManualRequest: () => void;
}

export const useHelpMode = create<HelpModeState>()((set) => ({
  active: false,
  openKey: null,
  manualRequest: null,
  toggle: () => set((state) => (state.active ? { active: false, openKey: null } : { active: true })),
  open: (key) => set({ openKey: key }),
  close: () => set({ openKey: null }),
  exit: () => set({ active: false, openKey: null }),
  requestManual: (heading) =>
    set((state) => ({ manualRequest: { heading, nonce: (state.manualRequest?.nonce ?? 0) + 1 } })),
  consumeManualRequest: () => set({ manualRequest: null }),
}));
