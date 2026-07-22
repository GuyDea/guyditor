import { describe, expect, it } from "vitest";

import type { AvoidRegion, PipConfig } from "../../core/src/index.js";
import { overlapWarning, planCollisionAvoidance } from "./avoidance.js";

const pip: PipConfig = {
  style: { mask: { shape: "rounded", cornerRadius: 0.08 } },
  placement: { base: { anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9" } },
  keyframes: [],
  avoid: {
    enabled: true,
    sources: ["caption", "marked", "safe_area"],
    softOverlapMax: 0.15,
    holdFrames: 60,
    fallbackAnchors: ["bottom_right", "bottom_left", "top_left", "top_right"],
    moveTransition: { preset: "pre_pipsmoothm", durationFrames: 18 },
  },
};

describe("PiP collision avoidance", () => {
  it("relocates immediately for hard caption overlap and returns after expiry", () => {
    const regions: AvoidRegion[] = [{
      id: "avr_aaaaaaaaaa", source: "caption", hardness: "hard",
      rect: { x: 0.7, y: 0.7, w: 0.3, h: 0.3 }, frames: { from: 10, to: 80 },
    }];
    const result = planCollisionAvoidance({
      layerId: "lyr_aaaaaaaaaa", pip, regions, compW: 1920, compH: 1080,
      fromFrame: 0, toFrame: 160,
      semanticAnchorAtFrame: (frame) => frame === 10 ? "word:w000318" : `timeline:seq_aaaaaaaaaa@${String(frame)}`,
      idFactory: (_, index) => index === 0 ? "kfr_aaaaaaaaaa" : "kfr_bbbbbbbbbb",
    });
    expect(result.status).toBe("proposal");
    expect(result.relocations).toEqual([
      expect.objectContaining({ frame: 10, anchor: "bottom_left", reason: "hard-overlap" }),
      expect.objectContaining({ frame: 81, anchor: "bottom_right", reason: "return" }),
    ]);
    expect(result.operations[0]).toMatchObject({
      op: "pip.keyframe.add",
      params: {
        keyframe: {
          at: "word:w000318",
          placement: { anchor: "bottom_left" },
          transition: { preset: "pre_pipsmoothm", durationFrames: 18 },
        },
      },
    });
    expect(result.summaries[0]).toContain("Move presenter to bottom_left at word:w000318");
  });

  it("requires twelve consecutive soft-overlap frames and reports M3 hooks", () => {
    const region: AvoidRegion = {
      id: "avr_aaaaaaaaaa", source: "marked", hardness: "soft",
      rect: { x: 0.7, y: 0.7, w: 0.3, h: 0.3 }, frames: { from: 5, to: 20 },
    };
    const planned = planCollisionAvoidance({
      layerId: "lyr_aaaaaaaaaa",
      pip: { ...pip, avoid: { ...pip.avoid!, sources: ["marked", "face", "diagram"] } },
      regions: [region], compW: 1920, compH: 1080, fromFrame: 0, toFrame: 40,
    });
    expect(planned.relocations[0]?.frame).toBe(16);
    expect(planned.unavailableSources).toEqual(["face", "diagram"]);
    expect(overlapWarning(pip.placement.base, [region], 1920, 1080, 6)).toMatchObject({
      severity: "soft",
    });
  });

  it("collects subject and diagram provider regions for vertical collision solving", () => {
    const subjectRegion: AvoidRegion = {
      id: "avr_bbbbbbbbbb", source: "face", hardness: "soft",
      rect: { x: 0.7, y: 0.7, w: 0.3, h: 0.3 }, frames: { from: 0, to: 20 },
    };
    const diagramRegion: AvoidRegion = {
      id: "avr_cccccccccc", source: "diagram", hardness: "soft",
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, frames: { from: 0, to: 20 },
    };
    const planned = planCollisionAvoidance({
      layerId: "lyr_aaaaaaaaaa",
      sequenceId: "seq_aaaaaaaaaa",
      aspectClass: "9:16",
      pip: { ...pip, avoid: { ...pip.avoid!, sources: ["face", "diagram"] } },
      regions: [], compW: 1080, compH: 1920, fromFrame: 0, toFrame: 40,
      subjectTrackProvider: {
        getSubjectRegions: (sequenceId, range, aspectClass) => {
          expect({ sequenceId, range, aspectClass }).toEqual({
            sequenceId: "seq_aaaaaaaaaa", range: { from: 0, to: 40 }, aspectClass: "9:16",
          });
          return [subjectRegion];
        },
      },
      diagramLayoutProvider: {
        getDiagramRegions: () => [diagramRegion],
      },
    });
    expect(planned.unavailableSources).toEqual([]);
    expect(planned.relocations[0]).toMatchObject({ reason: "soft-overlap" });
  });

  it("treats concrete tracked regions as available collision sources", () => {
    const planned = planCollisionAvoidance({
      layerId: "lyr_aaaaaaaaaa",
      pip: { ...pip, avoid: { ...pip.avoid!, sources: ["face"] } },
      regions: [{
        id: "avr_dddddddddd", source: "face", hardness: "soft",
        rect: { x: 0.7, y: 0.7, w: 0.3, h: 0.3 }, frames: { from: 0, to: 20 },
      }],
      compW: 1080, compH: 1920, fromFrame: 0, toFrame: 40,
    });

    expect(planned.unavailableSources).toEqual([]);
    expect(planned.relocations[0]).toMatchObject({ reason: "soft-overlap" });
  });
});
