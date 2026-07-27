import { describe, expect, it } from "vitest";

import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { restyleTimelineInsertions } from "./timeline-insertions.js";

describe("restyle timeline insertion ownership", () => {
  it("enumerates only seams applicable to the requested sequence", () => {
    const project = projectFixture();
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "short",
      clips: [{
        id: "clp_cccccccccc",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 0, fps: "24/1" },
          out: { frames: 12, fps: "24/1" },
        },
      }],
    });
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Shared seams",
      order: 2,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_bbbbbbbbbb",
        sequenceId: "seq_aaaaaaaaaa",
        template: "tpl_callout_text",
        at: "timeline:seq_aaaaaaaaaa@5",
        duration: { frames: 2, fps: "24/1" },
        layout: {
          restyleSeam: {
            seamId: "seam-primary",
            sourceFrame: 5,
            durationFrames: 2,
            resumeExact: true,
          },
        },
      }, {
        id: "gfx_cccccccccc",
        sequenceId: "seq_bbbbbbbbbb",
        template: "tpl_callout_text",
        at: "word:w000001",
        duration: "intrinsic",
        layout: {
          restyleSeam: {
            seamId: "seam-sibling",
            sourceFrame: 5,
            durationFrames: 2,
            resumeExact: true,
          },
        },
      }],
    });

    expect(restyleTimelineInsertions(project, "seq_aaaaaaaaaa")).toEqual([{
      seamId: "seam-primary",
      sourceFrame: 5,
      durationFrames: 2,
    }]);
  });
});
