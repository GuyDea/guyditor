import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  measureDeliveredLoudness,
  normalizeMasterLoudness,
} from "./loudness.js";

const scratch = join(tmpdir(), `guyditor-loudness-${process.pid}`);
const measurementJson = `{
  "input_i": "-24.0", "input_tp": "-8.0", "input_lra": "2.0",
  "input_thresh": "-34.0", "target_offset": "0.0"
}`;

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("master loudness pipeline", () => {
  it("caches pass one and records the deterministic limiter decision", async () => {
    const calls: string[][] = [];
    const result = await normalizeMasterLoudness({
      inputPath: join(scratch, "audio", "mix.wav"),
      outputPath: join(scratch, "audio", "final.wav"),
      measurementPath: join(scratch, "measure", "key.json"),
      target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 11 },
      sampleRate: 48_000,
      run: async (args) => {
        calls.push([...args]);
        return { stderrLines: calls.length === 1 ? [measurementJson] : [] };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.join(" ")).toContain("print_format=json");
    expect(calls[1]?.join(" ")).toContain("linear=true");
    expect(calls[1]?.join(" ")).toContain("alimiter=limit=0.891251");
    expect(calls[1]).toEqual(expect.arrayContaining(["-ar", "48000"]));
    expect(result.limiterApplied).toBe(true);
    expect(JSON.parse(await readFile(join(scratch, "measure", "key.json"), "utf8")))
      .toEqual(result.measurement);
  });

  it("includes the measured target offset in the true-peak limiter decision", async () => {
    const calls: string[][] = [];
    const measurementWithOffset = `{
      "input_i": "-24.0", "input_tp": "-11.1", "input_lra": "2.0",
      "input_thresh": "-34.0", "target_offset": "0.2"
    }`;
    const result = await normalizeMasterLoudness({
      inputPath: join(scratch, "offset", "mix.wav"),
      outputPath: join(scratch, "offset", "final.wav"),
      measurementPath: join(scratch, "offset", "measure.json"),
      target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 11 },
      sampleRate: 48_000,
      run: async (args) => {
        calls.push([...args]);
        return { stderrLines: calls.length === 1 ? [measurementWithOffset] : [] };
      },
    });

    expect(result.limiterApplied).toBe(true);
  });

  it("treats a fully silent program track as having no loudness target", async () => {
    const calls: string[][] = [];
    const silentMeasurement = `{
      "input_i": "-inf", "input_tp": "-inf", "input_lra": "0.0",
      "input_thresh": "-70.0", "target_offset": "inf"
    }`;
    const result = await normalizeMasterLoudness({
      inputPath: join(scratch, "silent", "mix.wav"),
      outputPath: join(scratch, "silent", "final.wav"),
      measurementPath: join(scratch, "silent", "measure.json"),
      target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 11 },
      sampleRate: 48_000,
      run: async (args) => {
        calls.push([...args]);
        return { stderrLines: [silentMeasurement] };
      },
    });

    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      limiterApplied: false,
      measurement: null,
      silent: true,
    });
    expect(JSON.parse(await readFile(join(scratch, "silent", "measure.json"), "utf8")))
      .toEqual({ silent: true });
  });

  it("measures the delivered result with ebur128", async () => {
    const measurement = await measureDeliveredLoudness("/tmp/final.mp4", async (args) => {
      expect(args.join(" ")).toContain("ebur128=peak=true");
      return {
        stderrLines: [
          "Integrated loudness:\n I: -14.1 LUFS\n Loudness range:\n LRA: 4.2 LU\n True peak:\n Peak: -1.2 dBFS",
        ],
      };
    });
    expect(measurement).toEqual({
      integratedLufs: -14.1,
      loudnessRangeLu: 4.2,
      truePeakDbtp: -1.2,
    });
  });
});
