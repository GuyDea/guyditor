import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

async function attachLottie(root: string): Promise<Buffer> {
  const document = {
    v: "5.12.2",
    fr: 30,
    ip: 0,
    op: 30,
    w: 100,
    h: 60,
    assets: [],
    layers: [{
      ty: 4,
      nm: "Animated badge",
      ip: 0,
      op: 30,
      ks: {
        a: { a: 0, k: [0, 0] },
        p: { a: 0, k: [50, 30] },
        s: { a: 0, k: [100, 100] },
        r: { a: 0, k: 0 },
        o: { a: 0, k: 100 },
      },
      shapes: [
        {
          ty: "rc",
          nm: "Badge",
          p: { a: 0, k: [0, 0] },
          s: {
            a: 1,
            k: [{ t: 0, s: [20, 20], e: [80, 40] }, { t: 29, s: [80, 40] }],
          },
          r: { a: 0, k: 8 },
        },
        {
          ty: "fl",
          nm: "accent",
          c: { a: 0, k: [0.46, 0.91, 0.77, 1] },
          o: { a: 0, k: 100 },
        },
      ],
    }],
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  await writeFile(join(root, "assets", "badge.json"), bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const manifestPath = join(root, "template.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "fonts: []",
      `fonts: []
assets:
  - name: badge-motion
    kind: lottie
    file: assets/badge.json
    sha256: ${hash}
    license:
      origin: licensed
      licenseName: Fixture License
      licensor: Fixture Studio
      restrictions: []`,
    ),
    "utf8",
  );
  return bytes;
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

  it("imports only primitives/v1 and drives reveals from canonical word timing", async () => {
    const api = render as unknown as RuntimeExports;
    if (
      api.validateTemplatePackage === undefined ||
      api.loadTemplateRuntime === undefined ||
      api.renderTemplatePng === undefined
    ) return;
    const root = await runtimePackage(`
      import { primitivesV1 } from "@guyditor/render/primitives/v1";
      export default {
        render(ctx) {
          const reveal = primitivesV1.text.reveal({
            text: "EXACT TIMING",
            mode: "word",
            timeline: ctx.timeline,
            wordTiming: ctx.wordTiming,
            easing: "linear"
          });
          ctx.canvas.fillStyle = "#336699";
          ctx.canvas.fillRect(0, 0, ctx.width, ctx.height);
          ctx.canvas.fillStyle = reveal.visibleUnits === 0
            ? "#000000"
            : reveal.visibleUnits === 1 ? "#777777" : "#ffffff";
          ctx.canvas.fillRect(0, 0, 8, 8);
        }
      };\n`);
    const pkg = await api.validateTemplatePackage(root);
    if (!pkg.ok) throw new Error("Primitives fixture package did not validate.");
    const loaded = await api.loadTemplateRuntime(pkg.value);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const timing = {
      wordId: "w000001",
      start: { frames: 24_000, fps: "24000/1001" },
      end: { frames: 30_000, fps: "24000/1001" },
      approximate: false,
    };
    const base = {
      params: { accent: "#336699" },
      seed: 42,
      frame: 0,
      totalFrames: 12_000,
      fps: "24000/1001",
      width: 64,
      height: 36,
      safeArea: { top: 2, right: 3, bottom: 2, left: 3 },
      brand: { palette: {} },
      wordTiming: timing,
    };
    const before = api.renderTemplatePng(loaded.value, {
      ...base,
      timeline: { frames: 23_999, fps: "24000/1001" },
    });
    const middle = api.renderTemplatePng(loaded.value, {
      ...base,
      timeline: { frames: 27_000, fps: "24000/1001" },
    });
    const after = api.renderTemplatePng(loaded.value, {
      ...base,
      timeline: { frames: 30_000, fps: "24000/1001" },
    });
    expect(before.ok).toBe(true);
    expect(middle.ok).toBe(true);
    expect(after.ok).toBe(true);
    expect(middle.value).not.toEqual(before.value);
    expect(after.value).not.toEqual(middle.value);

    const forbiddenRoot = await runtimePackage(`
      import { readFileSync } from "node:fs";
      export default { render() { readFileSync("/etc/passwd"); } };\n`);
    const forbiddenPackage = await api.validateTemplatePackage(forbiddenRoot);
    const forbiddenRuntime = await api.loadTemplateRuntime(forbiddenPackage.value);
    expect(forbiddenRuntime).toMatchObject({
      ok: false,
      error: { code: "E_TEMPLATE_SANDBOX" },
    });
  });

  it("rechecks declared font bytes immediately before painter registration", async () => {
    const api = render as unknown as RuntimeExports;
    if (
      api.validateTemplatePackage === undefined ||
      api.loadTemplateRuntime === undefined
    ) return;
    const root = await runtimePackage("export default { render() {} };\n");
    const sourceFont = new URL("../assets/fonts/Inconsolata.otf", import.meta.url);
    const font = await readFile(sourceFont);
    await copyFile(sourceFont, join(root, "fonts", "Brand.otf"));
    const hash = createHash("sha256").update(font).digest("hex");
    const manifestPath = join(root, "template.yaml");
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf8")).replace(
        "fonts: []",
        `fonts:
  - family: Brand Fixture
    file: fonts/Brand.otf
    weight: 600
    sha256: ${hash}
    license:
      origin: licensed
      licenseName: SIL Open Font License 1.1
      licenseUrl: https://openfontlicense.org/
      licensor: Raph Levien
      restrictions: []`,
      ),
      "utf8",
    );
    const pkg = await api.validateTemplatePackage(root);
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    await writeFile(join(root, "fonts", "Brand.otf"), Buffer.concat([font, Buffer.from([0])]));
    await expect(api.loadTemplateRuntime(pkg.value)).resolves.toMatchObject({
      ok: false,
      error: { code: "E_TEMPLATE_ASSET_HASH" },
    });
  });

  it("exposes hash-rechecked Lottie assets to the primitives/v1 explicit-frame painter", async () => {
    const api = render as unknown as RuntimeExports;
    if (
      api.validateTemplatePackage === undefined ||
      api.loadTemplateRuntime === undefined ||
      api.renderTemplatePng === undefined
    ) return;
    const root = await runtimePackage(`
      import { primitivesV1 } from "@guyditor/render/primitives/v1";
      export default {
        render(ctx, params) {
          primitivesV1.lottie.draw(ctx.canvas, {
            animation: ctx.lottie("badge-motion"),
            frame: ctx.frame,
            x: 0,
            y: 0,
            width: ctx.width,
            height: ctx.height,
            colorSlots: { accent: params.accent }
          });
        }
      };\n`);
    const original = await attachLottie(root);
    const pkg = await api.validateTemplatePackage(root);
    expect(pkg.ok).toBe(true);
    const loaded = await api.loadTemplateRuntime(pkg.value);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const base = {
      params: { accent: "#7C3AED" },
      seed: 42,
      frame: 7,
      totalFrames: 30,
      fps: "30/1",
      width: 200,
      height: 120,
      safeArea: { top: 6, right: 10, bottom: 6, left: 10 },
      brand: { palette: { accent: "#7C3AED" } },
    };
    const first = api.renderTemplatePng(loaded.value, base);
    const second = api.renderTemplatePng(loaded.value, base);
    const next = api.renderTemplatePng(loaded.value, { ...base, frame: 8 });
    expect(first.ok).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(next.value).not.toEqual(first.value);

    await writeFile(
      join(root, "assets", "badge.json"),
      Buffer.concat([original, Buffer.from("\n")]),
    );
    await expect(api.loadTemplateRuntime(pkg.value)).resolves.toMatchObject({
      ok: false,
      error: { code: "E_TEMPLATE_ASSET_HASH" },
    });
  });
});
