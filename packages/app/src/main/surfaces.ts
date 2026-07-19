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
    },
  },
  {
    service: "TranscriptEngine",
    methods: {
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
    service: "RenderService",
    methods: {
      cacheStats: { paramsSchema: emptyParams, resultSchema: anyResult, budgetMs: 20 },
      renderExport: { paramsSchema: { type: "object" }, resultSchema: anyResult, budgetMs: 20 },
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
