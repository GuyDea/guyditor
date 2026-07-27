import { useCallback, useEffect, useRef, useState } from "react";

import type {
  Annotation,
  Proposal,
  RestylePlan,
  TransactionRecord,
} from "../../../core/src/index.js";
import type { ExportReport } from "../../../render/src/index.js";
import type { TranscriptSidecar } from "../../../transcript/src/index.js";
import type { ResolvedSkill, SkillManifest } from "../../../agent/src/index.js";
import type { JobOverview, JobStatus, ProjectSnapshot } from "../shared/ipc.js";
import { DockWorkspace } from "./DockWorkspace.js";
import { GlobalProgress } from "./GlobalProgress.js";
import { GuidedTour } from "./GuidedTour.js";
import { MasterToolRail } from "./MasterToolRail.js";
import { WelcomeSurface } from "./WelcomeSurface.js";
import { WorkflowPhaseTabs } from "./WorkflowPhaseTabs.js";
import { BrollPanel } from "./panels/BrollPanel.js";
import { GraphicsPanel } from "./panels/GraphicsPanel.js";
import { HelpPanel } from "./panels/HelpPanel.js";
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
  applyOnboardingSignal as reduceOnboardingSignal,
  dismissWelcome,
  loadOnboardingState,
  saveOnboardingState,
  shouldShowWelcome,
} from "./state/onboarding.js";
import type {
  OnboardingSignal,
  OnboardingState,
} from "./state/onboarding.js";
import {
  usePreviewStore,
  useSelectionStore,
  useWorkspaceStore,
} from "./state/view-state.js";
import type { PanelId } from "./state/view-state.js";
import type { DockPanelId } from "./state/layout-state.js";
import {
  beginContextRequest,
  createContextRequestGate,
  invalidateContextRequests,
  isContextRequestCurrent,
} from "./state/async-context.js";
import {
  createRestyleContext,
  keyRestylePlan,
  restylePlanForContext,
} from "./state/restyle-context.js";
import type {
  KeyedRestylePlan,
  RestyleContext,
} from "./state/restyle-context.js";
import { resolveActiveDeliverable } from "./active-deliverable.js";
import { phaseForShortcut } from "./workflow-phases.js";
import { revealPanel } from "./workspace-navigation.js";

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLElement && target.isContentEditable;
}

const OVERVIEW_CONFIRMATION_POLL_MS = 2_000;

function activeRestyleContext(
  snapshot: ProjectSnapshot | null,
  selectedDeliverableId: string | null,
): RestyleContext | null {
  if (snapshot === null) return null;
  try {
    const deliverable = resolveActiveDeliverable(
      snapshot.master,
      selectedDeliverableId,
    );
    return createRestyleContext(
      snapshot.projectPath,
      deliverable.id,
      deliverable.sequenceId,
    );
  } catch {
    return null;
  }
}

