import { describe, expect, it } from "vitest";

import * as corePackage from "../index.js";

interface CoordinateApi {
  fitMapGeometry(
    geometry: unknown,
    authoredAspect: string,
    targetAspect: string,
  ): { geometry: unknown; approximate: boolean };
  normalizeAnnotationGeometry(geometry: unknown, aspect: string): unknown;
  normalizeCanvasPoint(
    point: { x: number; y: number },
    raster: { width: number; height: number },
  ): { x: number; y: number };
  normalizedPointToPixels(
    point: { x: number; y: number },
    raster: { width: number; height: number },
  ): { x: number; y: number };
}

describe("annotation normalized coordinates", () => {
  it("normalizes each canvas axis independently and maps it back to pixels", () => {
    const api = corePackage as unknown as Partial<CoordinateApi>;
    expect(typeof api.normalizeCanvasPoint).toBe("function");
    expect(typeof api.normalizedPointToPixels).toBe("function");
    if (
      api.normalizeCanvasPoint === undefined ||
      api.normalizedPointToPixels === undefined
    ) return;

    const normalized = api.normalizeCanvasPoint(
      { x: 960, y: 270 },
      { width: 1920, height: 1080 },
    );
    expect(normalized).toEqual({ x: 0.5, y: 0.25 });
    expect(api.normalizedPointToPixels(normalized, { width: 3840, height: 2160 }))
      .toEqual({ x: 1920, y: 540 });
  });

  it("fit-maps an authored canvas with contain centering and marks it approximate", () => {
    const api = corePackage as unknown as Partial<CoordinateApi>;
    expect(typeof api.fitMapGeometry).toBe("function");
    if (api.fitMapGeometry === undefined) return;

    expect(api.fitMapGeometry(
      { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
      "16:9",
      "9:16",
    )).toEqual({
      geometry: {
        kind: "arrow",
        from: { x: 0, y: 0.341797 },
        to: { x: 1, y: 0.658203 },
      },
      approximate: true,
    });
  });

  it("simplifies freehand input with the 0.002 height epsilon and 512-point cap", () => {
    const api = corePackage as unknown as Partial<CoordinateApi>;
    expect(typeof api.normalizeAnnotationGeometry).toBe("function");
    if (api.normalizeAnnotationGeometry === undefined) return;

    const points = Array.from({ length: 1_025 }, (_, index) => ({
      x: index / 1_024,
      y: index / 1_024,
    }));
    expect(api.normalizeAnnotationGeometry({
      kind: "freehand",
      points,
      closed: false,
    }, "16:9")).toEqual({
      kind: "freehand",
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      closed: false,
    });
  });
});
