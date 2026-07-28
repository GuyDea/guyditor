import { createHash } from "node:crypto";
import {
  readFile,
  stat,
} from "node:fs/promises";
import { extname, join } from "node:path";

import {
  createGenerationReview,
  failure,
  makeGuyditorError,
  makeId,
  touchedDerivativeIds,
} from "../../core/src/index.js";
import type {
  GenerationProvenance,
  IdPrefix,
  JobQueue,
  JobRecord,
  JsonValue,
  OperationEngine,
  ProjectStore,
  Proposal,
  Result,
} from "../../core/src/index.js";

import type {
  CostContext,
  CostEstimate,
  CostMeter,
  Preflight,
} from "./cost-meter.js";
import type { AdapterRegistry } from "./adapters/registry.js";
import { validateTextFreeGenerationRequest } from "./adapters/generation-guard.js";
import type {
  AdapterJobHandle,
  BrollProviderAdapter,
  GenerationRequest,
} from "./adapters/types.js";
import {
  GenerationCandidateStore,
  normalizedGenerationRights,
} from "./generation-candidates.js";
import type { GenerationCandidate } from "./generation-candidates.js";

export type GenerationStartResult =
  | { verdict: "enqueued"; estimate: CostEstimate; job: JobRecord }
  | (Extract<Preflight, { verdict: "warn" | "blocked" }> & { estimate: CostEstimate })
  | {
      verdict: "refused" | "unavailable";
      error: { code: string; message: string; suggestion?: string };
    };

export interface GenerationRequestInput {
  adapterId: string;
  request: GenerationRequest;
  context: CostContext;
  confirmToken?: string;
}

export interface GenerationAcceptancePlacement {
  sequenceId: string;
  atFrame: number;
  durationFrames: number;
}

