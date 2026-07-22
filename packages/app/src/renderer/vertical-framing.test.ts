import { describe, expect, it } from "vitest";

import { cropVideoStyle, projectTrackBox } from "./vertical-framing.js";

describe("vertical framing preview geometry", () => {
  it("projects source boxes through the active crop and sizes the video aperture", () => {
    const crop = { x: 0.25, y: 0, w: 0.5, h: 1 };
    expect(cropVideoStyle(crop)).toEqual({
      width: "200%",
      height: "100%",
      left: "-50%",
      top: "0%",
    });
    expect(projectTrackBox({ x: 0.4, y: 0.2, w: 0.1, h: 0.3 }, crop)).toEqual({
      x: 0.3,
      y: 0.2,
      w: 0.2,
      h: 0.3,
    });
  });
});
