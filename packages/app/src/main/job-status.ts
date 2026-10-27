import type { JobRecord, JobStatus } from "../../../core/src/index.js";

export function publicJobStatus(job: JobRecord): JobStatus {
  return {
    jobId: job.jobId,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    dependsOn: [...job.dependsOn],
    ...(job.error === undefined ? {} : { error: job.error }),
    title: job.title,
    cancellable: job.cancellable,
    createdAt: job.createdAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.etaSeconds === undefined ? {} : { etaSeconds: job.etaSeconds }),
  };
}
