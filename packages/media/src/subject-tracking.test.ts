import { describe, expect, it } from "vitest";

import {
  createSubjectTrackAnalysis,
  parseSubjectTrackAnalysis,
  serializeSubjectTrackAnalysis,
  subjectTrackSidecarPath,
} from "./subject-tracking.js";
import { subjectTrackAvoidRegions } from "./subject-avoidance.js";

describe("guyditor.analysis/v1 subject.track", () => {
  it("wraps the worker result in the one canonical normalized tracking sidecar", () => {
    const sidecar = createSubjectTrackAnalysis({
      assetId: "ast_aaaaaaaaaa",
      sourceHash: "a".repeat(64),
      params: { sampleEvery: 3 },
      createdAt: "2026-07-22T10:00:00.000Z",
      toolVersions: { mediapipe: "0.10.35", mlworker: "1.0.0" },
      result: {
        frameCount: 2,
        width: 1280,
        height: 720,
        fps: 30,
        sampleEvery: 3,
        samples: [{
          frame: 0,
          boxes: [{
            kind: "object", trackId: "trk_object0001",
            x: 0.2, y: 0.3, w: 0.1, h: 0.2, conf: 0.9,
          }],
        }],
        engine: { name: "mediapipe", version: "0.10.35" },
      },
    });
    expect(subjectTrackSidecarPath(sidecar.assetId)).toBe(
      "sidecars/analysis/ast_aaaaaaaaaa.subject.track.json",
    );
    expect(sidecar).toMatchObject({
      format: "guyditor.analysis/v1",
      kind: "subject.track",
      data: { sampleEvery: 3, samples: [{ frame: 0 }] },
    });
    const serialized = serializeSubjectTrackAnalysis(sidecar);
    expect(parseSubjectTrackAnalysis(serialized)).toEqual(sidecar);
  });

  it("rejects out-of-frame boxes and non-monotonic sample frames", () => {
    const invalid = JSON.stringify({
      format: "guyditor.analysis/v1",
      kind: "subject.track",
      assetId: "ast_aaaaaaaaaa",
      sourceHash: "a".repeat(64),
      params: {},
      toolVersions: { mediapipe: "0.10.35" },
      createdAt: "2026-07-22T10:00:00.000Z",
      data: {
        frameCount: 2, width: 1280, height: 720, fps: 30, sampleEvery: 1,
        samples: [
          { frame: 1, boxes: [] },
          { frame: 0, boxes: [{ kind: "face", trackId: "trk_face0001", x: 1.1, y: 0, w: 0.1, h: 0.1, conf: 1 }] },
        ],
      },
    });
    expect(() => parseSubjectTrackAnalysis(invalid)).toThrow(/subject\.track/u);
  });

  it("converts live tracked boxes into stable PiP collision-provider regions", () => {
    const boxes = [
      { kind: "face" as const, trackId: "trk_face0001", x: 0.6, y: 0.1, w: 0.2, h: 0.3, conf: 0.9 },
      { kind: "body" as const, trackId: "trk_body0001", x: 0.5, y: 0.2, w: 0.3, h: 0.7, conf: 0.8 },
      { kind: "screen-region" as const, trackId: "trk_screen0001", x: 0.1, y: 0.1, w: 0.3, h: 0.3, conf: 0.7 },
      { kind: "object" as const, trackId: "trk_noise0001", x: 0, y: 0, w: 0.1, h: 0.1, conf: 0.2 },
    ];

    const first = subjectTrackAvoidRegions(boxes, 42);
    expect(subjectTrackAvoidRegions(boxes, 42)).toEqual(first);
    expect(first).toEqual([
      expect.objectContaining({ source: "face", frames: { from: 42, to: 42 } }),
      expect.objectContaining({ source: "subject", frames: { from: 42, to: 42 } }),
      expect.objectContaining({ source: "diagram", frames: { from: 42, to: 42 } }),
    ]);
    expect(new Set(first.map(({ id }) => id)).size).toBe(3);
  });
});
