import { describe, expect, it } from "vitest";

import type { DuckingConfig, SampleTime } from "../../core/src/index.js";
import { compileDuckingEnvelope } from "./ducking.js";

const AUTO: DuckingConfig = {
  enabled: true,
  mode: "auto",
  duckDb: -12,
  attackMs: 150,
  releaseMs: 400,
  holdMs: 250,
  minGapMs: 700,
};

function at(samples: number): SampleTime {
  return { samples, rate: 1_000 };
}

describe("compileDuckingEnvelope", () => {
  it("merges short speech gaps and emits exact attack/hold/release points", () => {
    const result = compileDuckingEnvelope({
      config: AUTO,
      speech: [
        { start: at(1_000), end: at(2_000) },
        { start: at(2_500), end: at(3_000) },
      ],
      overrides: [],
      duration: at(5_000),
    });

    expect(result).toEqual([
      { at: at(0), gainDb: 0 },
      { at: at(850), gainDb: 0 },
      { at: at(1_000), gainDb: -12 },
      { at: at(3_250), gainDb: -12 },
      { at: at(3_650), gainDb: 0 },
      { at: at(5_000), gainDb: 0 },
    ]);
  });

  it("clamps overlapping release/attack ramps to the lower linear-in-dB gain", () => {
    const result = compileDuckingEnvelope({
      config: { ...AUTO, attackMs: 400, releaseMs: 400, holdMs: 0, minGapMs: 100 },
      speech: [
        { start: at(1_000), end: at(1_200) },
        { start: at(1_500), end: at(1_700) },
      ],
      overrides: [],
      duration: at(2_400),
    });

    expect(result).toContainEqual({ at: at(1_350), gainDb: -7.5 });
    expect(result.find(({ at: point }) => point.samples === 1_200)?.gainDb).toBe(-12);
    expect(result.find(({ at: point }) => point.samples === 1_500)?.gainDb).toBe(-12);
  });

  it("lets manual values win throughout their release-sized neighborhood", () => {
    const result = compileDuckingEnvelope({
      config: AUTO,
      speech: [{ start: at(1_000), end: at(2_000) }],
      overrides: [{ at: at(1_500), gainDb: -6 }],
      duration: at(3_000),
    });

    expect(result).toEqual(expect.arrayContaining([
      { at: at(1_100), gainDb: -6 },
      { at: at(1_500), gainDb: -6 },
      { at: at(1_900), gainDb: -6 },
    ]));
  });

  it("is byte-for-byte deterministic and manual mode ignores VAD intervals", () => {
    const input = {
      config: { ...AUTO, mode: "manual" as const },
      speech: [{ start: at(100), end: at(900) }],
      overrides: [{ at: at(1_000), gainDb: -9 }],
      duration: at(2_000),
    };

    const first = compileDuckingEnvelope(input);
    const second = compileDuckingEnvelope(structuredClone(input));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.some(({ at: point, gainDb }) => point.samples === 100 && gainDb < 0)).toBe(false);
  });
});
