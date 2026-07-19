import { describe, expect, it } from "vitest";

import {
  frameCenterSeconds,
  formatTimecode,
  nudgeFrameCenterSeconds,
} from "./preview-controller.js";

describe("M1 proxy preview timing", () => {
  it("seeks to the exact center of a source frame", () => {
    expect(frameCenterSeconds(23, "24/1")).toBeCloseTo(23.5 / 24, 12);
    expect(frameCenterSeconds(29, "30000/1001")).toBeCloseTo(29.5 * 1001 / 30000, 12);
  });

  it("nudges a corrective seek toward the missed frame", () => {
    expect(nudgeFrameCenterSeconds(10, "24/1", "earlier")).toBeCloseTo(10.25 / 24, 12);
    expect(nudgeFrameCenterSeconds(10, "24/1", "later")).toBeCloseTo(10.75 / 24, 12);
  });

  it("formats integer timeline frames as transport timecode", () => {
    expect(formatTimecode(0, "24/1")).toBe("00:00:00:00");
    expect(formatTimecode(24 * 65 + 7, "24/1")).toBe("00:01:05:07");
  });
});
