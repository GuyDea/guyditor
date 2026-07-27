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
  contextVersion: number;
  undo: UndoStackEntry[];
  redo: UndoStackEntry[];
  record: (entry: UndoStackEntry, contextVersion?: number) => void;
  beginUndo: () => UndoStackEntry | undefined;
  finishUndo: (entry: UndoStackEntry, contextVersion?: number) => void;
  cancelUndo: (
    entry: UndoStackEntry,
    reason?: string,
    contextVersion?: number,
  ) => void;
  beginRedo: () => UndoStackEntry | undefined;
  finishRedo: (entry: UndoStackEntry, contextVersion?: number) => void;
  cancelRedo: (
    entry: UndoStackEntry,
    reason?: string,
    contextVersion?: number,
  ) => void;
  clear: () => void;
}

const MAX_UNDO_DEPTH = 200;

export const useUndoStore = create<UndoState>((set, get) => ({
  contextVersion: 0,
  undo: [],
  redo: [],
  record: (entry, contextVersion) => set((state) =>
    contextVersion !== undefined && contextVersion !== state.contextVersion
      ? state
      : {
          undo: [...state.undo, structuredClone(entry)].slice(-MAX_UNDO_DEPTH),
          redo: [],
        }),
  beginUndo: () => {
    const entry = get().undo.at(-1);
    if (entry === undefined || entry.invalidReason !== undefined) return undefined;
    set((state) => ({ undo: state.undo.slice(0, -1) }));
    return entry;
  },
  finishUndo: (entry, contextVersion) => set((state) =>
    contextVersion !== undefined && contextVersion !== state.contextVersion
      ? state
      : { redo: [...state.redo, entry] }),
  cancelUndo: (entry, invalidReason, contextVersion) => set((state) =>
    contextVersion !== undefined && contextVersion !== state.contextVersion
      ? state
      : {
          undo: [
            ...state.undo,
            invalidReason === undefined ? entry : { ...entry, invalidReason },
          ],
        }),
  beginRedo: () => {
    const entry = get().redo.at(-1);
    if (entry === undefined || entry.invalidReason !== undefined) return undefined;
    set((state) => ({ redo: state.redo.slice(0, -1) }));
    return entry;
  },
  finishRedo: (entry, contextVersion) => set((state) =>
    contextVersion !== undefined && contextVersion !== state.contextVersion
      ? state
      : { undo: [...state.undo, entry].slice(-MAX_UNDO_DEPTH) }),
  cancelRedo: (entry, invalidReason, contextVersion) => set((state) =>
    contextVersion !== undefined && contextVersion !== state.contextVersion
      ? state
      : {
          redo: [
            ...state.redo,
            invalidReason === undefined ? entry : { ...entry, invalidReason },
          ],
        }),
  clear: () => set((state) => ({
    contextVersion: state.contextVersion + 1,
    undo: [],
    redo: [],
  })),
}));
