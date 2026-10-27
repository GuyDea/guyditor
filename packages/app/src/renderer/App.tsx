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
import type {
  JobOverview,
  JobStatus,
  LoadedProjectWorkspaceState,
  ProjectSnapshot,
} from "../shared/ipc.js";
import { DockWorkspace } from "./DockWorkspace.js";
import { GlobalProgress } from "./GlobalProgress.js";
import { GuidedTour } from "./GuidedTour.js";
import { MasterToolRail } from "./MasterToolRail.js";
import { WelcomeSurface } from "./WelcomeSurface.js";
import { WorkflowPhaseTabs } from "./WorkflowPhaseTabs.js";
import { AssemblePanel } from "./panels/AssemblePanel.js";
import { BrollPanel } from "./panels/BrollPanel.js";
import { GraphicsPanel } from "./panels/GraphicsPanel.js";
import { HelpPanel } from "./panels/HelpPanel.js";
import {
  errorMessage,
  getSnapshot,
  getWorkspaceState,
  redoLast,
  setActiveDeliverable,
  undoLast,
} from "./ipc.js";
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
  welcomeVisible,
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
  claimContextResponse,
  createContextRequestGate,
  invalidateContextRequests,
  isContextRequestCurrent,
  isContextRequestLatest,
} from "./state/async-context.js";
import type { ContextRequest } from "./state/async-context.js";
import {
  deliverableNavigationContextKey,
  nextCycledId,
  projectSnapshotContextKey,
} from "./state/project-context.js";
import {
  createRestyleContext,
  keyRestylePlan,
  restylePlanContractError,
  restylePlanForContext,
} from "./state/restyle-context.js";
import type {
  KeyedRestylePlan,
  RestyleContext,
} from "./state/restyle-context.js";
import {
  applyDeliverableSelection,
  resolveActiveDeliverable,
} from "./active-deliverable.js";
import { useAnnotationTimelineFrames } from "./annotation-timeline.js";
import { phaseForShortcut } from "./workflow-phases.js";
import { revealPanel } from "./workspace-navigation.js";

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLElement && target.isContentEditable;
}

const OVERVIEW_CONFIRMATION_POLL_MS = 2_000;

