import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { rasterizeKeyMasks } from "./key-mask.js";

describe("deterministic key-mask rasterization", () => {
  it("writes inverse garbage and positive holdout grayscale masks", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-mask-"));
    const masks = await rasterizeKeyMasks({
      cacheRoot: root,
      durationFrames: 30,
      fps: "30/1",
      height: 20,
      masks: [{
        id: "msk_aaaaaaaaaa",
        role: "garbage",
        shape: "rect",
        points: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }],
        featherPx: 0,
      }, {
        id: "msk_bbbbbbbbbb",
        role: "holdout",
        shape: "ellipse",
        points: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }],
        featherPx: 0,
      }],
      width: 20,
    });

    expect(masks.map(({ animated, path, sha256 }) => ({ animated, path, sha256 })))
      .toEqual([
        { animated: false, path: expect.stringMatching(/\.png$/u), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        { animated: false, path: expect.stringMatching(/\.png$/u), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      ]);

    const garbage = await loadImage(masks[0]!.path);
    const garbageContext = (await import("@napi-rs/canvas")).createCanvas(20, 20).getContext("2d");
    garbageContext.drawImage(garbage, 0, 0);
    const garbagePixels = garbageContext.getImageData(0, 0, 20, 20).data;
    expect(garbagePixels[0]).toBe(255);
    expect(garbagePixels[(10 * 20 + 10) * 4]).toBe(0);

    const holdout = await loadImage(masks[1]!.path);
    const holdoutContext = (await import("@napi-rs/canvas")).createCanvas(20, 20).getContext("2d");
    holdoutContext.drawImage(holdout, 0, 0);
    const holdoutPixels = holdoutContext.getImageData(0, 0, 20, 20).data;
    expect(holdoutPixels[0]).toBe(0);
    expect(holdoutPixels[(10 * 20 + 10) * 4]).toBe(255);
  });
});
