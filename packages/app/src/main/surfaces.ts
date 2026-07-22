import type { IpcSurface, JsonSchema } from "../shared/ipc.js";

const anyResult: JsonSchema = {};
const emptyParams: JsonSchema = { type: "object", additionalProperties: false };
const jobIdParams: JsonSchema = {
  type: "object",
  required: ["jobId"],
  properties: { jobId: { type: "string", pattern: "^job_[a-z2-7]{10}$" } },
  additionalProperties: false,
};
const operationSchema: JsonSchema = {
  type: "object",
  required: ["op", "params"],
  properties: {
    op: { type: "string", pattern: "^[a-z][A-Za-z]*(?:\\.[a-z][A-Za-z]*)+$" },
    params: { type: "object" },
  },
  additionalProperties: false,
};
const assetIdParams: JsonSchema = {
  type: "object",
  required: ["assetId"],
  properties: { assetId: { type: "string", pattern: "^ast_[a-z2-7]{10}$" } },
  additionalProperties: false,
};
const proposalIdParams: JsonSchema = {
  type: "object",
  required: ["proposalId"],
  properties: { proposalId: { type: "string", pattern: "^prp_[a-z2-7]{10}$" } },
  additionalProperties: false,
};
const annotationIdParams: JsonSchema = {
  type: "object",
  required: ["annotationId"],
  properties: { annotationId: { type: "string", pattern: "^ann_[a-z2-7]{10}$" } },
  additionalProperties: false,
};
const deliverableIdParams: JsonSchema = {
  type: "object",
  required: ["deliverableId"],
  properties: { deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" } },
  additionalProperties: false,
};
const candidateIdParams: JsonSchema = {
  type: "object",
  required: ["candidateId"],
  properties: { candidateId: { type: "string", minLength: 1 } },
  additionalProperties: false,
};
const generationRequestProperties = {
  adapterId: { type: "string", minLength: 1 },
  request: {
    type: "object",
    required: [
      "requestId", "mode", "model", "prompt", "width", "height", "count",
      "providerSettings",
    ],
    properties: {
      requestId: { type: "string", minLength: 1 },
      mode: { enum: ["image", "video"] },
      model: { type: "string", minLength: 1 },
      prompt: { type: "string", minLength: 1 },
      negativePrompt: { type: "string" },
      referenceAssetIds: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", pattern: "^ast_[a-z2-7]{10}$" },
      },
      width: { type: "integer", minimum: 16, maximum: 4096 },
      height: { type: "integer", minimum: 16, maximum: 4096 },
      durationFrames: { type: "integer", minimum: 1 },
      fps: { type: "string", pattern: "^[1-9][0-9]*/[1-9][0-9]*$" },
      seed: { type: "integer", minimum: 0, maximum: 4294967295 },
      count: { type: "integer", minimum: 1, maximum: 4 },
      providerSettings: { type: "object" },
    },
    additionalProperties: false,
  },
};
const generationRequestParams: JsonSchema = {
  type: "object",
  required: ["adapterId", "request"],
  properties: generationRequestProperties,
  additionalProperties: false,
};
const skillIdProperty: JsonSchema = { type: "string", pattern: "^skl_[a-z2-7]{10}$" };
const skillVersionProperty: JsonSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
};
const skillIdVersionParams: JsonSchema = {
  type: "object",
  required: ["skillId", "version"],
  properties: { skillId: skillIdProperty, version: skillVersionProperty },
  additionalProperties: false,
};

