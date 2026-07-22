import { describe, expect, it } from "vitest";

import { loadRenderProfile } from "./profile.js";

describe("loadRenderProfile", () => {
  it("loads and hashes the built-in youtube longform profile", async () => {
    const loaded = await loadRenderProfile(
      "youtube-longform@1.0.0",
      new URL("../../../profiles/", import.meta.url),
    );

    expect(loaded.profile).toEqual({
      id: "youtube-longform",
      version: "1.0.0",
      kind: "longform",
      video: {
        codec: "libx264",
        crf: 18,
        pixelFormat: "yuv420p",
        resolution: { width: 3840, height: 2160 },
        fps: "30/1",
        aspect: "16:9",
      },
      audio: {
        codec: "aac",
        bitrate: "256k",
        sampleRate: 48_000,
        channels: 2,
        loudness: { integratedLufs: -14, toleranceLu: 1, truePeakDbtp: -1, lraMaxLu: 11 },
      },
      container: "mp4",
      safeAreas: {
        title: { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 },
        action: { top: 0.025, bottom: 0.025, left: 0.025, right: 0.025 },
        platformUi: [{
          name: "player-controls",
          rect: { x: 0, y: 0.9, w: 1, h: 0.1 },
        }],
      },
      captionDefaults: {
        maxLines: 2,
        maxCharsPerLine: 42,
        placement: { anchor: "center", verticalCenter: 0.86 },
        perWordHighlight: false,
      },
      cover: {
        resolution: { width: 1280, height: 720 },
        formats: ["jpg", "png"],
        maxBytes: 2097152,
      },
      metadata: {
        title: { maxChars: 100 },
        description: { maxChars: 5000 },
        tags: { maxCount: 60, totalMaxChars: 500 },
        hashtags: { maxCount: 15, countedIn: "description" },
      },
    });
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("deep-merges deliverable overrides before narrowing encode settings", async () => {
    const loaded = await loadRenderProfile(
      "youtube-longform@1.0.0",
      new URL("../../../profiles/", import.meta.url),
      {
        video: { rateControl: { crf: 23 } },
        audio: { bitrateKbps: 192 },
      },
    );

    expect(loaded.profile.video.crf).toBe(23);
    expect(loaded.profile.audio.bitrate).toBe("192k");
  });
});
