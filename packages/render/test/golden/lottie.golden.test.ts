import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import {
  TemplateRegistry,
  loadTemplateRuntime,
  lottieToolchainHash,
  renderGraphicFrame,
  renderTemplatePng,
} from "../../src/index.js";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("FR-611 Lottie determinism goldens", () => {
  it("pins explicit-frame pixels, brand-slot remapping, and live-overlay painter parity", async () => {
    const registry = new TemplateRegistry({
      builtinsRoot: resolve("templates"),
      userRoot: await mkdtemp(join(tmpdir(), "guyditor-lottie-golden-user-")),
    });
    const descriptor = await registry.latest("tpl_k2m3n4p5q6");
    if (!descriptor.ok) throw descriptor.error;
    const pkg = await registry.package(
      descriptor.value.id,
      descriptor.value.version,
      descriptor.value.contentHash,
    );
    if (!pkg.ok) throw pkg.error;
    const runtime = await loadTemplateRuntime(pkg.value);
    if (!runtime.ok) throw runtime.error;
    const common = {
      seed: 611,
      frame: 34,
      totalFrames: 90,
      fps: "30/1",
      width: 640,
      height: 360,
      safeArea: { top: 18, right: 32, bottom: 18, left: 32 },
      brand: { palette: {} },
    } as const;
    const defaultFrame = renderTemplatePng(runtime.value, {
      ...common,
      params: {
        accent: "#FF6B57",
        surface: "#F4EDE4",
        ink: "#102A43",
      },
    });
    const repeated = renderTemplatePng(runtime.value, {
      ...common,
      params: {
        accent: "#FF6B57",
        surface: "#F4EDE4",
        ink: "#102A43",
      },
    });
    const branded = renderTemplatePng(runtime.value, {
      ...common,
      params: {
        accent: "#7C3AED",
        surface: "#111827",
        ink: "#F8FAFC",
      },
    });
    if (!defaultFrame.ok) throw defaultFrame.error;
    if (!repeated.ok) throw repeated.error;
    if (!branded.ok) throw branded.error;
    expect(repeated.value).toEqual(defaultFrame.value);
    expect({
      defaultFrame: digest(defaultFrame.value),
      brandedFrame: digest(branded.value),
    }).toEqual({
      defaultFrame: "5bc2680eaf3b41c87f0caa7e2130626b8bf07d8709aa02fdbb343f9b2bd51bdf",
      brandedFrame: "57aae37bd034d1d38be1124b0e319f37eab04ebdf98a5a54e9dae730bd3f9d53",
    });

    const project = projectFixture();
    project.templates = {
      [descriptor.value.id]: {
        version: descriptor.value.version,
        contentHash: descriptor.value.contentHash,
      },
    };
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Lottie",
      order: 2,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
      items: [{
        id: "gfx_bbbbbbbbbb",
        template: descriptor.value.id,
        at: "timeline:0@24/1",
        duration: { frames: 24, fps: "24/1" },
        params: {
          accent: "#7C3AED",
          surface: "#111827",
          ink: "#F8FAFC",
        },
        seed: 611,
      }],
    });
    const preview = await renderGraphicFrame({
      project,
      sequenceId: "seq_aaaaaaaaaa",
      registry,
      width: 640,
      height: 360,
      fps: "24/1",
      frame: 10,
      brand: { palette: {} },
    });
    const exportPainter = renderTemplatePng(runtime.value, {
      params: {
        accent: "#7C3AED",
        surface: "#111827",
        ink: "#F8FAFC",
      },
      seed: 611,
      frame: 10,
      totalFrames: 24,
      fps: "24/1",
      width: 640,
      height: 360,
      safeArea: { top: 18, right: 32, bottom: 18, left: 32 },
      brand: { palette: {} },
      timeline: { frames: 10, fps: "24/1" },
    });
    if (!exportPainter.ok) throw exportPainter.error;
    expect(preview).toEqual(exportPainter.value);
    expect(digest(preview))
      .toBe("3a226db84752667a0740248f388fddf01f5bb4eb2de3b9f649a7f4a6aec2a8cf");
    expect(lottieToolchainHash("lottie-canvas-shim/v2"))
      .not.toBe(lottieToolchainHash());
  });
});
