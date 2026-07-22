import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import type { PlatformProfile } from "../../deliver/src/index.js";
import {
  renderThumbnailComposition,
  thumbnailCompositionPlan,
  writeThumbnailComposition,
} from "./thumbnail.js";

const PROFILE = {
  id: "youtube-longform",
  cover: { resolution: { width: 1280, height: 720 }, formats: ["png", "jpg"], maxBytes: 2_097_152 },
} as Pick<PlatformProfile, "id" | "cover">;

function image(color: string): Buffer {
  const canvas = createCanvas(64, 36);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toBuffer("image/png");
}

describe("thumbnail composition", () => {
  it("plans and renders frame, keyed-cutout, and template layers at the platform spec", async () => {
    const composition = {
      format: "guyditor-thumb/v1",
      name: "hero",
      canvas: { width: 1280, height: 720 },
      layers: [
        { kind: "frame", assetId: "ast_aaaaaaaaaa", at: { frames: 30, fps: "30/1" } },
        { kind: "cutout", assetId: "ast_bbbbbbbbbb", at: { frames: 30, fps: "30/1" }, keyPresetId: "pre_aaaaaaaaaa", transform: { x: 0.6, y: 0.1, w: 0.35, h: 0.8 } },
        { kind: "template", templateId: "tpl_aaaaaaaaaa", params: { text: "Exact cuts" } },
      ],
    } as const;
    expect(thumbnailCompositionPlan(composition, PROFILE)).toMatchObject({
      width: 1280,
      height: 720,
      requiresKeying: true,
      templateIds: ["tpl_aaaaaaaaaa"],
    });

    const rendered = await renderThumbnailComposition({
      composition,
      profile: PROFILE,
      format: "png",
      providers: {
        frame: () => Promise.resolve(image("#223344")),
        cutout: (_layer, keyPresetId) => {
          expect(keyPresetId).toBe("pre_aaaaaaaaaa");
          return Promise.resolve(image("#ffb000"));
        },
        template: () => Promise.resolve(image("#ffffff")),
        image: () => Promise.resolve(image("#000000")),
      },
    });
    expect(rendered.width).toBe(1280);
    expect(rendered.height).toBe(720);
    expect(rendered.bytes.length).toBeLessThanOrEqual(PROFILE.cover.maxBytes);
    expect(rendered.mime).toBe("image/png");
  });

  it("rejects a composition whose canvas differs from the pinned platform", () => {
    expect(() => thumbnailCompositionPlan({
      format: "guyditor-thumb/v1",
      name: "wrong",
      canvas: { width: 1080, height: 1080 },
      layers: [],
    }, PROFILE)).toThrow(/1280×720/u);
  });

  it("persists the declarative composition beside its platform-sized render", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-thumb-"));
    try {
      const composition = {
        format: "guyditor-thumb/v1",
        name: "keyed-title",
        canvas: { width: 1280, height: 720 },
        layers: [{ kind: "template", templateId: "tpl_aaaaaaaaaa", params: { title: "Exact" } }],
      } as const;
      const rendered = await renderThumbnailComposition({
        composition,
        profile: PROFILE,
        format: "png",
        providers: {
          frame: () => Promise.resolve(image("#223344")),
          cutout: () => Promise.resolve(image("#ffb000")),
          template: () => Promise.resolve(image("#ffffff")),
          image: () => Promise.resolve(image("#000000")),
        },
      });
      const stored = await writeThumbnailComposition({
        projectRoot: root,
        deliverableId: "dlv_aaaaaaaaaa",
        composition,
        rendered,
      });
      expect(stored).toEqual({
        compositionPath: "publish/dlv_aaaaaaaaaa/thumbnails/keyed-title.yaml",
        imagePath: "publish/dlv_aaaaaaaaaa/thumbnails/keyed-title.png",
      });
      expect(await readFile(join(root, stored.compositionPath), "utf8"))
        .toContain("format: guyditor-thumb/v1");
      expect((await readFile(join(root, stored.imagePath))).length).toBe(rendered.bytes.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
