import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PipConfig } from "../../core/src/index.js";
import { rasterizePipAssets } from "./pip-assets.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) =>
  rm(path, { recursive: true, force: true }))));

const pip: PipConfig = {
  style: {
    mask: { shape: "rounded", cornerRadius: 0.12, featherPx: 1 },
    border: { widthPx: 2, color: "#FFFFFF", opacity: 0.9 },
    shadow: { dx: 1, dy: 2, blurPx: 3, color: "#000000", opacity: 0.4 },
    background: { color: "#15222B", padPx: 2 },
  },
  placement: { base: { anchor: "bottom_right", width: "30%", margin: "5%", aspect: "16:9" } },
  keyframes: [{
    id: "kfr_aaaaaaaaaa", at: "timeline:seq_aaaaaaaaaa@2",
    placement: { anchor: "bottom_left", width: "30%", margin: "5%", aspect: "16:9" },
    transition: { preset: "pre_pipsmoothm", durationFrames: 2 },
  }],
};

describe("deterministic PiP mask/chrome rasterization", () => {
  it("writes cache-keyed gray-mask, underlay, and chrome sequences", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "guyditor-pip-assets-"));
    temporary.push(cacheRoot);
    const options = {
      pip,
      compWidth: 64,
      compHeight: 36,
      durationFrames: 3,
      anchorFrames: { "timeline:seq_aaaaaaaaaa@2": 2 },
      cacheRoot,
    };
    const first = await rasterizePipAssets(options);
    const second = await rasterizePipAssets(options);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ durationFrames: 3, animated: true });
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/u);
    for (const pattern of [first.maskPath, first.underlayPath, first.chromePath]) {
      expect(pattern).toContain("%08d.png");
      const bytes = await readFile(pattern.replace("%08d", "00000001"));
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  });
});
