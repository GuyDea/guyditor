import { describe, expect, it } from "vitest";

import { buildCaptureGuidanceReport } from "./capture-guidance.js";
import type { ProbedAssetMedia } from "./probe.js";

const PROBE = {
  ffprobeVersion: "fixture",
  metadata: { chapterCount: 0, formatTags: {}, streams: [] },
  probe: { duration: { frames: 180, fps: "30/1" }, fps: "30/1" },
  sources: {},
  video: { width: 1280, height: 720, rotation: 0, pixelFormat: "yuv420p" },
} as unknown as ProbedAssetMedia;

describe("capture guidance", () => {
  it("does not classify a clip below the common key-color area threshold", () => {
    expect(buildCaptureGuidanceReport({
      assetId: "ast_aaaaaaaaaa",
      keyIntendedFraction: 0.29,
      probe: PROBE,
    })).toEqual({
      schema: "guyditor.capture/v1",
      assetId: "ast_aaaaaaaaaa",
      keyIntended: false,
      warnings: [],
    });
  });

  it("turns probe, frame-analysis, and key-QC evidence into actionable warnings", () => {
    const report = buildCaptureGuidanceReport({
      assetId: "ast_aaaaaaaaaa",
      keyIntendedFraction: 0.75,
      probe: PROBE,
      metrics: {
        backdropHueStdDeg: 7,
        backdropLumaStd: 0.09,
        blockBoundaryRatio: 1.4,
        bitsPerPixelFrame: 0.03,
        foregroundMedianLuma: 0.2,
        keyWardrobeFraction: 0.03,
        motionEdgeGradientRatio: 0.4,
      },
      qcReport: {
        schema: "guyditor.keyqc/v1",
        assetId: "ast_aaaaaaaaaa",
        clipId: "clp_aaaaaaaaaa",
        keyParamsHash: "a".repeat(64),
        sampledFrames: [12],
        metrics: [{
          detailLoss: 0,
          edgeChatter: 0,
          frame: 12,
          haloScore: 0,
          holeArea: 0,
          holeCount: 0,
          spillScore: 0.1,
        }],
        warnings: [],
      },
    });

    expect(report.keyIntended).toBe(true);
    expect(report.warnings.map(({ code }) => code)).toEqual([
      "uneven_backdrop",
      "underexposed_subject",
      "motion_blur",
      "compression_artifacts",
      "subject_too_close",
      "key_color_wardrobe",
    ]);
    expect(report.warnings[4]).toMatchObject({
      severity: "warning",
      evidence: { frames: [12], metric: 0.1, threshold: 0.08 },
      remediation: "Move approximately 0.5 m further from the screen and add separation light.",
    });
  });

  it("derives compression evidence from probed bitrate per pixel per frame", () => {
    const probe = structuredClone(PROBE);
    probe.video = {
      bitrate: 900_000,
      codec: "h264",
      fps: "30/1",
      hasAlpha: false,
      height: 720,
      pixFmt: "yuv420p",
      rotation: 0,
      width: 1280,
    };
    const report = buildCaptureGuidanceReport({
      assetId: "ast_aaaaaaaaaa",
      keyIntendedFraction: 0.8,
      probe,
    });

    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "compression_artifacts",
      evidence: expect.objectContaining({
        metric: 900_000 / (1280 * 720 * 30),
        threshold: 0.04,
      }),
    }));
  });
});
