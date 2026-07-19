import { describe, expect, it } from "vitest";

import type { PipConfig } from "../../core/src/index.js";
import {
  MOTION_PRESETS,
  compileMotionTransition,
  compilePipTimeline,
  compileSwapBackground,
  evaluatePipAtFrame,
  motionPreset,
} from "./motion.js";

const basePip: PipConfig = {
  style: { mask: { shape: "rounded", cornerRadius: 0.08 } },
  placement: {
    base: { anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9" },
  },
  keyframes: [{
    id: "kfr_aaaaaaaaaa",
    at: "word:w000123",
    placement: { anchor: "bottom_left", width: "24%", margin: "4%", aspect: "16:9" },
    transition: { preset: "pre_pipsmoothm", durationFrames: 18 },
  }],
};

describe("versioned PiP motion presets", () => {
  it("ships every FR-508 preset with a stable versioned ID", () => {
    expect(MOTION_PRESETS.map(({ name }) => name)).toEqual([
      "fade_in", "fade_out", "pop_in", "pop_out", "scale_in", "scale_out",
      "slide_in", "slide_out", "smooth_move", "expand_fullscreen",
      "collapse_fullscreen", "swap_background",
    ]);
    expect(MOTION_PRESETS.every(({ id, version }) =>
      /^pre_[a-z2-7]{10}$/u.test(id) && version === 1)).toBe(true);
    expect(motionPreset("pip-smooth-move").id).toBe("pre_pipsmoothm");
    expect(motionPreset("smooth_move").id).toBe("pre_pipsmoothm");
  });

  it.each(MOTION_PRESETS)("compiles $name to bounded derived transform samples", (preset) => {
    const samples = compileMotionTransition({
      preset,
      from: { rect: { x: 0.72, y: 0.69, w: 0.24, h: 0.24 }, opacity: 1 },
      to: { rect: { x: 0.04, y: 0.69, w: 0.24, h: 0.24 }, opacity: 1 },
      startFrame: 12,
      endFrame: 30,
      sampleEveryFrames: 3,
    });
    expect(samples[0]!.atOutputFrame).toBe(12);
    expect(samples.at(-1)!.atOutputFrame).toBe(30);
    expect(samples.every(({ opacity, rect }) =>
      Number.isFinite(opacity) && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)))
      .toBe(true);
  });

  it("resolves semantic anchors only at compile time and holds between transitions", () => {
    const timeline = compilePipTimeline({
      pip: basePip,
      compWidth: 1920,
      compHeight: 1080,
      sourceAspect: 16 / 9,
      anchorFrames: { "word:w000123": 90 },
      sampleEveryFrames: 3,
    });
    expect(timeline.samples[0]).toMatchObject({ atOutputFrame: 0, source: "base" });
    expect(timeline.samples).toContainEqual(expect.objectContaining({
      atOutputFrame: 72,
      presetId: "pre_pipsmoothm",
    }));
    expect(timeline.samples).toContainEqual(expect.objectContaining({
      atOutputFrame: 90,
      source: "kfr_aaaaaaaaaa",
      presetId: "pre_pipsmoothm",
    }));
    const midpoint = evaluatePipAtFrame(timeline, 81);
    expect(midpoint.rect.x).toBeGreaterThan(0.04);
    expect(midpoint.rect.x).toBeLessThan(0.72);
    expect(evaluatePipAtFrame(timeline, 120).rect.x).toBeCloseTo(0.04, 12);
    expect(() => compilePipTimeline({
      pip: basePip,
      compWidth: 1920,
      compHeight: 1080,
      sourceAspect: 16 / 9,
      anchorFrames: {},
    })).toThrow(expect.objectContaining({ code: "E_PIP_ANCHOR_UNRESOLVED" }));
  });

  it("compiles swap_background as synchronized inverse curve pairs", () => {
    const pair = compileSwapBackground({
      pipRect: { x: 0.72, y: 0.69, w: 0.24, h: 0.24 },
      backgroundRect: { x: 0, y: 0, w: 1, h: 1 },
      startFrame: 10,
      endFrame: 28,
    });
    expect(pair.pip.at(-1)!.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(pair.background.at(-1)!.rect).toEqual({ x: 0.72, y: 0.69, w: 0.24, h: 0.24 });
    expect(pair.pip.map(({ atOutputFrame }) => atOutputFrame))
      .toEqual(pair.background.map(({ atOutputFrame }) => atOutputFrame));
  });
});
