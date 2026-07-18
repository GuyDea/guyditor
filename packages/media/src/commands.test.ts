import { describe, expect, it } from "vitest";

import type { Asset } from "../../core/src/index.js";
import {
  peaksDecodeCommand,
  proxyCommand,
  proxyProfile,
} from "./commands.js";

function asset(overrides: Partial<Asset>): Asset {
  return {
    id: "ast_aaaaaaaaaa",
    kind: "video",
    path: "/source/input.mov",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    probe: {},
    ...overrides,
  };
}

describe("proxyCommand", () => {
  it("compiles the opaque-video edit profile with a one-second GOP", () => {
    const source = asset({
      probe: { duration: { fps: "30/1", frames: 300 }, fps: "30/1" },
      video: {
        codec: "h264",
        fps: "30/1",
        hasAlpha: false,
        height: 1_080,
        pixFmt: "yuv420p",
        rotation: 0,
        width: 1_920,
      },
    });

    expect(proxyProfile(source, "edit")).toMatchObject({
      extension: "mp4",
      kind: "opaque-video",
    });
    const command = proxyCommand(source, "edit", "/cache/proxy.mp4.part");

    expect(command).toBeDefined();
    expect(command).toContain("scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2");
    expect(command).toEqual(expect.arrayContaining([
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-g", "30",
      "-sc_threshold", "0",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "48000",
      "-ac", "2",
      "-movflags", "+faststart",
      "-f", "mp4",
    ]));
    expect(command).not.toContain("-r");
    expect(command?.at(-1)).toBe("/cache/proxy.mp4.part");
  });

  it("rounds rational native fps for the GOP without changing output fps", () => {
    const source = asset({
      probe: { fps: "30000/1001" },
      video: {
        codec: "h264",
        fps: "30000/1001",
        hasAlpha: false,
        height: 1_080,
        pixFmt: "yuv420p",
        rotation: 0,
        width: 1_920,
      },
    });

    const command = proxyCommand(source, "edit", "/cache/proxy.mp4.part");

    expect(command?.slice(command.indexOf("-g"), command.indexOf("-g") + 2))
      .toEqual(["-g", "30"]);
    expect(command).not.toContain("-r");
  });

  it("compiles alpha video to VP9 WebM with alpha pixel format", () => {
    const source = asset({
      video: {
        codec: "prores",
        fps: "25/1",
        hasAlpha: true,
        height: 1_080,
        pixFmt: "yuva444p10le",
        rotation: 0,
        width: 1_920,
      },
    });

    expect(proxyProfile(source, "edit")).toMatchObject({
      extension: "webm",
      kind: "alpha-video",
    });
    expect(proxyCommand(source, "edit", "/cache/proxy.webm.part")).toEqual(
      expect.arrayContaining([
        "-c:v", "libvpx-vp9",
        "-crf", "32",
        "-b:v", "0",
        "-pix_fmt", "yuva420p",
        "-row-mt", "1",
        "-f", "webm",
      ]),
    );
  });

  it("compiles audio-only media to AAC M4A", () => {
    const source = asset({
      kind: "audio",
      audio: [{
        channels: 1,
        codec: "pcm_s16le",
        index: 0,
        layout: "mono",
        sampleRate: 48_000,
      }],
      probe: {
        audio: { channels: 1, rate: 48_000 },
        duration: { rate: 48_000, samples: 960_000 },
      },
    });

    expect(proxyProfile(source, "edit")).toMatchObject({
      extension: "m4a",
      kind: "audio",
    });
    expect(proxyCommand(source, "edit", "/cache/proxy.m4a.part")).toEqual([
      "-y", "-nostdin",
      "-i", "/source/input.mov",
      "-map", "0:a:0",
      "-vn",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "48000",
      "-ac", "2",
      "-movflags", "+faststart",
      "-f", "mp4",
      "/cache/proxy.m4a.part",
    ]);
  });

  it("only compiles image proxies above 2048 pixels and preserves alpha", () => {
    const small = asset({
      image: { hasAlpha: false, height: 1_080, width: 1_920 },
      kind: "image",
    });
    const largeOpaque = asset({
      image: { hasAlpha: false, height: 2_000, width: 3_000 },
      kind: "image",
    });
    const largeAlpha = asset({
      image: { hasAlpha: true, height: 3_000, width: 2_000 },
      kind: "image",
    });

    expect(proxyProfile(small, "edit")).toBeUndefined();
    expect(proxyCommand(small, "edit", "/cache/small.jpg.part")).toBeUndefined();
    expect(proxyProfile(largeOpaque, "edit")).toMatchObject({
      extension: "jpg",
      kind: "opaque-image",
    });
    expect(proxyCommand(largeOpaque, "edit", "/cache/large.jpg.part")).toEqual(
      expect.arrayContaining(["-q:v", "2", "-f", "image2"]),
    );
    expect(proxyProfile(largeAlpha, "edit")).toMatchObject({
      extension: "png",
      kind: "alpha-image",
    });
    expect(proxyCommand(largeAlpha, "edit", "/cache/large.png.part")).toEqual(
      expect.arrayContaining(["-c:v", "png", "-f", "image2"]),
    );
  });
});

describe("peaksDecodeCommand", () => {
  it("compiles mono 48 kHz signed-16 PCM to stdout", () => {
    expect(peaksDecodeCommand(asset({}), "pipe:1")).toEqual([
      "-nostdin",
      "-i", "/source/input.mov",
      "-map", "0:a:0",
      "-vn",
      "-ac", "1",
      "-ar", "48000",
      "-c:a", "pcm_s16le",
      "-f", "s16le",
      "pipe:1",
    ]);
  });
});
