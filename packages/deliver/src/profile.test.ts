import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadPlatformProfile,
  resolveProfileOverrides,
} from "./profile.js";

const roots: string[] = [];
const builtinsRoot = new URL("../../../profiles/", import.meta.url);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("guyditor-profile/v1", () => {
  it("loads and validates every complete built-in profile", async () => {
    const profiles = await Promise.all([
      "youtube-longform@1.0.0",
      "youtube-shorts@1.0.0",
      "tiktok@1.0.0",
      "instagram-reels@1.0.0",
    ].map((pin) => loadPlatformProfile(pin, { builtinsRoot })));

    expect(profiles.map(({ profile }) => ({
      pin: `${profile.id}@${profile.version}`,
      format: profile.format,
      kind: profile.kind,
      aspect: profile.video.aspect,
      resolution: profile.video.resolution,
      maximum: profile.duration.maxSeconds,
      loudness: profile.audio.loudness,
    }))).toEqual([
      {
        pin: "youtube-longform@1.0.0",
        format: "guyditor-profile/v1",
        kind: "longform",
        aspect: "16:9",
        resolution: { width: 3840, height: 2160 },
        maximum: null,
        loudness: { integratedLufs: -14, toleranceLu: 1, truePeakDbtp: -1, lraMaxLu: 11 },
      },
      {
        pin: "youtube-shorts@1.0.0",
        format: "guyditor-profile/v1",
        kind: "short",
        aspect: "9:16",
        resolution: { width: 1080, height: 1920 },
        maximum: 180,
        loudness: { integratedLufs: -14, toleranceLu: 1, truePeakDbtp: -1, lraMaxLu: 11 },
      },
      {
        pin: "tiktok@1.0.0",
        format: "guyditor-profile/v1",
        kind: "short",
        aspect: "9:16",
        resolution: { width: 1080, height: 1920 },
        maximum: 600,
        loudness: { integratedLufs: -14, toleranceLu: 1, truePeakDbtp: -1, lraMaxLu: 11 },
      },
      {
        pin: "instagram-reels@1.0.0",
        format: "guyditor-profile/v1",
        kind: "short",
        aspect: "9:16",
        resolution: { width: 1080, height: 1920 },
        maximum: 180,
        loudness: { integratedLufs: -14, toleranceLu: 1, truePeakDbtp: -1, lraMaxLu: 11 },
      },
    ]);
    for (const loaded of profiles) {
      expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(loaded.profile.video).toMatchObject({
        codec: "h264",
        codecProfile: "high",
        pixelFormat: "yuv420p",
        colorSpace: "bt709",
        rateControl: { mode: "crf", crf: 18 },
      });
      expect(loaded.profile.safeAreas.platformUi.length).toBeGreaterThan(0);
      expect(loaded.profile.captionDefaults.maxLines).toBeGreaterThan(0);
      expect(loaded.profile.cover.resolution.width).toBeGreaterThan(0);
      expect(loaded.profile.metadata.description.maxChars).toBeGreaterThan(0);
    }
    expect(profiles[0]!.profile.video.resolutionsAllowed).toContainEqual({ width: 1920, height: 1080 });
    expect(profiles[0]!.profile.chapters).toEqual({
      minCount: 3,
      minChapterSeconds: 10,
      firstMustBeZero: true,
    });
    expect(profiles[1]!.profile.metadata.title).toEqual({ maxChars: 100 });
    expect(profiles[2]!.profile.metadata.title).toEqual({ maxChars: 90 });
    expect(profiles[3]!.profile.metadata.title).toBeNull();
  });

  it("resolves project before user before built-ins and reports an exact missing pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-profile-order-"));
    roots.push(root);
    const projectRoot = join(root, "project", "profiles");
    const userRoot = join(root, "user", "profiles");
    const relative = join("youtube-shorts", "1.0.0.yaml");
    const source = await readFile(new URL(relative, builtinsRoot), "utf8");
    await mkdir(join(userRoot, "youtube-shorts"), { recursive: true });
    await mkdir(join(projectRoot, "youtube-shorts"), { recursive: true });
    await writeFile(join(userRoot, relative), source.replace("YouTube Shorts", "User Shorts"));
    await writeFile(join(projectRoot, relative), source.replace("YouTube Shorts", "Project Shorts"));

    const loaded = await loadPlatformProfile("youtube-shorts@1.0.0", {
      projectRoot,
      userRoot,
      builtinsRoot,
    });
    expect(loaded.profile.displayName).toBe("Project Shorts");
    expect(loaded.path).toBe(join(projectRoot, relative));

    await expect(loadPlatformProfile("missing@9.9.9", {
      projectRoot,
      userRoot,
      builtinsRoot,
    })).rejects.toMatchObject({
      code: "E_PROFILE_NOT_FOUND",
      retry: "none",
      acceptedStateChanged: false,
    });
  });

  it("deep-merges object overrides, replaces arrays, and revalidates the result", async () => {
    const loaded = await loadPlatformProfile("youtube-shorts@1.0.0", { builtinsRoot });
    const resolved = resolveProfileOverrides(loaded.profile, {
      video: {
        fps: { default: "60/1" },
        rateControl: { maxBitrateKbps: 9_000 },
      },
      safeAreas: {
        title: { bottom: 0.3 },
        platformUi: [{ name: "creator-overlay", rect: { x: 0, y: 0, w: 1, h: 0.1 } }],
      },
      captionDefaults: { maxLines: 1 },
    });

    expect(resolved.video.fps).toEqual({
      allowed: ["30/1", "60/1", "30000/1001", "60000/1001"],
      default: "60/1",
    });
    expect(resolved.video.rateControl).toEqual({ mode: "crf", crf: 18, maxBitrateKbps: 9_000 });
    expect(resolved.safeAreas.title).toEqual({ top: 0.06, bottom: 0.3, left: 0.05, right: 0.16 });
    expect(resolved.safeAreas.platformUi).toHaveLength(1);
    expect(resolved.captionDefaults).toMatchObject({ maxLines: 1, maxCharsPerLine: 18 });

    expect(() => resolveProfileOverrides(loaded.profile, {
      video: { resolution: { width: -1 } },
    })).toThrow(expect.objectContaining({ code: "E_PROFILE_INVALID" }));
  });
});
