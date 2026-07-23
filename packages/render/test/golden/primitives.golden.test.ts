import { createHash } from "node:crypto";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { primitivesV1 as motion } from "../../src/index.js";

describe("FR-610 primitives/v1 pixel golden", () => {
  it("pins every visual primitive family and texture variant", async () => {
    const canvas = createCanvas(480, 270);
    const g = canvas.getContext("2d");

    motion.texture.fill(g, {
      kind: "noise",
      x: 0,
      y: 0,
      width: 160,
      height: 270,
      foreground: "#77E7C4",
      background: "#102A43",
      spacing: 8,
      size: 2,
      seed: 610,
    });
    motion.texture.fill(g, {
      kind: "dots",
      x: 160,
      y: 0,
      width: 160,
      height: 270,
      foreground: "#FF6B57",
      background: "#F4EDE4",
      spacing: 13,
      size: 2,
      seed: 611,
    });
    motion.texture.fill(g, {
      kind: "stripes",
      x: 320,
      y: 0,
      width: 160,
      height: 270,
      foreground: "#FFE45E",
      background: "#102A43",
      spacing: 18,
      size: 3,
    });

    motion.shapes.roundedRect(g, {
      x: 18, y: 16, width: 120, height: 56, radius: 12,
      fill: "#F4EDE4", stroke: "#FF6B57", strokeWidth: 3,
    });
    motion.shapes.ellipse(g, {
      centerX: 215, centerY: 45, radiusX: 43, radiusY: 27,
      fill: "#102A43", stroke: "#77E7C4", strokeWidth: 4,
    });
    motion.shapes.polygon(g, {
      points: [{ x: 350, y: 70 }, { x: 397, y: 15 }, { x: 452, y: 68 }],
      fill: "#FF6B57", stroke: "#F4EDE4", strokeWidth: 3,
    });

    motion.masks.withShape(g, {
      kind: "ellipse",
      centerX: 74,
      centerY: 130,
      radiusX: 55,
      radiusY: 35,
    }, () => {
      g.fillStyle = "#FFE45E";
      g.fillRect(12, 90, 124, 80);
      g.fillStyle = "#102A43";
      g.fillRect(64, 90, 24, 80);
    });
    motion.wipes.withRect(g, {
      direction: "right-to-left",
      progress: motion.easing.sample("ease-in-out", 0.72),
      x: 170,
      y: 92,
      width: 132,
      height: 72,
    }, () => {
      g.fillStyle = "#FF6B57";
      g.fillRect(170, 92, 132, 72);
    });
    motion.text.drawReveal(g, {
      text: "WORD BY WORD",
      mode: "word",
      progress: 0.74,
      easing: "ease-out",
      x: 178,
      y: 133,
      font: "600 17px sans-serif",
      fill: "#FFFFFF",
    });

    motion.charts.bar(g, {
      values: [7, 15, 11],
      max: 18,
      x: 326,
      y: 92,
      width: 132,
      height: 72,
      color: "#77E7C4",
      gap: 8,
      progress: 0.81,
    });
    motion.charts.line(g, {
      values: [2, 14, 6, 17],
      min: 0,
      max: 18,
      x: 18,
      y: 190,
      width: 122,
      height: 58,
      color: "#FFE45E",
      strokeWidth: 3,
      progress: 0.88,
    });
    motion.charts.pie(g, {
      values: [5, 3, 2],
      colors: ["#FF6B57", "#77E7C4", "#FFE45E"],
      centerX: 196,
      centerY: 218,
      radius: 31,
      progress: 0.79,
    });
    motion.charts.counter(g, {
      from: 12,
      to: 94,
      progress: 0.75,
      decimals: 1,
      prefix: "$",
      suffix: "m",
      x: 242,
      y: 226,
      font: "600 21px sans-serif",
      fill: "#102A43",
    });

    const map = await loadImage(Buffer.from(
      '<svg xmlns="http://www.w' + '3.org/2000/svg" width="80" height="50">' +
      '<path fill="#F4EDE4" stroke="#102A43" d="M2 24 21 3l25 9 30-8 2 42-33-6-25 8z"/></svg>',
    ));
    motion.geo.highlightPath(g, {
      map,
      x: 326,
      y: 184,
      width: 132,
      height: 72,
      path: [[0.12, 0.74], [0.42, 0.22], [0.88, 0.58]],
      color: "#FF6B57",
      strokeWidth: 4,
      progress: 0.83,
    });
    motion.cutout.place(g, {
      image: map,
      x: 285,
      y: 177,
      width: 34,
      height: 52,
      border: { width: 2, color: "#FFFFFF" },
      shadow: { dx: 4, dy: 5, blur: 4, color: "rgba(0,0,0,0.5)" },
    });

    const hash = createHash("sha256")
      .update(canvas.toBuffer("image/png"))
      .digest("hex");
    expect(hash).toBe("1fe94152235ffd0c9a09b46035d387c73b5d83d78ce9f3658db60a616aace503");
  });
});
