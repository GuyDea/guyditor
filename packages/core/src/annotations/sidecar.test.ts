import { describe, expect, it } from "vitest";

import * as corePackage from "../index.js";

interface AnnotationApi {
  parseAnnotationSidecar(text: string): unknown;
  serializeAnnotationSidecar(value: unknown): string;
  validateAnnotation(value: unknown): unknown;
}

const base = {
  id: "ann_aaaaaaaaaa",
  body: "",
  anchor: {
    kind: "timeline",
    sequenceId: "seq_aaaaaaaaaa",
    frame: { frames: 12, fps: "24/1" },
  },
  extent: { frames: 0, fps: "24/1" },
  canvasRef: { sequenceId: "seq_aaaaaaaaaa", aspect: "16:9" },
  state: "open",
  blocking: true,
  author: { kind: "human", id: "creator" },
  createdAt: "2026-07-18T12:00:00Z",
  history: [],
} as const;

const records = [
  { ...base, shape: "note", body: "Check this", geometry: null },
  {
    ...base,
    id: "ann_bbbbbbbbbb",
    shape: "pin",
    style: { color: "#ff3355", strokeWidth: 0.004 },
    geometry: { kind: "pin", at: { x: 0.25, y: 0.75 } },
  },
  {
    ...base,
    id: "ann_cccccccccc",
    shape: "rect",
    style: { color: "#ff3355", strokeWidth: 0.004 },
    geometry: {
      kind: "rect",
      origin: { x: -0.25, y: 0 },
      size: { x: 1.25, y: 0.5 },
      rotationDeg: 15,
    },
  },
  {
    ...base,
    id: "ann_dddddddddd",
    shape: "ellipse",
    style: { color: "#ff3355", strokeWidth: 0.004 },
    geometry: {
      kind: "ellipse",
      center: { x: 0.5, y: 0.5 },
      radii: { x: 0.2, y: 0.1 },
    },
  },
  {
    ...base,
    id: "ann_eeeeeeeeee",
    shape: "arrow",
    style: { color: "#ff3355", strokeWidth: 0.004 },
    geometry: {
      kind: "arrow",
      from: { x: 0.6123, y: 0.3814 },
      to: { x: 0.7021, y: 0.2449 },
    },
  },
  {
    ...base,
    id: "ann_ffffffffff",
    shape: "freehand",
    style: { color: "#ff3355", strokeWidth: 0.004 },
    geometry: {
      kind: "freehand",
      points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }],
      closed: false,
    },
  },
  {
    ...base,
    id: "ann_gggggggggg",
    shape: "spotlight",
    style: { color: "#ff3355", strokeWidth: 0.004 },
    geometry: {
      kind: "spotlight",
      region: {
        ellipse: { center: { x: 0.5, y: 0.5 }, radii: { x: 0.2, y: 0.1 } },
      },
      dimOpacity: 0.65,
    },
  },
  {
    ...base,
    id: "ann_hhhhhhhhhh",
    shape: "range",
    geometry: null,
    extent: { frames: 24, fps: "24/1" },
  },
] as const;

describe("guyditor.annotations/v1 sidecar", () => {
  it("validates every Part 8 annotation shape", () => {
    const api = corePackage as unknown as Partial<AnnotationApi>;
    expect(typeof api.validateAnnotation).toBe("function");
    if (api.validateAnnotation === undefined) return;

    for (const annotation of records) {
      expect(api.validateAnnotation(annotation)).toEqual(annotation);
    }
  });

  it("round-trips creation order and emits spatial decimals at six places", () => {
    const api = corePackage as unknown as Partial<AnnotationApi>;
    expect(typeof api.serializeAnnotationSidecar).toBe("function");
    expect(typeof api.parseAnnotationSidecar).toBe("function");
    if (
      api.serializeAnnotationSidecar === undefined ||
      api.parseAnnotationSidecar === undefined
    ) return;

    const sidecar = {
      format: "guyditor.annotations/v1",
      annotations: [records[4], records[1]],
    };
    const serialized = api.serializeAnnotationSidecar(sidecar);

    expect(serialized.startsWith("format: guyditor.annotations/v1\nannotations:\n")).toBe(true);
    expect(serialized).toContain("x: 0.612300");
    expect(serialized).toContain("y: 0.381400");
    expect(serialized.indexOf("ann_eeeeeeeeee")).toBeLessThan(
      serialized.indexOf("ann_bbbbbbbbbb"),
    );
    expect(serialized.endsWith("\n")).toBe(true);
    expect(api.parseAnnotationSidecar(serialized)).toEqual(sidecar);
    expect(api.serializeAnnotationSidecar(api.parseAnnotationSidecar(serialized)))
      .toBe(serialized);
  });

  it("rejects shape/geometry mismatches and coordinate overshoot beyond the limit", () => {
    const api = corePackage as unknown as Partial<AnnotationApi>;
    expect(typeof api.validateAnnotation).toBe("function");
    if (api.validateAnnotation === undefined) return;
    const validate = api.validateAnnotation;

    expect(() => validate({
      ...records[2],
      geometry: { kind: "pin", at: { x: 0.5, y: 0.5 } },
    })).toThrow(/matching geometry/u);
    expect(() => validate({
      ...records[1],
      geometry: { kind: "pin", at: { x: 1.250001, y: 0.5 } },
    })).toThrow(/-0\.25 through 1\.25/u);
  });
});
