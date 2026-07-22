import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  failure,
  makeGuyditorError,
  success,
} from "../../core/src/index.js";
import type {
  JobQueue,
  JobRecord,
  JsonValue,
  Result,
} from "../../core/src/index.js";

import type { DataClass } from "./audit-types.js";
import type { AdapterRegistry } from "./adapters/registry.js";
import type { CritiqueRequest, CritiqueResult } from "./adapters/types.js";
import type { CostContext, CostEstimate, CostMeter } from "./cost-meter.js";

const REQUIRED_CLASSES: readonly DataClass[] = ["metadata", "prompt", "video"];

export interface DataBoundaryPolicy {
  killSwitch: boolean;
  allowedClasses: DataClass[];
  perAdapter?: Record<string, DataClass[]>;
  projectAllowedClasses?: DataClass[];
}

export interface CriticExecutionServiceOptions {
  projectRoot: string;
  registry: AdapterRegistry;
  jobs: JobQueue;
  costMeter: CostMeter;
  policy: DataBoundaryPolicy;
  now?: () => Date;
}

export interface CriticExecutionInput {
  adapterId: string;
  request: CritiqueRequest;
  context: CostContext;
  confirmToken?: string;
}

function rangeNumber(range: Record<string, unknown>, key: string): number | undefined {
  const value = range[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function auditUnits(estimate: CostEstimate): { seconds?: number } {
  const seconds = "seconds" in estimate.units && typeof estimate.units.seconds === "number"
    ? estimate.units.seconds
    : undefined;
  return seconds === undefined ? {} : { seconds };
}

function effectiveClasses(policy: DataBoundaryPolicy, adapterId: string): Set<DataClass> {
  const configured = policy.killSwitch
    ? policy.allowedClasses.filter((value) => value === "metadata" || value === "prompt")
    : (policy.perAdapter?.[adapterId] ?? policy.allowedClasses);
  const project = policy.projectAllowedClasses;
  return new Set(project === undefined
    ? configured
    : configured.filter((value) => project.includes(value)));
}

interface CriticJobPayload {
  adapterId: string;
  request: CritiqueRequest;
  context: CostContext;
  estimate: CostEstimate;
  seconds: number;
  promptChars: number;
}

function jsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Critic job payload must be JSON serializable.");
  return JSON.parse(serialized) as JsonValue;
}

function criticJobPayload(value: JsonValue): CriticJobPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Critic job payload must be an object.");
  }
  return value as unknown as CriticJobPayload;
}

function terminal(job: JobRecord): boolean {
  return job.state === "done" || job.state === "failed" || job.state === "cancelled";
}

function waitForTerminal(jobs: JobQueue, jobId: string): Promise<JobRecord> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const finish = (job: JobRecord): void => {
      unsubscribe();
      resolve(job);
    };
    unsubscribe = jobs.onChange(({ job }) => {
      if (job.jobId === jobId && terminal(job)) finish(job);
    });
    const current = jobs.get(jobId);
    if (current !== undefined && terminal(current)) finish(current);
  });
}

export class CriticExecutionService {
  readonly #projectRoot: string;
  readonly #registry: AdapterRegistry;
  readonly #jobs: JobQueue;
  readonly #costMeter: CostMeter;
  readonly #policy: DataBoundaryPolicy;
  readonly #now: () => Date;

  public constructor(options: CriticExecutionServiceOptions) {
    this.#projectRoot = options.projectRoot;
    this.#registry = options.registry;
    this.#jobs = options.jobs;
    this.#costMeter = options.costMeter;
    this.#policy = structuredClone(options.policy);
    this.#now = options.now ?? (() => new Date());
    this.#jobs.registerExecutor("critic.review", (job, context) =>
      this.#execute(criticJobPayload(job.payload), context.signal, context.reportProgress));
  }