export function App(): React.JSX.Element {
  const snapshot = useProjectMirror((state) => state.snapshot);
  const replaceSnapshot = useProjectMirror((state) => state.replace);
  const [onboarding, setOnboarding] = useState<OnboardingState>(
    () => loadOnboardingState(window.localStorage),
  );
  const [welcomeOpen, setWelcomeOpen] = useState(
    () => shouldShowWelcome(window.localStorage),
  );
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStop, setTourStop] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptSidecar[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [pinnedSkills, setPinnedSkills] = useState<ResolvedSkill[]>([]);
  const [skillDrafts, setSkillDrafts] = useState<ResolvedSkill[]>([]);
  const [restylePlanState, setRestylePlanState] =
    useState<KeyedRestylePlan | null>(null);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [notice, setNotice] = useState("Open a project directory to connect the edit journal.");
  const overviewGeneration = useRef(0);
  const annotationGeneration = useRef(0);
  const restylePlanGate = useRef(createContextRequestGate());
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
  const selectedDeliverableId = useSelectionStore(
    (state) => state.selectedDeliverableId,
  );
  const undoCount = useUndoStore((state) => state.undo.length);
  const redoCount = useUndoStore((state) => state.redo.length);
  const restyleContext = activeRestyleContext(snapshot, selectedDeliverableId);
  const restylePlan = restylePlanForContext(restylePlanState, restyleContext);

  const applyChecklistSignal = useCallback((signal: OnboardingSignal): void => {
    setOnboarding((current) => {
      const next = reduceOnboardingSignal(current, signal);
      try {
        saveOnboardingState(window.localStorage, next);
      } catch {
        // Persistence failure does not interrupt the live onboarding surface.
      }
      return next;
    });
  }, []);

  const updateOnboarding = useCallback((
    update: (current: OnboardingState) => OnboardingState,
  ): void => {
    setOnboarding((current) => {
      const next = update(current);
      try {
        saveOnboardingState(window.localStorage, next);
      } catch {
        // Keep the renderer state usable if Chromium storage is unavailable.
      }
      return next;
    });
  }, []);

  const rememberWelcomeDismissal = useCallback((): void => {
    try {
      dismissWelcome(window.localStorage);
      setOnboarding(loadOnboardingState(window.localStorage));
    } catch {
      setOnboarding((current) => ({ ...current, welcomeDismissed: true }));
    }
    setWelcomeOpen(false);
  }, []);

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
      const report = await window.guyditor.call<ExportReport | null>(
        "RenderService",
        "exportReport",
        {},
      );
      setExportReport(report);
      applyChecklistSignal({ kind: "export.report", exists: report !== null });
    } catch {
      setExportReport(null);
    }
  }, [applyChecklistSignal]);

  const refreshRestylePlan = useCallback(async (): Promise<void> => {
    const context = activeRestyleContext(
      useProjectMirror.getState().snapshot,
      useSelectionStore.getState().selectedDeliverableId,
    );
    if (context === null) {
      invalidateContextRequests(restylePlanGate.current);
      setRestylePlanState(null);
      return;
    }
    const request = beginContextRequest(restylePlanGate.current, context.key);
    try {
      const next = await window.guyditor.call<RestylePlan | null>(
        "DeliverableService",
        "restylePlan",
        { deliverableId: context.deliverableId },
      );
      const current = activeRestyleContext(
        useProjectMirror.getState().snapshot,
        useSelectionStore.getState().selectedDeliverableId,
      );
      if (isContextRequestCurrent(
        restylePlanGate.current,
        request,
        current?.key ?? null,
      )) {
        setRestylePlanState(keyRestylePlan(context, next));
      }
    } catch {
      const current = activeRestyleContext(
        useProjectMirror.getState().snapshot,
        useSelectionStore.getState().selectedDeliverableId,
      );
      if (isContextRequestCurrent(
        restylePlanGate.current,
        request,
        current?.key ?? null,
      )) {
        setRestylePlanState(keyRestylePlan(context, null));
      }
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
    const [nextTranscripts, nextJobs, nextOverview, nextHistory] = await Promise.all([
      window.guyditor.call<TranscriptSidecar[]>("ProjectStore", "readTranscript", {})
        .catch(() => []),
      window.guyditor.call<JobStatus[]>("JobQueue", "list", {}).catch(() => []),
      window.guyditor.call<JobOverview>("JobQueue", "overview", {}).catch(() => null),
      window.guyditor.call<TransactionRecord[]>("ProjectStore", "listHistory", {})
        .catch(() => []),
    ]);
    setTranscripts(nextTranscripts);
    replaceJobs(nextJobs);
    applyChecklistSignal({ kind: "project.opened" });
    applyChecklistSignal({
      kind: "transcript.registered",
      count: nextTranscripts.length,
    });
    applyChecklistSignal({
      kind: "project.history",
      transactions: nextHistory,
    });
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
  }, [applyChecklistSignal, refreshAnnotations, refreshExportReport, refreshProposals, refreshRestylePlan, refreshSkills, replaceJobs, replaceOverview, replaceSnapshot]);

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
        applyChecklistSignal({ kind: "job.done", jobKind: event.job.kind });
        void refreshProject();
      }
      if (event.job.state === "done" && event.job.kind === "transcribe") {
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
      applyChecklistSignal({
        kind: "watcher.ingested",
        assetCount: event.assetIds.length,
      });
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
  }, [applyChecklistSignal, applyJobEvent, hydrate, refreshAnnotations, refreshExportReport, refreshOverview, refreshProject, refreshProposals, refreshRestylePlan, replaceJobs]);

  useEffect(() => {
    if (snapshot === null) return undefined;
    const interval = window.setInterval(() => {
      void refreshOverview();
    }, OVERVIEW_CONFIRMATION_POLL_MS);
    return () => window.clearInterval(interval);
  }, [refreshOverview, snapshot]);

  useEffect(() => {
    void refreshRestylePlan();
  }, [refreshRestylePlan, restyleContext?.key, restyleContext?.sequenceId]);

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

  async function openProject(): Promise<boolean> {
    setNotice("Waiting for a project directory…");
    try {
      const opened = await window.guyditor.call<ProjectSnapshot | null>(
        "ProjectStore",
        "openDialog",
        {},
      );
      if (opened === null) {
        setNotice("Project open cancelled.");
        return false;
      }
      useUndoStore.getState().clear();
      await hydrate(opened);
      setPlayhead({ frames: 0, fps: opened.master.settings.timeline.fps });
      setNotice(`Opened ${opened.projectPath}`);
      return true;
    } catch (error: unknown) {
      setNotice(errorMessage(error));
      return false;
    }
  }

  async function createProject(): Promise<boolean> {
    setNotice("Choose an empty directory for the new project…");
    try {
      const created = await window.guyditor.call<ProjectSnapshot | null>(
        "ProjectStore",
        "createDialog",
        {},
      );
      if (created === null) {
        setNotice("Project creation cancelled.");
        return false;
      }
      useUndoStore.getState().clear();
      await hydrate(created);
      setPlayhead({ frames: 0, fps: created.master.settings.timeline.fps });
      setNotice(`Created ${created.projectPath}`);
      return true;
    } catch (error: unknown) {
      setNotice(errorMessage(error));
      return false;
    }
  }

  async function welcomeProjectAction(action: "create" | "open"): Promise<void> {
    const completed = await (action === "create" ? createProject() : openProject());
    if (completed) rememberWelcomeDismissal();
  }

  function beginTour(): void {
    rememberWelcomeDismissal();
    setTourOpen(true);
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
    onProposalResolved: (status) => applyChecklistSignal({
      kind: "proposal.resolved",
      status,
    }),
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
    help: (
      <HelpPanel
        onboarding={onboarding}
        onChecklistDismissedChange={(checklistDismissed) => {
          updateOnboarding((current) => ({ ...current, checklistDismissed }));
        }}
        onRestartTour={() => setTourOpen(true)}
        onShowWelcome={() => setWelcomeOpen(true)}
      />
    ),
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
          <GlobalProgress
            forceOpen={tourStop === "global-progress"}
            refreshOverview={refreshOverview}
            setNotice={setNotice}
          />
          <button type="button" data-testid="undo-action" disabled={undoCount === 0} onClick={() => void undoLast().then(() => refreshProject()).catch((error: unknown) => setNotice(errorMessage(error)))}>Undo</button>
          <button type="button" data-testid="redo-action" disabled={redoCount === 0} onClick={() => void redoLast().then(() => refreshProject()).catch((error: unknown) => setNotice(errorMessage(error)))}>Redo</button>
          <button type="button" data-testid="reset-layout" onClick={resetLayout}>Reset layout</button>
          <button type="button" data-testid="reset-all-layouts" onClick={resetAllLayouts}>Reset all tabs</button>
          <button
            type="button"
            className="help-button"
            aria-label="Open Help"
            title="Help & manual"
            data-testid="title-help"
            onClick={() => revealPanel("help")}
          >?</button>
          <button type="button" className="open-button" onClick={() => void openProject()} data-testid="open-project">Open project</button>
        </div>
      </header>
      <WorkflowPhaseTabs setNotice={setNotice} />
      <div className="workspace-main">
        <MasterToolRail />
        <DockWorkspace panels={dockPanels} />
      </div>
      <p className="global-notice" role="status" data-testid="shell-status">
        {snapshot === null ? "Open a project to begin" : notice}
      </p>
      {welcomeOpen ? (
        <WelcomeSurface
          onCreateProject={() => welcomeProjectAction("create")}
          onOpenProject={() => welcomeProjectAction("open")}
          onSkip={rememberWelcomeDismissal}
          onTakeTour={beginTour}
        />
      ) : null}
      {tourOpen ? (
        <GuidedTour
          onFinish={() => {
            setTourOpen(false);
            setTourStop(null);
          }}
          onStopChange={setTourStop}
        />
      ) : null}
    </main>
  );
}
