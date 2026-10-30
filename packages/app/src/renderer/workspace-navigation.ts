import type { FrameTime, GuyditorProject } from "../../../core/src/index.js";
import { deriveTimeline } from "../../../core/src/project/derive.js";
import { errorMessage } from "./ipc.js";
import {
  useAgentPanelStore,
  usePreviewStore,
  useSelectionStore,
  useWorkspaceStore,
} from "./state/view-state.js";
import type { PanelId } from "./state/view-state.js";

export function revealPanel(panel: PanelId): void {
  useWorkspaceStore.getState().revealPanel(panel);
  queueMicrotask(() => document.querySelector<HTMLElement>(`[data-panel="${panel}"]`)?.focus());
}

export function jumpToProposal(proposalId: string): void {
  useAgentPanelStore.getState().setExpandedProposal(proposalId);
  revealPanel("agent");
}

function framesPerSecond(fps: string): number {
  const [numerator, denominator] = fps.split("/").map(Number);
  return (numerator ?? 24) / (denominator ?? 1);
}

/**
 * The primary deliverable's timeline frame showing `sourceFrame` of `assetId`, or null when no
 * clip on that sequence covers it (`source.in ≤ t < source.out`).
 */
export function timelineFrameForSource(
  project: GuyditorProject,
  assetId: string,
  sourceFrame: FrameTime,
): FrameTime | null {
  const deliverable = project.deliverables.find(({ id }) => id === project.settings.primaryDeliverable);
  const sequence = project.sequences.find(({ id }) => id === deliverable?.sequenceId);
  if (sequence === undefined) return null;
  const derived = deriveTimeline(project, sequence.id);
  if (!derived.ok) return null;
  const seconds = sourceFrame.frames / framesPerSecond(sourceFrame.fps);
  for (const [index, clip] of sequence.clips.entries()) {
    if (clip.asset !== assetId) continue;
    const clipFps = framesPerSecond(clip.source.in.fps);
    const inSeconds = clip.source.in.frames / clipFps;
    const outSeconds = clip.source.out.frames / framesPerSecond(clip.source.out.fps);
    if (seconds < inSeconds || seconds >= outSeconds) continue;
    const start = derived.value.clips[index]!.start;
    const offset = Math.floor((seconds - inSeconds) * framesPerSecond(start.fps) + 1e-9);
    return { frames: start.frames + offset, fps: start.fps };
  }
  return null;
}

/**
 * Select a transcript word range and, when its footage is on the primary timeline, move the
 * playhead there. Footage not yet on the timeline keeps the playhead and says so.
 */
export async function jumpToWordRange(
  project: GuyditorProject | null | undefined,
  assetId: string,
  fromWord: string,
  toWord: string,
  setNotice: (notice: string) => void,
): Promise<void> {
  try {
    const location = await window.guyditor.call<{
      assetId: string;
      word: { start: { samples: number; rate: number } };
    } | null | undefined>("TranscriptEngine", "findWord", { wordId: fromWord });
    if (location === null || location === undefined || location.assetId !== assetId) {
      setNotice(`Word ${fromWord} was not found in this asset's transcript.`);
      return;
    }
    const { samples, rate } = location.word.start;
    const frame = project === null || project === undefined
      ? null
      : timelineFrameForSource(project, assetId, { frames: samples, fps: `${String(rate)}/1` });
    useSelectionStore.getState().selectWord(fromWord);
    useSelectionStore.getState().setWordRange({ fromWord, toWord });
    if (frame === null) {
      revealPanel("transcript");
      setNotice("Footage is not on the timeline yet; selected it in the transcript.");
      return;
    }
    revealPanel("preview");
    usePreviewStore.getState().setPlayhead(frame);
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
