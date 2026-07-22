import { describe, expect, it } from "vitest";

import type { PlatformProfile } from "../../deliver/src/index.js";
import {
  exportOutputPath,
  exportReportPath,
  outputSetPaths,
  subtitleOutputPaths,
  validateOverlayLayout,
  validatePublishMetadataCheck,
} from "./index.js";

function profile(): PlatformProfile {
  return {
    format: "guyditor-profile/v1",
    id: "short-test",
    version: "1.0.0",
    displayName: "Short test",
    kind: "short",
    video: {
      aspect: "9:16",
      resolution: { width: 1080, height: 1920 },
      fps: { allowed: ["30/1"], default: "30/1" },
      container: "mp4",
      codec: "h264",
      codecProfile: "high",
      pixelFormat: "yuv420p",
      colorSpace: "bt709",
      rateControl: { mode: "crf", crf: 18, maxBitrateKbps: 12_000 },
    },
    duration: { minSeconds: 1, maxSeconds: 60, recommendedMaxSeconds: 45 },
    audio: {
      codec: "aac",
      sampleRate: 48_000,
      channels: 2,
      bitrateKbps: 192,
      loudness: { integratedLufs: -16, toleranceLu: 1.5, truePeakDbtp: -2, lraMaxLu: 8 },
    },
    safeAreas: {
      title: { top: 0.1, right: 0.1, bottom: 0.2, left: 0.1 },
      action: { top: 0.05, right: 0.05, bottom: 0.1, left: 0.05 },
      platformUi: [
        { name: "strict-buttons", strict: true, rect: { x: 0.85, y: 0.2, w: 0.15, h: 0.6 } },
        { name: "soft-caption", strict: false, rect: { x: 0, y: 0.8, w: 0.8, h: 0.2 } },
      ],
    },
    captionDefaults: {
      maxLines: 2,
      maxCharsPerLine: 20,
      placement: { anchor: "center", verticalCenter: 0.65 },
      perWordHighlight: true,
    },
    metadata: {
      title: { maxChars: 100 },
      description: { maxChars: 2_000 },
      tags: null,
      hashtags: { maxCount: 5, countedIn: "caption" },
    },
    cover: { resolution: { width: 1080, height: 1920 }, formats: ["jpg"], maxBytes: 2_000_000 },
    chapters: null,
  };
}

describe("output-set contract", () => {
  it("uses the Part 11 canonical per-deliverable paths", () => {
    const paths = outputSetPaths("/project/exports", "dlv_aaaaaaaaaa", "mp4");
    expect(paths).toEqual({
      root: "/project/exports/dlv_aaaaaaaaaa",
      videoBurned: "/project/exports/dlv_aaaaaaaaaa/video.burned.mp4",
      videoClean: "/project/exports/dlv_aaaaaaaaaa/video.clean.mp4",
      srt: "/project/exports/dlv_aaaaaaaaaa/subtitles.srt",
      vtt: "/project/exports/dlv_aaaaaaaaaa/subtitles.vtt",
      coversDir: "/project/exports/dlv_aaaaaaaaaa/covers",
      report: "/project/exports/dlv_aaaaaaaaaa/export-report.json",
    });
    expect(exportOutputPath("/project/exports", "dlv_aaaaaaaaaa", "burnin", "mp4"))
      .toBe(paths.videoBurned);
    expect(subtitleOutputPaths("/project/exports", "dlv_aaaaaaaaaa"))
      .toEqual({ srt: paths.srt, vtt: paths.vtt });
    expect(exportReportPath(paths.videoClean)).toBe(paths.report);
  });

  it("fails strict safe-area intersections and warns for overflow or soft zones", () => {
    expect(validateOverlayLayout({
      deliverableId: "dlv_aaaaaaaaaa",
      profile: profile(),
      captionOverflowWordIds: [],
      boxes: [{ ownerId: "cts_aaaaaaaaaa", kind: "caption", rect: { x: 0.88, y: 0.3, w: 0.1, h: 0.1 } }],
    })).toMatchObject({ id: "VAL-401", status: "fail", affected: ["cts_aaaaaaaaaa"] });

    expect(validateOverlayLayout({
      deliverableId: "dlv_aaaaaaaaaa",
      profile: profile(),
      captionOverflowWordIds: ["w000001"],
      boxes: [{ ownerId: "gfx_aaaaaaaaaa", kind: "graphic", rect: { x: 0.1, y: 0.85, w: 0.2, h: 0.1 } }],
    })).toMatchObject({
      id: "VAL-401",
      status: "warn",
      affected: expect.arrayContaining(["w000001", "gfx_aaaaaaaaaa"]),
    });
  });

  it("blocks pre-export validation when publish metadata exceeds Unicode limits", () => {
    expect(validatePublishMetadataCheck({
      deliverableId: "dlv_aaaaaaaaaa",
      metadata: {
        format: "guyditor-publish/v1",
        deliverableId: "dlv_aaaaaaaaaa",
        profile: "short-test@1.0.0",
        language: "en",
        title: "🎬".repeat(101),
        description: "Within limits",
        tags: [],
        hashtags: [],
        status: "draft",
      },
      profile: profile(),
    })).toMatchObject({
      id: "VAL-METADATA",
      status: "fail",
      message: "title: 101/100",
      affected: ["dlv_aaaaaaaaaa"],
    });
  });
});
