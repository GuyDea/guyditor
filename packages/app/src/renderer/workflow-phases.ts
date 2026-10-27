import type { JobOverview } from "../shared/ipc.js";
import {
  WORKFLOW_PHASES,
} from "./state/layout-state.js";
import type {
  DockPanelId,
  WorkflowPhase,
} from "./state/layout-state.js";

export const WORKFLOW_PHASE_LABELS: Record<WorkflowPhase, string> = {
  ingest: "Ingest",
  cut: "Cut",
  polish: "Polish",
  review: "Review",
  publish: "Publish",
};

export const WORKFLOW_PHASE_SHORTCUTS: Record<WorkflowPhase, string> = {
  ingest: "Ctrl+Alt+1",
  cut: "Ctrl+Alt+2",
  polish: "Ctrl+Alt+3",
  review: "Ctrl+Alt+4",
  publish: "Ctrl+Alt+5",
};

const INGEST_CHAIN_KINDS = new Set([
  "ingest",
  "proxy.generate",
  "peaks.generate",
  "transcribe",
]);

export function phaseBadgeCounts(
  overview: JobOverview,
): Record<WorkflowPhase, number> {
  const activeIngest = [...overview.running, ...overview.queued]
    .filter(({ kind }) => INGEST_CHAIN_KINDS.has(kind)).length;
  const fillerProposals = overview.waitingOnCreator.proposals.filter(({ title }) =>
    /filler|pause/iu.test(title)).length;
  const publishBlockers = overview.retryable.filter(({ kind }) =>
    kind === "render.export").length;

  return {
    ingest: activeIngest,
    cut: fillerProposals,
    polish: 0,
    review: overview.waitingOnCreator.proposals.length +
      overview.waitingOnCreator.annotations.length,
    publish: publishBlockers + overview.waitingOnCreator.confirmations.length,
  };
}

export function panelBadgeCounts(
  overview: JobOverview,
): Record<DockPanelId, number> {
  const phases = phaseBadgeCounts(overview);
  return {
    media: phases.ingest,
    preview: overview.waitingOnCreator.annotations.length,
    transcript: phases.cut,
    inspector: 0,
    agent: overview.waitingOnCreator.proposals.length,
    timeline: 0,
    status: phases.ingest,
    graphics: 0,
    publish: phases.publish,
    skills: 0,
    broll: 0,
    storage: 0,
    help: 0,
    assemble: 0,
  };
}

export function phaseForShortcut(event: KeyboardEvent): WorkflowPhase | null {
  if (!(event.ctrlKey || event.metaKey) || !event.altKey ||
    event.shiftKey || !/^[1-5]$/u.test(event.key)) {
    return null;
  }
  return WORKFLOW_PHASES[Number(event.key) - 1] ?? null;
}
