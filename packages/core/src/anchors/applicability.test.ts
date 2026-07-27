import { describe, expect, it } from "vitest";

import {
  placedItemAppliesToSequence,
} from "../index.js";
import type { PlacedItem } from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

function twoSequenceProject() {
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
  return project;
}

function item(overrides: Partial<PlacedItem> = {}): PlacedItem {
  return {
    id: "gfx_aaaaaaaaaa",
    at: "word:w000001",
    duration: { frames: 12, fps: "24/1" },
    ...overrides,
  };
}

describe("placed item sequence applicability", () => {
  it("treats explicit ownership as authoritative and rejects conflicting qualified anchors", () => {
    const project = twoSequenceProject();
    const scoped = item({ sequenceId: "seq_bbbbbbbbbb" });
    expect(placedItemAppliesToSequence(project, scoped, "seq_bbbbbbbbbb")).toBe(true);
    expect(placedItemAppliesToSequence(project, scoped, "seq_aaaaaaaaaa")).toBe(false);

    const conflict = item({
      sequenceId: "seq_bbbbbbbbbb",
      at: "timeline:seq_aaaaaaaaaa@4",
    });
    expect(placedItemAppliesToSequence(project, conflict, "seq_bbbbbbbbbb")).toBe(false);
    expect(placedItemAppliesToSequence(project, conflict, "seq_aaaaaaaaaa")).toBe(false);
  });

  it("infers legacy scope from qualified timeline and clip anchors, including until", () => {
    const project = twoSequenceProject();
    const timeline = item({ at: "timeline:seq_bbbbbbbbbb@4" });
    const clip = item({ at: "clip:clp_cccccccccc@0" });
    const until = item({
      duration: { until: "timeline:seq_bbbbbbbbbb@12" },
    });
    for (const candidate of [timeline, clip, until]) {
      expect(placedItemAppliesToSequence(project, candidate, "seq_bbbbbbbbbb")).toBe(true);
      expect(placedItemAppliesToSequence(project, candidate, "seq_aaaaaaaaaa")).toBe(false);
    }
  });

  it("keeps truly unscoped legacy items global and never leaks conflicting inferred scopes", () => {
    const project = twoSequenceProject();
    const global = item();
    expect(placedItemAppliesToSequence(project, global, "seq_aaaaaaaaaa")).toBe(true);
    expect(placedItemAppliesToSequence(project, global, "seq_bbbbbbbbbb")).toBe(true);

    const conflict = item({
      at: "timeline:seq_aaaaaaaaaa@4",
      duration: { until: "timeline:seq_bbbbbbbbbb@12" },
    });
    expect(placedItemAppliesToSequence(project, conflict, "seq_aaaaaaaaaa")).toBe(false);
    expect(placedItemAppliesToSequence(project, conflict, "seq_bbbbbbbbbb")).toBe(false);
  });
});
