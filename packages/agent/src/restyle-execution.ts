import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
} from "node:fs/promises";
import { extname, join } from "node:path";

import {
  makeGuyditorError,
  makeId,
  parseRestylePlan,
  restylePlanSidecarRef,
} from "../../core/src/index.js";
import type {
  Asset,
  ExternalProviderWait,
  IdPrefix,
  JobQueue,
  JobRecord,
  JsonValue,
  OperationEngine,
  ProjectStore,
  RestyleGenerationProvenance,
  RestylePlan,
  RightsMetadata,
} from "../../core/src/index.js";
import {
  materializeRestyleSegment,
  probeMedia,
} from "../../media/src/index.js";

import type { CostContext, CostEstimate, Preflight } from "./cost-meter.js";
import type { CostMeter } from "./cost-meter.js";
import type { AdapterRegistry } from "./adapters/registry.js";
import type {
  AdapterJobHandle,
  AdapterJobStatus,
  RestyleAdapter,
  RestyleRequest,
} from "./adapters/types.js";

export type RestyleStartResult =
  | {
      verdict: "enqueued";
      estimate: CostEstimate;
      jobs: JobRecord[];
    }
  | (Extract<Preflight, { verdict: "warn" }> & { estimate: CostEstimate })
  | (Extract<Preflight, { verdict: "blocked" }> & { estimate: CostEstimate });

export interface StartRestylePlanInput {
  plan: RestylePlan;
  context: CostContext;
  confirmToken?: string;
}

export interface RestyleExecutionServiceOptions {
  projectStore: ProjectStore;
  operationEngine: Pick<OperationEngine, "createProposal">;
  adapters: AdapterRegistry;
  jobs: JobQueue;
  costMeter: CostMeter;
  idFactory?: (prefix: IdPrefix) => string;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface RestyleJobPayload {
  plan: RestylePlan;
  chunkId: string;
  context: CostContext;
}

interface ActiveExternalCall {
  callId: string;
  provider: string;
  title: string;
  startedAtMs: number;
  spendUsd: number;
}

interface AdapterSemaphore {
  active: number;
  waiters: Array<() => void>;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function asRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolveWait, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

function resultRights(
  adapter: RestyleAdapter,
  rights: Partial<RightsMetadata>,
): RightsMetadata {
  return {
    origin: rights.origin ?? "generated",
    ...(rights.licenseName === undefined ? {} : { licenseName: rights.licenseName }),
    ...(rights.licenseUrl === undefined ? {} : { licenseUrl: rights.licenseUrl }),
    licensor: rights.licensor ?? adapter.descriptor.provider,
    ...(rights.purchaseRef === undefined ? {} : { purchaseRef: rights.purchaseRef }),
    restrictions: [...(rights.restrictions ?? [])],
    ...(rights.attributionText === undefined ? {} : { attributionText: rights.attributionText }),
    ...(rights.providerTermsUrl === undefined
      ? {}
      : { providerTermsUrl: rights.providerTermsUrl }),
    confirmedBy: rights.confirmedBy ?? "provider",
    ...(rights.confirmedAt === undefined ? {} : { confirmedAt: rights.confirmedAt }),
  };
}

function extensionFor(mime: string, filePath: string): string {
  if (mime === "video/mp4") return ".mp4";
  const existing = extname(filePath);
  return existing.length > 0 ? existing : ".bin";
}

function jobPayload(job: JobRecord): RestyleJobPayload {
  const payload = asRecord(job.payload);
  if (payload === undefined || typeof payload["chunkId"] !== "string") {
    throw makeGuyditorError("E_RESTYLE_JOB_PAYLOAD", "Restyle job payload is invalid.", {
      affected: [job.jobId],
      retry: "none",
    });
  }
  const parsed = parseRestylePlan(JSON.stringify(payload["plan"]));
  const context = payload["context"];
  if (
    !parsed.ok || typeof context !== "object" || context === null || Array.isArray(context) ||
    typeof context["sessionId"] !== "string" || typeof context["projectId"] !== "string" ||
    typeof context["taskId"] !== "string" ||
    (context["initiator"] !== "creator" && context["initiator"] !== "agent")
  ) {
    throw makeGuyditorError("E_RESTYLE_JOB_PAYLOAD", "Restyle job payload is invalid.", {
      affected: [job.jobId],
      retry: "none",
    });
  }
  return {
    plan: parsed.value,
    chunkId: payload["chunkId"],
    context: {
      sessionId: context["sessionId"],
      projectId: context["projectId"],
      taskId: context["taskId"],
      initiator: context["initiator"],
    },
  };
}

export class RestyleExecutionService {
  readonly #projectStore: ProjectStore;
  readonly #operationEngine: Pick<OperationEngine, "createProposal">;
  readonly #adapters: AdapterRegistry;
  readonly #jobs: JobQueue;
  readonly #costMeter: CostMeter;
  readonly #idFactory: (prefix: IdPrefix) => string;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #external = new Map<string, ActiveExternalCall>();
  readonly #semaphores = new Map<string, AdapterSemaphore>();