interface HydrationResult {
  applied: boolean;
  warning?: string;
}

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
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStop, setTourStop] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptSidecar[]>([]);
  const [assemblyVersion, setAssemblyVersion] = useState(0);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [pinnedSkills, setPinnedSkills] = useState<ResolvedSkill[]>([]);
  const [skillDrafts, setSkillDrafts] = useState<ResolvedSkill[]>([]);
  const [restylePlanState, setRestylePlanState] =
    useState<KeyedRestylePlan | null>(null);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [notice, setNotice] = useState("Open a project directory to connect the edit journal.");
  const projectLoadGate = useRef(createContextRequestGate());
  const jobsGate = useRef(createContextRequestGate());
  const overviewGate = useRef(createContextRequestGate());
  const annotationGate = useRef(createContextRequestGate());
  const proposalGate = useRef(createContextRequestGate());
  const skillGate = useRef(createContextRequestGate());
  const exportReportGate = useRef(createContextRequestGate());
  const restylePlanGate = useRef(createContextRequestGate());
  const wordNavigationGate = useRef(createContextRequestGate());
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
  const annotationDeliverable = snapshot === null
    ? undefined
    : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
  const annotationTimelineFrames = useAnnotationTimelineFrames(
    annotations,
    snapshot?.projectPath,
    annotationDeliverable?.sequenceId,
    snapshot?.master.settings.timeline.fps ?? "24/1",
    snapshot?.revision,
  );
  const restylePlan = restylePlanForContext(restylePlanState, restyleContext);
  const currentRestyleContextKey = useRef(restyleContext?.key ?? null);
  if (currentRestyleContextKey.current !== (restyleContext?.key ?? null)) {
    invalidateContextRequests(restylePlanGate.current);
  }
  currentRestyleContextKey.current = restyleContext?.key ?? null;

  const beginProjectLoad = useCallback((): ContextRequest => {
    invalidateContextRequests(jobsGate.current);
    invalidateContextRequests(overviewGate.current);
    invalidateContextRequests(annotationGate.current);
    invalidateContextRequests(proposalGate.current);
    invalidateContextRequests(skillGate.current);
    invalidateContextRequests(exportReportGate.current);
    invalidateContextRequests(restylePlanGate.current);
    invalidateContextRequests(wordNavigationGate.current);
    return beginContextRequest(projectLoadGate.current, "project-load");
  }, []);

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
    const contextKey = projectSnapshotContextKey(
      useProjectMirror.getState().snapshot,
    );
    if (contextKey === null) {
      invalidateContextRequests(annotationGate.current);
      setAnnotations([]);
      return;
    }
    const request = beginContextRequest(annotationGate.current, contextKey);
    try {
      const next = await window.guyditor.call<Annotation[]>("AnnotationService", "list", {});
      if (isContextRequestCurrent(
        annotationGate.current,
        request,
        projectSnapshotContextKey(useProjectMirror.getState().snapshot),
      )) {
        setAnnotations(next);
      }
    } catch {
      if (isContextRequestCurrent(
        annotationGate.current,
        request,
        projectSnapshotContextKey(useProjectMirror.getState().snapshot),
      )) {
        setAnnotations([]);
      }
    }
  }, []);

  const refreshProposals = useCallback(async (): Promise<void> => {
    const contextKey = projectSnapshotContextKey(
      useProjectMirror.getState().snapshot,
    );
    if (contextKey === null) {
      invalidateContextRequests(proposalGate.current);
      setProposals([]);
      return;
    }
    const request = beginContextRequest(proposalGate.current, contextKey);
    try {
      const next = await window.guyditor.call<Proposal[]>(
        "ProjectStore",
        "listProposals",
        {},
      );
      if (isContextRequestCurrent(
        proposalGate.current,
        request,
        projectSnapshotContextKey(useProjectMirror.getState().snapshot),
      )) {
        setProposals(next);
      }
    } catch {
      if (isContextRequestCurrent(
        proposalGate.current,
        request,
        projectSnapshotContextKey(useProjectMirror.getState().snapshot),
      )) {
        setProposals([]);
      }
    }
  }, []);

  const refreshSkills = useCallback(async (): Promise<void> => {
    const contextKey = projectSnapshotContextKey(
      useProjectMirror.getState().snapshot,
    );
    if (contextKey === null) {
      invalidateContextRequests(skillGate.current);
      setSkills([]);
      setPinnedSkills([]);
      setSkillDrafts([]);
      return;
    }
    const request = beginContextRequest(skillGate.current, contextKey);
    try {
      const [library, pinned, drafts] = await Promise.all([
        window.guyditor.call<SkillManifest[]>("SkillRegistry", "list", { scope: "global" }),
        window.guyditor.call<ResolvedSkill[]>("SkillRegistry", "pinned", {}),
        window.guyditor.call<ResolvedSkill[]>("SkillRegistry", "drafts", {}),
      ]);
      if (isContextRequestCurrent(
        skillGate.current,
        request,
        projectSnapshotContextKey(useProjectMirror.getState().snapshot),
      )) {
        setSkills(library);
        setPinnedSkills(pinned);
        setSkillDrafts(drafts);
      }
    } catch {
      if (isContextRequestCurrent(
        skillGate.current,
        request,
        projectSnapshotContextKey(useProjectMirror.getState().snapshot),
      )) {
        setSkills([]);
        setPinnedSkills([]);
        setSkillDrafts([]);
      }
    }
  }, []);

  const refreshExportReport = useCallback(async (): Promise<void> => {
    const contextKey = projectSnapshotContextKey(
      useProjectMirror.getState().snapshot,
    );
    if (contextKey === null) {
      invalidateContextRequests(exportReportGate.current);
      setExportReport(null);
      return;
    }
    const request = beginContextRequest(exportReportGate.current, contextKey);
    try {
      const report = await window.guyditor.call<ExportReport | null>(
        "RenderService",
        "exportReport",
        {},
      );
      if (isContextRequestCurrent(
        exportReportGate.current,
        request,
        projectSnapshotContextKey(useProjectMirror.getState().snapshot),
      )) {
        setExportReport(report);
        applyChecklistSignal({ kind: "export.report", exists: report !== null });
      }
    } catch {
      if (isContextRequestCurrent(
        exportReportGate.current,
        request,
        projectSnapshotContextKey(useProjectMirror.getState().snapshot),
      )) {
        setExportReport(null);
      }
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
        if (next !== null) {
          const contractError = restylePlanContractError(next, context);
          if (contractError !== null) {
            setRestylePlanState(keyRestylePlan(context, null));
            setNotice(contractError);
            return;
          }
        }
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

  useEffect(() => () => {
    invalidateContextRequests(restylePlanGate.current);
  }, []);

  const refreshOverview = useCallback(async (): Promise<void> => {
    const contextKey = projectSnapshotContextKey(
      useProjectMirror.getState().snapshot,
    );
    if (contextKey === null) {
      invalidateContextRequests(overviewGate.current);
      return;
    }
    const request = beginContextRequest(overviewGate.current, contextKey);
    try {
      const next = await window.guyditor.call<JobOverview>("JobQueue", "overview", {});
      if (isContextRequestCurrent(
        overviewGate.current,
        request,
        projectSnapshotContextKey(useProjectMirror.getState().snapshot),
      )) {
        replaceOverview(next);
      }
    } catch {
      // Keep the most recent re-queryable snapshot during project transitions.
    }
  }, [replaceOverview]);

  const hydrate = useCallback(async (
    initial: ProjectSnapshot,
    loadRequest: ContextRequest,
  ): Promise<HydrationResult> => {
    let next = initial;
    let retainedWarning: string | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!isContextRequestLatest(projectLoadGate.current, loadRequest)) {
        return { applied: false };
      }

      const previous = useProjectMirror.getState().snapshot;
      const projectChanged = previous?.projectPath !== next.projectPath;
      let requestedDeliverableId =
        useSelectionStore.getState().selectedDeliverableId;

      if (projectChanged) {
        let loaded: LoadedProjectWorkspaceState;
        try {
          loaded = await getWorkspaceState(next.projectPath);
        } catch (error: unknown) {
          loaded = {
            state: {
              format: "guyditor.workspace/v1",
              activeDeliverableId: next.master.settings.primaryDeliverable,
            },
            warning:
              `Could not load workspace selection; using primary deliverable: ${errorMessage(error)}`,
          };
        }
        if (!isContextRequestLatest(projectLoadGate.current, loadRequest)) {
          return { applied: false };
        }

        const confirmed = await getSnapshot();
        if (!isContextRequestLatest(projectLoadGate.current, loadRequest) ||
            confirmed.projectPath !== next.projectPath) {
          return { applied: false };
        }
        next = confirmed;
        requestedDeliverableId = loaded.state.activeDeliverableId;
        retainedWarning = loaded.warning ?? retainedWarning;
      }

      const active = resolveActiveDeliverable(
        next.master,
        requestedDeliverableId,
      );
      if (!isContextRequestLatest(projectLoadGate.current, loadRequest)) {
        return { applied: false };
      }

      const contextKey = projectSnapshotContextKey(next);
      if (contextKey === null) return { applied: false };
      const planContext = activeRestyleContext(next, active.id);
      const jobsRequest = beginContextRequest(jobsGate.current, contextKey);
      const overviewRequest = beginContextRequest(
        overviewGate.current,
        contextKey,
      );
      const annotationRequest = beginContextRequest(
        annotationGate.current,
        contextKey,
      );
      const proposalRequest = beginContextRequest(
        proposalGate.current,
        contextKey,
      );
      const skillRequest = beginContextRequest(skillGate.current, contextKey);
      const exportRequest = beginContextRequest(
        exportReportGate.current,
        contextKey,
      );
      const planRequest = planContext === null
        ? null
        : beginContextRequest(restylePlanGate.current, planContext.key);

      const [
        nextTranscripts,
        nextJobs,
        nextOverview,
        nextHistory,
        nextAnnotations,
        nextProposals,
        nextSkills,
        nextExportReport,
        nextRestylePlan,
      ] = await Promise.all([
        window.guyditor.call<TranscriptSidecar[]>(
          "ProjectStore",
          "readTranscript",
          {},
        ).catch(() => []),
        window.guyditor.call<JobStatus[]>("JobQueue", "list", {})
          .catch(() => []),
        window.guyditor.call<JobOverview>("JobQueue", "overview", {})
          .catch(() => null),
        window.guyditor.call<TransactionRecord[]>(
          "ProjectStore",
          "listHistory",
          {},
        ).catch(() => []),
        window.guyditor.call<Annotation[]>(
          "AnnotationService",
          "list",
          {},
        ).catch(() => []),
        window.guyditor.call<Proposal[]>(
          "ProjectStore",
          "listProposals",
          {},
        ).catch(() => []),
        Promise.all([
          window.guyditor.call<SkillManifest[]>(
            "SkillRegistry",
            "list",
            { scope: "global" },
          ),
          window.guyditor.call<ResolvedSkill[]>(
            "SkillRegistry",
            "pinned",
            {},
          ),
          window.guyditor.call<ResolvedSkill[]>(
            "SkillRegistry",
            "drafts",
            {},
          ),
        ]).then(([library, pinned, drafts]) => ({ library, pinned, drafts }))
          .catch(() => ({
            library: [] as SkillManifest[],
            pinned: [] as ResolvedSkill[],
            drafts: [] as ResolvedSkill[],
          })),
        window.guyditor.call<ExportReport | null>(
          "RenderService",
          "exportReport",
          {},
        ).catch(() => null),
        planContext === null
          ? Promise.resolve(null)
          : window.guyditor.call<RestylePlan | null>(
              "DeliverableService",
              "restylePlan",
              { deliverableId: planContext.deliverableId },
            ).catch(() => null),
      ]);

      if (!isContextRequestLatest(projectLoadGate.current, loadRequest)) {
        return { applied: false };
      }
      const confirmed = await getSnapshot();
      if (!isContextRequestLatest(projectLoadGate.current, loadRequest)) {
        return { applied: false };
      }
      if (confirmed.projectPath !== next.projectPath) {
        return { applied: false };
      }
      if (projectSnapshotContextKey(confirmed) !== contextKey) {
        next = confirmed;
        continue;
      }

      if (!projectChanged && active.id !== requestedDeliverableId) {
        try {
          await setActiveDeliverable(next.projectPath, active.id);
        } catch (error: unknown) {
          retainedWarning =
            `Active deliverable was removed; using ${active.name}, but workspace autosave failed: ${errorMessage(error)}`;
        }
        if (!isContextRequestLatest(projectLoadGate.current, loadRequest)) {
          return { applied: false };
        }
        const afterAutosave = await getSnapshot();
        if (!isContextRequestLatest(projectLoadGate.current, loadRequest) ||
            afterAutosave.projectPath !== next.projectPath) {
          return { applied: false };
        }
        if (projectSnapshotContextKey(afterAutosave) !== contextKey) {
          next = afterAutosave;
          continue;
        }
      }

      if (projectChanged) {
        useWorkspaceStore.getState().setProjectKey(next.projectPath);
      }
      replaceSnapshot(next);
      if (projectChanged || active.id !== requestedDeliverableId) {
        applyDeliverableSelection(next.master, active.id);
      }

      setTranscripts(nextTranscripts);
      if (claimContextResponse(
        jobsGate.current,
        jobsRequest,
        contextKey,
      )) {
        replaceJobs(nextJobs);
      }
      applyChecklistSignal({ kind: "project.opened" });
      applyChecklistSignal({
        kind: "transcript.registered",
        count: nextTranscripts.length,
      });
      applyChecklistSignal({
        kind: "project.history",
        transactions: nextHistory,
      });
      if (nextOverview !== null && claimContextResponse(
        overviewGate.current,
        overviewRequest,
        contextKey,
      )) {
        replaceOverview(nextOverview);
      }
      if (claimContextResponse(
        annotationGate.current,
        annotationRequest,
        contextKey,
      )) {
        setAnnotations(nextAnnotations);
      }
      if (claimContextResponse(
        proposalGate.current,
        proposalRequest,
        contextKey,
      )) {
        setProposals(nextProposals);
      }
      if (claimContextResponse(
        skillGate.current,
        skillRequest,
        contextKey,
      )) {
        setSkills(nextSkills.library);
        setPinnedSkills(nextSkills.pinned);
        setSkillDrafts(nextSkills.drafts);
      }
      if (claimContextResponse(
        exportReportGate.current,
        exportRequest,
        contextKey,
      )) {
        setExportReport(nextExportReport);
        applyChecklistSignal({
          kind: "export.report",
          exists: nextExportReport !== null,
        });
      }
      if (planContext !== null && planRequest !== null &&
          activeRestyleContext(
            useProjectMirror.getState().snapshot,
            useSelectionStore.getState().selectedDeliverableId,
          )?.key === planContext.key &&
          claimContextResponse(
            restylePlanGate.current,
            planRequest,
            planContext.key,
          )) {
        if (nextRestylePlan !== null) {
          const contractError = restylePlanContractError(
            nextRestylePlan,
            planContext,
          );
          if (contractError !== null) {
            setRestylePlanState(keyRestylePlan(planContext, null));
            retainedWarning ??= contractError;
          } else {
            setRestylePlanState(keyRestylePlan(
              planContext,
              nextRestylePlan,
            ));
          }
        } else {
          setRestylePlanState(keyRestylePlan(planContext, null));
        }
      }
      return {
        applied: true,
        ...(retainedWarning === undefined
          ? {}
          : { warning: retainedWarning }),
      };
    }

    return { applied: false };
  }, [applyChecklistSignal, replaceJobs, replaceOverview, replaceSnapshot]);

  const refreshProject = useCallback(async (
    successNotice?: string,
  ): Promise<void> => {
    const request = beginProjectLoad();
    try {
      const next = await getSnapshot();
      if (!isContextRequestLatest(projectLoadGate.current, request)) return;
      const result = await hydrate(next, request);
      if (!result.applied) return;
      if (result.warning !== undefined) setNotice(result.warning);
      else if (successNotice !== undefined) setNotice(successNotice);
    } catch (error: unknown) {
      if (isContextRequestLatest(projectLoadGate.current, request)) {
        throw error;
      }
    }
  }, [beginProjectLoad, hydrate]);

  useEffect(() => {
    let active = true;
    const request = beginProjectLoad();
    void getSnapshot().then(async (opened) => {
      if (!active ||
          !isContextRequestLatest(projectLoadGate.current, request)) {
        return;
      }
      const result = await hydrate(opened, request);
      if (active && result.applied && result.warning !== undefined) {
        setNotice(result.warning);
      }
    }).catch(() => undefined).finally(() => setSnapshotLoaded(true));
    const offState = window.guyditor.on("job.state", (event) => {
      const contextKey = projectSnapshotContextKey(
        useProjectMirror.getState().snapshot,
      );
      if (contextKey !== null) {
        beginContextRequest(jobsGate.current, contextKey);
      }
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
      if (event.job.kind === "assembly.prepare") {
        void refreshProject();
      }
      if (event.job.kind === "restyle.generate") {
        void Promise.all([refreshProposals(), refreshRestylePlan()]);
      }
    });
    const offProgress = window.guyditor.on("job.progress", (event) => {
      const contextKey = projectSnapshotContextKey(
        useProjectMirror.getState().snapshot,
      );
      if (contextKey !== null) {
        beginContextRequest(jobsGate.current, contextKey);
      }
      applyJobEvent(event);
      void refreshOverview();
    });
    const offRevision = window.guyditor.on("project.revision", (event) => {
      void refreshProject(`Accepted ${event.revision}`)
        .catch((error: unknown) => setNotice(errorMessage(error)));
    });
    const offProposal = window.guyditor.on("proposal.updated", () => {
      void Promise.all([refreshProposals(), refreshOverview()]);
    });
    const offAssembly = window.guyditor.on("assembly.updated", () => {
      setAssemblyVersion((version) => version + 1);
    });
    const offAnnotation = window.guyditor.on("annotation.updated", () => {
      void Promise.all([refreshAnnotations(), refreshOverview()]);
    });
    const offWatcher = window.guyditor.on("watcher.ingested", (event) => {
      applyChecklistSignal({
        kind: "watcher.ingested",
        assetCount: event.assetIds.length,
      });
      const successNotice =
        `Capture watcher ingested ${String(event.assetIds.length)} asset${event.assetIds.length === 1 ? "" : "s"}.`;
      void Promise.all([
        refreshProject(successNotice),
        refreshOverview(),
      ]).catch((error: unknown) => setNotice(errorMessage(error)));
    });
    return () => {
      active = false;
      invalidateContextRequests(projectLoadGate.current);
      invalidateContextRequests(jobsGate.current);
      invalidateContextRequests(overviewGate.current);
      invalidateContextRequests(annotationGate.current);
      invalidateContextRequests(proposalGate.current);
      invalidateContextRequests(skillGate.current);
      invalidateContextRequests(exportReportGate.current);
      invalidateContextRequests(wordNavigationGate.current);
      offState();
      offProgress();
      offRevision();
      offProposal();
      offAssembly();
      offAnnotation();
      offWatcher();
    };
  }, [applyChecklistSignal, applyJobEvent, beginProjectLoad, hydrate, refreshAnnotations, refreshExportReport, refreshOverview, refreshProject, refreshProposals, refreshRestylePlan]);

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
        const currentSnapshot = useProjectMirror.getState().snapshot;
        const activeDeliverable = currentSnapshot === null
          ? null
          : resolveActiveDeliverable(
              currentSnapshot.master,
              useSelectionStore.getState().selectedDeliverableId,
            );
        if (id !== undefined &&
            currentSnapshot !== null &&
            activeDeliverable !== null) {
          const contextKey = deliverableNavigationContextKey(
            currentSnapshot,
            activeDeliverable.id,
            activeDeliverable.sequenceId,
            selected,
          );
          const request = beginContextRequest(
            wordNavigationGate.current,
            contextKey,
          );
          void window.guyditor.call<{
            frame: { frames: number; fps: string };
          }>(
            "OperationEngine",
            "resolveNavigation",
            {
              target: { kind: "word", wordId: id },
              scope: activeDeliverable.sequenceId,
            },
          ).then(({ frame }) => {
            const latestSnapshot = useProjectMirror.getState().snapshot;
            if (latestSnapshot === null) return;
            const latestDeliverable = resolveActiveDeliverable(
              latestSnapshot.master,
              useSelectionStore.getState().selectedDeliverableId,
            );
            const latestContextKey = deliverableNavigationContextKey(
              latestSnapshot,
              latestDeliverable.id,
              latestDeliverable.sequenceId,
              useSelectionStore.getState().selectedWordId,
            );
            if (!isContextRequestCurrent(
              wordNavigationGate.current,
              request,
              latestContextKey,
            )) {
              return;
            }
            selectWord(id);
            setPlayhead(frame);
          }).catch(() => undefined);
        }
      } else if (event.key.toLowerCase() === "a") {
        const activeDeliverable = snapshot === null
          ? undefined
          : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
        const activeAnnotations = annotations.filter(
          ({ canvasRef }) =>
            canvasRef.sequenceId === activeDeliverable?.sequenceId,
        );
        if (activeAnnotations.length === 0) return;
        event.preventDefault();
        const selected = useSelectionStore.getState().selectedAnnotationId;
        const nextId = nextCycledId(
          activeAnnotations.map(({ id }) => id),
          selected,
          event.shiftKey ? -1 : 1,
        );
        if (nextId !== undefined) selectAnnotation(nextId);
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
  }, [annotations, playhead, playing, refreshProject, selectAnnotation, selectedDeliverableId, selectWord, setPlayhead, setPlaying, snapshot, transcripts]);

  async function openProject(): Promise<boolean> {
    let request = beginProjectLoad();
    setNotice("Waiting for a project directory…");
    try {
      const opened = await window.guyditor.call<ProjectSnapshot | null>(
        "ProjectStore",
        "openDialog",
        {},
      );
      if (opened === null) {
        if (isContextRequestLatest(projectLoadGate.current, request)) {
          setNotice("Project open cancelled.");
        }
        return false;
      }
      request = beginProjectLoad();
      useUndoStore.getState().clear();
      const result = await hydrate(opened, request);
      if (!result.applied) return false;
      setNotice(result.warning ?? `Opened ${opened.projectPath}`);
      return result.applied;
    } catch (error: unknown) {
      if (isContextRequestLatest(projectLoadGate.current, request)) {
        setNotice(errorMessage(error));
      }
      return false;
    }
  }

  async function createProject(): Promise<boolean> {
    let request = beginProjectLoad();
    setNotice("Choose an empty directory for the new project…");
    try {
      const created = await window.guyditor.call<ProjectSnapshot | null>(
        "ProjectStore",
        "createDialog",
        {},
      );
      if (created === null) {
        if (isContextRequestLatest(projectLoadGate.current, request)) {
          setNotice("Project creation cancelled.");
        }
        return false;
      }
      request = beginProjectLoad();
      useUndoStore.getState().clear();
      const result = await hydrate(created, request);
      if (!result.applied) return false;
      setNotice(result.warning ?? `Created ${created.projectPath}`);
      return result.applied;
    } catch (error: unknown) {
      if (isContextRequestLatest(projectLoadGate.current, request)) {
        setNotice(errorMessage(error));
      }
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
    annotationTimelineFrames,
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
    assemblyVersion,
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
    assemble: <AssemblePanel {...panelProps} />,
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
      {welcomeVisible({
        projectOpen: snapshot !== null,
        onboardingWants: welcomeOpen,
        loaded: snapshotLoaded,
      }) ? (
        <WelcomeSurface
          onCreateProject={() => welcomeProjectAction("create")}
          onOpenProject={() => welcomeProjectAction("open")}
          {...(snapshot === null
            ? {}
            : { onSkip: rememberWelcomeDismissal, onTakeTour: beginTour })}
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
