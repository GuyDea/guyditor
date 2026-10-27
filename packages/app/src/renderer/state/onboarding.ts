import { LAYOUT_STORAGE_KEY } from "./layout-state.js";

export const ONBOARDING_STORAGE_KEY = "guyditor/onboarding/v1";

export const CHECKLIST_STEPS = [
  { id: "projectOpened", label: "Create or open a project" },
  { id: "importedMedia", label: "Import your first media" },
  { id: "transcriptReady", label: "Wait for the transcript" },
  { id: "acceptedEdit", label: "Make your first accepted edit" },
  { id: "reviewedProposal", label: "Review an agent proposal" },
  { id: "exportedProject", label: "Export your first deliverable" },
] as const;

export type ChecklistStepId = typeof CHECKLIST_STEPS[number]["id"];

export interface OnboardingState {
  schema: "onboarding/v1";
  welcomeDismissed: boolean;
  checklistDismissed: boolean;
  seenFlowOnce: boolean;
  checklist: Record<ChecklistStepId, boolean>;
}

export type OnboardingSignal =
  | { kind: "project.opened" }
  | {
      kind: "project.history";
      transactions: Array<{ operations: Array<{ op: string }> }>;
    }
  | { kind: "job.done"; jobKind: string }
  | { kind: "watcher.ingested"; assetCount: number }
  | { kind: "transcript.registered"; count: number }
  | { kind: "proposal.resolved"; status: "accepted" | "rejected" }
  | { kind: "export.report"; exists: boolean };

export function createOnboardingState(): OnboardingState {
  return {
    schema: "onboarding/v1",
    welcomeDismissed: false,
    checklistDismissed: false,
    seenFlowOnce: false,
    checklist: {
      projectOpened: false,
      importedMedia: false,
      transcriptReady: false,
      acceptedEdit: false,
      reviewedProposal: false,
      exportedProject: false,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedState(value: unknown): OnboardingState | null {
  if (!isRecord(value) || value["schema"] !== "onboarding/v1" ||
    typeof value["welcomeDismissed"] !== "boolean" ||
    typeof value["checklistDismissed"] !== "boolean" ||
    typeof value["seenFlowOnce"] !== "boolean" ||
    !isRecord(value["checklist"])) {
    return null;
  }
  const checklist = value["checklist"];
  if (!CHECKLIST_STEPS.every(({ id }) => typeof checklist[id] === "boolean")) return null;
  return {
    schema: "onboarding/v1",
    welcomeDismissed: value["welcomeDismissed"],
    checklistDismissed: value["checklistDismissed"],
    seenFlowOnce: value["seenFlowOnce"],
    checklist: Object.fromEntries(
      CHECKLIST_STEPS.map(({ id }) => [id, checklist[id]]),
    ) as Record<ChecklistStepId, boolean>,
  };
}

export function loadOnboardingState(storage: Storage): OnboardingState {
  try {
    return parsedState(JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY) ?? "null")) ??
      createOnboardingState();
  } catch {
    return createOnboardingState();
  }
}

export function saveOnboardingState(
  storage: Storage,
  state: OnboardingState,
): void {
  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
}

function hasPriorProject(storage: Storage): boolean {
  try {
    const value: unknown = JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY) ?? "null");
    return isRecord(value) && isRecord(value["projects"]) &&
      Object.keys(value["projects"]).length > 0;
  } catch {
    return false;
  }
}

export function shouldShowWelcome(storage: Storage): boolean {
  return !loadOnboardingState(storage).welcomeDismissed && !hasPriorProject(storage);
}

export function welcomeVisible(input: {
  projectOpen: boolean;
  onboardingWants: boolean;
}): boolean {
  return !input.projectOpen || input.onboardingWants;
}

export function dismissWelcome(storage: Storage): void {
  saveOnboardingState(storage, {
    ...loadOnboardingState(storage),
    welcomeDismissed: true,
  });
}

export function applyOnboardingSignal(
  state: OnboardingState,
  signal: OnboardingSignal,
): OnboardingState {
  const checklist = { ...state.checklist };
  switch (signal.kind) {
    case "project.opened":
      checklist.projectOpened = true;
      break;
    case "project.history":
      checklist.acceptedEdit ||= signal.transactions.some(({ operations }) =>
        operations.some(({ op }) => op !== "project.create"));
      break;
    case "job.done":
      checklist.importedMedia ||= signal.jobKind === "ingest";
      break;
    case "watcher.ingested":
      checklist.importedMedia ||= signal.assetCount > 0;
      break;
    case "transcript.registered":
      checklist.transcriptReady ||= signal.count > 0;
      break;
    case "proposal.resolved":
      checklist.reviewedProposal = true;
      break;
    case "export.report":
      checklist.exportedProject ||= signal.exists;
      break;
  }
  const complete = CHECKLIST_STEPS.every(({ id }) => checklist[id]);
  return {
    ...state,
    checklist,
    seenFlowOnce: state.seenFlowOnce || complete,
  };
}

export function checklistComplete(state: OnboardingState): boolean {
  return CHECKLIST_STEPS.every(({ id }) => state.checklist[id]);
}
