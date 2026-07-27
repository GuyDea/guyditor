import { useEffect, useMemo, useState } from "react";

import type {
  GuyditorProject,
  Proposal,
} from "../../../../core/src/index.js";
import type { PlatformProfile, ShortCandidate } from "../../../../deliver/src/index.js";
import type { JobStatus } from "../../shared/ipc.js";
import {
  activateDeliverable,
  resolveActiveDeliverable,
} from "../active-deliverable.js";
import {
  errorMessage,
  executeDirect,
  setActiveDeliverable,
} from "../ipc.js";
import { useJobsStore } from "../state/jobs.js";
import { useSelectionStore } from "../state/view-state.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

function testKind(kind: string): string {
  return kind.replaceAll(".", "-");
}

function pin(profile: PlatformProfile): string {
  return `${profile.id}@${profile.version}`;
}

function operationDeliverableId(proposal: Proposal): string | undefined {
  const operation = proposal.operations.find(({ op }) => op === "deliverable.refresh");
  const id = operation?.params["deliverableId"];
  return typeof id === "string" ? id : undefined;
}

export function primaryTimelineSelection(
  project: GuyditorProject,
  startFrames: number,
  endFrames: number,
): Record<string, unknown> | undefined {
  const primary = project.deliverables.find(
    ({ id }) => id === project.settings.primaryDeliverable,
  );
  return primary === undefined || endFrames <= startFrames
    ? undefined
    : {
        timelineRange: {
          sequenceId: primary.sequenceId,
          start: { frames: startFrames, fps: project.settings.timeline.fps },
          end: { frames: endFrames, fps: project.settings.timeline.fps },
        },
      };
}

