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
    },
  },
  {
    service: "AnnotationService",
    methods: {
      list: { paramsSchema: emptyParams, resultSchema: { type: "array" }, budgetMs: 20 },
      get: {
        paramsSchema: {
          type: "object",
          required: ["annotationId"],
          properties: { annotationId: { type: "string", pattern: "^ann_[a-z2-7]{10}$" } },
          additionalProperties: false,
        },
        resultSchema: anyResult,
        budgetMs: 20,
      },
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
