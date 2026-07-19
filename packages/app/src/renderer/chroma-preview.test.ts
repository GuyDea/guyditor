import { describe, expect, it } from "vitest";

import { chromaPreviewAlpha } from "./chroma-preview.js";

describe("WebGL chroma preview formula", () => {
  it("matches the normative transparent, blend, and opaque branches", () => {
    const key = [0, 177 / 255, 64 / 255] as const;
    expect(chromaPreviewAlpha(key, key, 0.35, 0.12)).toBe(0);
    expect(chromaPreviewAlpha([1, 1, 1], key, 0.35, 0.12)).toBe(1);

    const similarity = 0.01 + 0.39 * 0.35;
    const blendW = 0.4 * 0.12;
    const blendedDistance = similarity + blendW / 2;
    // Find a deterministic blue-channel sample in the blend band.
    const candidates = Array.from({ length: 256 }, (_, blue) => [0, 177 / 255, blue / 255] as const);
    const sample = candidates.reduce((nearest, candidate) =>
      Math.abs(chromaPreviewAlpha(candidate, key, 0.35, 0.12) - 0.5) <
          Math.abs(chromaPreviewAlpha(nearest, key, 0.35, 0.12) - 0.5)
        ? candidate
        : nearest, candidates[0]!);
    const alpha = chromaPreviewAlpha(sample, key, 0.35, 0.12);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
    expect(blendedDistance).toBeGreaterThan(similarity);
  });
});
