import { makeGuyditorError } from "../../core/src/index.js";
import type {
  GuyditorError,
  JobQueue,
  JobState,
} from "../../core/src/index.js";

export interface BatchValidationResult {
  outcome: "pass" | "warnings" | "blocked";
  checks: Array<{ status: "pass" | "warn" | "fail"; message: string; affected: string[] }>;
}

export interface BatchExportItem {
  deliverableId: string;
  jobId: string;
  state: JobState;
  error?: GuyditorError;
}

export interface BatchExportResult {
  jobId: string;
  items: BatchExportItem[];
}

export interface BatchExportServiceOptions {
  queue: JobQueue;
  revision: () => string;
  validate: (deliverableId: string, revision: string) => Promise<BatchValidationResult>;
  exportOutputSet: (deliverableId: string, revision: string) => Promise<{ jobId: string }>;
  enqueueKitBuild?: (deliverableId: string, dependsOn: readonly string[]) => Promise<{ jobId: string }>;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Batch job payload must be an object.");
  }
  return value as Record<string, unknown>;
}

function itemError(error: unknown, deliverableId: string): GuyditorError {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (
      typeof record["code"] === "string" && record["code"].startsWith("E_") &&
      typeof record["message"] === "string" && Array.isArray(record["affected"]) &&
      record["affected"].every((value) => typeof value === "string") &&
      (record["retry"] === "safe" || record["retry"] === "unsafe" || record["retry"] === "none")
    ) {
      return {
        code: record["code"] as GuyditorError["code"],
        message: record["message"],
        affected: record["affected"] as string[],
        acceptedStateChanged: record["acceptedStateChanged"] === true,
        retry: record["retry"],
        ...(typeof record["suggestion"] === "string" ? { suggestion: record["suggestion"] } : {}),
      };
    }
  }
  return makeGuyditorError(
    "E_BATCH_ITEM_FAILED",
    error instanceof Error ? error.message : String(error),
    { affected: [deliverableId], retry: "safe" },
  );
}

export class BatchExportService {
  readonly #queue: JobQueue;
  readonly #revision: () => string;
  readonly #validate: BatchExportServiceOptions["validate"];
  readonly #exportOutputSet: BatchExportServiceOptions["exportOutputSet"];
  readonly #enqueueKitBuild: BatchExportServiceOptions["enqueueKitBuild"];

