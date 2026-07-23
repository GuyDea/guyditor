import { useState } from "react";

import type {
  JobDependencyNode,
  JobStatus,
  QueuedJobOverview,
} from "../shared/ipc.js";
import { errorMessage } from "./ipc.js";
import {
  overviewStatusText,
  overviewWaitingCount,
  useJobsStore,
} from "./state/jobs.js";
import {
  useAgentPanelStore,
  usePreviewStore,
  useSelectionStore,
  useWorkspaceStore,
} from "./state/view-state.js";
import type { PanelId } from "./state/view-state.js";

interface GlobalProgressProps {
  refreshOverview: () => Promise<void>;
  setNotice: (notice: string) => void;
}

function revealPanel(panel: PanelId): void {
  const workspace = useWorkspaceStore.getState();
  if (workspace.collapsed[panel]) workspace.togglePanel(panel);
  if (panel === "media" || panel === "preview" || panel === "transcript" ||
    panel === "inspector" || panel === "agent" || panel === "timeline" || panel === "status") {
    for (const [regionId, region] of Object.entries(workspace.layout.regions)) {
      if (region.panelIds.includes(panel)) {
        workspace.activatePanel(regionId as keyof typeof workspace.layout.regions, panel);
        break;
      }
    }
  }
  workspace.focusPanel(panel);
  queueMicrotask(() => document.querySelector<HTMLElement>(`[data-panel="${panel}"]`)?.focus());
}

function etaLabel(etaSeconds: number | undefined): string {
  if (etaSeconds === undefined) return "ETA pending";
  if (etaSeconds < 60) return `${String(Math.ceil(etaSeconds))}s left`;
  return `${String(Math.ceil(etaSeconds / 60))}m left`;
}

function DependencyTree({ nodes }: { nodes: JobDependencyNode[] }): React.JSX.Element | null {
  if (nodes.length === 0) return null;
  return (
    <ul className="dependency-tree">
      {nodes.map((node) => (
        <li key={node.jobId} data-testid={`global-dependency-${node.jobId}`}>
          <span data-state={node.state}>{node.state}</span>
          <strong>{node.title}</strong>
          <small>{node.kind}</small>
          <DependencyTree nodes={node.dependencies} />
        </li>
      ))}
    </ul>
  );
}

