import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createCanvas } from "@napi-rs/canvas";

import { compilePipTimeline, evaluatePipAtFrame } from "../../compositor/src/motion.js";
import type { NormalizedRect } from "../../compositor/src/placement.js";
import type { PipConfig, PipStyle } from "../../core/src/index.js";

export interface RasterizedPipAssets {
  maskPath: string;
  underlayPath: string;
  chromePath: string;
  sha256: string;
  durationFrames: number;
  animated: true;
}

export interface RasterizePipAssetsOptions {
  pip: PipConfig;
  compWidth: number;
  compHeight: number;
  durationFrames: number;
  anchorFrames: Readonly<Record<string, number>>;
  cacheRoot: string;
}

type Context2D = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

function pathForShape(
  context: Context2D,
  rect: { x: number; y: number; w: number; h: number },
  style: PipStyle,
): void {
  context.beginPath();
  if (style.mask.shape === "circle") {
    const radius = Math.min(rect.w, rect.h) / 2;
    context.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, radius, 0, Math.PI * 2);
  } else if (style.mask.shape === "ellipse") {
    context.ellipse(
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      rect.w / 2,
      rect.h / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else if (style.mask.shape === "rounded") {
    const radius = Math.min(rect.w, rect.h) * (style.mask.cornerRadius ?? 0.08);
    context.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
  } else {
    context.rect(rect.x, rect.y, rect.w, rect.h);
  }
  context.closePath();
}

function pixelRect(rect: NormalizedRect, width: number, height: number) {
  return { x: rect.x * width, y: rect.y * height, w: rect.w * width, h: rect.h * height };
}

function expanded(
  rect: { x: number; y: number; w: number; h: number },
  pad: number,
) {
  return { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
}

function mergedStyle(base: PipStyle, patch: PipStyle | Partial<PipStyle> | undefined): PipStyle {
  if (patch === undefined) return base;
  return {
    ...base,
    ...patch,
    mask: patch.mask === undefined ? base.mask : { ...base.mask, ...patch.mask },
  };
}

function renderMask(
  width: number,
  height: number,
  rect: NormalizedRect,
  style: PipStyle,
): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(0, 0, width, height);
  context.save();
  context.fillStyle = "#ffffff";
  if ((style.mask.featherPx ?? 0) > 0) {
    context.filter = `blur(${String(style.mask.featherPx ?? 0)}px)`;
  }
  pathForShape(context, pixelRect(rect, width, height), style);
  context.fill();
  context.restore();
  return canvas.toBuffer("image/png");
}

function renderUnderlay(
  width: number,
  height: number,
  rect: NormalizedRect,
  style: PipStyle,
): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const box = expanded(pixelRect(rect, width, height), style.background?.padPx ?? 0);
  const shadow = style.shadow;
  if (shadow !== undefined && shadow.opacity > 0) {
    context.save();
    context.shadowOffsetX = shadow.dx;
    context.shadowOffsetY = shadow.dy;
    context.shadowBlur = shadow.blurPx;
    context.shadowColor = shadow.color;
    context.globalAlpha = shadow.opacity;
    context.fillStyle = shadow.color;
    pathForShape(context, box, style);
    context.fill();
    context.restore();
    context.save();
    context.globalCompositeOperation = "destination-out";
    pathForShape(context, box, style);
    context.fill();
    context.restore();
  }
  if (style.background?.color !== undefined) {
    context.save();
    context.fillStyle = style.background.color;
    pathForShape(context, box, style);
    context.fill();
    context.restore();
  }
  return canvas.toBuffer("image/png");
}

function renderChrome(
  width: number,
  height: number,
  rect: NormalizedRect,
  style: PipStyle,
): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const box = expanded(pixelRect(rect, width, height), style.background?.padPx ?? 0);
  if (style.border !== undefined && style.border.widthPx > 0) {
    context.save();
    context.strokeStyle = style.border.color;
    context.globalAlpha = style.border.opacity;
    context.lineWidth = style.border.widthPx;
    pathForShape(context, box, style);
    context.stroke();
    context.restore();
  }
  if (style.deviceFrame !== undefined) {
    context.save();
    context.strokeStyle = "#20242A";
    context.lineWidth = Math.max(6, Math.min(box.w, box.h) * 0.025);
    context.rect(box.x, box.y, box.w, box.h);
    context.stroke();
    context.restore();
  }
  return canvas.toBuffer("image/png");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export async function rasterizePipAssets(
  options: RasterizePipAssetsOptions,
): Promise<RasterizedPipAssets> {
  if (
    !Number.isSafeInteger(options.compWidth) || options.compWidth <= 0 ||
    !Number.isSafeInteger(options.compHeight) || options.compHeight <= 0 ||
    !Number.isSafeInteger(options.durationFrames) || options.durationFrames <= 0
  ) throw new TypeError("PiP raster dimensions and duration must be positive integers.");
  const timeline = compilePipTimeline({
    pip: options.pip,
    compWidth: options.compWidth,
    compHeight: options.compHeight,
    anchorFrames: options.anchorFrames,
    sampleEveryFrames: 1,
  });
  const key = createHash("sha256").update(JSON.stringify({
    pip: options.pip,
    width: options.compWidth,
    height: options.compHeight,
    durationFrames: options.durationFrames,
    samples: timeline.samples,
  })).digest("hex");
  const root = join(options.cacheRoot, key);
  const maskRoot = join(root, "mask");
  const underlayRoot = join(root, "underlay");
  const chromeRoot = join(root, "chrome");
  await Promise.all([mkdir(maskRoot, { recursive: true }), mkdir(underlayRoot, { recursive: true }), mkdir(chromeRoot, { recursive: true })]);
  const lastFrame = join(chromeRoot, `${String(options.durationFrames - 1).padStart(8, "0")}.png`);
  if (!(await exists(lastFrame))) {
    for (let frame = 0; frame < options.durationFrames; frame += 1) {
      const sample = evaluatePipAtFrame(timeline, frame);
      const style = mergedStyle(options.pip.style, sample.style);
      const name = `${String(frame).padStart(8, "0")}.png`;
      await Promise.all([
        writeFile(join(maskRoot, name), renderMask(options.compWidth, options.compHeight, sample.rect, style)),
        writeFile(join(underlayRoot, name), renderUnderlay(options.compWidth, options.compHeight, sample.rect, style)),
        writeFile(join(chromeRoot, name), renderChrome(options.compWidth, options.compHeight, sample.rect, style)),
      ]);
    }
  }
  return {
    maskPath: join(maskRoot, "%08d.png"),
    underlayPath: join(underlayRoot, "%08d.png"),
    chromePath: join(chromeRoot, "%08d.png"),
    sha256: key,
    durationFrames: options.durationFrames,
    animated: true,
  };
}
