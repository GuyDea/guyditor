import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createContext, Script } from "node:vm";
import type { Context } from "node:vm";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import {
  createCanvas,
  GlobalFonts,
  loadImage,
} from "@napi-rs/canvas";
import type { Image } from "@napi-rs/canvas";

import {
  failure,
  makeGuyditorError,
  success,
} from "../../core/src/index.js";
import type { Result } from "../../core/src/index.js";
import { createSeededRng } from "./seeded-rng.js";
import type {
  DurationSpec,
  OverlayCanvas2D,
  ResolvedFontMap,
  TemplateModule,
  TemplateRenderContext,
  TemplateRenderOptions,
  TemplateStaticContext,
} from "./template-contract.js";
import type { LoadedTemplatePackage } from "./template-registry.js";

export const TEMPLATE_RENDERER_VERSION = "overlay/v1@1";
export const TEMPLATE_CANVAS_VERSION = "1.0.2";

export interface LoadedTemplateRuntime {
  package: LoadedTemplatePackage;
  context: Context;
  renderScript: Script;
  durationScript?: Script;
  fonts: ResolvedFontMap;
  staticAssets: ReadonlyMap<string, Image>;
  validateParams: ValidateFunction<Record<string, unknown>>;
}

interface ModuleContainer {
  exports: unknown;
}

function runtimeFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function throwingGlobal(name: string): (...args: unknown[]) => never {
  return () => {
    throw new TypeError(`${name} is unavailable in deterministic templates.`);
  };
}

function deterministicDate(): unknown {
  const blocked = throwingGlobal("Date");
  return new Proxy(blocked, {
    apply: blocked,
    construct: blocked,
    get: blocked,
  });
}

function deterministicMath(): object {
  const target = Object.create(null) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(Math)) {
    Object.defineProperty(target, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: name === "random" ? throwingGlobal("Math.random") : Reflect.get(Math, name),
    });
  }
  return Object.freeze(target);
}

function sandbox(): { context: Context; module: ModuleContainer } {
  const module: ModuleContainer = { exports: {} };
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  Object.assign(values, {
    module,
    exports: module.exports,
    Date: deterministicDate(),
    Math: deterministicMath(),
    fetch: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    queueMicrotask: undefined,
    process: undefined,
    require: undefined,
    Intl: undefined,
  });
  return {
    module,
    context: createContext(values, {
      codeGeneration: { strings: false, wasm: false },
      name: "guyditor-template",
    }),
  };
}

function isTemplateModule(value: unknown): value is TemplateModule {
  return typeof value === "object" && value !== null &&
    "render" in value && typeof value.render === "function" &&
    (!("duration" in value) || value.duration === undefined || typeof value.duration === "function");
}

async function resolvedFonts(pkg: LoadedTemplatePackage): Promise<Result<ResolvedFontMap>> {
  const fonts: Record<string, { family: string; weight: number; sha256: string }> = {};
  for (const declaration of pkg.manifest.fonts) {
    try {
      const bytes = await readFile(resolve(pkg.root, declaration.file));
      const registered = GlobalFonts.register(bytes, declaration.family);
      if (registered === null && !GlobalFonts.has(declaration.family)) {
        return runtimeFailure(
          "E_TEMPLATE_FONT_INVALID",
          `Template font ${declaration.file} could not be registered as ${declaration.family}.`,
          [pkg.manifest.id],
        );
      }
      fonts[declaration.family] = {
        family: declaration.family,
        weight: declaration.weight,
        sha256: sha256(bytes),
      };
    } catch (error: unknown) {
      return runtimeFailure(
        "E_TEMPLATE_FONT_INVALID",
        `Template font ${declaration.file} could not be loaded: ${errorMessage(error)}.`,
        [pkg.manifest.id],
      );
    }
  }
  return success(Object.freeze(fonts));
}

