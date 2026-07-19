import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  analyzeKeyQcFrame,
  buildKeyQcReport,
  keyQcSampleFrames,
  type RgbaFrame,
} from "./key-qc.js";

function frame(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): RgbaFrame {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return { data, height, width };
}

describe("key QC", () => {
  it("samples every twelfth frame plus five frames after shot boundaries", () => {
    expect(keyQcSampleFrames(31, [10, 29])).toEqual([
      0, 10, 11, 12, 13, 14, 24, 29, 30,
    ]);
  });

  it("measures edge contamination, spill, enclosed holes, and static chatter", () => {
    const source = frame(9, 9, (x, y) => {
      if (x >= 2 && x <= 6 && y >= 2 && y <= 6) return [20, 180, 30, 255];
      return [0, 177, 64, 255];
    });
    const keyed = frame(9, 9, (x, y) => {
      if (x === 4 && y === 4) return [20, 180, 30, 0];
      if (x >= 2 && x <= 6 && y >= 2 && y <= 6) {
        const edge = x === 2 || x === 6 || y === 2 || y === 6;
        return [20, 180, 30, edge ? 128 : 255];
      }
      return [0, 177, 64, 0];
    });
    const previous = frame(9, 9, (x, y) => {
      const alpha = x >= 2 && x <= 6 && y >= 2 && y <= 6 ? 255 : 0;
      return [20, 180, 30, alpha];
    });

    const metrics = analyzeKeyQcFrame({
      frame: 12,
      keyColor: "#00B140",
      keyed,
      previousKeyed: previous,
      similarity: 0.2,
      blendW: 0.08,
      source,
    });

    expect(metrics.frame).toBe(12);
    expect(metrics.haloScore).toBeGreaterThan(0.25);
    expect(metrics.spillScore).toBeGreaterThan(0.05);
    expect(metrics.holeCount).toBe(1);
    expect(metrics.holeArea).toBeCloseTo(1 / 81, 6);
    expect(metrics.edgeChatter).toBeGreaterThan(0.04);
    expect(metrics.detailLoss).toBeGreaterThanOrEqual(0);
    expect(metrics.detailLoss).toBeLessThanOrEqual(1);
  });

  it("builds the versioned deterministic report and threshold warnings", () => {
    const keySettings = {
      schema: "guyditor/key@1" as const,
      mode: "chroma" as const,
      chroma: {
        keyColor: "#00B140",
        tolerance: 0.2,
        softness: 0.2,
        preBlur: 0.8,
        edge: { erodePx: 0.5, featherPx: 1 },
        spill: { mode: "despill" as const, strength: 0.7 },
      },
      masks: [],
    };
    const report = buildKeyQcReport({
      assetId: "ast_aaaaaaaaaa",
      clipId: "clp_aaaaaaaaaa",
      keySettings,
      metrics: [{
        detailLoss: 0.7,
        edgeChatter: 0.05,
        frame: 12,
        haloScore: 0.3,
        holeArea: 0.001,
        holeCount: 1,
        spillScore: 0.06,
      }],
    });

    expect(report).toMatchObject({
      schema: "guyditor.keyqc/v1",
      sampledFrames: [12],
      warnings: [
        { code: "halo", frames: [12], peak: 0.3 },
        { code: "spill", frames: [12], peak: 0.06 },
        { code: "holes", frames: [12], peak: 1 },
        { code: "edge_chatter", frames: [12], peak: 0.05 },
        { code: "detail_loss", frames: [12], peak: 0.7 },
      ],
    });
    expect(report.keyParamsHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.keyParamsHash).toBe(createHash("sha256").update(
      JSON.stringify(keySettings),
    ).digest("hex"));
  });
});
