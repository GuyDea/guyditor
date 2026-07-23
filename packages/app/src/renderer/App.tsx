import { useCallback, useEffect, useRef, useState } from "react";

import type { Annotation, Proposal, RestylePlan } from "../../../core/src/index.js";
import type { ExportReport } from "../../../render/src/index.js";
import type { TranscriptSidecar } from "../../../transcript/src/index.js";
import type { ResolvedSkill, SkillManifest } from "../../../agent/src/index.js";
import type { JobOverview, JobStatus, ProjectSnapshot } from "../shared/ipc.js";
import { DockWorkspace } from "./DockWorkspace.js";
import { GlobalProgress } from "./GlobalProgress.js";
import { WorkflowPhaseTabs } from "./WorkflowPhaseTabs.js";
import { BrollPanel } from "./panels/BrollPanel.js";
import { GraphicsPanel } from "./panels/GraphicsPanel.js";
import { errorMessage, getSnapshot, redoLast, undoLast } from "./ipc.js";
import { InspectorPanel } from "./panels/InspectorPanel.js";
import { MediaBrowserPanel } from "./panels/MediaBrowserPanel.js";
import { PreviewPanel } from "./panels/PreviewPanel.js";
import { ProposalPanel } from "./panels/ProposalPanel.js";
import { PublishPanel } from "./panels/PublishPanel.js";
import { StatusStripPanel } from "./panels/StatusStripPanel.js";
import { StoragePanel } from "./panels/StoragePanel.js";
import { SkillsPanel } from "./panels/SkillsPanel.js";
import { TimelinePanel } from "./panels/TimelinePanel.js";
import { TranscriptPanel } from "./panels/TranscriptPanel.js";
import type { WorkspacePanelProps } from "./panels/types.js";
import { useJobsStore } from "./state/jobs.js";
import { useProjectMirror } from "./state/project-mirror.js";
import { useUndoStore } from "./state/undo.js";
import {
  usePreviewStore,
  useSelectionStore,
  useWorkspaceStore,
} from "./state/view-state.js";
import type { PanelId } from "./state/view-state.js";
import type { DockPanelId } from "./state/layout-state.js";
import { phaseForShortcut } from "./workflow-phases.js";
import { revealPanel } from "./workspace-navigation.js";

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLElement && target.isContentEditable;
}

const OVERVIEW_CONFIRMATION_POLL_MS = 2_000;

