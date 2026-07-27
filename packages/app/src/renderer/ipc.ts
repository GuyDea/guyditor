import type {
  ExecuteRequest,
  ExecuteResult,
  LoadedProjectWorkspaceState,
  ProjectWorkspaceState,
  ProjectSnapshot,
} from "../shared/ipc.js";
import type { DivergenceClass } from "../../../core/src/index.js";
import { useUndoStore } from "./state/undo.js";
import type { UndoOperation, UndoStackEntry } from "./state/undo.js";

export function getSnapshot(): Promise<ProjectSnapshot> {
  return window.guyditor.call("ProjectStore", "getSnapshot", {});
}

export function getWorkspaceState(): Promise<LoadedProjectWorkspaceState> {
  return window.guyditor.call("ProjectStore", "getWorkspaceState", {});
}

export function setActiveDeliverable(
  deliverableId: string,
): Promise<ProjectWorkspaceState> {
  return window.guyditor.call(
    "ProjectStore",
    "setActiveDeliverable",
    { deliverableId },
  );
}

export function executeOperations(request: ExecuteRequest): Promise<ExecuteResult> {
  return window.guyditor.call("OperationEngine", "execute", request);
}

export async function executeDirect(
  operations: UndoOperation[],
  label: string,
  divergence?: DivergenceClass,
): Promise<ExecuteResult> {
  const result = await executeOperations({
    operations,
    intent: "direct",
    label,
    ...(divergence === undefined ? {} : { divergence }),
  });
  useUndoStore.getState().record({
    txnId: result.txnId,
    label,
    ops: structuredClone(operations),
    inverse: structuredClone(result.inverse),
    ...(divergence === undefined ? {} : { divergence }),
  });
  return result;
}

export async function undoLast(): Promise<ExecuteResult | undefined> {
  const store = useUndoStore.getState();
  const entry = store.beginUndo();
  if (entry === undefined) return undefined;
  try {
    const result = await executeOperations({
      operations: entry.inverse,
      intent: "undo",
      undoOf: entry.txnId,
      label: `Undo: ${entry.label}`,
      ...(entry.divergence === undefined
        ? {}
        : { divergence: entry.divergence }),
    });
    useUndoStore.getState().finishUndo(entry);
    return result;
  } catch (error: unknown) {
    useUndoStore.getState().cancelUndo(entry, errorMessage(error));
    throw error;
  }
}

export async function redoLast(): Promise<ExecuteResult | undefined> {
  const store = useUndoStore.getState();
  const entry = store.beginRedo();
  if (entry === undefined) return undefined;
  try {
    const result = await executeOperations({
      operations: entry.ops,
      intent: "redo",
      undoOf: entry.txnId,
      label: `Redo: ${entry.label}`,
      ...(entry.divergence === undefined
        ? {}
        : { divergence: entry.divergence }),
    });
    useUndoStore.getState().finishRedo(entry);
    return result;
  } catch (error: unknown) {
    useUndoStore.getState().cancelRedo(entry, errorMessage(error));
    throw error;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { ProjectSnapshot, UndoStackEntry };
