import {
  WORKFLOW_PHASES,
} from "./state/layout-state.js";
import type {
  WorkflowPhase,
} from "./state/layout-state.js";
import { useJobsStore } from "./state/jobs.js";
import { useWorkspaceStore } from "./state/view-state.js";
import {
  phaseBadgeCounts,
  WORKFLOW_PHASE_LABELS,
  WORKFLOW_PHASE_SHORTCUTS,
} from "./workflow-phases.js";
import {
  jumpToAnnotation,
  jumpToProposal,
  revealPanel,
} from "./workspace-navigation.js";

interface WorkflowPhaseTabsProps {
  setNotice: (notice: string) => void;
}

export function WorkflowPhaseTabs({
  setNotice,
}: WorkflowPhaseTabsProps): React.JSX.Element {
  const activePhase = useWorkspaceStore((state) => state.activePhase);
  const setPhase = useWorkspaceStore((state) => state.setPhase);
  const overview = useJobsStore((state) => state.overview);
  const badges = phaseBadgeCounts(overview);

  function openBadge(phase: WorkflowPhase): void {
    setPhase(phase);
    if (phase === "ingest") {
      revealPanel("status");
      return;
    }
    if (phase === "cut") {
      const filler = overview.waitingOnCreator.proposals.find(({ title }) =>
        /filler|pause/iu.test(title));
      if (filler !== undefined) jumpToProposal(filler.proposalId);
      return;
    }
    if (phase === "review") {
      const proposal = overview.waitingOnCreator.proposals[0];
      if (proposal !== undefined) {
        jumpToProposal(proposal.proposalId);
        return;
      }
      const annotation = overview.waitingOnCreator.annotations[0];
      if (annotation !== undefined) {
        void jumpToAnnotation(annotation.annotationId, setNotice);
      }
      return;
    }
    if (phase === "publish") revealPanel("status");
  }

  return (
    <nav className="phase-strip" aria-label="Workflow phases" data-testid="workflow-phase-tabs">
      <div className="phase-track" role="tablist" aria-label="Workflow phase layouts">
        {WORKFLOW_PHASES.map((phase) => (
          <div className="phase-tab-item" data-active={activePhase === phase} key={phase}>
            <button
              type="button"
              role="tab"
              className="phase-tab"
              id={`phase-tab-${phase}`}
              aria-controls="workspace-layout"
              aria-selected={activePhase === phase}
              data-testid={`phase-tab-${phase}`}
              title={`${WORKFLOW_PHASE_LABELS[phase]} · ${WORKFLOW_PHASE_SHORTCUTS[phase]}`}
              onClick={() => setPhase(phase)}
            >
              <span className="phase-index" aria-hidden="true">
                {String(WORKFLOW_PHASES.indexOf(phase) + 1).padStart(2, "0")}
              </span>
              <span>{WORKFLOW_PHASE_LABELS[phase]}</span>
            </button>
            {badges[phase] > 0 ? (
              <button
                type="button"
                className="phase-badge"
                data-testid={`phase-badge-${phase}`}
                aria-label={`${String(badges[phase])} items need attention in ${WORKFLOW_PHASE_LABELS[phase]}`}
                title={`Open ${WORKFLOW_PHASE_LABELS[phase]} attention`}
                onClick={() => openBadge(phase)}
              >
                {String(badges[phase])}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </nav>
  );
}
