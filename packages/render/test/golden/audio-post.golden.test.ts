import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFfmpeg } from "../../../media/src/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  measureDeliveredLoudness,
  normalizeMasterLoudness,
} from "../../src/loudness.js";

const TARGET = {
  integratedLufs: -18,
  truePeakDbtp: -1,
  loudnessRangeLu: 11,
};

describe("audio post loudness golden", () => {
  let scratch = "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "guyditor-audio-golden-"));
  });

  afterAll(async () => {
    await rm(scratch, { force: true, recursive: true });
  });

  it("normalizes the integrated master within 0.5 LU without exceeding true peak", async () => {
    const inputPath = join(scratch, "master.wav");
    const outputPath = join(scratch, "normalized.wav");
    await runFfmpeg([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=997:sample_rate=48000:duration=6",
      "-af",
      "volume=0.05",
      "-c:a",
      "pcm_f32le",
      inputPath,
    ]);

    await normalizeMasterLoudness({
      inputPath,
      outputPath,
      measurementPath: join(scratch, "measure", "audio-key.json"),
      target: TARGET,
      sampleRate: 48_000,
    });
    const measured = await measureDeliveredLoudness(outputPath);

    expect(Math.abs(measured.integratedLufs - TARGET.integratedLufs)).toBeLessThanOrEqual(0.5);
    expect(measured.truePeakDbtp).toBeLessThanOrEqual(TARGET.truePeakDbtp);
  }, 30_000);
});
