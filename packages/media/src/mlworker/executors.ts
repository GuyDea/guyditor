import type {
  JobQueue,
  JsonValue,
} from "../../../core/src/index.js";

import type {
  MlworkerTaskMethod,
  MlworkerTaskRunner,
} from "./types.js";

function taskParams(payload: JsonValue, taskId: string): Record<string, JsonValue> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TypeError("mlworker job payload must be an object");
  }
  return { ...payload, taskId };
}

function taskResult(
  payload: JsonValue,
  result: JsonValue,
  taskId: string,
): JsonValue {
  if (
    typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
    typeof result === "object" && result !== null && !Array.isArray(result)
  ) {
    return { ...payload, ...result, jobId: taskId };
  }
  return result;
}

export function registerMlworkerJobExecutors(
  queue: JobQueue,
  runner: MlworkerTaskRunner,
): void {
  for (const method of ["transcribe", "align", "vad", "track"] as const satisfies readonly MlworkerTaskMethod[]) {
    queue.registerExecutor(method, async (job, { reportProgress, signal }) => {
      const result = await runner.runTask(
        method,
        taskParams(job.payload, job.jobId),
        {
          signal,
          onProgress: ({ progress }) => reportProgress(progress),
        },
      );
      if (!result.ok) throw result.error;
      return taskResult(job.payload, result.value, job.jobId);
    });
  }
}
