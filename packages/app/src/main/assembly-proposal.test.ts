import { describe, expect, it } from "vitest";

import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import type { CompiledCut } from "../../../transcript/src/index.js";

import { rederiveStarts } from "./assembly-proposal.js";

describe("rederiveStarts", () => {
  it("sums the lengths of the clips before each cut", () => {
    const project = projectFixture();
    const fps = "24/1";
    project.sequences[0]!.clips.push({
      id: "clp_cccccccccc",
      asset: "ast_aaaaaaaaaa",
      source: { in: { frames: 0, fps }, out: { frames: 10, fps } },
    });
    const cut = { index: 2, timelineStart: { frames: 999, fps } } as CompiledCut;
    expect(rederiveStarts(project, "seq_aaaaaaaaaa", [cut])[0]!.timelineStart).toEqual({ frames: 48, fps });
  });
});
