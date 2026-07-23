import { describe, expect, it } from "vitest";

import { IPC_SURFACES } from "./surfaces.js";

describe("workspace IPC surfaces", () => {
  it("exposes every M1 workspace read and action with an async budget", () => {
    const methods = new Map(IPC_SURFACES.map(({ service, methods: entries }) => [
      service,
      new Map(Object.entries(entries)),
    ]));

    const expected: Readonly<Record<string, readonly string[]>> = {
      ProjectStore: [
        "getSnapshot",
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
      MediaEngine: ["ingest", "pickAndIngest", "resolveProxy", "readPeaks", "importPickup"],
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
});
