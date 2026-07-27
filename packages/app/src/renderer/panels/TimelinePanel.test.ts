import { describe, expect, it } from "vitest";

import { jumpCutProposalNotice } from "./TimelinePanel.js";

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