  public async request(input: CriticExecutionInput): Promise<Result<CritiqueResult>> {
    const adapter = this.#registry.resolveCritic(input.adapterId);
    if (adapter === undefined) {
      return failure(makeGuyditorError(
        "E_ADAPTER_NOT_FOUND",
        `Critic adapter ${input.adapterId} is not registered.`,
        { affected: [input.adapterId] },
      ));
    }
    const seconds = rangeNumber(input.request.subject.range, "durationSeconds");
    if (seconds === undefined || seconds <= 0 || seconds > adapter.accepts.maxVideoSeconds) {
      return failure(makeGuyditorError(
        "E_CRITIC_RANGE",
        `Critic proxy duration must be between 0 and ${String(adapter.accepts.maxVideoSeconds)} seconds.`,
        { affected: [input.request.critiqueId] },
      ));
    }

    const effective = effectiveClasses(this.#policy, adapter.id);
    const blocked = REQUIRED_CLASSES.find((value) =>
      !effective.has(value) || !adapter.accepts.dataClasses.includes(value));
    const promptChars = input.request.questions.reduce((sum, value) => sum + value.length, 0) +
      input.request.rubric.reduce((sum, value) => sum + value.text.length, 0);
    if (blocked !== undefined) {
      const estimate: CostEstimate = {
        adapterId: adapter.id,
        currency: "USD",
        amount: 0,
        units: { seconds },
        confidence: "quote",
      };
      this.#costMeter.record({
        context: input.context,
        estimate,
        provider: adapter.provider,
        purpose: "critic_request:data_boundary_blocked",
        dataClassesSent: [],
        payloadSummary: { videoSeconds: seconds, promptChars },
        units: { seconds },
        actualUsd: 0,
        outcome: "error",
        durationMs: 0,
      });
      return failure(makeGuyditorError(
        "E_DATA_BOUNDARY",
        `Critic request requires blocked data class ${blocked}.`,
        {
          affected: [adapter.id, blocked],
          suggestion: "Enable the class for this adapter, or disable the external critic request.",
        },
      ));
    }

    const estimate = adapter.estimate(input.request);
    if (input.confirmToken !== undefined) {
      if (!this.#costMeter.confirm(input.confirmToken, input.context)) {
        return failure(makeGuyditorError(
          "E_BUDGET_CONFIRMATION",
          "The critic cost confirmation is invalid or expired.",
          { affected: [input.request.critiqueId] },
        ));
      }
    } else {
      const preflight = this.#costMeter.preflight(estimate, input.context);
      if (preflight.verdict === "blocked") {
        return failure(makeGuyditorError(
          "E_BUDGET_CAP",
          preflight.message,
          { affected: [input.request.critiqueId] },
        ));
      }
      if (preflight.verdict === "warn") {
        return failure(makeGuyditorError(
          "E_BUDGET_CONFIRMATION_REQUIRED",
          preflight.message,
          {
            affected: [input.request.critiqueId],
            retry: "safe",
            suggestion: preflight.confirmToken,
          },
        ));
      }
    }

