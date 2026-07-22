import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  BROLL_SOURCE_TAXONOMY,
  makeGuyditorError,
  makeId,
  rightsCompliance,
} from "../../../core/src/index.js";
import type {
  JobRecord,
  ProjectStore,
  Proposal,
  RightsMetadata,
  RightsPolicy,
} from "../../../core/src/index.js";
import { resolveBrollSourcePath } from "../../../media/src/index.js";
import type { MediaEngine } from "../../../media/src/index.js";
import {
  AdapterRegistry,
  ComfyUiGenerationAdapter,
  DeterministicGenerationAdapter,
  HttpGenerationAdapter,
} from "../../../agent/src/index.js";
import type {
  CredentialStore,
  GenerationExecutionService,
  GenerationRequest,
} from "../../../agent/src/index.js";

import type { JobStatus } from "../shared/ipc.js";
import type { IpcService } from "./rpc.js";

export function registerBuiltInGenerationAdapters(
  adapters: AdapterRegistry,
  credentials: CredentialStore,
): void {
  const deterministic = new DeterministicGenerationAdapter();
  adapters.register(deterministic);
  adapters.configure(deterministic.descriptor.adapterId, {
    enabled: true,
    model: deterministic.descriptor.models[0]!.id,
  });

  const http = new HttpGenerationAdapter({
    credentials,
    config: {
      enabled: false,
      apiKeyRef: "generationApiKey",
      baseUrl: "https://api.example.invalid/v1",
      models: [
        { id: "image-1", mode: "image" },
        { id: "video-1", mode: "video" },
      ],
      pricing: {
        currency: "USD",
        imagePerOutput: { default: 0 },
        videoPerSecond: { default: 0 },
      },
    },
  });
  adapters.register(http);
  adapters.configure(http.descriptor.adapterId, {
    enabled: false,
    baseUrl: "https://api.example.invalid/v1",
    apiKeyRef: "generationApiKey",
  });

  const comfyUi = new ComfyUiGenerationAdapter({
    config: { enabled: false, workflows: {} },
  });
  adapters.register(comfyUi);
  adapters.configure(comfyUi.descriptor.adapterId, {
    enabled: false,
    baseUrl: "http://127.0.0.1:8188",
  });
}

function publicJobStatus(job: JobRecord): JobStatus {
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

export interface GenerationServiceOptions {
  store: ProjectStore;
  media: MediaEngine;
  adapters: AdapterRegistry;
  generation: GenerationExecutionService;
  rightsPolicy: RightsPolicy;
  acceptProposal: (proposalId: string) => Promise<Proposal>;
}

export function generationService(options: GenerationServiceOptions): IpcService {
  return {
    taxonomy: () => structuredClone(BROLL_SOURCE_TAXONOMY),
    adapters: () => options.adapters.generationAdapters().map((adapter) => ({
      descriptor: structuredClone(adapter.descriptor),
      configuration: options.adapters.configuration(adapter.descriptor.adapterId),
    })),
    rightsPolicy: () => structuredClone(options.rightsPolicy),
    estimate: async ({ adapterId, request }: {
      adapterId: string;
      request: GenerationRequest;
    }) => {
      const adapter = options.adapters.resolveGeneration(adapterId);
      const availability = options.adapters.generationAvailability(adapterId);
      if (adapter === undefined || !availability.available) {
        return { availability, estimate: null };
      }
      return {
        availability,
        estimate: await adapter.estimateCost(request),
      };
    },
    request: async ({ adapterId, request, confirmToken }: {
      adapterId: string;
      request: GenerationRequest;
      confirmToken?: string;
    }) => {
      const result = await options.generation.request({
        adapterId,
        request,
        context: {
          sessionId: makeId("ses"),
          projectId: options.store.currentProject.project.id,
          taskId: request.requestId,
          initiator: "creator",
        },
        ...(confirmToken === undefined ? {} : { confirmToken }),
      });
      return result.verdict === "enqueued"
        ? { ...result, job: publicJobStatus(result.job) }
        : result;
    },
    reviewQueue: () => options.generation.reviewQueue().map((candidate) => ({
      ...candidate,
      previewUrl: pathToFileURL(candidate.previewPath).href,
      rightsCompliance: rightsCompliance(candidate.provenance.rights, options.rightsPolicy),
    })),
    recordCreatorJudgment: (params: {
      candidateId: string;
      itemId: string;
      state: "pass" | "fail" | "not_applicable";
      note: string;
    }) => options.generation.recordCreatorJudgment(
      params.candidateId,
      params.itemId,
      params.state,
      params.note,
    ),
    resolveReview: ({ candidateId }: { candidateId: string }) =>
      options.generation.resolveReview(candidateId),
    rejectCandidate: ({ candidateId }: { candidateId: string }) =>
      options.generation.rejectCandidate(candidateId),
    acceptCandidate: async ({ candidateId, sequenceId, atFrame, durationFrames }: {
      candidateId: string;
      sequenceId: string;
      atFrame: number;
      durationFrames: number;
    }) => {
      const proposal = await options.generation.acceptCandidate(candidateId, {
        sequenceId,
        atFrame,
        durationFrames,
      });
      if (!proposal.ok) throw proposal.error;
      return options.acceptProposal(proposal.value.id);
    },
    regenerate: ({ candidateId }: { candidateId: string }) => options.generation.regenerate(
      candidateId,
      {
        requestId: `generation-${randomUUID()}`,
        context: {
          sessionId: makeId("ses"),
          projectId: options.store.currentProject.project.id,
          taskId: `regenerate-${candidateId}-${randomUUID()}`,
          initiator: "creator",
        },
      },
    ),
    ingestSource: ({ sourceClass, path, origin, rights }: {
      sourceClass: "local-footage" | "licensed-asset" | "still-image" | "screen-capture";
      path: string;
      origin?: "captured" | "licensed";
      rights?: Partial<RightsMetadata>;
    }) => {
      const routed = resolveBrollSourcePath({
        sourceClass,
        path,
        ...(origin === undefined ? {} : { origin }),
        ...(rights === undefined ? {} : { rights }),
      });
      if (routed.kind !== "ingest") {
        throw new Error(`B-roll source ${sourceClass} does not route through ingest.`);
      }
      const compliance = rightsCompliance(
        routed.request.sources[0]?.rights,
        options.rightsPolicy,
      );
      if (compliance.severity === "error") {
        throw makeGuyditorError(
          "E_RIGHTS_MISSING",
          `B-roll source is missing required rights fields: ${compliance.missingFields.join(", ")}.`,
          { affected: [path], retry: "none" },
        );
      }
      return {
        job: publicJobStatus(options.media.ingest(options.store, routed.request)),
        rightsCompliance: compliance,
      };
    },
  };
}
