import type { FrameTime } from "../../../core/src/index.js";
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

function sourceFrameAt(
  time: { samples: number; rate: number },
  fps: string,
): FrameTime {
  const [numerator, denominator] = fps.split("/").map(Number);
  const rate = (numerator ?? 24) / (denominator ?? 1);
  return { frames: Math.max(0, Math.round((time.samples / time.rate) * rate)), fps };
}

/** Reveal Preview at the first word of a transcript range and select the whole range. */
export async function jumpToWordRange(
  assetId: string,
  fromWord: string,
  toWord: string,
  setNotice: (notice: string) => void,
): Promise<void> {
  revealPanel("preview");
  try {
    const location = await window.guyditor.call<{
      assetId: string;
      word: { start: { samples: number; rate: number } };
    } | null | undefined>("TranscriptEngine", "findWord", { wordId: fromWord });
    if (location === null || location === undefined || location.assetId !== assetId) {
      setNotice(`Word ${fromWord} was not found in this asset's transcript.`);
      return;
    }
    usePreviewStore.getState().setPlayhead(
      sourceFrameAt(location.word.start, usePreviewStore.getState().playhead.fps),
    );
    useSelectionStore.getState().selectWord(fromWord);
    useSelectionStore.getState().setWordRange({ fromWord, toWord });
  } catch (error: unknown) {
    setNotice(errorMessage(error));
  }
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
