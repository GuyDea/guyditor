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
      video: { codec: "libx264", crf: 18, pixelFormat: "yuv420p" },
      audio: { codec: "aac", bitrate: "256k" },
      container: "mp4",
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
