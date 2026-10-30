import type { WorkflowPhase } from "./state/layout-state.js";
import { configureLayoutSaver, useWorkspaceStore } from "./state/view-state.js";

/**
 * Wires the workspace store to the global WorkspaceLayout settings. Saves carry only the
 * phases that changed, so main merges them and nothing this window did not touch is reverted.
 * Phases edited before the stored document arrives keep their local edit; every other phase
 * loads from storage. Changes saved by other windows are applied live.
 */
export function startLayoutPersistence(): () => void {
  let active = true;
  const clientId = crypto.randomUUID();
  let hydrated = false;
  const editedPhases = new Set<WorkflowPhase>();
  let editedActivePhase = false;

  configureLayoutSaver((change) => {
    if (!hydrated) {
      for (const phase of Object.keys(change.layouts) as WorkflowPhase[]) editedPhases.add(phase);
      editedActivePhase = true;
    }
    void window.guyditor.call("WorkspaceLayout", "update", { clientId, ...change })
      .catch((error: unknown) => console.warn("Saving the workspace layout failed.", error));
  });
  void window.guyditor.call<unknown>("WorkspaceLayout", "get", {}).then((stored) => {
    if (!active) return;
    useWorkspaceStore.getState().hydrateLayouts(stored, {
      phases: [...editedPhases],
      activePhase: editedActivePhase,
    });
  }).catch((error: unknown) => {
    console.warn("Loading the workspace layout failed; presets are shown.", error);
  }).finally(() => {
    hydrated = true;
  });
  const off = window.guyditor.on("workspace.layout", (event) => {
    if (active && event.clientId !== clientId) {
      useWorkspaceStore.getState().applyRemoteLayouts(event.document);
    }
  });
  return () => {
    active = false;
    off();
    configureLayoutSaver(() => undefined);
  };
}
