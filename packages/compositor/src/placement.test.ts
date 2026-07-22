import { describe, expect, it } from "vitest";

import {
  constraintsFromDrag,
  formatPlacementConstraints,
  parsePlacementConstraints,
  resolveAspectClass,
  resolveResponsivePlacement,
  solvePlacement,
  solvePlacementPixels,
} from "./placement.js";

describe("PiP placement constraints", () => {
  it("parses and formats the human-readable grammar deterministically", () => {
    const parsed = parsePlacementConstraints([
      "anchor: bottom_right",
      "width: 24%",
      "margin: 4%",
      "aspect: 16:9",
      "fit: contain",
    ].join("\n"));
    expect(parsed).toEqual({
      anchor: "bottom_right",
      width: "24%",
      margin: "4%",
      aspect: "16:9",
      fit: "contain",
    });
    expect(formatPlacementConstraints(parsed)).toBe(
      "anchor: bottom_right, width: 24%, margin: 4%, aspect: 16:9, fit: contain",
    );
  });

  it.each([
    "anchor: nowhere",
    "anchor: bottom_right\nwidth: twenty",
    "anchor: bottom_right\naspect: 16/9",
    "anchor: bottom_right\nunknown: 4%",
    "width: 24%",
  ])("rejects malformed grammar with E_PIP_CONSTRAINT: %s", (text) => {
    expect(() => parsePlacementConstraints(text)).toThrow(expect.objectContaining({
      code: "E_PIP_CONSTRAINT",
      retry: "none",
    }));
  });

  it("uses composition width as the base for margin on both axes", () => {
    expect(solvePlacement({
      anchor: "bottom_right",
      width: "24%",
      margin: "4%",
      aspect: "16:9",
    }, 1920, 1080)).toEqual({
      x: expect.closeTo(0.72, 12),
      y: expect.closeTo(0.6888888888888889, 12),
      w: expect.closeTo(0.24, 12),
      h: expect.closeTo(0.24, 12),
    });
  });

  it("solves height-only, contain, cover, stretch, and default width rules", () => {
    expect(solvePlacement({ anchor: "center", height: "50%", aspect: "1:1" }, 1920, 1080))
      .toEqual({ x: 0.359375, y: 0.25, w: 0.28125, h: 0.5 });
    expect(solvePlacement({
      anchor: "top_left", width: "50%", height: "50%", aspect: "1:1", fit: "contain",
    }, 1920, 1080)).toEqual({ x: 0, y: 0, w: 0.28125, h: 0.5 });
    expect(solvePlacement({
      anchor: "top_left", width: "50%", height: "50%", aspect: "1:1", fit: "cover",
    }, 1920, 1080)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(solvePlacement({
      anchor: "top_left", width: "50%", height: "40%", aspect: "1:1", fit: "stretch",
    }, 1920, 1080)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.4 });
    expect(solvePlacement({ anchor: "center" }, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("rounds final positions nearest and final sizes nearest even", () => {
    expect(solvePlacementPixels({
      anchor: "bottom_right", width: "23.7%", margin: "3.9%", aspect: "16:9",
    }, 1280, 720)).toEqual({ x: 927, y: 499, w: 304, h: 170 });
  });

  it("round-trips a snapped drag to anchor plus margin and an unsnapped drag to offsets", () => {
    const snapped = constraintsFromDrag(
      { x: 0.04, y: 0.6888888888888889, w: 0.24, h: 0.24 },
      1920,
      1080,
      { anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9" },
    );
    expect(snapped).toEqual({
      anchor: "bottom_left",
      width: "24%",
      margin: "4%",
      aspect: "16:9",
    });

    const unsnapped = constraintsFromDrag(
      { x: 0.31, y: 0.3, w: 0.24, h: 0.24 },
      1920,
      1080,
      { anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9" },
    );
    expect(unsnapped.anchor).toBe("center");
    expect(unsnapped.width).toBe("24%");
    expect(unsnapped).toHaveProperty("offset_x");
    expect(unsnapped).toHaveProperty("offset_y");
    expect(solvePlacement(unsnapped, 1920, 1080)).toEqual({
      x: expect.closeTo(0.31, 6),
      y: expect.closeTo(0.3, 6),
      w: expect.closeTo(0.24, 6),
      h: expect.closeTo(0.24, 6),
    });
  });

  it("selects the exact or nearest aspect class and shallow-merges responsive overrides", () => {
    expect(resolveAspectClass("9:16")).toBe("9:16");
    expect(resolveAspectClass("3:4")).toBe("4:5");
    expect(resolveAspectClass("3:4", "9:16")).toBe("9:16");
    expect(resolveResponsivePlacement({
      base: { anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9" },
      overrides: {
        "9:16": { anchor: "top", width: "46%", margin_y: "6%" },
      },
    }, "9:16")).toEqual({
      anchor: "top",
      width: "46%",
      margin: "4%",
      margin_y: "6%",
      aspect: "16:9",
    });
  });
});
