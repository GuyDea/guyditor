import { describe, expect, it } from "vitest";

import {
  absoluteSeconds,
  addRational,
  addTime,
  compareRational,
  compareTime,
  convertTime,
  convertTimeRounding,
  divideRational,
  makeRational,
  multiplyRational,
  parseRational,
  parseTime,
  serializeTime,
  subRational,
  subTime,
} from "../index.js";
import type { Result } from "../index.js";

function valueOf<T>(result: Result<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

describe("rational helpers", () => {
  it("normalizes signs and common factors", () => {
    expect(valueOf(makeRational(-6, -8))).toBe("3/4");
    expect(valueOf(makeRational(0, 99))).toBe("0/1");
  });

  it("accepts a normalized broadcast frame rate", () => {
    expect(valueOf(parseRational("30000/1001"))).toBe("30000/1001");
  });

  it("rejects a non-normalized rational", () => {
    const result = parseRational("60000/2002");

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_TIME_FORMAT",
        acceptedStateChanged: false,
        affected: [],
        retry: "none",
      },
    });
  });

  it("performs exact normalized arithmetic", () => {
    expect(valueOf(addRational("1/6", "1/3"))).toBe("1/2");
    expect(valueOf(subRational("1/6", "1/3"))).toBe("-1/6");
    expect(valueOf(multiplyRational("6/5", "10/9"))).toBe("4/3");
    expect(valueOf(divideRational("6/5", "9/10"))).toBe("4/3");
  });

  it("compares rationals by exact cross-multiplication", () => {
    expect(valueOf(compareRational("1/3", "1/3"))).toBe(0);
    expect(valueOf(compareRational("1/3", "333333/1000000"))).toBe(1);
  });
});

describe("time arithmetic", () => {
  it("adds and subtracts same-rate frame durations exactly", () => {
    const first = { frames: 24, fps: "24/1" };
    const second = { frames: 48, fps: "24/1" };

    expect(valueOf(addTime(first, second))).toEqual({
      frames: 72,
      fps: "24/1",
    });
    expect(valueOf(subTime(second, first))).toEqual({
      frames: 24,
      fps: "24/1",
    });
  });

  it("rejects a negative duration from subtraction", () => {
    const result = subTime(
      { frames: 1, fps: "24/1" },
      { frames: 2, fps: "24/1" },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_TIME_NEGATIVE",
        acceptedStateChanged: false,
        affected: [],
        retry: "none",
      },
    });
  });

  it("rejects addition across different rates", () => {
    const result = addTime(
      { frames: 1, fps: "24/1" },
      { frames: 1, fps: "25/1" },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_TIME_RATE_MISMATCH" },
    });
  });

  it("compares different frame rates without an epsilon", () => {
    expect(
      valueOf(
        compareTime(
          { frames: 24, fps: "24/1" },
          { frames: 25, fps: "25/1" },
        ),
      ),
    ).toBe(0);
  });

  it("returns absolute seconds as an exact rational", () => {
    expect(
      valueOf(absoluteSeconds({ frames: 30, fps: "30000/1001" })),
    ).toBe("1001/1000");
    expect(valueOf(absoluteSeconds({ samples: 48_000, rate: 48_000 }))).toBe(
      "1/1",
    );
  });
});

describe("rate conversion", () => {
  it("converts an exactly representable frame time losslessly", () => {
    expect(
      valueOf(convertTime({ frames: 24, fps: "24/1" }, "60/1")),
    ).toEqual({ frames: 60, fps: "60/1" });
  });

  it("returns E_TIME_INCOMMENSURATE instead of rounding", () => {
    const result = convertTime({ frames: 1, fps: "2/1" }, "1/1");

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_TIME_INCOMMENSURATE",
        acceptedStateChanged: false,
        affected: [],
        retry: "none",
      },
    });
  });

  it("rounds an exact positive tie toward the earlier frame", () => {
    expect(
      valueOf(convertTimeRounding({ frames: 1, fps: "2/1" }, "1/1")),
    ).toEqual({
      time: { frames: 0, fps: "1/1" },
      preRoundingFrames: "1/2",
    });
  });

  it("rounds an exact negative tie toward the earlier frame", () => {
    expect(
      valueOf(convertTimeRounding({ frames: -1, fps: "2/1" }, "1/1")),
    ).toEqual({
      time: { frames: -1, fps: "1/1" },
      preRoundingFrames: "-1/2",
    });
  });
});

describe("canonical time serialization", () => {
  it("serializes the broadcast-rate example canonically", () => {
    expect(
      valueOf(
        serializeTime({ frames: 30_000, fps: "30000/1001" }),
      ),
    ).toBe('{"frames":30000,"fps":"30000/1001"}');
  });

  it("serializes sample time canonically", () => {
    expect(valueOf(serializeTime({ samples: 48_000, rate: 48_000 }))).toBe(
      '{"samples":48000,"rate":48000}',
    );
  });

  it("parses canonical frame and sample time", () => {
    expect(
      valueOf(parseTime('{"frames":30000,"fps":"30000/1001"}')),
    ).toEqual({ frames: 30_000, fps: "30000/1001" });
    expect(valueOf(parseTime('{"samples":48000,"rate":48000}'))).toEqual({
      samples: 48_000,
      rate: 48_000,
    });
  });

  it("rejects alternate JSON byte forms", () => {
    expect(parseTime('{ "frames": 1, "fps": "24/1" }')).toMatchObject({
      ok: false,
      error: { code: "E_TIME_FORMAT" },
    });
    expect(parseTime('{"fps":"24/1","frames":1}')).toMatchObject({
      ok: false,
      error: { code: "E_TIME_FORMAT" },
    });
  });

  it("rejects unsafe or non-integral time quantities", () => {
    expect(
      serializeTime({ frames: Number.MAX_SAFE_INTEGER + 1, fps: "24/1" }),
    ).toMatchObject({ ok: false, error: { code: "E_TIME_FORMAT" } });
    expect(serializeTime({ samples: 0.5, rate: 48_000 })).toMatchObject({
      ok: false,
      error: { code: "E_TIME_FORMAT" },
    });
  });
});