  public constructor(options: BatchExportServiceOptions) {
    this.#queue = options.queue;
    this.#revision = options.revision;
    this.#validate = options.validate;
    this.#exportOutputSet = options.exportOutputSet;
    this.#enqueueKitBuild = options.enqueueKitBuild;
    this.#queue.registerExecutor("render.batch.invalid", async (job) => {
      const error = payloadRecord(job.payload)["error"];
      if (typeof error === "object" && error !== null && !Array.isArray(error)) {
        const record = error as Record<string, unknown>;
        if (
          typeof record["code"] === "string" && record["code"].startsWith("E_") &&
          typeof record["message"] === "string" && Array.isArray(record["affected"]) &&
          record["affected"].every((value) => typeof value === "string") &&
          (record["retry"] === "safe" || record["retry"] === "unsafe" || record["retry"] === "none")
        ) {
          throw makeGuyditorError(record["code"] as `E_${Uppercase<string>}`, record["message"], {
            affected: record["affected"] as string[],
            retry: record["retry"],
            ...(typeof record["suggestion"] === "string" ? { suggestion: record["suggestion"] } : {}),
          });
        }
      }
      throw makeGuyditorError("E_EXPORT_VALIDATION_FAILED", "Batch item validation failed.", {
        affected: [job.jobId], retry: "none",
      });
    });
    this.#queue.registerExecutor("render.batchexport", async (job) => {
      const payload = payloadRecord(job.payload);
      const entries = payload["items"];
      if (!Array.isArray(entries)) throw new TypeError("Batch parent has no item map.");
      return {
        items: entries.map((entry) => {
          const item = payloadRecord(entry);
          const deliverableId = item["deliverableId"];
          const jobId = item["jobId"];
          if (typeof deliverableId !== "string" || typeof jobId !== "string") {
            throw new TypeError("Batch item has invalid identifiers.");
          }
          const child = this.#queue.get(jobId);
          const error = this.#rootError(jobId);
          return {
            deliverableId,
            jobId,
            state: child?.state ?? "failed",
            ...(error === undefined ? {} : {
              error: {
                code: error.code,
                message: error.message,
                affected: [...error.affected],
                acceptedStateChanged: error.acceptedStateChanged,
                retry: error.retry,
                ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
              },
            }),
          };
        }),
      };
    });
  }

  public async exportBatch(input: {
    deliverableIds: readonly string[];
    buildKits?: boolean;
  }): Promise<BatchExportResult> {
    const revision = this.#revision();
    const items: Array<{ deliverableId: string; jobId: string }> = [];
    for (const deliverableId of [...new Set(input.deliverableIds)]) {
      let validation: BatchValidationResult;
      try {
        validation = await this.#validate(deliverableId, revision);
      } catch (error: unknown) {
        items.push({
          deliverableId,
          jobId: this.#enqueueFailure(deliverableId, revision, itemError(error, deliverableId)),
        });
        continue;
      }
      if (validation.outcome !== "pass") {
        const failed = validation.checks.filter(({ status }) => status !== "pass");
        const error = makeGuyditorError(
          "E_EXPORT_VALIDATION_FAILED",
          `Export validation ${validation.outcome === "blocked" ? "blocked" : "needs warning acknowledgement for"} ${deliverableId}: ${failed.map(({ message }) => message).join("; ")}`,
          {
            affected: [...new Set(failed.flatMap(({ affected }) => affected))],
            retry: "none",
            suggestion: validation.outcome === "blocked"
              ? "Fix the item validation failures before retrying the batch."
              : "Acknowledge the item validation warnings before retrying the batch.",
          },
        );
        items.push({ deliverableId, jobId: this.#enqueueFailure(deliverableId, revision, error) });
        continue;
      }
      let exported: { jobId: string } | undefined;
      try {
        exported = await this.#exportOutputSet(deliverableId, revision);
        const leaf = input.buildKits === true && this.#enqueueKitBuild !== undefined
          ? await this.#enqueueKitBuild(deliverableId, [exported.jobId])
          : exported;
        items.push({ deliverableId, jobId: leaf.jobId });
      } catch (error: unknown) {
        items.push({
          deliverableId,
          jobId: this.#enqueueFailure(
            deliverableId,
            revision,
            itemError(error, deliverableId),
            exported === undefined ? [] : [exported.jobId],
          ),
        });
      }
    }
    const parent = this.#queue.enqueue({
      kind: "render.batchexport",
      title: `Batch export · ${String(items.length)} deliverables`,
      cancellable: true,
      dependsOn: items.map(({ jobId }) => jobId),
      dependencyMode: "terminal",
      payload: { revision, buildKits: input.buildKits === true, items },
    });
    return { jobId: parent.jobId, items: this.#items(items) };
  }

  public result(jobId: string): BatchExportResult {
    const parent = this.#queue.get(jobId);
    if (parent === undefined || parent.kind !== "render.batchexport") {
      throw new TypeError(`Batch export ${jobId} does not exist.`);
    }
    const payload = payloadRecord(parent.payload);
    const entries = payload["items"];
    if (!Array.isArray(entries)) throw new TypeError(`Batch export ${jobId} has no item results.`);
    const mapped = entries.map((entry) => {
      const item = payloadRecord(entry);
      const deliverableId = item["deliverableId"];
      const childJobId = item["jobId"];
      if (typeof deliverableId !== "string" || typeof childJobId !== "string") {
        throw new TypeError(`Batch export ${jobId} has an invalid item result.`);
      }
      return { deliverableId, jobId: childJobId };
    });
    return { jobId, items: this.#items(mapped) };
  }

  public retryBatch(jobId: string): Promise<BatchExportResult> {
    const prior = this.result(jobId);
    const payload = payloadRecord(this.#queue.get(jobId)!.payload);
    return this.exportBatch({
      deliverableIds: prior.items
        .filter(({ state }) => state === "failed" || state === "cancelled")
        .map(({ deliverableId }) => deliverableId),
      buildKits: payload["buildKits"] === true,
    });
  }

  #items(items: readonly { deliverableId: string; jobId: string }[]): BatchExportItem[] {
    return items.map(({ deliverableId, jobId }) => {
      const job = this.#queue.get(jobId);
      const error = this.#rootError(jobId);
      return {
        deliverableId,
        jobId,
        state: job?.state ?? "failed",
        ...(error === undefined ? {} : { error: structuredClone(error) }),
      };
    });
  }

  #enqueueFailure(
    deliverableId: string,
    revision: string,
    error: GuyditorError,
    dependsOn: readonly string[] = [],
  ): string {
    return this.#queue.enqueue({
      kind: "render.batch.invalid",
      title: `Batch item failed · ${deliverableId}`,
      cancellable: false,
      dependsOn: [...dependsOn],
      payload: {
        deliverableId,
        revision,
        error: {
          code: error.code,
          message: error.message,
          affected: [...error.affected],
          retry: error.retry,
          ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
        },
      },
    }).jobId;
  }

  #rootError(jobId: string, seen = new Set<string>()): GuyditorError | undefined {
    if (seen.has(jobId)) return undefined;
    seen.add(jobId);
    const job = this.#queue.get(jobId);
    if (job?.error === undefined) return undefined;
    if (job.error.code !== "E_JOB_DEPENDENCY_FAILED") return job.error;
    for (const dependencyId of job.dependsOn) {
      const dependencyError = this.#rootError(dependencyId, seen);
      if (dependencyError !== undefined) return dependencyError;
    }
    return job.error;
  }
}