    const job = this.#jobs.enqueue({
      kind: "critic.review",
      title: `Critic review · ${input.request.critiqueId}`,
      cancellable: true,
      payload: jsonValue({
        adapterId: input.adapterId,
        request: input.request,
        context: input.context,
        estimate,
        seconds,
        promptChars,
      }),
    });
    const finished = await waitForTerminal(this.#jobs, job.jobId);
    if (finished.state === "failed") {
      return failure(finished.error ?? makeGuyditorError(
        "E_CRITIC_CALL",
        "Critic review job failed without an error envelope.",
        { affected: [input.request.critiqueId, job.jobId], retry: "safe" },
      ));
    }
    if (finished.state === "cancelled") {
      return failure(makeGuyditorError(
        "E_JOB_CANCELLED",
        `Critic review ${input.request.critiqueId} was cancelled.`,
        { affected: [input.request.critiqueId, job.jobId], retry: "safe" },
      ));
    }
    const critique = await this.get(input.request.critiqueId);
    return critique === undefined
      ? failure(makeGuyditorError(
          "E_CRITIC_CACHE",
          `Critic review ${input.request.critiqueId} completed without a cached result.`,
          { affected: [input.request.critiqueId, job.jobId], retry: "safe" },
        ))
      : success(critique);
  }

  async #execute(
    payload: CriticJobPayload,
    signal: AbortSignal,
    reportProgress: (progress: number, etaSeconds?: number) => void,
  ): Promise<JsonValue> {
    const adapter = this.#registry.resolveCritic(payload.adapterId);
    if (adapter === undefined) {
      throw makeGuyditorError(
        "E_ADAPTER_NOT_FOUND",
        `Critic adapter ${payload.adapterId} is not registered.`,
        { affected: [payload.adapterId] },
      );
    }
    if (signal.aborted) {
      throw makeGuyditorError("E_JOB_CANCELLED", "Critic review was cancelled before invocation.", {
        affected: [payload.request.critiqueId],
        retry: "safe",
      });
    }
    reportProgress(0.1);
    const startedAt = this.#now().getTime();
    try {
      const critique = await adapter.critique(payload.request);
      if (signal.aborted) {
        this.#costMeter.record({
          context: payload.context,
          estimate: payload.estimate,
          provider: adapter.provider,
          purpose: "critic_request",
          dataClassesSent: [...REQUIRED_CLASSES],
          payloadSummary: { videoSeconds: payload.seconds, promptChars: payload.promptChars },
          units: auditUnits(payload.estimate),
          actualUsd: payload.estimate.amount,
          outcome: "cancelled",
          durationMs: Math.max(0, this.#now().getTime() - startedAt),
        });
        throw makeGuyditorError("E_JOB_CANCELLED", "Critic review was cancelled.", {
          affected: [payload.request.critiqueId],
          retry: "safe",
        });
      }
      reportProgress(0.8);
      await this.#writeCache(critique);
      this.#costMeter.record({
        context: payload.context,
        estimate: payload.estimate,
        provider: adapter.provider,
        purpose: "critic_request",
        dataClassesSent: [...REQUIRED_CLASSES],
        payloadSummary: { videoSeconds: payload.seconds, promptChars: payload.promptChars },
        units: auditUnits(payload.estimate),
        actualUsd: payload.estimate.amount,
        outcome: "ok",
        durationMs: Math.max(0, this.#now().getTime() - startedAt),
      });
      reportProgress(1);
      return jsonValue({
        critiqueId: critique.critiqueId,
        adapterId: critique.adapterId,
        cachePath: this.#cachePath(critique.critiqueId),
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error &&
          error.code === "E_JOB_CANCELLED") throw error;
      this.#costMeter.record({
        context: payload.context,
        estimate: payload.estimate,
        provider: adapter.provider,
        purpose: "critic_request",
        dataClassesSent: [...REQUIRED_CLASSES],
        payloadSummary: { videoSeconds: payload.seconds, promptChars: payload.promptChars },
        units: auditUnits(payload.estimate),
        actualUsd: payload.estimate.amount,
        outcome: "error",
        durationMs: Math.max(0, this.#now().getTime() - startedAt),
      });
      throw makeGuyditorError(
        "E_CRITIC_CALL",
        error instanceof Error ? error.message : "Critic call failed.",
        { affected: [payload.request.critiqueId], retry: "safe" },
      );
    }
  }

  public async get(critiqueId: string): Promise<CritiqueResult | undefined> {
    if (!/^crt_[a-z2-7]{10}$/u.test(critiqueId)) return undefined;
    try {
      return JSON.parse(await readFile(this.#cachePath(critiqueId), "utf8")) as CritiqueResult;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #writeCache(critique: CritiqueResult): Promise<void> {
    const path = this.#cachePath(critique.critiqueId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(critique, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  #cachePath(critiqueId: string): string {
    return join(this.#projectRoot, ".guyditor", "cache", "critiques", `${critiqueId}.json`);
  }
}
