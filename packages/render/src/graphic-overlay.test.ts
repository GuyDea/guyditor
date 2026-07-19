import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { success } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { TemplateRegistry } from "./template-registry.js";
import {
  renderGraphicFrame,
  renderGraphicOverlaySequence,
} from "./graphic-overlay.js";

const TEMPLATE_ID = "tpl_a2c3d4e5f6";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("FR-601 anchored graphic overlay painter", () => {
  it("resolves a word anchor and renders byte-identical cached frame sequences", async () => {
    const project = projectFixture();
    const registry = new TemplateRegistry({
      builtinsRoot: resolve(process.cwd(), "templates"),
      userRoot: await mkdtemp(join(tmpdir(), "guyditor-empty-template-library-")),
    });
    const descriptor = await registry.latest(TEMPLATE_ID);
    expect(descriptor.ok).toBe(true);
    if (!descriptor.ok) return;
    project.templates = {
      [TEMPLATE_ID]: {
        version: descriptor.value.version,
        contentHash: descriptor.value.contentHash,
      },
    };
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Graphics",
      order: 2,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
      items: [{
        id: "gfx_bbbbbbbbbb",
        template: TEMPLATE_ID,
        at: "word:w000001",
        duration: { frames: 12, fps: "24/1" },
        params: {
          title: "Anchored lower third",
          subtitle: "Rendered once, everywhere",
          accent: "#77E7C4",
          position: "left",
        },
        seed: 42,
      }],
    });
    const common = {
      project,
      sequenceId: "seq_aaaaaaaaaa",
      registry,
      anchorDependencies: {
        wordLookup: {
          resolveWord: () => success({
            wordId: "w000001",
            assetId: "ast_aaaaaaaaaa",
            start: { frames: 4, fps: "24/1" },
            end: { frames: 5, fps: "24/1" },
            approximate: false,
          }),
        },
      },
      width: 640,
      height: 360,
      fps: "24/1",
      brand: { palette: {} },
    } as const;

    const active = await renderGraphicFrame({ ...common, frame: 8 });
    const before = await renderGraphicFrame({ ...common, frame: 3 });
    expect(digest(active)).not.toBe(digest(before));

    const cacheRoot = await mkdtemp(join(tmpdir(), "guyditor-graphic-overlays-"));
    const first = await renderGraphicOverlaySequence({ ...common, cacheRoot });
    const second = await renderGraphicOverlaySequence({ ...common, cacheRoot });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ atOutputFrame: 4, durationFrames: 12 });
    if (first === undefined) return;
    expect(digest(await readFile(first.pathPattern.replace("%08d", "00000004"))))
      .toBe(digest(active));
  });

  it("rejects orphaned and backwards until anchors as export-blocking errors", async () => {
    const project = projectFixture();
    const registry = new TemplateRegistry({
      builtinsRoot: resolve(process.cwd(), "templates"),
      userRoot: await mkdtemp(join(tmpdir(), "guyditor-empty-template-library-")),
    });
    const descriptor = await registry.latest(TEMPLATE_ID);
    expect(descriptor.ok).toBe(true);
    if (!descriptor.ok) return;
    project.templates = {
      [TEMPLATE_ID]: { version: descriptor.value.version, contentHash: descriptor.value.contentHash },
    };
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Graphics",
      order: 2,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
      items: [{
        id: "gfx_bbbbbbbbbb",
        template: TEMPLATE_ID,
        at: "timeline:12@24/1",
        duration: { until: "timeline:8@24/1" },
        params: {
          title: "Invalid",
          subtitle: "Backwards",
          accent: "#77E7C4",
          position: "left",
        },
        seed: 1,
      }],
    });

    await expect(renderGraphicFrame({
      project,
      sequenceId: "seq_aaaaaaaaaa",
      registry,
      width: 640,
      height: 360,
      fps: "24/1",
      frame: 12,
      brand: { palette: {} },
    })).rejects.toMatchObject({ code: "E_GRAPHIC_NEGATIVE_SPAN" });
  });
});
