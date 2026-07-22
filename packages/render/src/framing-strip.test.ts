import { describe, expect, it } from "vitest";

import { framingPreviewStripSvg } from "./framing-strip.js";

describe("framingPreviewStripSvg", () => {
  it("embeds first/middle/last proxies with crop boxes and a motion path", () => {
    const svg = framingPreviewStripSvg("fd_0001", [
      { frame: 0, png: Buffer.from("first"), crop: { x: 0.1, y: 0, w: 0.3, h: 1 } },
      { frame: 45, png: Buffer.from("middle"), crop: { x: 0.2, y: 0, w: 0.3, h: 1 } },
      { frame: 89, png: Buffer.from("last"), crop: { x: 0.3, y: 0, w: 0.3, h: 1 } },
    ]);

    expect(svg.match(/<image /gu)).toHaveLength(3);
    expect(svg.match(/<rect x=/gu)).toHaveLength(3);
    expect(svg).toContain("<polyline points=");
    expect(svg).toContain("frame 0");
    expect(svg).toContain("frame 45");
    expect(svg).toContain("frame 89");
  });
});