export const IPC_SURFACES: readonly IpcSurface[] = Object.freeze([
  {
    service: "ProjectStore",
    methods: {
      openDialog: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
      open: {
        paramsSchema: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
      getSnapshot: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
      listHistory: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 20 },
      listProposals: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 20 },
      readTranscript: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 50 },
      revealProject: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
      openMaster: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
    },
  },
  {
    service: "SkillRegistry",
    methods: {
      list: {
        paramsSchema: {
          type: "object",
          required: ["scope"],
          properties: { scope: { enum: ["global", "project", "all"] } },
          additionalProperties: false,
        },
        resultSchema: { type: "array" },
        budgetMs: 50,
      },
      versions: {
        paramsSchema: {
          type: "object",
          required: ["skillId"],
          properties: { skillId: skillIdProperty },
          additionalProperties: false,
        },
        resultSchema: { type: "array" },
        budgetMs: 50,
      },
      get: {
        paramsSchema: {
          type: "object",
          required: ["skillId"],
          properties: { skillId: skillIdProperty, version: skillVersionProperty },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 50,
      },
      publish: {
        paramsSchema: {
          type: "object",
          required: ["directory"],
          properties: { directory: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 100,
      },
      verify: { paramsSchema: skillIdVersionParams, resultSchema: anyResult, budgetMs: 50 },
      drafts: {
        paramsSchema: {
          type: "object",
          properties: { skillId: skillIdProperty },
          additionalProperties: false,
        },
        resultSchema: { type: "array" },
        budgetMs: 50,
      },
      createDraft: {
        paramsSchema: {
          type: "object",
          required: ["skillId", "baseVersion", "version"],
          properties: {
            skillId: skillIdProperty,
            baseVersion: skillVersionProperty,
            version: skillVersionProperty,
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 100,
      },
      updateDraft: {
        paramsSchema: {
          type: "object",
          required: ["skillId", "version"],
          properties: {
            skillId: skillIdProperty,
            version: skillVersionProperty,
            title: { type: "string", minLength: 1 },
            summary: { type: "string", minLength: 1 },
            categories: { type: "array", items: { type: "string" } },
            rules: { type: "array", items: { type: "object" } },
            examples: { type: "object" },
            body: { type: "string" },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 100,
      },
      deleteDraft: { paramsSchema: skillIdVersionParams, resultSchema: anyResult, budgetMs: 100 },
      publishDraft: { paramsSchema: skillIdVersionParams, resultSchema: anyResult, budgetMs: 100 },
      diff: {
        paramsSchema: {
          type: "object",
          required: ["skillId", "fromVersion", "toVersion"],
          properties: {
            skillId: skillIdProperty,
            fromVersion: skillVersionProperty,
            toVersion: skillVersionProperty,
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 50,
      },
      pinned: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 50 },
      associate: { paramsSchema: skillIdVersionParams, resultSchema: anyResult, budgetMs: 150 },
      upgrade: { paramsSchema: skillIdVersionParams, resultSchema: anyResult, budgetMs: 150 },
      captureExample: {
        paramsSchema: {
          type: "object",
          required: ["proposalId", "skillId", "decision", "description"],
          properties: {
            proposalId: { type: "string", pattern: "^prp_[a-z2-7]{10}$" },
            skillId: skillIdProperty,
            decision: { enum: ["approved", "rejected"] },
            description: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
    },
  },
  {
    service: "OperationEngine",
    methods: {
      execute: {
        paramsSchema: {
          type: "object",
          required: ["operations", "intent", "label"],
          properties: {
            operations: { type: "array", items: operationSchema },
            intent: { enum: ["direct", "undo", "redo"] },
            label: { type: "string", minLength: 1 },
            undoOf: { type: "string", pattern: "^txn_[a-z2-7]{10}$" },
            divergence: { enum: ["hook", "order", "pacing", "cuts", "graphics", "captions", "cta", "ending", "framing"] },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      resolveNavigation: {
        paramsSchema: {
          type: "object",
          required: ["target"],
          properties: { target: { type: "object" }, scope: { type: "string" } },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 50,
      },
      acceptProposal: { paramsSchema: proposalIdParams, resultSchema: anyResult, budgetMs: 150 },
      rejectProposal: { paramsSchema: proposalIdParams, resultSchema: anyResult, budgetMs: 50 },
      supersedeProposal: {
        paramsSchema: {
          type: "object",
          required: ["proposalId", "instruction"],
          properties: {
            proposalId: { type: "string", pattern: "^prp_[a-z2-7]{10}$" },
            instruction: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      listJumpCuts: {
        paramsSchema: {
          type: "object",
          required: ["sequenceId"],
          properties: { sequenceId: { type: "string", pattern: "^seq_[a-z2-7]{10}$" } },
          additionalProperties: false,
        },
        resultSchema: { type: "array" },
        budgetMs: 20,
      },
      proposeJumpCutConcealment: {
        paramsSchema: {
          type: "object",
          required: ["sequenceId"],
          properties: {
            sequenceId: { type: "string", pattern: "^seq_[a-z2-7]{10}$" },
            beforeClipId: { type: "string", pattern: "^clp_[a-z2-7]{10}$" },
            config: { type: "object" },
            faceTracks: { type: "object" },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
    },
  },
  {
    service: "JobQueue",
    methods: {
      list: {
        paramsSchema: {
          type: "object",
          properties: {
            kind: { type: "string", minLength: 1 },
            state: {
              oneOf: [
                { enum: ["queued", "running", "done", "failed", "cancelled"] },
                {
                  type: "array",
                  items: { enum: ["queued", "running", "done", "failed", "cancelled"] },
                },
              ],
            },
          },
          additionalProperties: false,
        },
        resultSchema: { type: "array" },
        budgetMs: 20,
      },
      overview: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
      cancel: { paramsSchema: jobIdParams, resultSchema: anyResult, budgetMs: 20 },
      retry: { paramsSchema: jobIdParams, resultSchema: anyResult, budgetMs: 20 },
    },
  },
  {
    service: "MediaEngine",
    methods: {
      ingest: {
        paramsSchema: {
          type: "object",
          required: ["paths"],
          properties: {
            paths: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
      pickAndIngest: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
      resolveProxy: { paramsSchema: assetIdParams, resultSchema: anyResult, budgetMs: 20 },
      readPeaks: { paramsSchema: assetIdParams, resultSchema: anyResult, budgetMs: 50 },
      estimateCacheUse: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
      mlworkerState: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
      importPickup: {
        paramsSchema: {
          type: "object",
          required: ["path", "slug"],
          properties: {
            path: { type: "string", minLength: 1 },
            slug: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 100,
      },
    },
  },
  {
    service: "CompositorModel",
    methods: {
      arrangements: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 20 },
      keyQcReport: {
        paramsSchema: {
          type: "object",
          required: ["clipId"],
          properties: { clipId: { type: "string", pattern: "^clp_[a-z2-7]{10}$" } },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
      captureGuidance: {
        paramsSchema: assetIdParams,
        resultSchema: anyResult,
        budgetMs: 20,
      },
    },
  },
  {
    service: "TranscriptEngine",
    methods: {
      importSubtitles: {
        paramsSchema: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 50,
      },
      findWord: {
        paramsSchema: {
          type: "object",
          required: ["wordId"],
          properties: { wordId: { type: "string", pattern: "^w[0-9]{6}$" } },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
      resolveWord: {
        paramsSchema: {
          type: "object",
          required: ["wordId"],
          properties: { wordId: { type: "string", pattern: "^w[0-9]{6}$" } },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
      enqueueFillerDetection: {
        paramsSchema: {
          type: "object",
          properties: {
            assetIds: {
              type: "array",
              items: { type: "string", pattern: "^ast_[a-z2-7]{10}$" },
            },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
      proposePickup: {
        paramsSchema: {
          type: "object",
          required: ["targetAssetId", "pickupAssetId", "fromWord", "toWord"],
          properties: {
            targetAssetId: { type: "string", pattern: "^ast_[a-z2-7]{10}$" },
            pickupAssetId: { type: "string", pattern: "^ast_[a-z2-7]{10}$" },
            fromWord: { type: "string", pattern: "^w[0-9]{6}$" },
            toWord: { type: "string", pattern: "^w[0-9]{6}$" },
            roomTonePaddingMs: { type: "integer", minimum: 0, maximum: 5000 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
    },
  },
  {
    service: "CaptureWatcher",
    methods: {
      list: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 20 },
      listTakes: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 50 },
      listTakeComparisons: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 50 },
      compareTakes: {
        paramsSchema: {
          type: "object",
          required: ["takeIds"],
          properties: {
            takeIds: {
              type: "array",
              minItems: 2,
              uniqueItems: true,
              items: { type: "string", pattern: "^tak_[a-z2-7]{10}$" },
            },
          },
          additionalProperties: false,
        },
        resultSchema: { type: "array" },
        budgetMs: 500,
      },
      selectTake: {
        paramsSchema: {
          type: "object",
          required: ["comparisonId", "takeId"],
          properties: {
            comparisonId: { type: "string", pattern: "^tkc_[a-z2-7]{10}$" },
            takeId: { type: "string", pattern: "^tak_[a-z2-7]{10}$" },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      configure: {
        paramsSchema: {
          type: "object",
          required: ["watchFolders"],
          properties: {
            watchFolders: {
              type: "array",
              items: {
                type: "object",
                required: ["path", "convention", "autoIngest", "autoJobs"],
                properties: {
                  path: { type: "string", minLength: 1 },
                  convention: { enum: ["guyditor", "flat"] },
                  ignore: { type: "array", items: { type: "string" } },
                  autoIngest: { type: "boolean" },
                  autoJobs: {
                    type: "object",
                    required: ["proxy", "analysis", "transcription"],
                    properties: {
                      proxy: { type: "boolean" },
                      analysis: { type: "boolean" },
                      transcription: { type: "boolean" },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 200,
      },
      reconcile: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 200 },
    },
  },
  {
    service: "AnnotationService",
    methods: {
      list: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 20 },
      get: {
        paramsSchema: annotationIdParams,
        resultSchema: anyResult,
        budgetMs: 20,
      },
      contextPackage: { paramsSchema: annotationIdParams, resultSchema: anyResult, budgetMs: 150 },
    },
  },
  {
    service: "AdapterRegistry",
    methods: {
      list: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 20 },
    },
  },
  {
    service: "GenerationService",
    methods: {
      taxonomy: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 20 },
      adapters: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 20 },
      rightsPolicy: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
      estimate: {
        paramsSchema: generationRequestParams,
        resultSchema: anyResult,
        budgetMs: 50,
      },
      request: {
        paramsSchema: {
          type: "object",
          required: ["adapterId", "request"],
          properties: {
            ...generationRequestProperties,
            confirmToken: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 50,
      },
      reviewQueue: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 50 },
      recordCreatorJudgment: {
        paramsSchema: {
          type: "object",
          required: ["candidateId", "itemId", "state", "note"],
          properties: {
            candidateId: { type: "string", minLength: 1 },
            itemId: { type: "string", minLength: 1 },
            state: { enum: ["pass", "fail", "not_applicable"] },
            note: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 50,
      },
      resolveReview: { paramsSchema: candidateIdParams, resultSchema: anyResult, budgetMs: 50 },
      rejectCandidate: { paramsSchema: candidateIdParams, resultSchema: anyResult, budgetMs: 50 },
      acceptCandidate: {
        paramsSchema: {
          type: "object",
          required: ["candidateId", "sequenceId", "atFrame", "durationFrames"],
          properties: {
            candidateId: { type: "string", minLength: 1 },
            sequenceId: { type: "string", pattern: "^seq_[a-z2-7]{10}$" },
            atFrame: { type: "integer", minimum: 0 },
            durationFrames: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      regenerate: { paramsSchema: candidateIdParams, resultSchema: anyResult, budgetMs: 50 },
      ingestSource: {
        paramsSchema: {
          type: "object",
          required: ["sourceClass", "path"],
          properties: {
            sourceClass: {
              enum: ["local-footage", "licensed-asset", "still-image", "screen-capture"],
            },
            path: { type: "string", minLength: 1 },
            origin: { enum: ["captured", "licensed"] },
            rights: { type: "object" },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 50,
      },
    },
  },
  {
    service: "DeliverableService",
    methods: {
      publishState: { paramsSchema: deliverableIdParams, resultSchema: anyResult, budgetMs: 20 },
      draftMetadata: { paramsSchema: deliverableIdParams, resultSchema: anyResult, budgetMs: 150 },
      saveMetadata: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId", "metadata"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            metadata: { type: "object" },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      generateChapters: { paramsSchema: deliverableIdParams, resultSchema: anyResult, budgetMs: 150 },
      approvePublish: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId", "targets"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            targets: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { enum: ["metadata", "chapters"] },
            },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      selectThumbnail: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId", "composition"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            composition: { type: ["string", "null"] },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      writeTextExports: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId", "targets"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            targets: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { enum: ["transcript", "chapters", "metadata"] },
            },
          },
          additionalProperties: false,
        },
        resultSchema: { type: "array" },
        budgetMs: 150,
      },
      renderOutputSet: { paramsSchema: deliverableIdParams, resultSchema: anyResult, budgetMs: 150 },
      buildKit: { paramsSchema: deliverableIdParams, resultSchema: anyResult, budgetMs: 20 },
      batchExport: {
        paramsSchema: {
          type: "object",
          required: ["deliverableIds"],
          properties: {
            deliverableIds: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            },
            buildKits: { type: "boolean" },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      batchResult: { paramsSchema: jobIdParams, resultSchema: anyResult, budgetMs: 20 },
      retryBatch: { paramsSchema: jobIdParams, resultSchema: anyResult, budgetMs: 150 },
      profiles: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 50 },
      candidates: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 50 },
      discoverCandidates: {
        paramsSchema: {
          type: "object",
          required: ["profile"],
          properties: {
            profile: { type: "string", pattern: "^[a-z0-9-]+@[0-9]+\\.[0-9]+\\.[0-9]+$" },
            maxCandidates: { type: "integer", minimum: 1, maximum: 100 },
            constraints: { type: "object" },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
      derive: {
        paramsSchema: {
          type: "object",
          required: ["name", "profile"],
          anyOf: [{ required: ["selection"] }, { required: ["candidateId"] }],
          properties: {
            name: { type: "string", minLength: 1 },
            profile: { type: "string", pattern: "^[a-z0-9-]+@[0-9]+\\.[0-9]+\\.[0-9]+$" },
            profileOverrides: { type: "object" },
            selection: { type: "object" },
            candidateId: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      refresh: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId"],
          properties: { deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" } },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      restylePlan: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 50,
      },
      createRestylePlan: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId", "coverage", "prompt"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            adapterId: { type: "string", pattern: "^adp_[a-z2-7]{10}$" },
            coverage: {
              oneOf: [
                { const: "full" },
                {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    required: ["startFrame", "endFrame"],
                    properties: {
                      startFrame: { type: "integer", minimum: 0 },
                      endFrame: { type: "integer", minimum: 1 },
                    },
                    additionalProperties: false,
                  },
                },
              ],
            },
            prompt: { type: "string", minLength: 1 },
            negativePrompt: { type: "string" },
            seed: { type: "integer", minimum: 0, maximum: 4294967295 },
            providerSettings: { type: "object" },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
      startRestyle: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            confirmToken: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
      setRestyleSeamTreatment: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId", "seamId", "treatment"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            seamId: { type: "string", pattern: "^restyle-seam-[A-Za-z0-9._-]+$" },
            treatment: {
              oneOf: [
                {
                  type: "object",
                  required: ["kind", "templateId", "params", "durationFrames", "resumeExact"],
                  properties: {
                    kind: { const: "interstitial" },
                    templateId: { type: "string", pattern: "^tpl_[a-z2-7]{10}$" },
                    params: { type: "object" },
                    durationFrames: { type: "integer", minimum: 1 },
                    resumeExact: { const: true },
                  },
                  additionalProperties: false,
                },
                {
                  type: "object",
                  required: ["kind"],
                  properties: { kind: { const: "punch-in" } },
                  additionalProperties: false,
                },
                {
                  type: "object",
                  required: ["kind"],
                  properties: { kind: { const: "none" } },
                  additionalProperties: false,
                },
              ],
            },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 150,
      },
    },
  },
  {
    service: "RenderService",
    methods: {
      cacheStats: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
      captionFrame: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId", "revision", "frame"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            revision: { type: "string", pattern: "^rev_[0-9]{5}$" },
            frame: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 50,
      },
      framingFrame: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId", "revision", "frame"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            revision: { type: "string", pattern: "^rev_[0-9]{5}$" },
            frame: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 50,
      },
      graphicsFrame: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId", "revision", "frame"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            revision: { type: "string", pattern: "^rev_[0-9]{5}$" },
            frame: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 100,
      },
      templateCatalog: {
        paramsSchema: emptyParams,
        resultSchema: { type: "array" },
        budgetMs: 100,
      },
      templateFrame: {
        paramsSchema: {
          type: "object",
          required: ["templateId"],
          properties: {
            templateId: { type: "string", pattern: "^tpl_[a-z2-7]{10}$" },
            params: { type: "object" },
            seed: { type: "integer", minimum: 0, maximum: 4294967295 },
            frame: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 100,
      },
      renderExport: { paramsSchema: { type: "object" }, resultSchema: anyResult, budgetMs: 20 },
      renderDiagnostic: { paramsSchema: { type: "object" }, resultSchema: anyResult, budgetMs: 20 },
      validateExport: {
        paramsSchema: {
          type: "object",
          required: ["deliverableId", "revision"],
          properties: {
            deliverableId: { type: "string", pattern: "^dlv_[a-z2-7]{10}$" },
            revision: { type: "string", pattern: "^rev_[0-9]{5}$" },
          },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
      exportReport: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 50 },
    },
  },
  {
    service: "AuditLog",
    methods: {
      readSession: {
        paramsSchema: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", pattern: "^ses_[a-z2-7]{10}$" } },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
    },
  },
  {
    service: "CostMeter",
    methods: {
      status: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
    },
  },
]);
