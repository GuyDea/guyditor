import { describe, expect, it } from "vitest";

import { LAYOUT_STORAGE_KEY } from "./layout-state.js";
import {
  CHECKLIST_STEPS,
  applyOnboardingSignal,
  checklistComplete,
  createOnboardingState,
  dismissWelcome,
  loadOnboardingState,
  saveOnboardingState,
  shouldShowWelcome,
  welcomeVisible,
} from "./onboarding.js";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("first-run onboarding state", () => {
  it("shows welcome only when no project was persisted and welcome was not dismissed", () => {
    const fresh = memoryStorage();
    const returning = memoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        schema: "layout/v2",
        projects: { "/project": {} },
      }),
    });

    expect(shouldShowWelcome(fresh)).toBe(true);
    expect(shouldShowWelcome(returning)).toBe(false);

    dismissWelcome(fresh);
    expect(shouldShowWelcome(fresh)).toBe(false);
    expect(loadOnboardingState(fresh).welcomeDismissed).toBe(true);
  });

  it("recovers malformed persisted onboarding state without losing first-run behavior", () => {
    const storage = memoryStorage({ "guyditor/onboarding/v1": "{broken" });

    expect(loadOnboardingState(storage)).toEqual(createOnboardingState());
    expect(shouldShowWelcome(storage)).toBe(true);
  });
});

describe("getting-started checklist reducer", () => {
  it("ticks the six amendment steps only from their real signals", () => {
    let state = createOnboardingState();
    state = applyOnboardingSignal(state, { kind: "project.opened" });
    state = applyOnboardingSignal(state, {
      kind: "project.history",
      transactions: [{ operations: [{ op: "project.create" }] }],
    });
    state = applyOnboardingSignal(state, { kind: "job.done", jobKind: "ingest" });
    state = applyOnboardingSignal(state, { kind: "transcript.registered", count: 1 });
    state = applyOnboardingSignal(state, {
      kind: "project.history",
      transactions: [
        { operations: [{ op: "project.create" }] },
        { operations: [{ op: "clip.trim" }] },
      ],
    });
    state = applyOnboardingSignal(state, {
      kind: "proposal.resolved",
      status: "rejected",
    });
    state = applyOnboardingSignal(state, { kind: "export.report", exists: true });

    expect(CHECKLIST_STEPS.map(({ id }) => state.checklist[id])).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(checklistComplete(state)).toBe(true);
    expect(state.seenFlowOnce).toBe(true);
  });

  it("accepts watcher ingest and proposal acceptance while ignoring incomplete signals", () => {
    let state = createOnboardingState();
    state = applyOnboardingSignal(state, { kind: "watcher.ingested", assetCount: 0 });
    state = applyOnboardingSignal(state, { kind: "transcript.registered", count: 0 });
    state = applyOnboardingSignal(state, { kind: "export.report", exists: false });
    expect(state.checklist).toMatchObject({
      importedMedia: false,
      transcriptReady: false,
      exportedProject: false,
    });

    state = applyOnboardingSignal(state, { kind: "watcher.ingested", assetCount: 2 });
    state = applyOnboardingSignal(state, {
      kind: "proposal.resolved",
      status: "accepted",
    });
    expect(state.checklist.importedMedia).toBe(true);
    expect(state.checklist.reviewedProposal).toBe(true);
  });

  it("persists achievements per app rather than replacing them for a new project", () => {
    const storage = memoryStorage();
    const opened = applyOnboardingSignal(createOnboardingState(), {
      kind: "project.opened",
    });
    saveOnboardingState(storage, opened);
    const anotherProject = applyOnboardingSignal(loadOnboardingState(storage), {
      kind: "job.done",
      jobKind: "ingest",
    });
    saveOnboardingState(storage, anotherProject);

    expect(loadOnboardingState(storage).checklist).toMatchObject({
      projectOpened: true,
      importedMedia: true,
    });
  });
});

describe("welcomeVisible", () => {
  it("always shows welcome when no project is open", () => {
    expect(welcomeVisible({ projectOpen: false, onboardingWants: false, loaded: true })).toBe(true);
    expect(welcomeVisible({ projectOpen: false, onboardingWants: true, loaded: true })).toBe(true);
  });

  it("follows onboarding once a project is open", () => {
    expect(welcomeVisible({ projectOpen: true, onboardingWants: false, loaded: true })).toBe(false);
    expect(welcomeVisible({ projectOpen: true, onboardingWants: true, loaded: true })).toBe(true);
  });

  it("stays hidden until the first project snapshot has loaded", () => {
    expect(welcomeVisible({ projectOpen: false, onboardingWants: true, loaded: false })).toBe(false);
  });
});
