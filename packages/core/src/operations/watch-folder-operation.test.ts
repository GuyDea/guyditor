import { describe, expect, it } from "vitest";

import { OperationEngine } from "./engine.js";
import { projectFixture } from "../project/test-fixtures.js";

describe("project.watchFolders.set", () => {
  it("persists validated capture configuration as reversible low-risk project metadata", async () => {
    const project = projectFixture();
    const result = await new OperationEngine(project).execute([{
      op: "project.watchFolders.set",
      params: { watchFolders: [{
        path: "/capture",
        convention: "guyditor",
        ignore: ["renders/**"],
        autoIngest: true,
        autoJobs: { proxy: true, analysis: true, transcription: true },
      }] },
    }], { baseRevision: project.revision, origin: "ui", dryRun: true });

    expect(result).toMatchObject({
      ok: true,
      value: {
        riskClass: "low",
        applied: [{
          inverse: [{ op: "project.watchFolders.set", params: { watchFolders: [] } }],
          affected: ["prj_aaaaaaaaaa"],
        }],
      },
    });
  });
});
