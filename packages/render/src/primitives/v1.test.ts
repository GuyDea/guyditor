import { createHash } from "node:crypto";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import {
  PRIMITIVES_V1_VERSION,
  primitivesV1,
} from "./v1.js";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("FR-610 primitives/v1", () => {
  it("samples easing and a fixed-step spring deterministically", () => {
    expect(PRIMITIVES_V1_VERSION).toBe("primitives/v1@1");
    expect([
      primitivesV1.easing.sample("linear", 0.375),
      primitivesV1.easing.sample("ease-in", 0.375),
      primitivesV1.easing.sample("ease-out", 0.375),
      primitivesV1.easing.sample("ease-in-out", 0.375),
      primitivesV1.easing.spring(0.375, {
        stiffness: 170,
        damping: 26,
        mass: 1,
        steps: 120,
      }),
    ]).toEqual([
      0.375,
      0.052734375,
      0.755859375,
      0.2109375,
      0.952460309389,
    ]);
  });

  it("uses exact canonical word timing for a word-anchored reveal", () => {
    const timing = {
      wordId: "w000001",
      start: { frames: 24, fps: "24/1" },
      end: { frames: 30, fps: "24/1" },
      approximate: false,
    } as const;
    expect(primitivesV1.text.reveal({
      text: "Exact word",
      mode: "word",
      timeline: { frames: 23, fps: "24/1" },
      wordTiming: timing,
      easing: "linear",
    })).toMatchObject({ visibleText: "", progress: 0 });
    expect(primitivesV1.text.reveal({
      text: "Exact word",
      mode: "word",
      timeline: { frames: 27, fps: "24/1" },
      wordTiming: timing,
      easing: "linear",
    })).toMatchObject({ visibleText: "Exact", progress: 0.5 });
    expect(primitivesV1.text.reveal({
      text: "Exact word",
      mode: "word",
      timeline: { frames: 30_000, fps: "24000/1001" },
      wordTiming: {
        ...timing,
        start: { frames: 24_000, fps: "24000/1001" },
        end: { frames: 30_000, fps: "24000/1001" },
      },
      easing: "linear",
    })).toMatchObject({ visibleText: "Exact word", progress: 1 });
  });

  it("renders every visual primitive into a stable pixel-exact composite", async () => {
    const canvas = createCanvas(320, 180);
    const painter = canvas.getContext("2d");
    painter.fillStyle = "#111820";
    painter.fillRect(0, 0, 320, 180);

    primitivesV1.texture.fill(painter, {
      kind: "dots",
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      foreground: "#26384a",
      background: "#111820",
      spacing: 12,
      size: 1.5,
      seed: 17,
    });
    primitivesV1.shapes.roundedRect(painter, {
      x: 12,
      y: 12,
      width: 138,
      height: 72,
      radius: 10,
      fill: "#f4f7f5",
      stroke: "#77e7c4",
      strokeWidth: 2,
    });
    primitivesV1.text.drawReveal(painter, {
      text: "MOTION SYSTEM",
      mode: "character",
      progress: 0.72,
      easing: "ease-out",
      x: 22,
      y: 43,
      font: "600 14px sans-serif",
      fill: "#111820",
    });
    primitivesV1.wipes.withRect(painter, {
      direction: "left-to-right",
      progress: 0.63,
      easing: "ease-in-out",
      x: 20,
      y: 55,
      width: 116,
      height: 18,
    }, () => {
      painter.fillStyle = "#ff6b57";
      painter.fillRect(20, 55, 116, 18);
    });

    primitivesV1.charts.bar(painter, {
      values: [12, 25, 18],
      max: 30,
      x: 168,
      y: 16,
      width: 136,
      height: 66,
      color: "#77e7c4",
      gap: 8,
      progress: 0.85,
    });
    primitivesV1.charts.line(painter, {
      values: [4, 19, 13, 28],
      min: 0,
      max: 30,
      x: 16,
      y: 102,
      width: 128,
      height: 58,
      color: "#ffd166",
      strokeWidth: 3,
      progress: 0.9,
    });
    primitivesV1.charts.pie(painter, {
      values: [3, 2, 1],
      colors: ["#ff6b57", "#77e7c4", "#ffd166"],
      centerX: 184,
      centerY: 131,
      radius: 28,
      progress: 0.8,
    });
    primitivesV1.charts.counter(painter, {
      from: 0,
      to: 42,
      progress: 0.75,
      decimals: 0,
      suffix: "%",
      x: 221,
      y: 112,
      font: "600 18px sans-serif",
      fill: "#f4f7f5",
    });

    const svg = Buffer.from(
      '<svg xmlns="http://www.w' + '3.org/2000/svg" width="32" height="24">' +
      '<path fill="#26384a" d="M1 1h30v22H1z"/></svg>',
    );
    primitivesV1.geo.highlightPath(painter, {
      map: await loadImage(svg),
      x: 226,
      y: 128,
      width: 74,
      height: 40,
      path: [[0.1, 0.7], [0.43, 0.22], [0.9, 0.48]],
      color: "#ff6b57",
      strokeWidth: 3,
      progress: 0.7,
    });

    const cutoutCanvas = createCanvas(12, 12);
    const cutoutPainter = cutoutCanvas.getContext("2d");
    cutoutPainter.fillStyle = "rgba(119,231,196,0.8)";
    cutoutPainter.beginPath();
    cutoutPainter.arc(6, 6, 5, 0, Math.PI * 2);
    cutoutPainter.fill();
    primitivesV1.cutout.place(painter, {
      image: await loadImage(cutoutCanvas.toBuffer("image/png")),
      x: 276,
      y: 84,
      width: 28,
      height: 28,
      border: { width: 2, color: "#f4f7f5" },
      shadow: { dx: 3, dy: 3, blur: 2, color: "rgba(0,0,0,0.5)" },
    });

    expect(digest(canvas.toBuffer("image/png")))
      .toBe("82dfd3eac17f6d70a0ce90d7bb76d7884e707946d9c40d4925929e4bd10b855b");
  });
});
