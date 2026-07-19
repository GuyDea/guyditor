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
      ],
      MediaEngine: ["ingest", "pickAndIngest", "resolveProxy", "readPeaks"],
      TranscriptEngine: ["enqueueFillerDetection"],
      AnnotationService: ["list", "get", "contextPackage"],
      RenderService: ["renderExport", "exportReport"],
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
  });
});
