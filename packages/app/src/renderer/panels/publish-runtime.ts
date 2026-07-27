import type {
  Deliverable,
  PublishMetadataDocument,
} from "../../../../core/src/index.js";
import { deliverableContextKey } from "../state/async-context.js";

export interface PublishMetadataState {
  contextKey: string | null;
  value: PublishMetadataDocument | null;
  dirty: boolean;
}

export interface ContextualValue<Value> {
  contextKey: string;
  value: Value;
}

export interface PublishBatchState {
  projectPath: string | null;
  ids: string[];
}

function approvedIds(deliverables: readonly Deliverable[]): string[] {
  return deliverables
    .filter(({ status }) => status === "approved")
    .map(({ id }) => id);
}

export function publishContextKey(
  projectPath: string,
  deliverableId: string,
): string {
  return deliverableContextKey(projectPath, deliverableId);
}

export function createPublishMetadataState(
  contextKey: string | null,
  canonical: PublishMetadataDocument | null,
): PublishMetadataState {
  return { contextKey, value: canonical, dirty: false };
}

export function reconcilePublishMetadata(
  state: PublishMetadataState,
  contextKey: string | null,
  canonical: PublishMetadataDocument | null,
): PublishMetadataState {
  if (state.contextKey !== contextKey) {
    return createPublishMetadataState(contextKey, canonical);
  }
  return state.dirty
    ? state
    : { contextKey, value: canonical, dirty: false };
}

export function editPublishMetadata(
  state: PublishMetadataState,
  contextKey: string,
  value: PublishMetadataDocument,
): PublishMetadataState {
  return state.contextKey === contextKey && state.value === value && state.dirty
    ? state
    : { contextKey, value, dirty: true };
}

export function replacePublishMetadata(
  state: PublishMetadataState,
  contextKey: string,
  value: PublishMetadataDocument | null,
): PublishMetadataState {
  return state.contextKey === contextKey && state.value === value && !state.dirty
    ? state
    : { contextKey, value, dirty: false };
}

export function publishMetadataForContext(
  state: PublishMetadataState,
  contextKey: string | null,
  canonical: PublishMetadataDocument | null,
): PublishMetadataDocument | null {
  return state.contextKey === contextKey ? state.value : canonical;
}

export function contextualValue<Value>(
  contextKey: string,
  value: Value,
): ContextualValue<Value> {
  return { contextKey, value };
}

export function valueForContext<Value>(
  state: ContextualValue<Value> | null,
  contextKey: string | null,
): Value | null {
  return state !== null && state.contextKey === contextKey
    ? state.value
    : null;
}

export function createPublishBatchState(
  projectPath: string | null,
  deliverables: readonly Deliverable[],
): PublishBatchState {
  return { projectPath, ids: approvedIds(deliverables) };
}

export function reconcilePublishBatch(
  state: PublishBatchState,
  projectPath: string | null,
  deliverables: readonly Deliverable[],
): PublishBatchState {
  if (state.projectPath !== projectPath) {
    return createPublishBatchState(projectPath, deliverables);
  }
  const available = new Set(deliverables.map(({ id }) => id));
  const ids = state.ids.filter((id) => available.has(id));
  return ids.length === state.ids.length
    ? state
    : { projectPath, ids };
}

export function batchIdsForProject(
  state: PublishBatchState,
  projectPath: string | null,
  deliverables: readonly Deliverable[],
): string[] {
  return state.projectPath === projectPath
    ? reconcilePublishBatch(state, projectPath, deliverables).ids
    : approvedIds(deliverables);
}
