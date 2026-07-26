import type {
  Deliverable,
  GuyditorProject,
} from "../../../core/src/index.js";

import { errorMessage, setActiveDeliverable } from "./ipc.js";
import {
  usePreviewStore,
  useSelectionStore,
  useTimelineViewStore,
} from "./state/view-state.js";

type PersistSelection = (deliverableId: string) => Promise<unknown>;

export function resolveActiveDeliverable(
  project: GuyditorProject,
  selectedDeliverableId: string | null,
): Deliverable {
  const selected = project.deliverables.find(
    ({ id }) => id === selectedDeliverableId,
  );
  if (selected !== undefined) return selected;

  const primary = project.deliverables.find(
    ({ id }) => id === project.settings.primaryDeliverable,
  );
  if (primary === undefined) {
    throw new Error(
      `Primary deliverable ${project.settings.primaryDeliverable} does not exist.`,
    );
  }
  return primary;
}

export function applyDeliverableSelection(
  project: GuyditorProject,
  deliverableId: string,
): Deliverable {
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  if (deliverable === undefined) {
    throw new Error(`Deliverable ${deliverableId} does not exist.`);
  }

  const preview = usePreviewStore.getState();
  preview.setPlaying(false);
  preview.setPlayhead({ frames: 0, fps: project.settings.timeline.fps });
  preview.setLoopRange(null);
  preview.setPreviewKeySettings(null);
  useTimelineViewStore.getState().setScrollOffset(0);
  useSelectionStore.getState().activateDeliverable(deliverable.id);
  return deliverable;
}

export async function activateDeliverable(
  project: GuyditorProject,
  deliverableId: string,
  setNotice: (message: string) => void,
  persist: PersistSelection = setActiveDeliverable,
): Promise<void> {
  const current = useSelectionStore.getState().selectedDeliverableId;
  const deliverable = current === deliverableId
    ? project.deliverables.find(({ id }) => id === deliverableId)
    : applyDeliverableSelection(project, deliverableId);
  if (deliverable === undefined) {
    throw new Error(`Deliverable ${deliverableId} does not exist.`);
  }

  try {
    await persist(deliverable.id);
  } catch (error: unknown) {
    setNotice(
      `Switched to ${deliverable.name}, but workspace autosave failed: ${errorMessage(error)}`,
    );
  }
}