async function decodedAssets(pkg: LoadedTemplatePackage): Promise<Result<ReadonlyMap<string, Image>>> {
  const assets = new Map<string, Image>();
  const root = resolve(pkg.root, "assets");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return success(assets);
  }
  for (const name of names.sort()) {
    try {
      assets.set(name, await loadImage(resolve(root, name)));
    } catch (error: unknown) {
      return runtimeFailure(
        "E_TEMPLATE_ASSET_INVALID",
        `Template asset ${name} could not be decoded: ${errorMessage(error)}.`,
        [pkg.manifest.id],
      );
    }
  }
  return success(assets);
}

export async function loadTemplateRuntime(
  pkg: LoadedTemplatePackage,
): Promise<Result<LoadedTemplateRuntime>> {
  const fonts = await resolvedFonts(pkg);
  if (!fonts.ok) return fonts;
  const assets = await decodedAssets(pkg);
  if (!assets.ok) return assets;
  let validateParams: ValidateFunction<Record<string, unknown>>;
  try {
    validateParams = new Ajv2020({ allErrors: true, strict: true })
      .compile<Record<string, unknown>>(pkg.manifest.params);
  } catch (error: unknown) {
    return runtimeFailure(
      "E_TEMPLATE_PACKAGE_INVALID",
      `Template parameter schema cannot compile: ${errorMessage(error)}.`,
      [pkg.manifest.id],
    );
  }
  const isolated = sandbox();
  try {
    new Script(pkg.compiledSource, {
      filename: `${pkg.manifest.id}@${pkg.manifest.version}.js`,
    }).runInContext(isolated.context, { timeout: 100 });
  } catch (error: unknown) {
    return runtimeFailure(
      "E_TEMPLATE_SANDBOX",
      `Template module could not initialize in the deterministic sandbox: ${errorMessage(error)}.`,
      [pkg.manifest.id],
    );
  }
  const exported = isolated.module.exports as { default?: unknown };
  const template = exported.default ?? isolated.module.exports;
  if (!isTemplateModule(template)) {
    return runtimeFailure(
      "E_TEMPLATE_PACKAGE_INVALID",
      "Template entry must default-export a TemplateModule with render(ctx, params).",
      [pkg.manifest.id],
    );
  }
  Reflect.set(isolated.context, "__template", template);
  Reflect.deleteProperty(isolated.context, "module");
  Reflect.deleteProperty(isolated.context, "exports");
  return success({
    package: pkg,
    context: isolated.context,
    renderScript: new Script("__template.render(__context, __params);"),
    ...(template.duration === undefined
      ? {}
      : { durationScript: new Script("__template.duration(__params, __media);") }),
    fonts: fonts.value,
    staticAssets: assets.value,
    validateParams,
  });
}

function validateRenderOptions(
  runtime: LoadedTemplateRuntime,
  options: TemplateRenderOptions,
): Result<TemplateRenderOptions> {
  if (!runtime.validateParams(options.params)) {
    return runtimeFailure(
      "E_TEMPLATE_PARAMS_INVALID",
      `Parameters for ${runtime.package.manifest.name} failed validation.`,
      [runtime.package.manifest.id],
    );
  }
  if (
    !Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff ||
    !Number.isSafeInteger(options.frame) || options.frame < 0 ||
    !Number.isSafeInteger(options.totalFrames) || options.totalFrames < 1 ||
    options.frame >= options.totalFrames ||
    !Number.isSafeInteger(options.width) || options.width < 1 ||
    !Number.isSafeInteger(options.height) || options.height < 1
  ) {
    return runtimeFailure(
      "E_TEMPLATE_RENDER_CONTEXT",
      "Template frame, duration, geometry, or seed is outside the render contract.",
      [runtime.package.manifest.id],
    );
  }
  return success(options);
}

function deterministicPainter(
  painter: OverlayCanvas2D,
  fonts: ResolvedFontMap,
): OverlayCanvas2D {
  const families = Object.keys(fonts);
  const assertDeclaredFont = (font: unknown): void => {
    if (typeof font !== "string" || !families.some((family) => font.includes(family))) {
      throw new TypeError(
        `Template text requires a declared package font; received ${String(font)}.`,
      );
    }
  };
  const textMethods = new Set<PropertyKey>(["fillText", "strokeText", "measureText"]);
  return new Proxy(painter, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      if (textMethods.has(property)) {
        return (...args: unknown[]) => {
          assertDeclaredFont(target.font);
          return Reflect.apply(value, target, args) as unknown;
        };
      }
      return (...args: unknown[]) => Reflect.apply(value, target, args) as unknown;
    },
    set(target, property, value) {
      if (property === "font") assertDeclaredFont(value);
      return Reflect.set(target, property, value, target);
    },
  });
}