export function App(): React.JSX.Element {
  const snapshot = useProjectMirror((state) => state.snapshot);
  const replaceSnapshot = useProjectMirror((state) => state.replace);
  const [transcripts, setTranscripts] = useState<TranscriptSidecar[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [pinnedSkills, setPinnedSkills] = useState<ResolvedSkill[]>([]);
  const [skillDrafts, setSkillDrafts] = useState<ResolvedSkill[]>([]);
  const [restylePlan, setRestylePlan] = useState<RestylePlan | null>(null);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [notice, setNotice] = useState("Open a project directory to connect the edit journal.");
  const overviewGeneration = useRef(0);
  const annotationGeneration = useRef(0);
  const replaceJobs = useJobsStore((state) => state.replace);
  const replaceOverview = useJobsStore((state) => state.replaceOverview);
  const applyJobEvent = useJobsStore((state) => state.applyEvent);
  const resetLayout = useWorkspaceStore((state) => state.resetLayout);
  const resetAllLayouts = useWorkspaceStore((state) => state.resetAllLayouts);
  const playhead = usePreviewStore((state) => state.playhead);
  const playing = usePreviewStore((state) => state.playing);
  const setPlayhead = usePreviewStore((state) => state.setPlayhead);
  const setPlaying = usePreviewStore((state) => state.setPlaying);
  const selectWord = useSelectionStore((state) => state.selectWord);
  const selectAnnotation = useSelectionStore((state) => state.selectAnnotation);
  const undoCount = useUndoStore((state) => state.undo.length);
  const redoCount = useUndoStore((state) => state.redo.length);

  const refreshAnnotations = useCallback(async (): Promise<void> => {
    const generation = ++annotationGeneration.current;
    try {
      const next = await window.guyditor.call<Annotation[]>("AnnotationService", "list", {});
      if (generation === annotationGeneration.current) setAnnotations(next);
    } catch {
      if (generation === annotationGeneration.current) setAnnotations([]);
    }
  }, []);

  const refreshProposals = useCallback(async (): Promise<void> => {
    try {
      setProposals(await window.guyditor.call<Proposal[]>("ProjectStore", "listProposals", {}));
    } catch {
      setProposals([]);
    }
  }, []);

  const refreshSkills = useCallback(async (): Promise<void> => {
    try {
      const [library, pinned, drafts] = await Promise.all([
        window.guyditor.call<SkillManifest[]>("SkillRegistry", "list", { scope: "global" }),
        window.guyditor.call<ResolvedSkill[]>("SkillRegistry", "pinned", {}),
        window.guyditor.call<ResolvedSkill[]>("SkillRegistry", "drafts", {}),
      ]);
      setSkills(library);
      setPinnedSkills(pinned);
      setSkillDrafts(drafts);
    } catch {
      setSkills([]);
      setPinnedSkills([]);
      setSkillDrafts([]);
    }
  }, []);

  const refreshExportReport = useCallback(async (): Promise<void> => {
    try {
      setExportReport(await window.guyditor.call<ExportReport | null>(
        "RenderService",
        "exportReport",
        {},
      ));
    } catch {
      setExportReport(null);
    }
  }, []);

  const refreshRestylePlan = useCallback(async (): Promise<void> => {
    const deliverableId = useProjectMirror.getState().snapshot?.master.settings.primaryDeliverable;
    if (deliverableId === undefined) {
      setRestylePlan(null);
      return;
    }
    try {
      setRestylePlan(await window.guyditor.call<RestylePlan | null>(
        "DeliverableService",
        "restylePlan",
        { deliverableId },
      ));
    } catch {
      setRestylePlan(null);
    }
  }, []);

  const refreshOverview = useCallback(async (): Promise<void> => {
    const generation = ++overviewGeneration.current;
    try {
      const next = await window.guyditor.call<JobOverview>("JobQueue", "overview", {});
      if (generation === overviewGeneration.current) replaceOverview(next);
    } catch {
      // Keep the most recent re-queryable snapshot during project transitions.
    }
  }, [replaceOverview]);

  const hydrate = useCallback(async (next: ProjectSnapshot): Promise<void> => {
    const generation = ++overviewGeneration.current;
    useWorkspaceStore.getState().setProjectKey(next.projectPath);
    replaceSnapshot(next);
    const [nextTranscripts, nextJobs, nextOverview] = await Promise.all([
      window.guyditor.call<TranscriptSidecar[]>("ProjectStore", "readTranscript", {})
        .catch(() => []),
      window.guyditor.call<JobStatus[]>("JobQueue", "list", {}).catch(() => []),
      window.guyditor.call<JobOverview>("JobQueue", "overview", {}).catch(() => null),
    ]);
    setTranscripts(nextTranscripts);
    replaceJobs(nextJobs);
    if (nextOverview !== null && generation === overviewGeneration.current) {
      replaceOverview(nextOverview);
    }
    await Promise.all([
      refreshAnnotations(),
      refreshProposals(),
      refreshSkills(),
      refreshExportReport(),
      refreshRestylePlan(),
    ]);
  }, [refreshAnnotations, refreshExportReport, refreshProposals, refreshRestylePlan, refreshSkills, replaceJobs, replaceOverview, replaceSnapshot]);

  const refreshProject = useCallback(async (): Promise<void> => {
    const next = await getSnapshot();
    await hydrate(next);
  }, [hydrate]);

  useEffect(() => {
    let active = true;
    void getSnapshot().then((opened) => active ? hydrate(opened) : undefined).catch(() => undefined);
    void window.guyditor.call<JobStatus[]>("JobQueue", "list", {}).then((initial) => {
      if (active) replaceJobs(initial);
    }).catch(() => undefined);
    const offState = window.guyditor.on("job.state", (event) => {
      applyJobEvent(event);
      void refreshOverview();
      if (event.job.state === "done" && event.job.kind === "render.export") {
        void refreshExportReport();
      }
      if (event.job.state === "done" && event.job.kind === "ingest") {
        void refreshProject();
      }
      if (event.job.kind === "restyle.generate") {
        void Promise.all([refreshProposals(), refreshRestylePlan()]);
      }
    });
    const offProgress = window.guyditor.on("job.progress", (event) => {
      applyJobEvent(event);
      void refreshOverview();
    });
    const offRevision = window.guyditor.on("project.revision", (event) => {
      void refreshProject().then(() => setNotice(`Accepted ${event.revision}`));
    });
    const offProposal = window.guyditor.on("proposal.updated", () => {
      void Promise.all([refreshProposals(), refreshOverview()]);
    });
    const offAnnotation = window.guyditor.on("annotation.updated", () => {
      void Promise.all([refreshAnnotations(), refreshOverview()]);
    });
    const offWatcher = window.guyditor.on("watcher.ingested", (event) => {
      void Promise.all([refreshProject(), refreshOverview()]).then(() => {
        setNotice(`Capture watcher ingested ${String(event.assetIds.length)} asset${event.assetIds.length === 1 ? "" : "s"}.`);
      });
    });
    return () => {
      active = false;
      offState();
      offProgress();
      offRevision();
      offProposal();
      offAnnotation();
      offWatcher();
    };
  }, [applyJobEvent, hydrate, refreshAnnotations, refreshExportReport, refreshOverview, refreshProject, refreshProposals, refreshRestylePlan, replaceJobs]);

  useEffect(() => {
    if (snapshot === null) return undefined;
    const interval = window.setInterval(() => {
      void refreshOverview();
    }, OVERVIEW_CONFIRMATION_POLL_MS);
    return () => window.clearInterval(interval);
  }, [refreshOverview, snapshot]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      const shortcutPhase = phaseForShortcut(event);
      if (shortcutPhase !== null) {
        event.preventDefault();
        useWorkspaceStore.getState().setPhase(shortcutPhase);
        return;
      }
      if (isTypingTarget(event.target)) return;
      const fps = snapshot?.master.settings.timeline.fps ?? playhead.fps;
      const step = (delta: number): void => {
        event.preventDefault();
        setPlaying(false);
        setPlayhead({ frames: Math.max(0, playhead.frames + delta), fps });
      };
      if (event.code === "Space") {
        event.preventDefault();
        setPlaying(!playing);
      } else if (event.key === "ArrowLeft" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        step(event.shiftKey ? -10 : -1);
      } else if (event.key === "ArrowRight" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        step(event.shiftKey ? 10 : 1);
      } else if ((event.key === "," || event.key === ".") && !playing) {
        step(event.key === "," ? -1 : 1);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey ? redoLast() : undoLast())
          .then(() => refreshProject())
          .catch((error: unknown) => setNotice(errorMessage(error)));
      } else if (event.key === "Home") {
        event.preventDefault();
        setPlayhead({ frames: 0, fps });
      } else if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        const words = transcripts.flatMap((sidecar) => sidecar.segments.flatMap(({ words: ids }) => ids));
        const selected = useSelectionStore.getState().selectedWordId;
        const index = Math.max(0, words.indexOf(selected ?? words[0] ?? ""));
        const id = words[Math.max(0, Math.min(words.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)))];
        if (id !== undefined) {
          selectWord(id);
          void window.guyditor.call<{ frame: { frames: number; fps: string } }>(
            "OperationEngine",
            "resolveNavigation",
            { target: { kind: "word", wordId: id } },
          ).then(({ frame }) => setPlayhead(frame)).catch(() => undefined);
        }
      } else if (event.key.toLowerCase() === "a" && annotations.length > 0) {
        event.preventDefault();
        const selected = useSelectionStore.getState().selectedAnnotationId;
        const index = Math.max(0, annotations.findIndex(({ id }) => id === selected));
        const next = annotations[(index + (event.shiftKey ? -1 : 1) + annotations.length) % annotations.length];
        if (next !== undefined) selectAnnotation(next.id);
      } else if (/^[1-9]$/u.test(event.key) &&
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const id = (["media", "preview", "transcript", "inspector", "agent", "timeline", "status", "graphics", "publish"] as PanelId[])[Number(event.key) - 1];
        if (id !== undefined) {
          revealPanel(id);
        }
      } else if (event.key.toLowerCase() === "q") {
        setNotice("HQ preview is an M2 mode; M1 remains on the proxy leg.");
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [annotations, playhead, playing, refreshProject, selectAnnotation, selectWord, setPlayhead, setPlaying, snapshot, transcripts]);

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
      useUndoStore.getState().clear();
      await hydrate(opened);
      setPlayhead({ frames: 0, fps: opened.master.settings.timeline.fps });
      setNotice(`Opened ${opened.projectPath}`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  const panelProps: WorkspacePanelProps = {
    snapshot,
    transcripts,
    annotations,
    proposals,
    skills,
    pinnedSkills,
    skillDrafts,
    restylePlan,
    exportReport,
    refreshProject,
    refreshAnnotations,
    refreshProposals,
    refreshSkills,
    refreshRestylePlan,
    refreshExportReport,
    setNotice,
  };
  const dockPanels: Record<DockPanelId, React.ReactNode> = {
    media: <MediaBrowserPanel {...panelProps} />,
    broll: <BrollPanel {...panelProps} />,
    graphics: <GraphicsPanel {...panelProps} />,
    skills: <SkillsPanel {...panelProps} />,
    storage: <StoragePanel setNotice={setNotice} />,
    preview: <PreviewPanel {...panelProps} />,
    transcript: <TranscriptPanel {...panelProps} />,
    inspector: <InspectorPanel {...panelProps} />,
    agent: <ProposalPanel {...panelProps} />,
    timeline: <TimelinePanel {...panelProps} />,
    status: <StatusStripPanel {...panelProps} />,
    publish: <PublishPanel {...panelProps} />,
  };

  return (
    <main className="shell workspace-shell">
      <header className="titlebar">
        <div className="wordmark" aria-label="Guyditor">
          <span className="wordmark-glyph" aria-hidden="true">G</span>
          <span>GUYDITOR</span>
        </div>
        <div className="project-identity">
          <strong>{snapshot?.master.project.name ?? "No project open"}</strong>
          <span data-testid="revision-indicator">{snapshot?.revision ?? "— no revision"}</span>
        </div>
        <div className="title-actions">
          <GlobalProgress refreshOverview={refreshOverview} setNotice={setNotice} />
          <button type="button" data-testid="undo-action" disabled={undoCount === 0} onClick={() => void undoLast().then(() => refreshProject()).catch((error: unknown) => setNotice(errorMessage(error)))}>Undo</button>
          <button type="button" data-testid="redo-action" disabled={redoCount === 0} onClick={() => void redoLast().then(() => refreshProject()).catch((error: unknown) => setNotice(errorMessage(error)))}>Redo</button>
          <button type="button" data-testid="reset-layout" onClick={resetLayout}>Reset layout</button>
          <button type="button" data-testid="reset-all-layouts" onClick={resetAllLayouts}>Reset all tabs</button>
          <button type="button" className="open-button" onClick={() => void openProject()} data-testid="open-project">Open project</button>
        </div>
      </header>
      <WorkflowPhaseTabs setNotice={setNotice} />
      <DockWorkspace panels={dockPanels} />
      <p className="global-notice" role="status" data-testid="shell-status">{notice}</p>
    </main>
  );
}
