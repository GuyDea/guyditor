import { describe, expect, it } from "vitest";

import type { FramingDecision } from "../../deliver/src/index.js";
import { framingPreviewSpec } from "./framing-preview.js";

describe("framingPreviewSpec", () => {
  it("interpolates the effective manual crop and exposes subject boxes", () => {
    const decision: FramingDecision = {
      decisionId: "fd_0001",
      shot: {
        clipId: "clp_aaaaaaaaaa",
        source: {
          start: { frames: 0, fps: "30/1" },
          end: { frames: 90, fps: "30/1" },
        },
      },
      mode: "crop",
      crop: { keyframes: [
        { at: { frames: 0, fps: "30/1" }, rect: { x: 0.1, y: 0, w: 0.316, h: 1 } },
      ] },
      subjects: ["face-1"],
      confidence: 0.9,
      warnings: [],
    };

    expect(framingPreviewSpec({
      decision,
      sourceFrame: 45,
      override: {
        id: "fov_aaaaaaaaaa",
        decisionId: "fd_0001",
        crop: { keyframes: [
          { at: { frames: 0, fps: "30/1" }, rect: { x: 0.2, y: 0, w: 0.316, h: 1 } },
          { at: { frames: 90, fps: "30/1" }, rect: { x: 0.4, y: 0, w: 0.316, h: 1 } },
        ] },
      },
      boxes: [{ kind: "face", trackId: "face-1", x: 0.43, y: 0.2, w: 0.1, h: 0.2, conf: 0.95 }],
      output: { width: 1080, height: 1920 },
      safeArea: { top: 0.06, bottom: 0.26, left: 0.05, right: 0.16 },
    })).toMatchObject({
      decisionId: "fd_0001",
      mode: "crop",
      overridden: true,
      crop: { x: 0.3, y: 0, w: 0.316, h: 1 },
      boxes: [{ trackId: "face-1" }],
      output: { width: 1080, height: 1920 },
    });
  });
});
