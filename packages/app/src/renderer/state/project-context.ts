import type { ProjectSnapshot } from "../../shared/ipc.js";

export function projectSnapshotContextKey(
  snapshot: ProjectSnapshot | null,
): string | null {
  if (snapshot === null) return null;
  return JSON.stringify([snapshot.projectPath, snapshot.revision]);
}

export function projectDeliverableContextKey(
  snapshot: ProjectSnapshot | null,
  deliverableId: string | null,
): string {
  return JSON.stringify([
    snapshot?.projectPath ?? null,
    snapshot?.revision ?? null,
    deliverableId,
  ]);
}

export function deliverableNavigationContextKey(
  snapshot: ProjectSnapshot,
  deliverableId: string,
  sequenceId: string,
  selectedWordId: string | null,
): string {
  return JSON.stringify([
    snapshot.projectPath,
    snapshot.revision,
    deliverableId,
    sequenceId,
    selectedWordId,
  ]);
}

export function nextCycledId(
  ids: readonly string[],
  selectedId: string | null,
  direction: 1 | -1,
): string | undefined {
  if (ids.length === 0) return undefined;
  const selectedIndex = selectedId === null ? -1 : ids.indexOf(selectedId);
  if (selectedIndex === -1) {
    return direction === 1 ? ids[0] : ids.at(-1);
  }
  return ids[
    (selectedIndex + direction + ids.length) % ids.length
  ];
}
