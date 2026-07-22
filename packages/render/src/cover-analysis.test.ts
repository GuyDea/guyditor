import { describe, expect, it } from "vitest";

import { laplacianVariance } from "./cover-analysis.js";

describe("cover sharpness analysis", () => {
  it("scores an edge-rich grayscale frame above a flat frame", () => {
    const flat = new Uint8Array(25).fill(120);
    const edge = Uint8Array.from({ length: 25 }, (_, index) => index % 2 === 0 ? 0 : 255);

    expect(laplacianVariance(flat, 5, 5)).toBe(0);
    expect(laplacianVariance(edge, 5, 5)).toBeGreaterThan(0);
  });

  it("rejects buffers that do not match the declared dimensions", () => {
    expect(() => laplacianVariance(new Uint8Array(8), 3, 3))
      .toThrow("Grayscale frame has 8 bytes; expected 9.");
  });
});