export function renderTemplatePng(
  runtime: LoadedTemplateRuntime,
  options: TemplateRenderOptions,
): Result<Buffer> {
  const valid = validateRenderOptions(runtime, options);
  if (!valid.ok) return valid;
  const canvas = createCanvas(options.width, options.height);
  const painter = deterministicPainter(canvas.getContext("2d"), runtime.fonts);
  const renderContext: TemplateRenderContext = Object.freeze({
    canvas: painter,
    frame: options.frame,
    totalFrames: options.totalFrames,
    fps: options.fps,
    width: options.width,
    height: options.height,
    safeArea: Object.freeze(structuredClone(options.safeArea)),
    progress: options.totalFrames === 1 ? 0 : options.frame / (options.totalFrames - 1),
    fonts: runtime.fonts,
    brand: options.brand,
    rng: createSeededRng(options.seed),
    staticAssets: (name: string): Image => {
      const image = runtime.staticAssets.get(name);
      if (image === undefined) throw new TypeError(`Template static asset ${name} does not exist.`);
      return image;
    },
  });
  Reflect.set(runtime.context, "__context", renderContext);
  Reflect.set(runtime.context, "__params", structuredClone(options.params));
  try {
    runtime.renderScript.runInContext(runtime.context, { timeout: 100 });
    return success(canvas.toBuffer("image/png"));
  } catch (error: unknown) {
    return runtimeFailure(
      "E_TEMPLATE_SANDBOX",
      `Template render failed in the deterministic sandbox: ${errorMessage(error)}.`,
      [runtime.package.manifest.id],
    );
  } finally {
    Reflect.deleteProperty(runtime.context, "__context");
    Reflect.deleteProperty(runtime.context, "__params");
  }
}

export function resolveTemplateDuration(
  runtime: LoadedTemplateRuntime,
  params: Record<string, unknown>,
  media: TemplateStaticContext,
): Result<DurationSpec> {
  if (!runtime.validateParams(params)) {
    return runtimeFailure(
      "E_TEMPLATE_PARAMS_INVALID",
      `Parameters for ${runtime.package.manifest.name} failed validation.`,
      [runtime.package.manifest.id],
    );
  }
  if (runtime.durationScript === undefined) {
    return runtimeFailure(
      "E_TEMPLATE_DURATION_MISSING",
      `Template ${runtime.package.manifest.name} does not declare duration().`,
      [runtime.package.manifest.id],
    );
  }
  Reflect.set(runtime.context, "__params", structuredClone(params));
  Reflect.set(runtime.context, "__media", Object.freeze(structuredClone(media)));
  try {
    const duration = runtime.durationScript.runInContext(runtime.context, { timeout: 100 }) as unknown;
    if (
      typeof duration !== "object" || duration === null || !("mode" in duration) ||
      (duration.mode !== "intrinsic" && duration.mode !== "anchor_span" &&
        !(duration.mode === "fixed" && "frames" in duration && "fps" in duration &&
          Number.isSafeInteger(duration.frames) && Number(duration.frames) > 0 &&
          typeof duration.fps === "string"))
    ) {
      return runtimeFailure(
        "E_TEMPLATE_DURATION_INVALID",
        `Template ${runtime.package.manifest.name} returned an invalid duration.`,
        [runtime.package.manifest.id],
      );
    }
    return success(structuredClone(duration) as DurationSpec);
  } catch (error: unknown) {
    return runtimeFailure(
      "E_TEMPLATE_SANDBOX",
      `Template duration failed in the deterministic sandbox: ${errorMessage(error)}.`,
      [runtime.package.manifest.id],
    );
  } finally {
    Reflect.deleteProperty(runtime.context, "__params");
    Reflect.deleteProperty(runtime.context, "__media");
  }
}
