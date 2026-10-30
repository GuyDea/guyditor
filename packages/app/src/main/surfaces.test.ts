import { describe, expect, it } from "vitest";

import { DIVERGENCE_CLASSES } from "../../../core/src/index.js";
import { createRpcDispatcher } from "./rpc.js";
import { IPC_SURFACES } from "./surfaces.js";

describe("workspace IPC surfaces", () => {
  it("keeps the operation divergence enum aligned with core", () => {
    const operationSurface = IPC_SURFACES.find(({ service }) =>
      service === "OperationEngine");
    const executeSchema = operationSurface?.methods["execute"]?.paramsSchema as {
      properties?: { divergence?: { enum?: unknown } };
    } | undefined;

    expect(executeSchema?.properties?.divergence?.enum).toEqual(DIVERGENCE_CLASSES);
  });

  it("requires workspace reads and writes to identify the open project", () => {
    const projectSurface = IPC_SURFACES.find(({ service }) =>
      service === "ProjectStore");
    const getSchema = projectSurface?.methods["getWorkspaceState"]
      ?.paramsSchema as { required?: unknown } | undefined;
    const setSchema = projectSurface?.methods["setActiveDeliverable"]
      ?.paramsSchema as { required?: unknown } | undefined;

    expect(getSchema?.required).toEqual(["projectPath"]);
    expect(setSchema?.required).toEqual([
      "projectPath",
      "deliverableId",
    ]);
  });

  it("bounds timeline frame resolution to cache-owned thumbnail requests", () => {
    const media = IPC_SURFACES.find(({ service }) => service === "MediaEngine");
    const method = media?.methods["resolveTimelineFrames"];
    const schema = method?.paramsSchema as {
      required?: unknown;
      properties?: {
        sourceFrames?: { maxItems?: unknown; uniqueItems?: unknown };
        height?: { enum?: unknown };
      };
    } | undefined;

    expect(schema?.required).toEqual(["assetId", "sourceFrames", "height"]);
    expect(schema?.properties?.sourceFrames).toMatchObject({
      maxItems: 12,
      uniqueItems: true,
    });
    expect(schema?.properties?.height?.enum).toEqual([96]);
    expect(method?.resultSchema).toMatchObject({
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        required: ["sourceFrame", "url"],
        properties: {
          sourceFrame: { type: "integer", minimum: 0 },
          url: {
            anyOf: [
              { type: "string", pattern: "^file:" },
              { type: "null" },
            ],
          },
        },
        additionalProperties: false,
      },
    });
  });

  it("exposes every M1 workspace read and action with an async budget", () => {
    const methods = new Map(IPC_SURFACES.map(({ service, methods: entries }) => [
      service,
      new Map(Object.entries(entries)),
    ]));

    const expected: Readonly<Record<string, readonly string[]>> = {
      ProjectStore: [
        "getSnapshot",
        "getWorkspaceState",
        "setActiveDeliverable",
        "pickTemplatePackage",
        "listHistory",
        "listProposals",
        "readTranscript",
        "revealProject",
        "openMaster",
      ],
      OperationEngine: [
        "execute",
        "resolveNavigation",
        "acceptProposal",
        "rejectProposal",
        "supersedeProposal",
        "listJumpCuts",
        "proposeJumpCutConcealment",
      ],
      JobQueue: ["overview"],
      MediaEngine: [
        "ingest",
        "pickAndIngest",
        "resolveProxy",
        "resolveTimelineFrames",
        "readPeaks",
        "importPickup",
      ],
      TranscriptEngine: ["enqueueFillerDetection", "proposePickup"],
      CaptureWatcher: [
        "list", "configure", "reconcile", "listTakes", "listTakeComparisons",
        "compareTakes", "selectTake",
      ],
      AnnotationService: ["list", "get", "contextPackage"],
      CompositorModel: ["matteCandidates", "acceptMatteCandidate"],
      SkillRegistry: [
        "list",
        "versions",
        "get",
        "publish",
        "verify",
        "drafts",
        "createDraft",
        "updateDraft",
        "deleteDraft",
        "publishDraft",
        "diff",
        "pinned",
        "associate",
        "upgrade",
        "captureExample",
      ],
      AdapterRegistry: ["list"],
      DeliverableService: [
        "restylePlan", "createRestylePlan", "startRestyle", "setRestyleSeamTreatment",
        "previewOtioExport", "exportOtio",
      ],
      RenderService: [
        "renderExport",
        "exportReport",
        "graphicsFrame",
        "templateCatalog",
        "templateFrame",
      ],
    };

    for (const [service, names] of Object.entries(expected)) {
      const exposed = methods.get(service as never);
      expect(exposed, `${service} surface`).toBeDefined();
      for (const name of names) {
        const method = exposed?.get(name);
        expect(method, `${service}.${name}`).toBeDefined();
        expect(method?.budgetMs).toBeGreaterThan(0);
      }
    }
    expect(methods.get("JobQueue")?.get("overview")?.budgetMs).toBe(20);
  });

  it("exposes the AI settings methods", () => {
    const ai = IPC_SURFACES.find(({ service }) => service === "AiSettings");
    expect(Object.keys(ai?.methods ?? {}).sort()).toEqual([
      "checkCli",
      "clearKey",
      "get",
      "listModels",
      "setKey",
      "update",
    ]);
  });

  it("validates workspace layout saves", async () => {
    const saved: unknown[] = [];
    const dispatch = createRpcDispatcher(IPC_SURFACES, (service) =>
      service === "WorkspaceLayout"
        ? { get: () => null, update: (params: unknown) => { saved.push(params); } }
        : undefined);
    const call = (method: string, params: unknown) => dispatch({
      v: 1,
      requestId: "req_aaaaaaaaaa",
      service: "WorkspaceLayout",
      method,
      params,
    });

    expect((await call("update", {})).ok).toBe(false);
    expect((await call("update", { clientId: "a", activePhase: "later", layouts: {} })).ok)
      .toBe(false);
    expect((await call("update", { clientId: "a", activePhase: "cut", layouts: 1 })).ok)
      .toBe(false);
    expect((await call("update", { clientId: "a", activePhase: "cut", layouts: {} })).ok)
      .toBe(true);
    expect((await call("get", {})).ok).toBe(true);
    expect(saved).toEqual([{ clientId: "a", activePhase: "cut", layouts: {} }]);
  });

  it("exposes the assembly session methods", () => {
    const assembly = IPC_SURFACES.find(({ service }) => service === "Assembly");
    expect(Object.keys(assembly?.methods ?? {}).sort()).toEqual([
      "abandon",
      "addFiles",
      "create",
      "createProposal",
      "get",
      "list",
      "pickContextFiles",
      "prepare",
      "removeFile",
      "send",
      "setAssets",
      "setScript",
    ]);
    const create = assembly?.methods["create"]?.paramsSchema as { properties: Record<string, unknown> };
    expect(create.properties).not.toHaveProperty("scriptPath");
  });
});
