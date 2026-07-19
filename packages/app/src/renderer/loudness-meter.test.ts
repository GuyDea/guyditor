import { describe, expect, it } from "vitest";

import {
  LOUDNESS_WORKLET_SOURCE,
  loudnessMeterStatus,
  meterFillPercent,
} from "./loudness-meter.js";

const target = {
  integratedLufs: -14,
  toleranceLu: 1,
  truePeakDbtp: -1,
  profileId: "sequence-master",
};

describe("preview loudness meter", () => {
  it("classifies target distance and true-peak ceiling", () => {
    expect(loudnessMeterStatus(null, [], target)).toBe("idle");
    expect(loudnessMeterStatus(-14.4, [-2, -1.1], target)).toBe("pass");
    expect(loudnessMeterStatus(-14.8, [-2, -1.1], target)).toBe("warn");
    expect(loudnessMeterStatus(-15.2, [-2, -1.1], target)).toBe("fail");
    expect(loudnessMeterStatus(-14, [-0.9], target)).toBe("fail");
  });

  it("maps the EBU display range to a clamped vertical fill", () => {
    expect(meterFillPercent(-60)).toBe(0);
    expect(meterFillPercent(-37)).toBe(50);
    expect(meterFillPercent(-14)).toBe(100);
    expect(meterFillPercent(3)).toBe(100);
  });

  it("ships the required 10 Hz AudioWorklet analysis primitives", () => {
    expect(LOUDNESS_WORKLET_SOURCE).toContain("registerProcessor");
    expect(LOUDNESS_WORKLET_SOURCE).toContain("truePeakDbtp");
    expect(LOUDNESS_WORKLET_SOURCE).toContain("integratedLufs");
    expect(LOUDNESS_WORKLET_SOURCE).toContain("sampleRate / 10");
    expect(LOUDNESS_WORKLET_SOURCE).toContain("oversample = 4");
  });
});
