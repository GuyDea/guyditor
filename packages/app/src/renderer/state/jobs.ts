import { create } from "zustand";

import type { GdEvent, JobOverview, JobStatus } from "../../shared/ipc.js";

interface JobsState {
  jobs: JobStatus[];
  overview: JobOverview;
  replace: (jobs: JobStatus[]) => void;
  replaceOverview: (overview: JobOverview) => void;
  applyEvent: (event: Extract<GdEvent, { kind: "job.state" | "job.progress" }>) => void;
}

function emptyOverview(): JobOverview {
  return {
    running: [],
    queued: [],
    retryable: [],
    waitingOnCreator: { proposals: [], annotations: [], confirmations: [] },
    waitingOnExternal: [],
    aggregateFraction: 1,
    idle: true,
  };
}

export function overviewWaitingCount(overview: JobOverview): number {
  return overview.waitingOnCreator.proposals.length +
    overview.waitingOnCreator.annotations.length +
    overview.waitingOnCreator.confirmations.length;
}

export function overviewStatusText(overview: JobOverview): string {
  if (overview.idle) return "idle — no background work, nothing awaiting review";
  const active = overview.running.length + overview.queued.length;
  if (active > 0) {
    return `${String(active)} active · ${String(Math.round(overview.aggregateFraction * 100))}%`;
  }
  if (overview.retryable.length > 0) {
    return `${String(overview.retryable.length)} ${overview.retryable.length === 1 ? "job" : "jobs"} needs attention`;
  }
  const waiting = overviewWaitingCount(overview);
  return waiting > 0
    ? `waiting on you · ${String(waiting)}`
    : `waiting on external providers · ${String(overview.waitingOnExternal.length)}`;
}

function newestFirst(jobs: JobStatus[]): JobStatus[] {
  return [...jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: [],
  overview: emptyOverview(),
  replace: (jobs) => set({ jobs: newestFirst(jobs) }),
  replaceOverview: (overview) => set({ overview: structuredClone(overview) }),
  applyEvent: (event) => set((state) => {
    if (event.kind === "job.state") {
      const remaining = state.jobs.filter(({ jobId }) => jobId !== event.job.jobId);
      return { jobs: newestFirst([event.job, ...remaining]) };
    }
    return {
      jobs: state.jobs.map((job) => job.jobId === event.jobId
        ? {
            ...job,
            progress: event.progress,
            ...(event.etaSeconds === undefined ? {} : { etaSeconds: event.etaSeconds }),
          }
        : job),
    };
  }),
}));
