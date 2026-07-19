import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import * as render from "./index.js";

interface RuntimeExports {
  validateTemplatePackage?: (path: string) => Promise<{ ok: boolean; value?: unknown }>;
  loadTemplateRuntime?: (pkg: unknown) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
  renderTemplatePng?: (
    runtime: unknown,
    options: Record<string, unknown>,
  ) => { ok: boolean; value?: Buffer; error?: { code: string } };
}

async function runtimePackage(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-template-runtime-"));
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "fonts"));
  const preview = createCanvas(640, 360);
  await writeFile(join(root, "preview.png"), preview.toBuffer("image/png"));
  await writeFile(join(root, "render.ts"), source, "utf8");
  await writeFile(join(root, "template.yaml"), `schema: guyditor/template/v1
id: tpl_a2c3d4e5f6
name: Runtime fixture
kind: motion
version: 1.0.0
engine: overlay/v1
entry: render.ts
min_guyditor: "1.0.0"
duration:
  mode: fixed
  default: { frames: 30, fps: "30/1" }
params:
  type: object
  additionalProperties: false
  required: [accent]
  properties:
    accent: { type: string, pattern: "^#[0-9a-fA-F]{6}$" }
preview:
  file: preview.png
  params: { accent: "#336699" }
fonts: []
safe_area_aware: true
`, "utf8");
  return root;
}

describe("FR-600/602 deterministic template runtime", () => {
  it("renders byte-identical PNGs for the same seed and changes seeded pixels for another seed", async () => {
    const api = render as unknown as RuntimeExports;
    expect(api.loadTemplateRuntime).toBeTypeOf("function");
    expect(api.renderTemplatePng).toBeTypeOf("function");
    if (
      api.validateTemplatePackage === undefined ||
      api.loadTemplateRuntime === undefined ||
      api.renderTemplatePng === undefined
    ) return;
    const root = await runtimePackage(`export default {
      render(ctx, params) {
        ctx.canvas.fillStyle = params.accent;
        ctx.canvas.fillRect(0, 0, ctx.width, ctx.height);
        ctx.canvas.fillStyle = "#ffffff";
        ctx.canvas.fillRect(ctx.rng.int(0, ctx.width - 8), 4, 8, 8);
      }
    };\n`);
    const pkg = await api.validateTemplatePackage(root);
    expect(pkg.ok).toBe(true);
    const loaded = await api.loadTemplateRuntime(pkg.value);
    expect(loaded.ok).toBe(true);
    const base = {
      params: { accent: "#336699" },
      seed: 42,
      frame: 7,
      totalFrames: 30,
      fps: "30/1",
      width: 320,
      height: 180,
      safeArea: { top: 9, right: 16, bottom: 9, left: 16 },
      brand: { palette: {} },
    };
    const first = api.renderTemplatePng(loaded.value, base);
    const second = api.renderTemplatePng(loaded.value, base);
    const changed = api.renderTemplatePng(loaded.value, { ...base, seed: 43 });

    expect(first.ok).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(changed.value).not.toEqual(first.value);
  });

  it("rejects invalid params and blocks wall-clock, ambient randomness, network, and timers", async () => {
    const api = render as unknown as RuntimeExports;
    if (
      api.validateTemplatePackage === undefined ||
      api.loadTemplateRuntime === undefined ||
      api.renderTemplatePng === undefined
    ) return;
    const base = {
      params: { accent: "#336699" },
      seed: 42,
      frame: 0,
      totalFrames: 30,
      fps: "30/1",
      width: 64,
      height: 36,
      safeArea: { top: 2, right: 3, bottom: 2, left: 3 },
      brand: { palette: {} },
    };
    const invalidRoot = await runtimePackage("export default { render() {} };\n");
    const invalidPackage = await api.validateTemplatePackage(invalidRoot);
    const invalidRuntime = await api.loadTemplateRuntime(invalidPackage.value);
    expect(api.renderTemplatePng(invalidRuntime.value, {
      ...base,
      params: { accent: "not-a-color" },
    })).toMatchObject({ ok: false, error: { code: "E_TEMPLATE_PARAMS_INVALID" } });

    for (const expression of [
      "Date.now()",
      "Math.random()",
      "fetch('https://example.invalid')",
      "setTimeout(() => {}, 0)",
    ]) {
      const root = await runtimePackage(`export default {
        render(ctx) { void (${expression}); ctx.canvas.fillRect(0, 0, 1, 1); }
      };\n`);
      const pkg = await api.validateTemplatePackage(root);
      const runtime = await api.loadTemplateRuntime(pkg.value);
      expect(api.renderTemplatePng(runtime.value, base), expression).toMatchObject({
        ok: false,
        error: { code: "E_TEMPLATE_SANDBOX" },
      });
    }

    const fontRoot = await runtimePackage(`export default {
      render(ctx) {
        ctx.canvas.font = "12px Arial";
        ctx.canvas.fillText("ambient glyph", 0, 12);
      }
    };\n`);
    const fontPackage = await api.validateTemplatePackage(fontRoot);
    const fontRuntime = await api.loadTemplateRuntime(fontPackage.value);
    expect(api.renderTemplatePng(fontRuntime.value, base)).toMatchObject({
      ok: false,
      error: { code: "E_TEMPLATE_SANDBOX" },
    });
  });
});
