import { describe, expect, it } from "vitest";

import type { Asset } from "../../../../core/src/index.js";
import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import {
  jumpCutProposalNotice,
  timelineMediaRequests,
} from "./TimelinePanel.js";

describe("timeline media requests", () => {
  it("builds media requests for every visible clip without consulting selection", () => {
    const asset = {
      ...projectFixture().assets[0]!,
      video: {
        codec: "h264",
        width: 1920,
        height: 1080,
        fps: "24/1",
        pixFmt: "yuv420p",
        hasAlpha: false,
        rotation: 0 as const,
      },
      audio: [{
        index: 0,
        codec: "aac",
        sampleRate: 48_000,
        channels: 1,
        layout: "mono",
      }],
    } satisfies Asset;
    const clips = projectFixture().sequences[0]!.clips;

    expect(timelineMediaRequests([
      { clipId: "clp_aaaaaaaaaa", width: 96 },
      { clipId: "clp_bbbbbbbbbb", width: 144 },
    ], clips, [asset]).map(({ clip }) => clip.id))
      .toEqual(["clp_aaaaaaaaaa", "clp_bbbbbbbbbb"]);
  });
});

describe("jump-cut proposal notices", () => {
  it("reports every split proposal instead of implying the first is the whole plan", () => {
    expect(jumpCutProposalNotice({
      report: "Prepared two concealment operations.",
      proposals: [{ id: "prp_aaaaaaaaaa" }, { id: "prp_bbbbbbbbbb" }],
    })).toBe(
      "Prepared 2 review proposals prp_aaaaaaaaaa and prp_bbbbbbbbbb for the flagged cut.",
    );
  });

  it("uses the planner report when no proposal was created", () => {
    expect(jumpCutProposalNotice({
      report: "No concealment was applicable.",
      proposals: [],
    })).toBe("No concealment was applicable.");
  });
});
