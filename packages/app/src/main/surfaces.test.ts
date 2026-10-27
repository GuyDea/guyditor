import { describe, expect, it } from "vitest";

import { DIVERGENCE_CLASSES } from "../../../core/src/index.js";
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
      "clearKey",
      "get",
      "listModels",
      "setKey",
      "update",
    ]);
  });

  it("exposes the assembly session methods", () => {
    const assembly = IPC_SURFACES.find(({ service }) => service === "Assembly");
    expect(Object.keys(assembly?.methods ?? {}).sort()).toEqual([
      "abandon",
      "create",
      "createProposal",
      "get",
      "list",
      "prepare",
      "send",
    ]);
  });
});