export interface GenerationExecutionServiceOptions {
  projectStore: ProjectStore;
  operationEngine: Pick<OperationEngine, "createProposal">;
  adapters: AdapterRegistry;
  jobs: JobQueue;
  costMeter: CostMeter;
  candidateStore?: GenerationCandidateStore;
  idFactory?: (prefix: IdPrefix) => string;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface GenerationJobPayload {
  adapterId: string;
  request: GenerationRequest;
  context: CostContext;
  estimate: CostEstimate;
  settingsSchemaHash: string;
  adapterHandle?: AdapterJobHandle;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function asRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function parsePayload(job: JobRecord): GenerationJobPayload {
  const payload = asRecord(job.payload);
  if (payload === undefined) throw new Error("Generation job payload is invalid.");
  return payload as unknown as GenerationJobPayload;
}

function schemaHash(schema: object): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(schema)).digest("hex")}`;
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

function schemaSettingsValid(schema: object, settings: Record<string, unknown>): boolean {
  const source = schema as Record<string, unknown>;
  const properties = typeof source["properties"] === "object" && source["properties"] !== null
    ? source["properties"] as Record<string, unknown>
    : {};
  if (source["additionalProperties"] === false &&
      Object.keys(settings).some((key) => !Object.hasOwn(properties, key))) return false;
  const required = Array.isArray(source["required"])
    ? source["required"].filter((key): key is string => typeof key === "string")
    : [];
  return required.every((key) => settings[key] !== undefined);
}

function requestFailure(code: string, message: string, suggestion?: string): GenerationStartResult {
  return {
    verdict: code === "E_GENERATION_ADAPTER_UNAVAILABLE" ? "unavailable" : "refused",
    error: { code, message, ...(suggestion === undefined ? {} : { suggestion }) },
  };
}

function candidateExtension(mime: string, filePath: string): string {
  if (mime === "video/mp4") return ".mp4";
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  return extname(filePath) || ".bin";
}

function videoSeconds(durationFrames: number, fps: string): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(fps);
  if (match === null) throw new TypeError(`Invalid generation frame rate ${fps}.`);
  return durationFrames * Number(match[2]) / Number(match[1]);
}

export class GenerationExecutionService {
  readonly #projectStore: ProjectStore;
  readonly #operationEngine: Pick<OperationEngine, "createProposal">;
  readonly #adapters: AdapterRegistry;
  readonly #jobs: JobQueue;
  readonly #costMeter: CostMeter;
  readonly #candidates: GenerationCandidateStore;
  readonly #idFactory: (prefix: IdPrefix) => string;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  public constructor(options: GenerationExecutionServiceOptions) {
    this.#projectStore = options.projectStore;
    this.#operationEngine = options.operationEngine;
    this.#adapters = options.adapters;
    this.#jobs = options.jobs;
    this.#costMeter = options.costMeter;
    this.#candidates = options.candidateStore ?? new GenerationCandidateStore({
      projectRoot: options.projectStore.root,
    });
    this.#idFactory = options.idFactory ?? makeId;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? defaultSleep;
    this.#jobs.registerExecutor("broll.generate", (job, context) =>
      this.#execute(job, context.signal, context.reportProgress));
  }

  public async request(input: GenerationRequestInput): Promise<GenerationStartResult> {
    const textFree = validateTextFreeGenerationRequest(input.request);
    if (!textFree.ok) {
      return requestFailure(
        textFree.error.code,
        textFree.error.message,
        textFree.error.suggestion,
      );
    }
    if (input.request.count < 1 || input.request.count > 4 || !Number.isInteger(input.request.count)) {
      return requestFailure("E_GENERATION_REQUEST_INVALID", "Generation count must be from 1 through 4.");
    }
    const adapter = this.#adapters.resolveGeneration(input.adapterId);
    const availability = this.#adapters.generationAvailability(input.adapterId);
    if (adapter === undefined || !availability.available) {
      return requestFailure(
        "E_GENERATION_ADAPTER_UNAVAILABLE",
        availability.reason ?? `Generation adapter ${input.adapterId} is unavailable.`,
      );
    }
    const model = adapter.descriptor.models.find(({ id, mode }) =>
      id === input.request.model && mode === input.request.mode);
    if (model === undefined) {
      return requestFailure(
        "E_GENERATION_MODEL_UNAVAILABLE",
        `Adapter ${input.adapterId} does not offer ${input.request.model} in ${input.request.mode} mode.`,
      );
    }
    if (!schemaSettingsValid(adapter.descriptor.requestSchema, input.request.providerSettings)) {
      return requestFailure(
        "E_GENERATION_PROVIDER_SETTINGS",
        `Provider settings do not match ${input.adapterId}'s pinned request schema.`,
      );
    }
    const estimate = await adapter.estimateCost(input.request);
    if (input.confirmToken !== undefined) {
      if (!this.#costMeter.confirm(input.confirmToken, input.context)) {
        return { verdict: "blocked", level: "task", message: "Cost confirmation is invalid or expired.", estimate };
      }
    } else {
      const preflight = this.#costMeter.preflight(estimate, input.context);
      if (preflight.verdict !== "proceed") return { ...preflight, estimate };
    }
    const payload: GenerationJobPayload = {
      adapterId: adapter.descriptor.adapterId,
      request: structuredClone(input.request),
      context: structuredClone(input.context),
      estimate: structuredClone(estimate),
      settingsSchemaHash: schemaHash(adapter.descriptor.requestSchema),
    };
    const job = this.#jobs.enqueue({
      kind: "broll.generate",
      title: `Generate ${String(input.request.count)} B-roll candidate${input.request.count === 1 ? "" : "s"}`,
      cancellable: true,
      payload: jsonValue(payload),
    });
    return { verdict: "enqueued", estimate, job };
  }

  public reviewQueue(): GenerationCandidate[] {
    return this.#candidates.list().filter(({ status }) => status === "review");
  }

  public candidate(candidateId: string): GenerationCandidate | undefined {
    return this.#candidates.get(candidateId);
  }

  async #updateReview(
    candidateId: string,
    itemId: string,
    update: (item: GenerationCandidate["review"]["checklist"]["items"][number]) => void,
  ): Promise<void> {
    const candidate = this.#candidates.get(candidateId);
    if (candidate === undefined) throw new Error(`Generation candidate ${candidateId} does not exist.`);
    const item = candidate.review.checklist.items.find(({ id }) => id === itemId);
    if (item === undefined) throw new Error(`Generation review item ${itemId} does not exist.`);
    update(item);
    candidate.review.state = "open";
    delete candidate.review.resolvedAt;
    await this.#candidates.save(candidate);
  }

  public addAgentObservation(
    candidateId: string,
    itemId: string,
    observation: string,
  ): Promise<void> {
    return this.#updateReview(candidateId, itemId, (item) => {
      item.agentObservation = observation;
    });
  }

  public recordCreatorJudgment(
    candidateId: string,
    itemId: string,
    state: "pass" | "fail" | "not_applicable",
    note: string,
  ): Promise<void> {
    if (note.trim() === "") throw new TypeError("Generation review judgments require a note.");
    return this.#updateReview(candidateId, itemId, (item) => {
      item.state = state;
      item.note = note;
    });
  }

  public async resolveReview(candidateId: string): Promise<void> {
    const candidate = this.#candidates.get(candidateId);
    if (candidate === undefined) throw new Error(`Generation candidate ${candidateId} does not exist.`);
    if (candidate.review.checklist.items.some(({ state, note, required }) =>
      required && (state === "pending" || note?.trim() === "" || note === undefined))) {
      throw makeGuyditorError(
        "E_GENERATION_REVIEW_INCOMPLETE",
        `Generation review ${candidate.review.annotationId} has incomplete judgments.`,
        { affected: [candidate.review.annotationId] },
      );
    }
    candidate.review.state = "resolved";
    candidate.review.resolvedAt = this.#now().toISOString();
    await this.#candidates.save(candidate);
  }

  public async rejectCandidate(candidateId: string): Promise<void> {
    const candidate = this.#candidates.get(candidateId);
    if (candidate === undefined) throw new Error(`Generation candidate ${candidateId} does not exist.`);
    candidate.status = "rejected";
    candidate.review.state = "rejected";
    await this.#candidates.save(candidate);
  }

  public async acceptCandidate(
    candidateId: string,
    placement: GenerationAcceptancePlacement,
  ): Promise<Result<Proposal>> {
    const candidate = this.#candidates.get(candidateId);
    if (candidate === undefined) {
      return failure(makeGuyditorError(
        "E_GENERATION_CANDIDATE_NOT_FOUND",
        `Generation candidate ${candidateId} does not exist.`,
        { affected: [candidateId] },
      ));
    }
    const assetId = this.#idFactory("ast");
    const layerId = this.#idFactory("lyr");
    const itemId = this.#idFactory("gfx");
    const file = await stat(candidate.filePath);
    const fps = candidate.request.fps ?? this.#projectStore.currentProject.settings.timeline.fps;
    const asset = {
      id: assetId,
      kind: "generated" as const,
      path: `media/generated/${assetId}${candidateExtension(candidate.mime, candidate.filePath)}`,
      sha256: candidate.provenance.contentHash.replace(/^sha256:/u, ""),
      bytes: file.size,
      container: candidate.mime === "video/mp4" ? "mp4" : candidate.mime.split("/")[1],
      probe: {
        ...(candidate.durationSeconds === undefined
          ? {}
          : { duration: { frames: placement.durationFrames, fps } }),
        width: candidate.width,
        height: candidate.height,
        ...(candidate.request.mode === "video" ? { fps } : {}),
      },
      ...(candidate.request.mode === "video"
        ? {
            video: {
              codec: "h264",
              width: candidate.width,
              height: candidate.height,
              fps,
              pixFmt: "yuv420p",
              hasAlpha: false,
              rotation: 0 as const,
            },
          }
        : { image: { width: candidate.width, height: candidate.height, hasAlpha: false } }),
      ingest: {
        at: candidate.provenance.generation.createdAt,
        ffprobeVersion: "adapter-metadata",
        via: "generated" as const,
      },
      provenance: { sidecar: `provenance-${assetId}` },
      rights: structuredClone(candidate.provenance.rights),
    };
    const provenance: GenerationProvenance = {
      ...structuredClone(candidate.provenance),
      assetId,
      reviewAnnotationId: candidate.review.annotationId,
    };
    const operations = [{
      op: "generation.accept",
      params: {
        cachedPath: candidate.filePath,
        asset,
        provenance,
        review: candidate.review,
        placement: { ...placement, layerId, itemId },
      },
    }];
    const divergence = touchedDerivativeIds(
      this.#projectStore.currentProject,
      this.#projectStore.currentProject,
      operations,
    ).length > 0
      ? "graphics" as const
      : undefined;
    const result = await this.#operationEngine.createProposal({
      operations,
      instruction: { kind: "annotation", annotation: candidate.review.annotationId },
      actor: { kind: "agent", id: "generation-review", model: "deterministic-lifecycle" },
      reason: {
        text: "Freeze and place the creator-reviewed generation candidate.",
        sources: [{ kind: "annotation", ref: candidate.review.annotationId }],
      },
      addresses: [],
      ...(divergence === undefined ? {} : { divergence }),
    });
    if (result.ok) {
      candidate.status = "proposed";
      candidate.proposalId = result.value.id;
      await this.#candidates.save(candidate);
    }
    return result;
  }

  public regenerate(
    candidateId: string,
    input: { requestId: string; context: CostContext },
  ): Promise<GenerationStartResult> {
    const candidate = this.#candidates.get(candidateId);
    if (candidate === undefined) {
      return Promise.resolve(requestFailure(
        "E_GENERATION_CANDIDATE_NOT_FOUND",
        `Generation candidate ${candidateId} does not exist.`,
      ));
    }
    return this.request({
      adapterId: candidate.provenance.generation.adapterId,
      context: input.context,
      request: { ...structuredClone(candidate.request), requestId: input.requestId },
    });
  }

  async #execute(
    job: JobRecord,
    signal: AbortSignal,
    reportProgress: (progress: number, etaSeconds?: number) => void,
  ): Promise<JsonValue> {
    const payload = parsePayload(job);
    const adapter = this.#adapters.resolveGeneration(payload.adapterId);
    if (adapter === undefined) {
      throw makeGuyditorError(
        "E_GENERATION_ADAPTER_UNAVAILABLE",
        `Generation adapter ${payload.adapterId} is no longer installed.`,
        { affected: [payload.adapterId], retry: "safe" },
      );
    }
    const startedAt = Date.now();
    let recorded = false;
    const recordCall = (
      outcome: "ok" | "error" | "cancelled",
      actualUsd: number,
    ): void => {
      recorded = true;
      this.#costMeter.record({
        context: payload.context,
        estimate: payload.estimate,
        provider: adapter.descriptor.provider,
        purpose: "broll.generate",
        dataClassesSent: [...adapter.descriptor.dataClassesSent],
        payloadSummary: {
          promptChars: payload.request.prompt.length,
          ...(payload.request.mode === "video" && payload.request.durationFrames !== undefined &&
              payload.request.fps !== undefined
            ? { videoSeconds: videoSeconds(payload.request.durationFrames, payload.request.fps) }
            : {}),
        },
        units: {
          ...(payload.request.mode === "image" ? { images: payload.request.count } : {}),
          ...(payload.request.mode === "video" && payload.request.durationFrames !== undefined &&
              payload.request.fps !== undefined
            ? { seconds: videoSeconds(payload.request.durationFrames, payload.request.fps) }
            : {}),
        },
        actualUsd,
        outcome,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    };
    // A resumed job already transmitted its prompt in an earlier run.
    let callIssued = payload.adapterHandle !== undefined;
    try {
      return await this.#executeSubmitted(
        job,
        payload,
        adapter,
        signal,
        reportProgress,
        recordCall,
        () => { callIssued = true; },
      );
    } catch (error: unknown) {
      // Once the request is on the wire the call is disclosable regardless of
      // how it ends; without this the two paid paths logged nothing at all for
      // a failed or cancelled provider call (NFR-001/NFR-007), and the budget
      // aggregates silently under-counted it.
      if (callIssued && !recorded) {
        recordCall(signal.aborted ? "cancelled" : "error", payload.estimate.amount);
      }
      throw error;
    }
  }

  async #executeSubmitted(
    job: JobRecord,
    payload: GenerationJobPayload,
    adapter: BrollProviderAdapter,
    signal: AbortSignal,
    reportProgress: (progress: number, etaSeconds?: number) => void,
    recordCall: (outcome: "ok" | "error" | "cancelled", actualUsd: number) => void,
    markCallIssued: () => void,
  ): Promise<JsonValue> {
    let handle = payload.adapterHandle;
    if (handle === undefined) {
      markCallIssued();
      handle = await adapter.submit(payload.request, signal);
      payload.adapterHandle = handle;
      const checkpoint = this.#jobs.checkpoint(job.jobId, jsonValue(payload));
      if (!checkpoint.ok) throw checkpoint.error;
    }
    let delay = 2_000;
    let terminal: Awaited<ReturnType<BrollProviderAdapter["poll"]>>;
    while (true) {
      terminal = await adapter.poll(handle);
      if (terminal.state === "succeeded" || terminal.state === "failed") break;
      reportProgress(terminal.progress ?? 0, terminal.etaSeconds);
      await this.#sleep(delay, signal);
      delay = Math.min(30_000, delay * 2);
    }
    if (terminal.state === "failed") {
      throw makeGuyditorError(
        "E_GENERATION_PROVIDER_FAILED",
        terminal.error,
        { affected: [job.jobId], retry: terminal.retry },
      );
    }
    const destination = join(
      this.#projectStore.root,
      ".guyditor/cache/generations",
      job.jobId,
    );
    const fetched = await adapter.fetchResult(handle, destination);
    const brandVisual = this.#projectStore.currentProject.skills.find(({ name }) =>
      name === "brand_visual");
    const candidateIds: string[] = [];
    for (const [index, output] of fetched.outputs.entries()) {
      const contentHash = createHash("sha256").update(await readFile(output.filePath)).digest("hex");
      const candidateId = `${job.jobId}/${String(index)}`;
      const rights = normalizedGenerationRights(adapter.descriptor.provider, output.rights);
      const review = createGenerationReview({
        annotationId: this.#idFactory("ann"),
        candidateId,
        createdAt: this.#now().toISOString(),
        ...(brandVisual === undefined
          ? {}
          : {
              brandVisualSkill: {
                id: brandVisual.id,
                version: brandVisual.version,
                contentHash: brandVisual.contentHash,
              },
            }),
      });
      const candidate: GenerationCandidate = {
        candidateId,
        jobId: job.jobId,
        index,
        status: "review",
        filePath: output.filePath,
        previewPath: output.filePath,
        mime: output.mime,
        width: output.width,
        height: output.height,
        ...(output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds }),
        ...(output.seed === undefined ? {} : { seed: output.seed }),
        request: structuredClone(payload.request),
        provenance: {
          schema: "guyditor.provenance/v1",
          generation: {
            adapterId: adapter.descriptor.adapterId,
            adapterVersion: adapter.descriptor.adapterVersion,
            provider: adapter.descriptor.provider,
            ...(this.#adapters.configuration(adapter.descriptor.adapterId)?.baseUrl === undefined
              ? {}
              : { endpoint: this.#adapters.configuration(adapter.descriptor.adapterId)!.baseUrl }),
            model: payload.request.model,
            prompt: payload.request.prompt,
            negativePrompt: payload.request.negativePrompt ?? null,
            settings: {
              width: payload.request.width,
              height: payload.request.height,
              ...(payload.request.durationFrames === undefined
                ? {}
                : { durationFrames: payload.request.durationFrames }),
              ...(payload.request.fps === undefined ? {} : { fps: payload.request.fps }),
              providerSettings: structuredClone(payload.request.providerSettings),
            },
            settingsSchemaHash: payload.settingsSchemaHash,
            ...(output.seed === undefined ? {} : { seed: output.seed }),
            requestId: payload.request.requestId,
            jobId: job.jobId,
            referenceAssetIds: [...(payload.request.referenceAssetIds ?? [])],
            createdAt: this.#now().toISOString(),
            providerMetadata: structuredClone(output.providerMetadata),
          },
          rights,
          contentHash: `sha256:${contentHash}`,
        },
        review,
        rawResponseRef: fetched.rawResponseRef,
      };
      await this.#candidates.save(candidate);
      candidateIds.push(candidateId);
    }
    recordCall("ok", terminal.actualCostUsd ?? payload.estimate.amount);
    return jsonValue({
      status: "waiting-for-review",
      adapterHandle: handle,
      candidateIds,
      rawResponseRef: fetched.rawResponseRef,
      actualCostUsd: terminal.actualCostUsd ?? payload.estimate.amount,
    });
  }
}
