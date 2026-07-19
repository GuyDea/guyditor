import { describe, expect, it } from "vitest";

import {
  ebur128MeasureCommand,
  loudnormMeasureCommand,
  loudnormNormalizeCommand,
  parseEbur128Summary,
  parseLoudnormMeasurement,
} from "./loudness.js";

const TARGET = {
  integratedLufs: -16,
  truePeakDbtp: -1.5,
  loudnessRangeLu: 11,
};

const MEASURE_STDERR = `
[Parsed_loudnorm_0 @ 0x1] {
  "input_i" : "-22.34",
  "input_tp" : "-7.12",
  "input_lra" : "3.40",
  "input_thresh" : "-32.70",
  "output_i" : "-15.95",
  "output_tp" : "-1.50",
  "output_lra" : "3.20",
  "output_thresh" : "-26.30",
  "normalization_type" : "linear",
  "target_offset" : "-0.05"
}
`;

describe("two-pass loudnorm command contract", () => {
  it("builds pass one and parses the machine-readable measurement", () => {
    expect(loudnormMeasureCommand("/tmp/master.wav", TARGET)).toEqual([
      "-hide_banner", "-nostdin", "-i", "/tmp/master.wav",
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
      "-f", "null", "-",
    ]);
    expect(parseLoudnormMeasurement(MEASURE_STDERR)).toEqual({
      inputI: -22.34,
      inputTp: -7.12,
      inputLra: 3.4,
      inputThresh: -32.7,
      targetOffset: -0.05,
    });
  });

  it("builds a deterministic linear pass two and appends a limiter only when requested", () => {
    const measurement = parseLoudnormMeasurement(MEASURE_STDERR);
    const base = loudnormNormalizeCommand(
      "/tmp/master.wav",
      "/tmp/normalized.wav",
      TARGET,
      measurement,
      false,
      48_000,
    );
    expect(base.join(" ")).toContain(
      "measured_I=-22.34:measured_TP=-7.12:measured_LRA=3.4:" +
      "measured_thresh=-32.7:offset=-0.05:linear=true:print_format=json",
    );
    expect(base.join(" ")).not.toContain("alimiter");
    expect(loudnormNormalizeCommand(
      "/tmp/master.wav",
      "/tmp/normalized.wav",
      TARGET,
      measurement,
      true,
      48_000,
    ).join(" ")).toContain(",alimiter=limit=0.841395:level=false");
    expect(base).toEqual(expect.arrayContaining(["-ar", "48000"]));
  });

  it("builds and parses authoritative ebur128 verification", () => {
    expect(ebur128MeasureCommand("/tmp/final.mp4")).toEqual([
      "-hide_banner", "-nostdin", "-i", "/tmp/final.mp4",
      "-filter_complex", "ebur128=peak=true",
      "-f", "null", "-",
    ]);
    expect(parseEbur128Summary(`
      Integrated loudness:
        I:         -16.1 LUFS
        Threshold: -26.4 LUFS
      Loudness range:
        LRA:         3.2 LU
      True peak:
        Peak:       -1.7 dBFS
    `)).toEqual({ integratedLufs: -16.1, loudnessRangeLu: 3.2, truePeakDbtp: -1.7 });
  });
});
