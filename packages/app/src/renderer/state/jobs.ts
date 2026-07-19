import { create } from "zustand";

import type { GdEvent, JobStatus } from "../../shared/ipc.js";

interface JobsState {
  jobs: JobStatus[];
  replace: (jobs: JobStatus[]) => void;
  applyEvent: (event: Extract<GdEvent, { kind: "job.state" | "job.progress" }>) => void;
}

function newestFirst(jobs: JobStatus[]): JobStatus[] {
  return [...jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: [],
  replace: (jobs) => set({ jobs: newestFirst(jobs) }),
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
