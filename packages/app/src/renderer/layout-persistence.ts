import { configureLayoutSaver, useWorkspaceStore } from "./state/view-state.js";

/**
 * Wires the workspace store to the global WorkspaceLayout settings: every layout change is
 * saved, and the stored document is loaded once unless the user already changed something.
 */
export function startLayoutPersistence(): () => void {
  let active = true;
  let changed = false;
  configureLayoutSaver((document) => {
    changed = true;
    void window.guyditor.call("WorkspaceLayout", "save", { document }).catch(() => undefined);
  });
  void window.guyditor.call<unknown>("WorkspaceLayout", "get", {}).then((stored) => {
    if (active && !changed) useWorkspaceStore.getState().hydrateLayouts(stored);
  }).catch(() => undefined);
  return () => {
    active = false;
    configureLayoutSaver(() => undefined);
  };
}
