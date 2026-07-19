import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createCanvas } from "@napi-rs/canvas";

import type { KeyMask } from "../../core/src/index.js";
import { runFfmpeg } from "../../media/src/index.js";

export interface RasterizedKeyMask {
  id: string;
  role: KeyMask["role"];
  path: string;
  sha256: string;
  animated: boolean;
}

export interface RasterizeKeyMasksOptions {
  masks: readonly KeyMask[];
  width: number;
  height: number;
  durationFrames: number;
  fps: string;
  cacheRoot: string;
  signal?: AbortSignal;
}

function keyFor(mask: KeyMask, options: RasterizeKeyMasksOptions): string {
  return createHash("sha256").update(JSON.stringify({
    mask,
    width: options.width,
    height: options.height,
    ...(mask.frames === undefined ? {} : {
      durationFrames: options.durationFrames,
      fps: options.fps,
    }),
  })).digest("hex");
}

function point(mask: KeyMask, index: number, width: number, height: number): readonly [number, number] {
  const value = mask.points[index];
  if (value === undefined) throw new TypeError(`Mask ${mask.id} does not have point ${String(index)}.`);
  return [value.x * width, value.y * height];
}

function drawShape(
  context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  mask: KeyMask,
  width: number,
  height: number,
): void {
  context.beginPath();
  if (mask.shape === "polygon") {
    const [firstX, firstY] = point(mask, 0, width, height);
    context.moveTo(firstX, firstY);
    for (let index = 1; index < mask.points.length; index += 1) {
      const [x, y] = point(mask, index, width, height);
      context.lineTo(x, y);
    }
    context.closePath();
  } else {
    const [x0, y0] = point(mask, 0, width, height);
    const [x1, y1] = point(mask, 1, width, height);
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const shapeWidth = Math.abs(x1 - x0);
    const shapeHeight = Math.abs(y1 - y0);
    if (mask.shape === "rect") context.rect(left, top, shapeWidth, shapeHeight);
    else context.ellipse(
      left + shapeWidth / 2,
      top + shapeHeight / 2,
      shapeWidth / 2,
      shapeHeight / 2,
      0,
      0,
      Math.PI * 2,
    );
  }
  context.fill();
}

function renderMask(mask: KeyMask, width: number, height: number, active: boolean): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const passColor = mask.role === "garbage" ? "#ffffff" : "#000000";
  const shapeColor = mask.role === "garbage" ? "#000000" : "#ffffff";
  context.fillStyle = passColor;
  context.fillRect(0, 0, width, height);
  if (active) {
    context.save();
    context.fillStyle = shapeColor;
    if (mask.featherPx > 0) context.filter = `blur(${String(mask.featherPx)}px)`;
    drawShape(context, mask, width, height);
    context.restore();
  }
  return canvas.toBuffer("image/png");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function renderAnimated(
  mask: KeyMask,
  outputPath: string,
  options: RasterizeKeyMasksOptions,
): Promise<void> {
  const directory = await mkdtemp(join(options.cacheRoot, ".keymask-"));
  try {
    for (let frame = 0; frame < options.durationFrames; frame += 1) {
      const active = mask.frames === undefined ||
        (frame >= mask.frames.from && frame < mask.frames.to);
      await writeFile(
        join(directory, `${String(frame).padStart(8, "0")}.png`),
        renderMask(mask, options.width, options.height, active),
      );
    }
    await runFfmpeg([
      "-hide_banner", "-nostdin", "-y", "-framerate", options.fps,
      "-start_number", "0", "-i", join(directory, "%08d.png"),
      "-frames:v", String(options.durationFrames), "-an", "-c:v", "ffv1",
      "-pix_fmt", "gray", "-map_metadata", "-1", outputPath,
    ], options.signal === undefined ? {} : { signal: options.signal });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function rasterizeKeyMasks(
  options: RasterizeKeyMasksOptions,
): Promise<RasterizedKeyMask[]> {
  if (!Number.isInteger(options.width) || options.width <= 0 ||
      !Number.isInteger(options.height) || options.height <= 0 ||
      !Number.isInteger(options.durationFrames) || options.durationFrames <= 0) {
    throw new TypeError("Key-mask dimensions and duration must be positive integers.");
  }
  await mkdir(options.cacheRoot, { recursive: true });
  const rendered: RasterizedKeyMask[] = [];
  for (const mask of options.masks) {
    const animated = mask.frames !== undefined;
    const outputPath = join(options.cacheRoot, `${keyFor(mask, options)}.${animated ? "mkv" : "png"}`);
    if (!(await exists(outputPath))) {
      if (animated) await renderAnimated(mask, outputPath, options);
      else await writeFile(outputPath, renderMask(mask, options.width, options.height, true));
    }
    rendered.push({
      id: mask.id,
      role: mask.role,
      path: outputPath,
      sha256: await fileHash(outputPath),
      animated,
    });
  }
  return rendered;
}