export function StatusStripPanel({
  snapshot,
  proposals,
  exportReport,
  refreshProject,
  refreshProposals,
  refreshExportReport,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const jobs = useJobsStore((state) => state.jobs);
  const applyJobEvent = useJobsStore((state) => state.applyEvent);
  const selectedDeliverableId = useSelectionStore(
    (state) => state.selectedDeliverableId,
  );
  const selectedWordId = useSelectionStore((state) => state.selectedWordId);
  const wordRange = useSelectionStore((state) => state.wordRange);
  const [deriveOpen, setDeriveOpen] = useState(false);
  const [profiles, setProfiles] = useState<PlatformProfile[]>([]);
  const [candidates, setCandidates] = useState<ShortCandidate[]>([]);
  const [profilePin, setProfilePin] = useState("youtube-shorts@1.0.0");
  const [name, setName] = useState("New short");
  const [mode, setMode] = useState<"candidate" | "transcript" | "clips" | "beats" | "timeline">("transcript");
  const [candidateId, setCandidateId] = useState("");
  const [clipIds, setClipIds] = useState("");
  const [beatIds, setBeatIds] = useState("");
  const [timelineStart, setTimelineStart] = useState(0);
  const [timelineEnd, setTimelineEnd] = useState(30);
  const primary = snapshot?.master.deliverables.find(
    ({ id }) => id === snapshot.master.settings.primaryDeliverable,
  );
  const activeDeliverable = snapshot === null
    ? undefined
    : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
  const selectedProfile = profiles.find((profile) => pin(profile) === profilePin);
  const shortProfiles = profiles.filter(({ kind }) => kind === "short");
  const newestByKind = new Map<string, JobStatus>();
  for (const job of jobs) if (!newestByKind.has(job.kind)) newestByKind.set(job.kind, job);
  const refreshByDeliverable = useMemo(() => new Map(proposals.flatMap((proposal) => {
    const id = operationDeliverableId(proposal);
    return id === undefined || proposal.status !== "ready" ? [] : [[id, proposal] as const];
  })), [proposals]);

  useEffect(() => {
    if (!deriveOpen) return;
    void Promise.all([
      window.guyditor.call<PlatformProfile[]>("DeliverableService", "profiles", {}),
      window.guyditor.call<ShortCandidate[]>("DeliverableService", "candidates", {}),
    ]).then(([nextProfiles, nextCandidates]) => {
      setProfiles(nextProfiles);
      setCandidates(nextCandidates);
    }).catch((error: unknown) => setNotice(errorMessage(error)));
  }, [deriveOpen, setNotice]);

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

  async function discover(): Promise<void> {
    try {
      const job = await window.guyditor.call<JobStatus>("DeliverableService", "discoverCandidates", {
        profile: profilePin,
        maxCandidates: 8,
      });
      applyJobEvent({ kind: "job.state", seq: 0, job });
      setNotice(`Queued candidate discovery ${job.jobId}. Load results when it completes.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function loadCandidates(): Promise<void> {
    try {
      setCandidates(await window.guyditor.call<ShortCandidate[]>("DeliverableService", "candidates", {}));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function manualSelection(): Record<string, unknown> | undefined {
    if (mode === "candidate") return undefined;
    if (mode === "transcript") {
      const startWordId = wordRange?.fromWord ?? selectedWordId;
      const endWordId = wordRange?.toWord ?? selectedWordId;
      return startWordId === null || startWordId === undefined || endWordId === null || endWordId === undefined
        ? undefined
        : { words: { startWordId, endWordId } };
    }
    if (mode === "clips") {
      const clips = clipIds.split(/[\s,]+/u).filter(Boolean);
      return clips.length === 0 ? undefined : { clips };
    }
    if (mode === "beats") {
      const beats = beatIds.split(/[\s,]+/u).filter(Boolean);
      return beats.length === 0 ? undefined : { beats };
    }
    return snapshot === null
      ? undefined
      : primaryTimelineSelection(snapshot.master, timelineStart, timelineEnd);
  }

  async function derive(): Promise<void> {
    const selection = manualSelection();
    if (mode === "candidate" && candidateId.length === 0 || mode !== "candidate" && selection === undefined) {
      setNotice("Choose a candidate or provide a valid manual selection before deriving.");
      return;
    }
    try {
      const proposal = await window.guyditor.call<Proposal>("DeliverableService", "derive", {
        name,
        profile: profilePin,
        ...(mode === "candidate" ? { candidateId } : { selection }),
      });
      await refreshProposals();
      setDeriveOpen(false);
      setNotice(`Derivation proposal ${proposal.id} is ready for review.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function lifecycle(deliverableId: string, action: "review" | "approve" | "refresh"): Promise<void> {
    try {
      if (action === "refresh") {
        const proposal = await window.guyditor.call<Proposal>("DeliverableService", "refresh", { deliverableId });
        await refreshProposals();
        setNotice(`Refresh proposal ${proposal.id} includes a diff and preview job.`);
        return;
      }
      await executeDirect([action === "review"
        ? { op: "deliverable.status.set", params: { deliverableId, status: "in-review" } }
        : { op: "deliverable.approve", params: { deliverableId } }],
      action === "review" ? "Send deliverable for review" : "Approve deliverable");
      await refreshProject();
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function reviewRefresh(proposal: Proposal, action: "acceptProposal" | "rejectProposal"): Promise<void> {
    try {
      await window.guyditor.call<Proposal>("OperationEngine", action, { proposalId: proposal.id });
      await Promise.all([refreshProject(), refreshProposals()]);
      setNotice(`${action === "acceptProposal" ? "Accepted" : "Rejected"} refresh ${proposal.id}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <Panel
      id="status"
      title="Deliverables & jobs"
      eyebrow="Independent cuts / dependency watch"
      actions={<>
        <button type="button" data-testid="derive-open" onClick={() => setDeriveOpen(true)}>Derive short</button>
        <button type="button" data-testid="export-report-refresh" onClick={() => void refreshExportReport()}>Refresh report</button>
      </>}
    >
      <div className="status-layout">
        <div className="deliverable-list" data-testid="deliverable-list">
          {(snapshot?.master.deliverables ?? []).map((deliverable) => {
            const refreshProposal = refreshByDeliverable.get(deliverable.id);
            return (
              <article className="deliverable-card" key={deliverable.id} data-state={deliverable.status}>
                <button
                  type="button"
                  data-testid={`deliverable-${deliverable.id}`}
                  data-state={deliverable.status}
                  data-active={deliverable.id === activeDeliverable?.id}
                  aria-pressed={deliverable.id === activeDeliverable?.id}
                  onClick={() => snapshot === null
                    ? undefined
                    : void activateDeliverable(
                        snapshot.master,
                        deliverable.id,
                        setNotice,
                        (deliverableId) => setActiveDeliverable(
                          snapshot.projectPath,
                          deliverableId,
                        ),
                      )}
                >
                  <span><strong>{deliverable.name}</strong><small>{deliverable.profile}</small></span>
                  <span className="state-chip" data-testid={deliverable.status === "stale" ? "stale-badge" : undefined} data-state={deliverable.status}>{deliverable.status}</span>
                </button>
                {deliverable.status === "stale" ? (
                  <div className="dependency-alert" data-testid="stale-explanation">
                    {(deliverable.staleReasons ?? []).flatMap(({ affected }) => affected).map(({ dependency, change }, index) => (
                      <p key={`${dependency.derivativeClipId}-${String(index)}`}>
                        <code>{dependency.source.range.start.frames}–{dependency.source.range.end.frames}@{dependency.source.range.start.fps}</code> {change}
                      </p>
                    ))}
                    {refreshProposal === undefined ? (
                      <button type="button" data-testid={`refresh-${deliverable.id}`} onClick={() => void lifecycle(deliverable.id, "refresh")}>Build refresh review</button>
                    ) : (
                      <div className="refresh-review" data-testid="refresh-proposal-review">
                        <span>{refreshProposal.diff?.entries.length ?? 0} changes · preview {refreshProposal.previewJobId ?? "pending"}</span>
                        <button type="button" onClick={() => void reviewRefresh(refreshProposal, "acceptProposal")}>Accept refresh</button>
                        <button type="button" onClick={() => void reviewRefresh(refreshProposal, "rejectProposal")}>Keep stale</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="deliverable-actions">
                    {deliverable.status === "draft" ? <button type="button" onClick={() => void lifecycle(deliverable.id, "review")}>Send review</button> : null}
                    {deliverable.status === "in-review" ? <button type="button" onClick={() => void lifecycle(deliverable.id, "approve")}>Approve</button> : null}
                  </div>
                )}
              </article>
            );
          })}
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
                <div className="job-title-row"><strong>{job.title}</strong><span data-state={job.state}>{job.state}</span></div>
                <progress value={job.progress} max={1} aria-label={`${job.title} progress`} />
                <small>{Math.round(job.progress * 100)}% · {job.kind}</small>
                <div className="row-actions">
                  {job.cancellable && (job.state === "queued" || job.state === "running") ? <button type="button" onClick={() => void jobAction(job, "cancel")}>Cancel</button> : null}
                  {job.state === "failed" || job.state === "cancelled" ? <button type="button" onClick={() => void jobAction(job, "retry")}>Retry</button> : null}
                </div>
              </li>
            ))}
            {jobs.length === 0 ? <li className="empty-copy" data-testid="jobs-empty">No background work.</li> : null}
          </ol>
        </aside>
        <div className="export-report" data-testid="export-report">
          {exportReport === null ? <p className="empty-copy">No export report yet.</p> : <>
            <strong>{exportReport.output.path}</strong>
            <dl>
              <div><dt>Revision</dt><dd>{exportReport.revision}</dd></div>
              <div><dt>Output hash</dt><dd>{exportReport.output.sha256.slice(0, 12)}…</dd></div>
              <div><dt>Frames</dt><dd>{exportReport.output.durationFrames}</dd></div>
              <div><dt>Profile</dt><dd>{exportReport.profile.id}@{exportReport.profile.version}</dd></div>
            </dl>
          </>}
        </div>
      </div>
      {deriveOpen ? (
        <section className="derive-dialog" role="dialog" aria-modal="true" aria-label="Derive a short" data-testid="derive-dialog">
          <header><div><span className="panel-eyebrow">Independent sequence</span><h3>Derive a short</h3></div><button type="button" onClick={() => setDeriveOpen(false)}>Close</button></header>
          <div className="derive-grid">
            <label>Name<input value={name} onChange={(event) => setName(event.currentTarget.value)} /></label>
            <label>Platform<select data-testid="profile-picker" value={profilePin} onChange={(event) => setProfilePin(event.currentTarget.value)}>
              {(shortProfiles.length === 0 ? [{ id: "youtube-shorts", version: "1.0.0", displayName: "YouTube Shorts" } as PlatformProfile] : shortProfiles)
                .map((profile) => <option key={pin(profile)} value={pin(profile)}>{profile.displayName}</option>)}
            </select></label>
            {selectedProfile === undefined ? null : (
              <div className="profile-constraints" data-testid="profile-constraints">
                <strong>{selectedProfile.video.resolution.width}×{selectedProfile.video.resolution.height} · {selectedProfile.video.aspect}</strong>
                <span>{selectedProfile.video.codec}/{selectedProfile.video.container} · {selectedProfile.video.fps.default} fps</span>
                <span>{selectedProfile.duration.minSeconds}–{selectedProfile.duration.maxSeconds ?? "∞"} s · {selectedProfile.audio.loudness.integratedLufs} LUFS</span>
                <span>Title safe: {selectedProfile.safeAreas.title.top}/{selectedProfile.safeAreas.title.bottom}/{selectedProfile.safeAreas.title.left}/{selectedProfile.safeAreas.title.right}</span>
              </div>
            )}
            <label>Source<select value={mode} onChange={(event) => setMode(event.currentTarget.value as typeof mode)}>
              <option value="transcript">Transcript passage</option><option value="clips">Clip range</option><option value="beats">Beat range</option><option value="timeline">Timeline range</option><option value="candidate">Discovered candidate</option>
            </select></label>
            {mode === "candidate" ? <div className="candidate-picker">
              <div className="row-actions"><button type="button" onClick={() => void discover()}>Discover candidates</button><button type="button" onClick={() => void loadCandidates()}>Load results</button></div>
              {candidates.map((candidate) => <label key={candidate.candidateId} className="candidate-option"><input type="radio" name="candidate" checked={candidateId === candidate.candidateId} onChange={() => setCandidateId(candidate.candidateId)} /><span><strong>{candidate.evidence.hookLine}</strong><small>{candidate.durationSeconds}s · {Math.round(candidate.scores.overall * 100)} · {candidate.evidence.criteria.join(", ")}</small></span></label>)}
            </div> : null}
            {mode === "transcript" ? <p className="selection-readout">{wordRange === null ? selectedWordId ?? "Select a transcript word or passage." : `${wordRange.fromWord}–${wordRange.toWord}`}</p> : null}
            {mode === "clips" ? <label className="wide">Clip IDs<input value={clipIds} onChange={(event) => setClipIds(event.currentTarget.value)} placeholder="Paste one or more clip IDs" /></label> : null}
            {mode === "beats" ? <label className="wide">Beat IDs<input value={beatIds} onChange={(event) => setBeatIds(event.currentTarget.value)} placeholder="Paste one or more beat IDs" /></label> : null}
            {mode === "timeline" ? <div className="timeline-range-fields"><label>Start frame<input type="number" min={0} value={timelineStart} onChange={(event) => setTimelineStart(event.currentTarget.valueAsNumber)} /></label><label>End frame<input type="number" min={1} value={timelineEnd} onChange={(event) => setTimelineEnd(event.currentTarget.valueAsNumber)} /></label></div> : null}
          </div>
          <footer><span>Derivation creates a review-gated, independently editable sequence.</span><button type="button" className="primary-action" data-testid="derive-submit" onClick={() => void derive()}>Create proposal</button></footer>
        </section>
      ) : null}
    </Panel>
  );
}
