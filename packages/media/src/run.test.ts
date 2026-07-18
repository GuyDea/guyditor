import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveFfmpeg } from "./binaries.js";
import { runFfmpeg } from "./run.js";

const originalOverride = process.env.GUYDITOR_FFMPEG;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalOverride === undefined) {
    delete process.env.GUYDITOR_FFMPEG;
  } else {
    process.env.GUYDITOR_FFMPEG = originalOverride;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("runFfmpeg", () => {
  it("streams binary stdout without retaining the complete payload", async () => {
    process.env.GUYDITOR_FFMPEG = resolveFfmpeg().path;
    const chunks: Buffer[] = [];

    const result = await runFfmpeg(
      [
        "-nostdin",
        "-f", "lavfi",
        "-i", "sine=frequency=1000:sample_rate=48000:duration=0.1",
        "-ac", "1",
        "-ar", "48000",
        "-c:a", "pcm_s16le",
        "-f", "s16le",
        "pipe:1",
      ],
      {
        collectStdout: false,
        onStdoutChunk: (chunk) => chunks.push(Buffer.from(chunk)),
      },
    );

    expect(Buffer.concat(chunks)).toHaveLength(9_600);
    expect(result.stdout).toBe("");
  });

  it("streams machine-readable progress lines from stdout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "guyditor-progress-"));
    temporaryDirectories.push(directory);
    process.env.GUYDITOR_FFMPEG = resolveFfmpeg().path;
    const progressLines: string[] = [];

    await runFfmpeg(
      [
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=16x16:r=10:d=0.2",
        "-frames:v",
        "2",
        "-progress",
        "pipe:1",
        "-f",
        "null",
        "-",
      ],
      { onStdoutLine: (line) => progressLines.push(line) },
    );

    expect(progressLines).toContain("progress=end");
    expect(progressLines.some((line) => line.startsWith("out_time="))).toBe(true);
  });

  it("streams all stderr lines but retains only the last 20 on failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "guyditor-runner-"));
    temporaryDirectories.push(directory);
    process.env.GUYDITOR_FFMPEG = resolveFfmpeg().path;
    const streamedLines: string[] = [];

    let failure: unknown;
    try {
      await runFfmpeg(
        [
          "-loglevel",
          "debug",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=16x16:d=0.1",
          "-frames:v",
          "1",
          path.join(directory, "missing", "output.mp4"),
        ],
        { onStderrLine: (line) => streamedLines.push(line) },
      );
    } catch (error) {
      failure = error;
    }

    expect(streamedLines.length).toBeGreaterThan(20);
    expect(failure).toMatchObject({
      code: "E_FFMPEG_FAILED",
      exitCode: 1,
    });
    expect(failure).toHaveProperty("stderrLines", streamedLines.slice(-20));
  });
});
