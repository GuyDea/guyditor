import { describe, expect, it, vi } from "vitest";

import type { Annotation } from "../../../core/src/index.js";
import {
  annotationTimelineRequestKey,
  annotationIsVisibleAtFrame,
  directAnnotationTimelineFrame,
  mergeAnnotationTimelineFrames,
  resolveAnnotationTimelineFrames,
} from "./annotation-timeline.js";

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann_aaaaaaaaaa",
    shape: "rect",
    body: "Check this frame",
    geometry: {
      kind: "rect",
      origin: { x: 0.2, y: 0.2 },
      size: { x: 0.3, y: 0.3 },
    },
    anchor: {
      kind: "timeline",
      sequenceId: "seq_aaaaaaaaaa",
      frame: { frames: 30, fps: "30/1" },
    },
    extent: { frames: 0, fps: "30/1" },
    canvasRef: {
      sequenceId: "seq_aaaaaaaaaa",
      deliverableId: "dlv_aaaaaaaaaa",
      aspect: "16:9",
    },
    state: "open",
    blocking: false,
    author: { kind: "human", id: "creator" },
    createdAt: "2000-01-01T00:00:00.000Z",
    history: [],
    ...overrides,
  };
}

describe("annotation timeline projection", () => {
  it("converts direct timeline anchors into the active timeline rate", () => {
    expect(directAnnotationTimelineFrame(
      annotation(),
      "seq_aaaaaaaaaa",
      "24/1",
    )).toEqual({ frames: 24, fps: "24/1" });
    expect(directAnnotationTimelineFrame(
      annotation(),
      "seq_bbbbbbbbbb",
      "24/1",
    )).toBeUndefined();
  });

  it("shows a point annotation for exactly its anchored frame", () => {
    const item = annotation();
    const position = { frames: 30, fps: "30/1" } as const;

    expect(annotationIsVisibleAtFrame(item, position, {
      frames: 30,
      fps: "30/1",
    })).toBe(true);
    expect(annotationIsVisibleAtFrame(item, position, {
      frames: 31,
      fps: "30/1",
    })).toBe(false);
  });

  it("shows a range annotation only across its converted extent", () => {
    const item = annotation({
      shape: "range",
      geometry: null,
      extent: { frames: 30, fps: "30/1" },
    });
    const position = { frames: 24, fps: "24/1" } as const;

    expect(annotationIsVisibleAtFrame(item, position, {
      frames: 47,
      fps: "24/1",
    })).toBe(true);
    expect(annotationIsVisibleAtFrame(item, position, {
      frames: 48,
      fps: "24/1",
    })).toBe(false);
  });

  it("resolves indirect anchors without consulting navigation for direct anchors", async () => {
    const indirect = annotation({
      id: "ann_bbbbbbbbbb",
      anchor: { kind: "word", wordId: "w000001" },
    });
    const resolve = vi.fn(async (item: Annotation) => ({
      frame: {
        frames: item.id === indirect.id ? 42 : 99,
        fps: "24/1" as const,
      },
    }));

    await expect(resolveAnnotationTimelineFrames(
      [annotation(), indirect, annotation({
        id: "ann_cccccccccc",
        canvasRef: { sequenceId: "seq_bbbbbbbbbb", aspect: "9:16" },
      })],
      "seq_aaaaaaaaaa",
      "24/1",
      resolve,
    )).resolves.toEqual({
      ann_aaaaaaaaaa: { frames: 24, fps: "24/1" },
      ann_bbbbbbbbbb: { frames: 42, fps: "24/1" },
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(indirect);
  });

  it("invalidates resolved positions across projects and anchor changes", () => {
    const indirect = annotation({
      anchor: { kind: "word", wordId: "w000001" },
    });
    const projectA = annotationTimelineRequestKey(
      [indirect],
      "/projects/a",
      "seq_aaaaaaaaaa",
      "24/1",
      "rev_00001",
    );

    expect(annotationTimelineRequestKey(
      [indirect],
      "/projects/b",
      "seq_aaaaaaaaaa",
      "24/1",
      "rev_00001",
    )).not.toBe(projectA);
    expect(annotationTimelineRequestKey(
      [annotation()],
      "/projects/a",
      "seq_aaaaaaaaaa",
      "24/1",
      "rev_00001",
    )).not.toBe(projectA);
  });

  it("lets a fresh direct anchor override a cached indirect position", () => {
    expect(mergeAnnotationTimelineFrames(
      { ann_aaaaaaaaaa: { frames: 40, fps: "24/1" } },
      { ann_aaaaaaaaaa: { frames: 10, fps: "24/1" } },
      true,
    )).toEqual({
      ann_aaaaaaaaaa: { frames: 40, fps: "24/1" },
    });
    expect(mergeAnnotationTimelineFrames(
      { ann_aaaaaaaaaa: { frames: 40, fps: "24/1" } },
      { ann_bbbbbbbbbb: { frames: 10, fps: "24/1" } },
      false,
    )).toEqual({
      ann_aaaaaaaaaa: { frames: 40, fps: "24/1" },
    });
  });
});
