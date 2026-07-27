import { create } from "zustand";

import type { DivergenceClass } from "../../../../core/src/index.js";

export interface UndoOperation {
  op: string;
  params: Record<string, unknown>;
}

export interface UndoStackEntry {
  txnId: string;
  label: string;
  ops: UndoOperation[];
  inverse: UndoOperation[];
  divergence?: DivergenceClass;
  invalidReason?: string;
}

interface UndoState {
  undo: UndoStackEntry[];
  redo: UndoStackEntry[];
  record: (entry: UndoStackEntry) => void;
  beginUndo: () => UndoStackEntry | undefined;
  finishUndo: (entry: UndoStackEntry) => void;
  cancelUndo: (entry: UndoStackEntry, reason?: string) => void;
  beginRedo: () => UndoStackEntry | undefined;
  finishRedo: (entry: UndoStackEntry) => void;
  cancelRedo: (entry: UndoStackEntry, reason?: string) => void;
  clear: () => void;
}

const MAX_UNDO_DEPTH = 200;

export const useUndoStore = create<UndoState>((set, get) => ({
  undo: [],
  redo: [],
  record: (entry) => set((state) => ({
    undo: [...state.undo, structuredClone(entry)].slice(-MAX_UNDO_DEPTH),
    redo: [],
  })),
  beginUndo: () => {
    const entry = get().undo.at(-1);
    if (entry === undefined || entry.invalidReason !== undefined) return undefined;
    set((state) => ({ undo: state.undo.slice(0, -1) }));
    return entry;
  },
  finishUndo: (entry) => set((state) => ({ redo: [...state.redo, entry] })),
  cancelUndo: (entry, invalidReason) => set((state) => ({
    undo: [...state.undo, invalidReason === undefined ? entry : { ...entry, invalidReason }],
  })),
  beginRedo: () => {
    const entry = get().redo.at(-1);
    if (entry === undefined || entry.invalidReason !== undefined) return undefined;
    set((state) => ({ redo: state.redo.slice(0, -1) }));
    return entry;
  },
  finishRedo: (entry) => set((state) => ({
    undo: [...state.undo, entry].slice(-MAX_UNDO_DEPTH),
  })),
  cancelRedo: (entry, invalidReason) => set((state) => ({
    redo: [...state.redo, invalidReason === undefined ? entry : { ...entry, invalidReason }],
  })),
  clear: () => set({ undo: [], redo: [] }),
}));