export function GlobalProgress({
  refreshOverview,
  setNotice,
}: GlobalProgressProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const overview = useJobsStore((state) => state.overview);
  const waitingCount = overviewWaitingCount(overview);
  const activeCount = overview.running.length + overview.queued.length;
  const fill = Math.max(0, Math.min(100, overview.aggregateFraction * 100));

  async function jobAction(job: JobStatus, action: "cancel" | "retry"): Promise<void> {
    try {
      await window.guyditor.call<JobStatus>("JobQueue", action, { jobId: job.jobId });
      await refreshOverview();
      setNotice(`${action === "cancel" ? "Cancelled" : "Re-queued"} ${job.title}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function jumpToProposal(proposalId: string): void {
    useAgentPanelStore.getState().setExpandedProposal(proposalId);
    revealPanel("agent");
    setOpen(false);
  }

  async function jumpToAnnotation(annotationId: string): Promise<void> {
    useSelectionStore.getState().selectAnnotation(annotationId);
    revealPanel("preview");
    setOpen(false);
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

  const jobRow = (job: JobStatus): React.JSX.Element => (
    <div className="global-job-copy">
      <div>
        <strong>{job.title}</strong>
        <span data-state={job.state}>{job.state}</span>
      </div>
      <progress value={job.progress} max={1} aria-label={`${job.title} progress`} />
      <small>{job.kind} · {Math.round(job.progress * 100)}% · {etaLabel(job.etaSeconds)}</small>
      <div className="global-job-actions">
        {job.cancellable && (job.state === "running" || job.state === "queued") ? (
          <button
            type="button"
            data-testid={`global-job-cancel-${job.jobId}`}
            onClick={() => void jobAction(job, "cancel")}
          >Cancel</button>
        ) : null}
        {job.state === "failed" || job.state === "cancelled" ? (
          <button
            type="button"
            data-testid={`global-job-retry-${job.jobId}`}
            onClick={() => void jobAction(job, "retry")}
          >Retry chain</button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="global-progress-wrap">
      <button
        type="button"
        className="global-progress"
        data-testid="global-progress"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="global-progress-copy">
          <strong>Project activity</strong>
          <small data-testid="global-progress-status">{overviewStatusText(overview)}</small>
        </span>
        <span
          className="global-progress-track"
          role="progressbar"
          aria-label="Aggregate project progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fill)}
        >
          <span
            className="global-progress-fill"
            data-testid="global-progress-fill"
            style={{ width: `${String(fill)}%` }}
          />
        </span>
        <span
          className="global-waiting-badge"
          data-active={waitingCount > 0}
          data-testid="global-progress-waiting-count"
        >{String(waitingCount)} waiting on you</span>
      </button>

      {open ? (
        <aside
          className="global-progress-popover"
          role="dialog"
          aria-label="What the project is waiting on"
          data-testid="global-progress-popover"
        >
          <header>
            <div>
              <span className="eyebrow">Global queue / FR-907</span>
              <h2>What are we waiting on?</h2>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close progress overview">×</button>
          </header>

          <div className="global-progress-groups">
            <section data-testid="global-progress-running">
              <h3><span>Running</span><b>{String(overview.running.length)}</b></h3>
              {overview.running.map((job) => (
                <article key={job.jobId} data-testid={`global-running-job-${job.jobId}`}>
                  {jobRow(job)}
                </article>
              ))}
              {overview.running.length === 0 ? <p>Nothing is running.</p> : null}
              {overview.retryable.length > 0 ? (
                <div className="global-retryable-jobs">
                  <h4>Needs attention</h4>
                  {overview.retryable.map((job) => (
                    <article key={job.jobId} data-testid={`global-retryable-job-${job.jobId}`}>
                      {jobRow(job)}
                    </article>
                  ))}
                </div>
              ) : null}
            </section>

            <section data-testid="global-progress-queued">
              <h3><span>Queued / blocked</span><b>{String(overview.queued.length)}</b></h3>
              {overview.queued.map((job: QueuedJobOverview) => (
                <article key={job.jobId} data-testid={`global-queued-job-${job.jobId}`}>
                  {jobRow(job)}
                  {job.dependencyChain.length === 0 ? null : (
                    <div className="dependency-copy">
                      <span>Blocked on</span>
                      <DependencyTree nodes={job.dependencyChain} />
                    </div>
                  )}
                </article>
              ))}
              {overview.queued.length === 0 ? <p>Nothing is queued.</p> : null}
            </section>

            <section className="creator-waits" data-testid="global-progress-creator">
              <h3><span>Waiting on you</span><b>{String(waitingCount)}</b></h3>
              {overview.waitingOnCreator.proposals.map((proposal) => (
                <article key={proposal.proposalId}>
                  <span className="wait-kind">Proposal</span>
                  <strong>{proposal.title}</strong>
                  <button
                    type="button"
                    data-testid={`global-proposal-jump-${proposal.proposalId}`}
                    onClick={() => jumpToProposal(proposal.proposalId)}
                  >Review proposal</button>
                </article>
              ))}
              {overview.waitingOnCreator.annotations.map((annotation) => (
                <article key={annotation.annotationId}>
                  <span className="wait-kind">{annotation.code}</span>
                  <strong>{annotation.message}</strong>
                  <button
                    type="button"
                    data-testid={`global-annotation-jump-${annotation.annotationId}`}
                    onClick={() => void jumpToAnnotation(annotation.annotationId)}
                  >Go to annotation</button>
                </article>
              ))}
              {overview.waitingOnCreator.confirmations.map((confirmation) => (
                <article key={confirmation.confirmToken}>
                  <span className="wait-kind">Budget · {confirmation.level}</span>
                  <strong>{confirmation.message}</strong>
                  <small>${confirmation.estimatedUsd.toFixed(2)} · {confirmation.taskId}</small>
                </article>
              ))}
              {waitingCount === 0 ? <p>No creator decisions are pending.</p> : null}
            </section>

            <section data-testid="global-progress-external">
              <h3><span>External providers</span><b>{String(overview.waitingOnExternal.length)}</b></h3>
              {overview.waitingOnExternal.map((call) => (
                <article key={call.callId}>
                  <span className="wait-kind">{call.provider}</span>
                  <strong>{call.title}</strong>
                  <small>{String(call.elapsedSeconds)}s · ${call.spendUsd.toFixed(2)}</small>
                </article>
              ))}
              {overview.waitingOnExternal.length === 0 ? <p>No provider calls are in flight.</p> : null}
            </section>
          </div>
          <footer>{String(activeCount)} background · {String(waitingCount)} creator · {String(overview.waitingOnExternal.length)} external</footer>
        </aside>
      ) : null}
    </div>
  );
}
