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

let activationGeneration = 0;

function nextActivationGeneration(): number {
  activationGeneration += 1;
  return activationGeneration;
}

function requireDeliverable(
  project: GuyditorProject,
  deliverableId: string,
): Deliverable {
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  if (deliverable === undefined) {
    throw new Error(`Deliverable ${deliverableId} does not exist.`);
  }
  return deliverable;
}

function applyValidatedDeliverableSelection(
  project: GuyditorProject,
  deliverable: Deliverable,
): number {
  const generation = nextActivationGeneration();
  usePreviewStore.getState().resetForDeliverable(project.settings.timeline.fps);
  useTimelineViewStore.getState().setScrollOffset(0);
  useSelectionStore.getState().activateDeliverable(deliverable.id);
  return generation;
}

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
  const deliverable = requireDeliverable(project, deliverableId);
  applyValidatedDeliverableSelection(project, deliverable);
  return deliverable;
}

export async function activateDeliverable(
  project: GuyditorProject,
  deliverableId: string,
  setNotice: (message: string) => void,
  persist: PersistSelection = setActiveDeliverable,
): Promise<void> {
  const deliverable = requireDeliverable(project, deliverableId);
  const current = useSelectionStore.getState().selectedDeliverableId;
  const generation = current === deliverableId
    ? nextActivationGeneration()
    : applyValidatedDeliverableSelection(project, deliverable);

  try {
    await persist(deliverable.id);
  } catch (error: unknown) {
    if (generation !== activationGeneration) return;
    setNotice(
      `Switched to ${deliverable.name}, but workspace autosave failed: ${errorMessage(error)}`,
    );
    return;
  }
  if (generation === activationGeneration) {
    setNotice(`Switched to ${deliverable.name}.`);
  }
}
