import type { JobStatus } from "../../shared/ipc.js";
import { errorMessage } from "../ipc.js";
import { useJobsStore } from "../state/jobs.js";
import { useSelectionStore } from "../state/view-state.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

function testKind(kind: string): string {
  return kind.replaceAll(".", "-");
}

export function StatusStripPanel({
  snapshot,
  exportReport,
  refreshExportReport,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const jobs = useJobsStore((state) => state.jobs);
  const applyJobEvent = useJobsStore((state) => state.applyEvent);
  const selectDeliverable = useSelectionStore((state) => state.selectDeliverable);
  const primary = snapshot?.master.deliverables.find(
    ({ id }) => id === snapshot.master.settings.primaryDeliverable,
  );
  const newestByKind = new Map<string, JobStatus>();
  for (const job of jobs) if (!newestByKind.has(job.kind)) newestByKind.set(job.kind, job);

  async function exportPrimary(): Promise<void> {
    if (snapshot === null || primary === undefined) return;
    try {
      const result = await window.guyditor.call<{ jobId: string }>("RenderService", "renderExport", {
        revision: snapshot.revision,
        deliverableId: primary.id,
        variants: ["clean"],
        outputDir: `${snapshot.projectPath}/exports`,
      });
      setNotice(`Queued export ${result.jobId}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function jobAction(job: JobStatus, action: "cancel" | "retry"): Promise<void> {
    try {
      const updated = await window.guyditor.call<JobStatus>("JobQueue", action, { jobId: job.jobId });
      applyJobEvent({ kind: "job.state", seq: 0, job: updated });
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <Panel
      id="status"
      title="Deliverables & jobs"
      eyebrow="Render status / reports"
      actions={<button type="button" data-testid="export-report-refresh" onClick={() => void refreshExportReport()}>Refresh report</button>}
    >
      <div className="status-layout">
        <div className="deliverable-list" data-testid="deliverable-list">
          {(snapshot?.master.deliverables ?? []).map((deliverable) => (
            <button
              type="button"
              key={deliverable.id}
              data-testid={`deliverable-${deliverable.id}`}
              data-state={deliverable.status}
              onClick={() => selectDeliverable(deliverable.id)}
            >
              <span><strong>{deliverable.name}</strong><small>{deliverable.id}</small></span>
              <span className="state-chip" data-state={deliverable.status}>{deliverable.status}</span>
            </button>
          ))}
          <button
            type="button"
            className="primary-action"
            data-testid="render-export-primary"
            disabled={primary === undefined}
            onClick={() => void exportPrimary()}
          >Render primary export</button>
        </div>
        <aside className="jobs-panel" data-testid="jobs-panel" aria-label="Background jobs">
          {[...newestByKind].map(([kind, job]) => (
            <span key={kind} hidden data-testid={`job-state-${testKind(kind)}`}>{job.state}</span>
          ))}
          <ol className="job-list">
            {jobs.map((job) => (
              <li key={job.jobId} data-testid={`job-${job.jobId}`}>
                <div className="job-title-row">
                  <strong>{job.title}</strong>
                  <span data-state={job.state}>{job.state}</span>
                </div>
                <progress value={job.progress} max={1} aria-label={`${job.title} progress`} />
                <small>{Math.round(job.progress * 100)}% · {job.kind}</small>
                <div className="row-actions">
                  {job.cancellable && (job.state === "queued" || job.state === "running") ? (
                    <button type="button" data-testid={`job-cancel-${job.jobId}`} onClick={() => void jobAction(job, "cancel")}>Cancel</button>
                  ) : null}
                  {job.state === "failed" || job.state === "cancelled" ? (
                    <button type="button" data-testid={`job-retry-${job.jobId}`} onClick={() => void jobAction(job, "retry")}>Retry</button>
                  ) : null}
                </div>
              </li>
            ))}
            {jobs.length === 0 ? <li className="empty-copy" data-testid="jobs-empty">No background work.</li> : null}
          </ol>
        </aside>
        <div className="export-report" data-testid="export-report">
          {exportReport === null ? (
            <p className="empty-copy">No export report yet.</p>
          ) : (
            <>
              <strong>{exportReport.output.path}</strong>
              <dl>
                <div><dt>Revision</dt><dd>{exportReport.revision}</dd></div>
                <div><dt>Output hash</dt><dd>{exportReport.output.sha256.slice(0, 12)}…</dd></div>
                <div><dt>Frames</dt><dd>{exportReport.output.durationFrames}</dd></div>
                <div><dt>Profile</dt><dd>{exportReport.profile.id}@{exportReport.profile.version}</dd></div>
              </dl>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}
