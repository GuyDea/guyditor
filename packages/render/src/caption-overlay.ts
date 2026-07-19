import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

import type { CaptionStyle } from "../../core/src/index.js";
import type {
  CaptionRenderModel,
  CaptionFrameSpec,
} from "../../transcript/src/index.js";
import { paintCaptionFrame } from "./caption-painter.js";
import type { CaptionPaintContext } from "./caption-painter.js";

export const CAPTION_OVERLAY_RENDERER_VERSION = "caption-overlay/v1";
export const CAPTION_CANVAS_VERSION = "1.0.2";
export const CAPTION_FONT_FAMILY = "Inconsolata Guyditor";
export const CAPTION_FONT_SHA256 = "1561e616c414a1b82d6e6dfbd18e5726fd65028913ade191e5fa38b6ec375a1a";
export const CAPTION_FONT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../assets/fonts/Inconsolata.otf",
);

let fontRegistered = false;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensureBundledFont(style?: CaptionStyle): void {
  if (style !== undefined && style.typeface.family !== CAPTION_FONT_FAMILY) {
    throw new TypeError(`Caption typeface ${style.typeface.family} is not a bundled font family.`);
  }
  if (fontRegistered) return;
  const bytes = readFileSync(CAPTION_FONT_PATH);
  const actual = sha256(bytes);
  if (actual !== CAPTION_FONT_SHA256) {
    throw new TypeError(`Bundled caption font hash mismatch: expected ${CAPTION_FONT_SHA256}, received ${actual}.`);
  }
  const registered = GlobalFonts.register(bytes, CAPTION_FONT_FAMILY);
  if (registered === null && !GlobalFonts.has(CAPTION_FONT_FAMILY)) {
    throw new TypeError("Bundled caption font could not be registered with the overlay renderer.");
  }
  fontRegistered = true;
}

function contextFor(width: number, height: number): CaptionPaintContext {
  return createCanvas(width, height).getContext("2d") as unknown as CaptionPaintContext;
}

function font(style: CaptionStyle, fontPx: number): string {
  return `${style.italic ? "italic " : ""}${String(style.weight)} ${String(fontPx)}px ${JSON.stringify(style.typeface.family)}`;
}

export function createCaptionTextMeasurer(): (
  text: string,
  fontPx: number,
  style: CaptionStyle,
) => number {
  ensureBundledFont();
  const context = contextFor(1, 1);
  return (text, fontPx, style) => {
    ensureBundledFont(style);
    context.font = font(style, fontPx);
    context.letterSpacing = `${String(style.letterSpacingPct / 100)}em`;
    const base = (context as unknown as { measureText(value: string): { width: number } }).measureText(text).width;
    return base;
  };
}

export function renderCaptionFrameToContext(
  context: CaptionPaintContext,
  frame: CaptionFrameSpec,
  width: number,
  height: number,
): void {
  ensureBundledFont(frame.styleResolved);
  paintCaptionFrame(context, frame, width, height);
}

export function renderCaptionPng(model: CaptionRenderModel, frame: number): Buffer {
  ensureBundledFont(model.styleResolved);
  const canvas = createCanvas(model.outputs.width, model.outputs.height);
  paintCaptionFrame(
    canvas.getContext("2d") as unknown as CaptionPaintContext,
    model.captionsAtFrame(frame),
    model.outputs.width,
    model.outputs.height,
  );
  return canvas.toBuffer("image/png");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Overlay keys cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).filter((key) => source[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`).join(",")}}`;
  }
  throw new TypeError(`Overlay keys cannot contain ${typeof value}.`);
}

export interface CaptionOverlayVersions {
  preset: { presetId: string; version: number };
  captionRevision?: string;
}

export function captionOverlayKey(
  model: CaptionRenderModel,
  versions: CaptionOverlayVersions,
): string {
  return sha256(canonical({
    renderer: CAPTION_OVERLAY_RENDERER_VERSION,
    canvas: CAPTION_CANVAS_VERSION,
    fonts: { [CAPTION_FONT_FAMILY]: CAPTION_FONT_SHA256 },
    versions,
    plan: {
      trackId: model.trackId,
      outputs: model.outputs,
      cues: model.cues,
      styleResolved: model.styleResolved,
    },
  }));
}

export interface CaptionOverlayPlan {
  overlayKey: string;
  pathPattern: string;
  overlaySha256: string;
  atOutputFrame: number;
  durationFrames: number;
}

export async function renderCaptionOverlaySequence(options: {
  model: CaptionRenderModel;
  cacheRoot: string;
  versions: CaptionOverlayVersions;
}): Promise<CaptionOverlayPlan> {
  const overlayKey = captionOverlayKey(options.model, options.versions);
  const directory = join(options.cacheRoot, overlayKey);
  await mkdir(directory, { recursive: true });
  const start = options.model.cues[0]?.startFrame ?? 0;
  const end = options.model.cues.reduce((maximum, cue) => Math.max(maximum, cue.endFrame), start);
  const hashes: string[] = [];
  for (let frame = start; frame < end; frame += 1) {
    const bytes = renderCaptionPng(options.model, frame);
    const filename = `${String(frame - start).padStart(8, "0")}.png`;
    await writeFile(join(directory, filename), bytes);
    hashes.push(sha256(bytes));
  }
  const overlaySha256 = sha256(canonical(hashes));
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify({
    overlayKey,
    overlaySha256,
    atOutputFrame: start,
    durationFrames: end - start,
    frameHashes: hashes,
  }, null, 2)}\n`, "utf8");
  return {
    overlayKey,
    pathPattern: join(directory, "%08d.png"),
    overlaySha256,
    atOutputFrame: start,
    durationFrames: end - start,
  };
}

export function captionOverlayToolchain(): {
  version: string;
  canvasVersion: string;
  fontHashes: Record<string, string>;
} {
  ensureBundledFont();
  return {
    version: CAPTION_OVERLAY_RENDERER_VERSION,
    canvasVersion: CAPTION_CANVAS_VERSION,
    fontHashes: { [CAPTION_FONT_FAMILY]: CAPTION_FONT_SHA256 },
  };
}
