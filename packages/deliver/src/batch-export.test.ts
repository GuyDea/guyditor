import { describe, expect, it } from "vitest";

import { JobQueue, makeGuyditorError } from "../../core/src/index.js";
import type { ExportValidationResult } from "../../render/src/index.js";
import { BatchExportService } from "./batch-export.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for batch export.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function validation(deliverableId: string, outcome: ExportValidationResult["outcome"]): ExportValidationResult {
  return {
    deliverableId,
    revision: "rev_00001",
    profileId: "youtube-shorts",
    profileVersion: "1.0.0",
    checks: outcome === "blocked" || outcome === "warnings" ? [{
      id: "VAL-401",
      status: outcome === "blocked" ? "fail" : "warn",
      message: outcome === "blocked"
        ? "caption intersects strict controls"
        : "caption intersects soft controls",
      affected: [deliverableId],
    }] : [],
    outcome,
  };
}

describe("BatchExportService", () => {
  it("isolates item failures, aggregates terminal children, and retries only failed items", async () => {
    const queue = JobQueue.open(":memory:", { concurrency: 4 }).queue;
    const exportCalls: string[] = [];
    let cAttempts = 0;
    queue.registerExecutor("fixture.export", async (job) => {
      const payload = job.payload as { deliverableId: string };
      if (payload.deliverableId === "dlv_cccccccccc" && cAttempts++ === 0) {
        throw makeGuyditorError("E_RENDER_SEGMENT_FAILED", "fixture render failed", {
          affected: [payload.deliverableId], retry: "safe",
        });
      }
      return payload;
    });
    queue.registerExecutor("fixture.kit", async (job) => job.payload);
    const service = new BatchExportService({
      queue,
      revision: () => "rev_00001",
      validate: (deliverableId) => Promise.resolve(validation(
        deliverableId,
        deliverableId === "dlv_bbbbbbbbbb"
          ? "blocked"
          : deliverableId === "dlv_dddddddddd" ? "warnings" : "pass",
      )),
      exportOutputSet: (deliverableId) => {
        if (deliverableId === "dlv_eeeeeeeeee") {
          throw makeGuyditorError("E_RENDER_PROFILE", "fixture profile failed", {
            affected: [deliverableId], retry: "none",
          });
        }
        exportCalls.push(deliverableId);
        const job = queue.enqueue({
          kind: "fixture.export",
          title: `Export ${deliverableId}`,
          cancellable: true,
          payload: { deliverableId },
        });
        return Promise.resolve({ jobId: job.jobId });
      },
      enqueueKitBuild: (deliverableId, dependsOn) => Promise.resolve(queue.enqueue({
        kind: "fixture.kit",
        title: `Kit ${deliverableId}`,
        cancellable: true,
        dependsOn: [...dependsOn],
        payload: { deliverableId },
      })),
    });
    try {
      const batch = await service.exportBatch({
        deliverableIds: [
          "dlv_aaaaaaaaaa",
          "dlv_bbbbbbbbbb",
          "dlv_cccccccccc",
          "dlv_dddddddddd",
          "dlv_eeeeeeeeee",
        ],
        buildKits: true,
      });
      await waitFor(() => queue.get(batch.jobId)?.state === "done");
      expect(service.result(batch.jobId).items).toEqual([
        expect.objectContaining({ deliverableId: "dlv_aaaaaaaaaa", state: "done" }),
        expect.objectContaining({
          deliverableId: "dlv_bbbbbbbbbb",
          state: "failed",
          error: expect.objectContaining({ code: "E_EXPORT_VALIDATION_FAILED" }),
        }),
        expect.objectContaining({
          deliverableId: "dlv_cccccccccc",
          state: "failed",
          error: expect.objectContaining({ code: "E_RENDER_SEGMENT_FAILED" }),
        }),
        expect.objectContaining({
          deliverableId: "dlv_dddddddddd",
          state: "failed",
          error: expect.objectContaining({ code: "E_EXPORT_VALIDATION_FAILED" }),
        }),
        expect.objectContaining({
          deliverableId: "dlv_eeeeeeeeee",
          state: "failed",
          error: expect.objectContaining({ code: "E_RENDER_PROFILE" }),
        }),
      ]);
      expect(queue.get(batch.jobId)).toMatchObject({
        kind: "render.batchexport",
        dependencyMode: "terminal",
        dependsOn: expect.arrayContaining(service.result(batch.jobId).items.map(({ jobId }) => jobId)),
      });

      const retry = await service.retryBatch(batch.jobId);
      await waitFor(() => queue.get(retry.jobId)?.state === "done");
      expect(exportCalls).toEqual(["dlv_aaaaaaaaaa", "dlv_cccccccccc", "dlv_cccccccccc"]);
      expect(service.result(retry.jobId).items.map(({ deliverableId }) => deliverableId))
        .toEqual([
          "dlv_bbbbbbbbbb",
          "dlv_cccccccccc",
          "dlv_dddddddddd",
          "dlv_eeeeeeeeee",
        ]);
    } finally {
      queue.close();
    }
  });
});
