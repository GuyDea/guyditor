import { describe, expect, it } from "vitest";

import { JobQueue, ProjectStore } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { RenderService } from "./service.js";

describe("deliverable export lifecycle", () => {
  it("refuses a stale deliverable with the refresh instruction", async () => {
    const project = projectFixture();
    project.deliverables[0]!.status = "stale";
    const queue = JobQueue.open(":memory:").queue;
    try {
      const service = new RenderService({
        projectRoot: "/tmp",
        store: new ProjectStore("/tmp", project),
        jobQueue: queue,
      });
      await expect(service.renderExport({
        revision: project.revision,
        deliverableId: project.deliverables[0]!.id,
        variants: ["clean"],
        outputDir: "/tmp",
      })).rejects.toMatchObject({
        code: "E_DELIVERABLE_STALE",
        retry: "none",
        acceptedStateChanged: false,
        suggestion: "Run deliverable.refresh and review the diff",
      });
      expect(queue.list()).toHaveLength(0);
    } finally {
      queue.close();
    }
  });
});
