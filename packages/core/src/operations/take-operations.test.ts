import { describe, expect, it } from "vitest";

import { OperationEngine } from "./engine.js";
import { projectFixture } from "../project/test-fixtures.js";

const HASH = "c".repeat(64);

describe("take metadata operations", () => {
  it("attaches marker/take IDs and the hashed load-bearing sidecar as low-risk metadata", async () => {
    const project = projectFixture();
    const result = await new OperationEngine(project).execute([
      {
        op: "asset.markers.attach",
        params: {
          assetId: "ast_aaaaaaaaaa",
          markerIds: ["mrk_aaaaaaaaaa", "mrk_bbbbbbbbbb"],
          sidecar: { path: "sidecars/takes/ast_aaaaaaaaaa.takes.json", sha256: HASH },
        },
      },
      {
        op: "asset.takes.set",
        params: {
          assetId: "ast_aaaaaaaaaa",
          takeIds: ["tak_aaaaaaaaaa"],
          sidecar: { path: "sidecars/takes/ast_aaaaaaaaaa.takes.json", sha256: HASH },
        },
      },
    ], { baseRevision: project.revision, origin: "ui", dryRun: true });

    expect(result).toMatchObject({
      ok: true,
      value: {
        riskClass: "low",
        applied: [
          { op: "asset.markers.attach", captionImpact: "none" },
          { op: "asset.takes.set", captionImpact: "none" },
        ],
        diff: { entries: [
          { entityId: "ast_aaaaaaaaaa", fields: [{ field: "markers" }] },
          {
            entityId: "takes-ast_aaaaaaaaaa",
            entityType: "sidecar",
            change: "added",
          },
          { entityId: "ast_aaaaaaaaaa", fields: [{ field: "takes" }] },
        ] },
      },
    });
  });
});
