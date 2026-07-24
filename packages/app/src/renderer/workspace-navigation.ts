import { errorMessage } from "./ipc.js";
import {
  useAgentPanelStore,
  usePreviewStore,
  useSelectionStore,
  useWorkspaceStore,
} from "./state/view-state.js";
import type { PanelId } from "./state/view-state.js";

export function revealPanel(panel: PanelId): void {
  useWorkspaceStore.getState().expandPanel(panel);
  queueMicrotask(() => document.querySelector<HTMLElement>(`[data-panel="${panel}"]`)?.focus());
}

export function jumpToProposal(proposalId: string): void {
  useAgentPanelStore.getState().setExpandedProposal(proposalId);
  revealPanel("agent");
}

export async function jumpToAnnotation(
  annotationId: string,
  setNotice: (notice: string) => void,
): Promise<void> {
  useSelectionStore.getState().selectAnnotation(annotationId);
  revealPanel("preview");
  try {
    const { frame } = await window.guyditor.call<{
      frame: { frames: number; fps: string };
    }>("OperationEngine", "resolveNavigation", {
      target: { kind: "annotation", annotationId },
    });
    usePreviewStore.getState().setPlayhead(frame);
  } catch (error: unknown) {
    setNotice(errorMessage(error));
  }
}