  public constructor(options: RestyleExecutionServiceOptions) {
    this.#projectStore = options.projectStore;
    this.#operationEngine = options.operationEngine;
    this.#adapters = options.adapters;
    this.#jobs = options.jobs;
    this.#costMeter = options.costMeter;
    this.#idFactory = options.idFactory ?? makeId;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? defaultSleep;
    this.#jobs.registerExecutor("restyle.generate", (job, context) =>
      this.#executeChunk(job, context.signal, context.reportProgress));
  }

  public startPlan(input: StartRestylePlanInput): RestyleStartResult {
    const adapter = this.#acceptedAdapter(input.plan);
    const estimate: CostEstimate = {
      adapterId: adapter.descriptor.adapterId,
      currency: "USD",
      amount: input.plan.estimatedCost.amount,
      units: {
        seconds: input.plan.chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0),
        chunks: input.plan.chunks.length,
      },
      confidence: "pricebook",
    };
    if (input.confirmToken !== undefined) {
      if (!this.#costMeter.confirm(input.confirmToken, input.context)) {
        return {
          verdict: "blocked",
          level: "task",
          message: "Restyle cost confirmation is invalid or expired.",
          estimate,
        };
      }
    } else {
      const preflight = this.#costMeter.preflight(estimate, input.context);
      if (preflight.verdict !== "proceed") return { ...preflight, estimate };
    }
    const jobs = input.plan.chunks.map((chunk) => this.#jobs.enqueue({
      kind: "restyle.generate",
      title: `Restyle chunk ${String(chunk.index + 1)}/${String(input.plan.chunks.length)}`,
      cancellable: true,
      payload: jsonValue({
        plan: input.plan,
        chunkId: chunk.id,
        context: input.context,
      }),
    }));
    return { verdict: "enqueued", estimate, jobs };
  }

  public externalWaits(): ExternalProviderWait[] {
    const now = this.#now().getTime();
    return [...this.#external.values()]
      .sort((left, right) => left.callId.localeCompare(right.callId))
      .map((call) => ({
        callId: call.callId,
        provider: call.provider,
        title: call.title,
        elapsedSeconds: Math.max(0, Math.floor((now - call.startedAtMs) / 1_000)),
        spendUsd: call.spendUsd,
      }));
  }

  #acceptedAdapter(plan: RestylePlan): RestyleAdapter {
    const adapter = this.#adapters.resolveRestyle(plan.adapterId);
    if (adapter === undefined) {
      throw new Error(`Restyle adapter ${plan.adapterId} is not registered.`);
    }
    const deliverable = this.#projectStore.currentProject.deliverables.find(({ id }) =>
      id === plan.deliverableId);
    const reference = restylePlanSidecarRef(plan);
    const registered = this.#projectStore.currentProject.sidecars.find(({ name }) =>
      name === reference.name);
    if (
      deliverable?.restyle?.planSidecar !== reference.name ||
      registered?.sha256 !== reference.sha256
    ) {
      throw new Error(`Restyle plan ${plan.id} has not been accepted.`);
    }
    return adapter;
  }

  async #acquire(adapter: RestyleAdapter, signal: AbortSignal): Promise<() => void> {
    const key = adapter.descriptor.adapterId;
    const semaphore = this.#semaphores.get(key) ?? { active: 0, waiters: [] };
    this.#semaphores.set(key, semaphore);
    if (semaphore.active >= adapter.constraints.concurrency) {
      await new Promise<void>((resolveWait, reject) => {
        const waiter = (): void => resolveWait();
        semaphore.waiters.push(waiter);
        signal.addEventListener("abort", () => {
          const index = semaphore.waiters.indexOf(waiter);
          if (index !== -1) semaphore.waiters.splice(index, 1);
          reject(signal.reason);
        }, { once: true });
      });
    }
    if (signal.aborted) throw signal.reason;
    semaphore.active += 1;
    return () => {
      semaphore.active -= 1;
      semaphore.waiters.shift()?.();
    };
  }

  async #executeChunk(
    job: JobRecord,
    signal: AbortSignal,
    reportProgress: (progress: number, etaSeconds?: number) => void,
  ): Promise<JsonValue> {
    const payload = jobPayload(job);
    const adapter = this.#acceptedAdapter(payload.plan);
    const chunk = payload.plan.chunks.find(({ id }) => id === payload.chunkId);
    if (chunk === undefined) {
      throw makeGuyditorError("E_RESTYLE_CHUNK_NOT_FOUND", `Chunk ${payload.chunkId} is missing.`, {
        affected: [payload.chunkId],
        retry: "none",
      });
    }
    const release = await this.#acquire(adapter, signal);
    let handle: AdapterJobHandle | undefined;
    let externalKey: string | undefined;
    const startedAt = this.#now().getTime();
    try {
      const cacheDirectory = join(
        this.#projectStore.root,
        ".guyditor/cache/generations",
        job.jobId,
      );
      await mkdir(cacheDirectory, { recursive: true });
      const sourcePath = join(cacheDirectory, "source.mp4");
      await materializeRestyleSegment({
        project: this.#projectStore.currentProject,
        sequenceId: payload.plan.sequenceId,
        range: chunk.sourceRange,
        outputPath: sourcePath,
        projectRoot: this.#projectStore.root,
        signal,
      });
      reportProgress(0.15, chunk.durationSeconds * 2);
      const request: RestyleRequest = {
        requestId: `${payload.plan.id}-${chunk.id}`,
        model: payload.plan.model,
        prompt: payload.plan.settings.prompt,
        ...(payload.plan.settings.negativePrompt === undefined
          ? {}
          : { negativePrompt: payload.plan.settings.negativePrompt }),
        inputFilePath: sourcePath,
        inputMime: "video/mp4",
        referenceAssetIds: payload.plan.sourceAssets.map(({ assetId }) => assetId),
        sourceRange: { sequenceId: payload.plan.sequenceId, ...chunk.sourceRange },
        width: this.#projectStore.currentProject.settings.timeline.width,
        height: this.#projectStore.currentProject.settings.timeline.height,
        fps: this.#projectStore.currentProject.settings.timeline.fps,
        durationSeconds: chunk.durationSeconds,
        ...(payload.plan.settings.seed === undefined
          ? {}
          : { seed: payload.plan.settings.seed }),
        providerSettings: structuredClone(payload.plan.settings.providerSettings),
      };
      handle = await adapter.restyle(request, signal);
      externalKey = `${job.jobId}:${handle.providerJobId}`;
      this.#external.set(externalKey, {
        callId: handle.providerJobId,
        provider: adapter.descriptor.provider,
        title: job.title,
        startedAtMs: this.#now().getTime(),
        spendUsd: chunk.estimatedCostUsd,
      });
      let delayMs = 2_000;
      let status: AdapterJobStatus = await adapter.poll(handle);
      while (status.state === "queued" || status.state === "running") {
        reportProgress(0.2 + (status.progress ?? 0) * 0.55, status.etaSeconds);
        await this.#sleep(delayMs, signal);
        delayMs = Math.min(delayMs * 2, 30_000);
        status = await adapter.poll(handle);
      }
      if (status.state === "failed") {
        throw makeGuyditorError("E_RESTYLE_PROVIDER", status.error, {
          affected: [job.jobId, chunk.id],
          retry: status.retry,
        });
      }
      if (status.state !== "succeeded") {
        throw makeGuyditorError(
          "E_RESTYLE_PROVIDER",
          `Provider task ${handle.providerJobId} did not reach a terminal state.`,
          { affected: [job.jobId, chunk.id], retry: "safe" },
        );
      }
      const result = await adapter.fetchResult(handle, cacheDirectory);
      reportProgress(0.85, 0);
      const actualCostUsd = result.actualCostUsd ?? status.actualCostUsd ?? chunk.estimatedCostUsd;
      const estimate: CostEstimate = {
        adapterId: adapter.descriptor.adapterId,
        currency: "USD",
        amount: chunk.estimatedCostUsd,
        units: { seconds: chunk.durationSeconds },
        confidence: "pricebook",
      };
      this.#costMeter.record({
        context: payload.context,
        estimate,
        provider: adapter.descriptor.provider,
        purpose: "restyle.generate",
        dataClassesSent: [...adapter.descriptor.dataClassesSent],
        payloadSummary: {
          videoSeconds: chunk.durationSeconds,
          promptChars: payload.plan.settings.prompt.length,
        },
        units: { seconds: chunk.durationSeconds },
        actualUsd: actualCostUsd,
        outcome: "ok",
        durationMs: Math.max(0, this.#now().getTime() - startedAt),
      });
      const content = await readFile(result.output.filePath);
      const contentHash = createHash("sha256").update(content).digest("hex");
      const probed = await probeMedia(result.output.filePath);
      const assetId = this.#idFactory("ast");
      const rights = resultRights(adapter, result.output.rights);
      const asset: Asset = {
        id: assetId,
        kind: "generated",
        path: `media/generated/${assetId}${extensionFor(result.output.mime, result.output.filePath)}`,
        sha256: contentHash,
        bytes: (await stat(result.output.filePath)).size,
        ...(probed.container === undefined ? {} : { container: probed.container }),
        probe: probed.probe,
        ...(probed.video === undefined ? {} : { video: probed.video }),
        ...(probed.audio === undefined ? {} : { audio: probed.audio }),
        ingest: {
          at: this.#now().toISOString(),
          ffprobeVersion: probed.ffprobeVersion,
          via: "generated",
        },
        provenance: { sidecar: `provenance-${assetId}` },
        rights,
      };
      const updatedPlan = structuredClone(payload.plan);
      const updatedChunk = updatedPlan.chunks.find(({ id }) => id === chunk.id)!;
      updatedChunk.status = "approved";
      updatedChunk.assetId = assetId;
      updatedChunk.jobId = job.jobId;
      updatedChunk.providerJobId = handle.providerJobId;
      const provenance: RestyleGenerationProvenance = {
        schema: "guyditor.provenance/v1",
        assetId,
        generation: {
          adapterId: adapter.descriptor.adapterId,
          adapterVersion: adapter.descriptor.adapterVersion,
          provider: adapter.descriptor.provider,
          model: payload.plan.model,
          prompt: payload.plan.settings.prompt,
          ...(payload.plan.settings.negativePrompt === undefined
            ? {}
            : { negativePrompt: payload.plan.settings.negativePrompt }),
          settings: {
            width: request.width,
            height: request.height,
            fps: request.fps,
            durationSeconds: request.durationSeconds,
            providerSettings: request.providerSettings,
          },
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          requestId: request.requestId,
          jobId: job.jobId,
          referenceAssetIds: [...request.referenceAssetIds],
          sourceRange: structuredClone(request.sourceRange),
          createdAt: this.#now().toISOString(),
          providerMetadata: structuredClone(result.output.providerMetadata),
        },
        rights,
        contentHash: `sha256:${contentHash}`,
      };
      const proposal = await this.#operationEngine.createProposal({
        operations: [{
          op: "restyle.segment.approve",
          params: {
            deliverableId: payload.plan.deliverableId,
            plan: updatedPlan,
            chunkId: chunk.id,
            cachedPath: result.output.filePath,
            layerId: this.#idFactory("lyr"),
            itemId: this.#idFactory("gfx"),
            asset,
            provenance,
          },
        }],
        instruction: { kind: "skill-policy", text: `Review restyle chunk ${chunk.id}` },
        actor: {
          kind: "agent",
          id: payload.context.sessionId,
          model: "restyle-execution",
        },
        sessionId: payload.context.sessionId,
        reason: {
          text: `Freeze and place the reviewed provider result for ${chunk.id}.`,
          sources: [{ kind: "media-evidence", ref: result.rawResponseRef }],
        },
        addresses: [],
      });
      if (!proposal.ok) throw proposal.error;
      reportProgress(1, 0);
      return jsonValue({
        planId: payload.plan.id,
        chunkId: chunk.id,
        status: "waiting-for-approval",
        proposalId: proposal.value.id,
        providerJobId: handle.providerJobId,
        candidatePath: result.output.filePath,
        contentHash,
        actualCostUsd,
      });
    } catch (error: unknown) {
      if (signal.aborted && handle !== undefined) await adapter.cancel?.(handle).catch(() => undefined);
      throw error;
    } finally {
      if (externalKey !== undefined) this.#external.delete(externalKey);
      release();
    }
  }
}
