import { describe, expect, it } from "vitest";

import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import { useProjectMirror } from "./project-mirror.js";
import { useUndoStore } from "./undo.js";
import {
  usePreviewStore,
  useSelectionStore,
  useWorkspaceStore,
} from "./view-state.js";

describe("workspace renderer state", () => {
  it("replaces the read-only project mirror as a whole snapshot", () => {
    const master = projectFixture();
    useProjectMirror.getState().replace({
      revision: master.revision,
      master,
      sidecarIndex: master.sidecars,
      projectPath: "/project",
    });

    expect(useProjectMirror.getState().snapshot?.master.project.name).toBe("Fixture");
    expect(useProjectMirror.getState().snapshot?.revision).toBe("rev_00001");
  });

  it("keeps panel, selection, and preview choices in Zustand view state", () => {
    useWorkspaceStore.getState().togglePanel("media");
    useSelectionStore.getState().selectWord("w000042");
    usePreviewStore.getState().setPlayhead({ frames: 12, fps: "24/1" });
    usePreviewStore.getState().setSettled(false);

    expect(useWorkspaceStore.getState().collapsed.media).toBe(true);
    expect(useSelectionStore.getState().selectedWordId).toBe("w000042");
    expect(usePreviewStore.getState()).toMatchObject({
      playhead: { frames: 12, fps: "24/1" },
      settled: false,
      quality: "proxy",
    });
  });

  it("caps direct undo history at 200 and clears redo on a new action", () => {
    useUndoStore.getState().clear();
    for (let index = 0; index < 201; index += 1) {
      useUndoStore.getState().record({
        txnId: "txn_aaaaaaaaaa",
        label: `Edit ${String(index)}`,
        ops: [{ op: "clip.remove", params: { clipId: "clp_aaaaaaaaaa", closeGap: true } }],
        inverse: [{ op: "clip.insert", params: {} }],
      });
    }
    expect(useUndoStore.getState().undo).toHaveLength(200);

    const undone = useUndoStore.getState().beginUndo();
    expect(undone?.label).toBe("Edit 200");
    if (undone !== undefined) useUndoStore.getState().finishUndo(undone);
    expect(useUndoStore.getState().redo).toHaveLength(1);

    useUndoStore.getState().record({
      txnId: "txn_bbbbbbbbbb",
      label: "A newer edit",
      ops: [],
      inverse: [],
    });
    expect(useUndoStore.getState().redo).toHaveLength(0);
  });
});
