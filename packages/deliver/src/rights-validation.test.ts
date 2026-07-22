import { describe, expect, it } from "vitest";

import { validateDeliverableRights } from "./index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";

describe("NFR-004 export rights validation hook", () => {
  it.each([
    ["off", "pass", "pass"],
    ["warn", "warnings", "warn"],
    ["block", "blocked", "fail"],
  ] as const)("applies the configured %s requirement level", (level, outcome, status) => {
    const project = projectFixture();
    project.assets[0]!.rights = { origin: "licensed", restrictions: [] };

    expect(validateDeliverableRights(project, "dlv_aaaaaaaaaa", {
      requirementLevel: level,
    })).toEqual({
      outcome,
      checks: level === "off" ? [] : [{
        id: "rights-ast_aaaaaaaaaa",
        code: "E_RIGHTS_MISSING",
        status,
        assetId: "ast_aaaaaaaaaa",
        missingFields: ["licenseName", "licensor"],
        message: "Asset ast_aaaaaaaaaa is missing rights fields: licenseName, licensor.",
      }],
      attributionText: [],
    });
  });

  it("checks only used assets and drafts attribution for compliant restricted media", () => {
    const project = projectFixture();
    project.assets[0]!.rights = {
      origin: "licensed",
      licenseName: "CC-BY-4.0",
      licensor: "Example Artist",
      restrictions: ["attribution-required"],
      attributionText: "Footage © Example Artist, CC BY 4.0",
    };
    project.assets.push({
      id: "ast_bbbbbbbbbb",
      kind: "image",
      path: "unused.png",
      sha256: "b".repeat(64),
      probe: { width: 100, height: 100 },
      rights: { origin: "unknown", restrictions: [] },
    });

    expect(validateDeliverableRights(project, "dlv_aaaaaaaaaa", {
      requirementLevel: "block",
    })).toEqual({
      outcome: "pass",
      checks: [],
      attributionText: ["Footage © Example Artist, CC BY 4.0"],
    });
  });
});
