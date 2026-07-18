import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { probeMedia } from "./probe.js";
import { runFfmpeg } from "./run.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("probeMedia", () => {
  it("maps ffprobe JSON into exact core Asset media shapes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "guyditor-probe-"));
    temporaryDirectories.push(directory);
    const mediaPath = path.join(directory, "color.mp4");
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x90:r=30:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      mediaPath,
    ]);

    const result = await probeMedia(mediaPath);

    expect(result.container).toContain("mp4");
    expect(result.probe).toMatchObject({
      duration: { fps: "30/1", frames: 30 },
      fps: "30/1",
      height: 90,
      width: 160,
    });
    expect(result.video).toMatchObject({
      codec: "h264",
      fps: "30/1",
      hasAlpha: false,
      height: 90,
      pixFmt: "yuv420p",
      rotation: 0,
      width: 160,
    });
    expect(result.sources).toMatchObject({
      duration: expect.stringMatching(/nb_frames|duration/),
      fps: expect.stringMatching(/avg_frame_rate|r_frame_rate/),
    });
    expect(result.ffprobeVersion).toMatch(/^ffprobe version /);
  });

  it("maps a still-image pipe format into the Asset image shape", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "guyditor-image-"));
    temporaryDirectories.push(directory);
    const imagePath = path.join(directory, "still.png");
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x32:d=1",
      "-frames:v",
      "1",
      imagePath,
    ]);

    const result = await probeMedia(imagePath);

    expect(result.image).toEqual({
      hasAlpha: false,
      height: 32,
      width: 64,
    });
    expect(result.video).toBeUndefined();
    expect(result.sources.image).toBe("streams[0].{width,height,pix_fmt}");
  });

  it("maps audio-only duration into exact SampleTime with field sources", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "guyditor-audio-"));
    temporaryDirectories.push(directory);
    const audioPath = path.join(directory, "tone.wav");
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000:duration=1",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ]);

    const result = await probeMedia(audioPath);

    expect(result.probe).toMatchObject({
      audio: { channels: 1, rate: 48_000 },
      duration: { rate: 48_000, samples: 48_000 },
    });
    expect(result.audio?.[0]).toMatchObject({
      channels: 1,
      codec: "pcm_s16le",
      index: 0,
      sampleRate: 48_000,
    });
    expect(result.sources.audio).toMatchObject({
      probe: "streams[0].{sample_rate,channels}",
      streams: [
        expect.objectContaining({
          channels: "streams[0].channels",
          codec: "streams[0].codec_name",
          index: "streams[0].index",
          layout: "streams[0].channel_layout",
          sampleRate: "streams[0].sample_rate",
        }),
      ],
    });
  });

  it("falls back to exact duration-times-fps rounding without nb_frames", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "guyditor-fallback-"));
    temporaryDirectories.push(directory);
    const mediaPath = path.join(directory, "fallback.ts");
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x90:r=30:d=0.5",
      "-c:v",
      "libx264",
      "-f",
      "mpegts",
      mediaPath,
    ]);

    const result = await probeMedia(mediaPath);

    expect(result.probe.duration).toEqual({ fps: "30/1", frames: 15 });
    expect(result.sources.duration).toMatch(
      /^streams\[0\]\.duration × 30\/1, rounded nearest/u,
    );
  });

  it("returns a structured FFmpeg failure for a nonexistent input", async () => {
    const missingPath = path.join(
      tmpdir(),
      "guyditor-probe-input-does-not-exist.mp4",
    );

    await expect(probeMedia(missingPath)).rejects.toMatchObject({
      acceptedStateChanged: false,
      code: "E_FFMPEG_FAILED",
      exitCode: 1,
      retry: "safe",
      stderrLines: expect.arrayContaining([
        expect.stringContaining("No such file or directory"),
      ]),
    });
  });
});
