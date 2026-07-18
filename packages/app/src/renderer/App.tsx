import { useEffect, useMemo, useState } from "react";

import type { GuyditorProject, SidecarRef } from "../../../core/src/index.js";
import type { ExecuteResult, JobStatus } from "../shared/ipc.js";
import { useJobsStore } from "./state/jobs.js";
import {
  useSelectionStore,
  useTimelineViewStore,
  useWorkspaceStore,
} from "./state/view-state.js";

interface ProjectSnapshot {
  revision: string;
  master: GuyditorProject;
  sidecarIndex: SidecarRef[];
  projectPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function JobsPanel(): React.JSX.Element {
  const jobs = useJobsStore((state) => state.jobs);
  return (
    <aside className="jobs-panel" data-testid="jobs-panel" aria-labelledby="jobs-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Background work</span>
          <h2 id="jobs-title">Jobs</h2>
        </div>
        <span className="count" aria-label={`${String(jobs.length)} jobs`}>{jobs.length}</span>
      </div>
      {jobs.length === 0 ? (
        <div className="empty-state" data-testid="jobs-empty">
          <span className="empty-mark" aria-hidden="true">◌</span>
          <p>No background work yet.</p>
          <small>Proxy, transcript, and render progress will stay visible here.</small>
        </div>
      ) : (
        <ol className="job-list">
          {jobs.map((job) => (
            <li key={job.jobId} data-testid={`job-${job.jobId}`}>
              <div className="job-title-row">
                <strong>{job.title}</strong>
                <span data-state={job.state}>{job.state}</span>
              </div>
              <progress value={job.progress} max={1} aria-label={`${job.title} progress`} />
              <small>{Math.round(job.progress * 100)}% · {job.kind}</small>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

interface OperationConsoleProps {
  snapshot: ProjectSnapshot;
  onCommitted: (result: ExecuteResult) => void;
}

function OperationConsole({ snapshot, onCommitted }: OperationConsoleProps): React.JSX.Element {
  const clips = snapshot.master.sequences.flatMap(({ clips }) => clips);
  const selectedClipId = useSelectionStore((state) => state.selectedClipId);
  const selectClip = useSelectionStore((state) => state.selectClip);
  const [edge, setEdge] = useState<"head" | "tail">("tail");
  const [frames, setFrames] = useState(-1);
  const [result, setResult] = useState("Ready");
  const clipId = selectedClipId ?? clips[0]?.id ?? null;

  async function executeTrim(): Promise<void> {
    if (clipId === null) return;
    setResult("Committing…");
    try {
      const committed = await window.guyditor.call<ExecuteResult>("OperationEngine", "execute", {
        operations: [{
          op: "clip.trim",
          params: {
            clipId,
            edge,
            delta: { frames, fps: snapshot.master.settings.timeline.fps },
            snapPolicy: "none",
          },
        }],
        intent: "direct",
        label: `Trim ${clipId} ${edge} by ${String(frames)} frames`,
      });
      setResult(`${committed.txnId} → ${committed.revision}`);
      onCommitted(committed);
    } catch (error: unknown) {
      setResult(errorMessage(error));
    }
  }

  return (
    <section className="operation-console" data-testid="operation-console">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Development surface</span>
          <h2>Raw operation console</h2>
        </div>
        <code>clip.trim</code>
      </div>
      {clips.length === 0 ? (
        <p className="inline-note">This project has no clips to trim.</p>
      ) : (
        <div className="console-grid">
          <label>
            Clip
            <select value={clipId ?? ""} onChange={(event) => selectClip(event.target.value)}>
              {clips.map((clip) => <option key={clip.id} value={clip.id}>{clip.id}</option>)}
            </select>
          </label>
          <label>
            Edge
            <select value={edge} onChange={(event) => setEdge(event.target.value as "head" | "tail")}>
              <option value="head">Head</option>
              <option value="tail">Tail</option>
            </select>
          </label>
          <label>
            Delta frames
            <input
              type="number"
              value={frames}
              onChange={(event) => setFrames(event.target.valueAsNumber)}
            />
          </label>
          <button type="button" onClick={() => void executeTrim()} data-testid="trim-submit">
            Commit trim
          </button>
        </div>
      )}
      <output className="console-output" aria-live="polite">{result}</output>
    </section>
  );
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [notice, setNotice] = useState("Open a project directory to connect the edit journal.");
  const replaceJobs = useJobsStore((state) => state.replace);
  const applyJobEvent = useJobsStore((state) => state.applyEvent);
  const zoom = useTimelineViewStore((state) => state.zoomPixelsPerFrame);
  const setZoom = useTimelineViewStore((state) => state.setZoom);
  const jobsPanelWidth = useWorkspaceStore((state) => state.jobsPanelWidth);

  const projectName = snapshot?.master.project.name ?? "No project open";
  const clips = useMemo(
    () => snapshot?.master.sequences.reduce((count, sequence) => count + sequence.clips.length, 0) ?? 0,
    [snapshot],
  );

  useEffect(() => {
    let active = true;
    void window.guyditor.call<ProjectSnapshot>("ProjectStore", "getSnapshot", {}).then((opened) => {
      if (active) setSnapshot(opened);
    }).catch(() => undefined);
    void window.guyditor.call<JobStatus[]>("JobQueue", "list", {}).then((jobs) => {
      if (active) replaceJobs(jobs);
    }).catch(() => undefined);
    const offState = window.guyditor.on("job.state", applyJobEvent);
    const offProgress = window.guyditor.on("job.progress", applyJobEvent);
    const offRevision = window.guyditor.on("project.revision", (event) => {
      void window.guyditor.call<ProjectSnapshot>("ProjectStore", "getSnapshot", {}).then((next) => {
        if (active) {
          setSnapshot(next);
          setNotice(`Accepted ${event.revision}`);
        }
      });
    });
    return () => {
      active = false;
      offState();
      offProgress();
      offRevision();
    };
  }, [applyJobEvent, replaceJobs]);

  async function openProject(): Promise<void> {
    setNotice("Waiting for a project directory…");
    try {
      const opened = await window.guyditor.call<ProjectSnapshot | null>(
        "ProjectStore",
        "openDialog",
        {},
      );
      if (opened === null) {
        setNotice("Project open cancelled.");
        return;
      }
      setSnapshot(opened);
      replaceJobs(await window.guyditor.call<JobStatus[]>("JobQueue", "list", {}));
      setNotice(`Opened ${opened.projectPath}`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <main className="shell" style={{ "--jobs-width": `${String(jobsPanelWidth)}px` } as React.CSSProperties}>
      <header className="titlebar">
        <div className="wordmark" aria-label="Guyditor">
          <span className="wordmark-glyph" aria-hidden="true">G</span>
          <span>GUYDITOR</span>
        </div>
        <div className="project-identity">
          <strong>{projectName}</strong>
          <span data-testid="revision-indicator">
            {snapshot?.revision ?? "— no revision"}
          </span>
        </div>
        <button type="button" className="open-button" onClick={() => void openProject()} data-testid="open-project">
          Open project
        </button>
      </header>

      <div className="workspace">
        <section className="stage" aria-labelledby="stage-title">
          <div className="stage-heading">
            <div>
              <span className="eyebrow">Main process link</span>
              <h1 id="stage-title">Edit pipe</h1>
            </div>
            <div className="revision-ticket" data-active={snapshot !== null}>
              <span>Accepted revision</span>
              <strong>{snapshot?.revision ?? "UNMOUNTED"}</strong>
            </div>
          </div>

          <div className="project-well" data-empty={snapshot === null}>
            <div className="tape-rail" aria-hidden="true" />
            {snapshot === null ? (
              <div className="project-empty">
                <p>Project state stays on disk and in the main process.</p>
                <button type="button" onClick={() => void openProject()}>Choose a project directory</button>
              </div>
            ) : (
              <div className="project-summary">
                <span>{snapshot.master.project.id}</span>
                <strong>{snapshot.master.project.name}</strong>
                <dl>
                  <div><dt>Clips</dt><dd>{clips}</dd></div>
                  <div><dt>Frame rate</dt><dd>{snapshot.master.settings.timeline.fps}</dd></div>
                  <div><dt>Sidecars</dt><dd>{snapshot.sidecarIndex.length}</dd></div>
                </dl>
              </div>
            )}
          </div>

          <div className="view-controls" aria-label="View-state proof">
            <label htmlFor="zoom">Timeline view zoom</label>
            <input
              id="zoom"
              type="range"
              min="0.25"
              max="16"
              step="0.25"
              value={zoom}
              onChange={(event) => setZoom(event.target.valueAsNumber)}
            />
            <output>{zoom.toFixed(2)} px/frame</output>
          </div>

          {import.meta.env.DEV && snapshot !== null ? (
            <OperationConsole snapshot={snapshot} onCommitted={({ revision }) => {
              setNotice(`Trim committed as ${revision}; waiting for revision event.`);
            }} />
          ) : null}

          <p className="notice" role="status" data-testid="shell-status">{notice}</p>
        </section>
        <JobsPanel />
      </div>
    </main>
  );
}
