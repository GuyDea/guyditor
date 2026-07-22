import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";

import {
  compareTime,
  convertTimeRounding,
  deriveTimeline,
  makeGuyditorError,
  resolveAnchor,
} from "../../core/src/index.js";
import type {
  AnchorResolverDependencies,
  GuyditorProject,
  PlacedItem,
} from "../../core/src/index.js";
import type { BrandContext } from "./template-contract.js";
import {
  loadTemplateRuntime,
  renderTemplatePng,
  resolveTemplateDuration,
  TEMPLATE_CANVAS_VERSION,
  TEMPLATE_RENDERER_VERSION,
} from "./template-runtime.js";
import type { LoadedTemplateRuntime } from "./template-runtime.js";
import type { TemplateRegistry } from "./template-registry.js";
import {
  insertedDurationFrames,
  restyleTimelineInsertionForItem,
  restyleTimelineInsertions,
  sourceFrameToOutputFrame,
} from "./timeline-insertions.js";

export const GRAPHIC_OVERLAY_RENDERER_VERSION = "graphic-overlay/v1";

export interface GraphicOverlayOptions {
  project: GuyditorProject;
  sequenceId: string;
  registry: TemplateRegistry;
  anchorDependencies?: AnchorResolverDependencies;
  width: number;
  height: number;
  fps: string;
  brand: BrandContext;
}

export interface GraphicFrameOptions extends GraphicOverlayOptions {
  frame: number;
}

export interface GraphicSequenceOptions extends GraphicOverlayOptions {
  cacheRoot: string;
}

export interface GraphicOverlayPlan {
  overlayKey: string;
  pathPattern: string;
  overlaySha256: string;
  atOutputFrame: number;
  durationFrames: number;
}

interface ResolvedGraphic {
  item: PlacedItem;
  layerId: string;
  layerOrder: number;
  itemOrder: number;
  startFrame: number;
  endFrame: number;
  runtime: LoadedTemplateRuntime;
}

function graphicError(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[],
) {
  return makeGuyditorError(code, message, { affected });
}

function requireSafeFrame(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Graphic overlay keys require finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`Graphic overlay keys cannot contain ${typeof value}.`);
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeArea(options: GraphicOverlayOptions) {
  return {
    top: Math.round(options.height * 0.05),
    right: Math.round(options.width * 0.05),
    bottom: Math.round(options.height * 0.05),
    left: Math.round(options.width * 0.05),
  };
}

async function anchorFrame(
  options: GraphicOverlayOptions,
  item: PlacedItem,
  anchor: string,
  role: "start" | "end",
): Promise<number> {
  const resolution = await resolveAnchor(
    options.project,
    anchor,
    options.sequenceId,
    options.anchorDependencies,
  );
  if (!resolution.ok) throw resolution.error;
  if (resolution.value.status !== "resolved" || resolution.value.timeline === undefined) {
    throw graphicError(
      "E_GRAPHIC_ANCHOR_ORPHANED",
      `Graphic ${item.id} ${role} anchor ${anchor} is orphaned${
        resolution.value.reason === undefined ? "" : ` (${resolution.value.reason})`
      }.`,
      [item.id, anchor],
    );
  }
  const converted = convertTimeRounding(resolution.value.timeline, options.fps);
  if (!converted.ok) throw converted.error;
  return converted.value.time.frames;
}

function convertedDuration(
  options: GraphicOverlayOptions,
  item: PlacedItem,
  frames: number,
  fps: string,
): number {
  const converted = convertTimeRounding({ frames, fps }, options.fps);
  if (!converted.ok) throw converted.error;
  if (converted.value.time.frames < 1) {
    throw graphicError(
      "E_GRAPHIC_DURATION_INVALID",
      `Graphic ${item.id} duration must resolve to at least one output frame.`,
      [item.id],
    );
  }
  return converted.value.time.frames;
}

async function endFrame(
  options: GraphicOverlayOptions,
  item: PlacedItem,
  startFrame: number,
  runtime: LoadedTemplateRuntime,
): Promise<number> {
  if (item.duration !== "intrinsic" && "until" in item.duration) {
    const end = await anchorFrame(options, item, item.duration.until, "end");
    const order = compareTime(
      { frames: startFrame, fps: options.fps },
      { frames: end, fps: options.fps },
    );
    if (!order.ok) throw order.error;
    if (order.value !== -1) {
      throw graphicError(
        "E_GRAPHIC_NEGATIVE_SPAN",
        `Graphic ${item.id} end anchor must resolve after its start anchor.`,
        [item.id, item.at, item.duration.until],
      );
    }
    return end;
  }
  if (item.duration !== "intrinsic") {
    return startFrame + convertedDuration(
      options,
      item,
      item.duration.frames,
      item.duration.fps,
    );
  }
  const declared = runtime.package.manifest.duration;
  if (declared.default !== undefined) {
    return startFrame + convertedDuration(
      options,
      item,
      declared.default.frames,
      declared.default.fps,
    );
  }
  const duration = resolveTemplateDuration(runtime, item.params ?? {}, {
    width: options.width,
    height: options.height,
    fps: options.fps,
  });
  if (!duration.ok) throw duration.error;
  if (duration.value.mode !== "fixed") {
    throw graphicError(
      "E_GRAPHIC_DURATION_INVALID",
      `Graphic ${item.id} intrinsic template did not resolve a fixed duration.`,
      [item.id, runtime.package.manifest.id],
    );
  }
  return startFrame + convertedDuration(
    options,
    item,
    duration.value.frames,
    duration.value.fps,
  );
}

async function resolvedGraphics(options: GraphicOverlayOptions): Promise<ResolvedGraphic[]> {
  if (!Number.isSafeInteger(options.width) || options.width < 1 ||
      !Number.isSafeInteger(options.height) || options.height < 1) {
    throw new RangeError("Graphic output dimensions must be positive safe integers.");
  }
  const resolved: ResolvedGraphic[] = [];
  const runtimes = new Map<string, LoadedTemplateRuntime>();
  const timeline = deriveTimeline(options.project, options.sequenceId);
  if (!timeline.ok) throw timeline.error;
  const sourceExtent = timeline.value.clips.reduce(
    (maximum, clip) => Math.max(maximum, clip.start.frames + clip.duration.frames),
    0,
  );
  const insertions = restyleTimelineInsertions(options.project, options.sequenceId);
  const extent = sourceExtent + insertedDurationFrames(insertions);
  const layers = options.project.layers
    .filter((layer) =>
      layer.enabled &&
      (layer.sequence === undefined || layer.sequence === options.sequenceId) &&
      (layer.kind === "text" || layer.kind === "animation") &&
      layer.items !== undefined)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  for (const layer of layers) {
    for (const [itemOrder, item] of (layer.items ?? []).entries()) {
      if (item.template === undefined || !/^gfx_[a-z2-7]{10}$/u.test(item.id)) continue;
      const pin = options.project.templates?.[item.template];
      if (pin === undefined) {
        throw graphicError(
          "E_TEMPLATE_MISSING_VERSION",
          `Graphic ${item.id} has no project pin for template ${item.template}.`,
          [item.id, item.template],
        );
      }
      if (item.seed === undefined || !Number.isInteger(item.seed) || item.seed < 0 || item.seed > 0xffff_ffff) {
        throw graphicError(
          "E_GRAPHIC_SEED_INVALID",
          `Graphic ${item.id} requires a stored uint32 seed.`,
          [item.id],
        );
      }
      const runtimeKey = `${item.template}@${pin.version}#${pin.contentHash}`;
      let runtime = runtimes.get(runtimeKey);
      if (runtime === undefined) {
        const pkg = await options.registry.package(item.template, pin.version, pin.contentHash);
        if (!pkg.ok) throw pkg.error;
        const loaded = await loadTemplateRuntime(pkg.value);
        if (!loaded.ok) throw loaded.error;
        runtime = loaded.value;
        runtimes.set(runtimeKey, runtime);
      }
      const sourceStartFrame = await anchorFrame(options, item, item.at, "start");
      const sourceEndFrame = await endFrame(options, item, sourceStartFrame, runtime);
      const seamInsertion = restyleTimelineInsertionForItem(item);
      const startFrame = sourceFrameToOutputFrame(
        sourceStartFrame,
        insertions,
        seamInsertion === undefined,
      );
      const unclampedEnd = seamInsertion === undefined
        ? startFrame + (sourceEndFrame - sourceStartFrame)
        : startFrame + seamInsertion.durationFrames;
      const clampedEnd = Math.min(extent, unclampedEnd);
      if (startFrame >= extent || clampedEnd <= startFrame) continue;
      resolved.push({
        item,
        layerId: layer.id,
        layerOrder: layer.order,
        itemOrder,
        startFrame,
        endFrame: clampedEnd,
        runtime,
      });
    }
  }
  return resolved.sort((left, right) =>
    left.layerOrder - right.layerOrder ||
    left.layerId.localeCompare(right.layerId) ||
    left.itemOrder - right.itemOrder);
}

async function paintFrame(
  options: GraphicOverlayOptions,
  graphics: readonly ResolvedGraphic[],
  frame: number,
): Promise<Buffer> {
  requireSafeFrame(frame, "Graphic preview frame");
  const canvas = createCanvas(options.width, options.height);
  const painter = canvas.getContext("2d");
  for (const graphic of graphics) {
    if (frame < graphic.startFrame || frame >= graphic.endFrame) continue;
    const png = renderTemplatePng(graphic.runtime, {
      params: graphic.item.params ?? {},
      seed: graphic.item.seed!,
      frame: frame - graphic.startFrame,
      totalFrames: graphic.endFrame - graphic.startFrame,
      fps: options.fps,
      width: options.width,
      height: options.height,
      safeArea: safeArea(options),
      brand: options.brand,
    });
    if (!png.ok) throw png.error;
    painter.drawImage(await loadImage(png.value), 0, 0);
  }
  return canvas.toBuffer("image/png");
}

export async function renderGraphicFrame(options: GraphicFrameOptions): Promise<Buffer> {
  const graphics = await resolvedGraphics(options);
  return paintFrame(options, graphics, options.frame);
}

export async function renderGraphicOverlaySequence(
  options: GraphicSequenceOptions,
): Promise<GraphicOverlayPlan | undefined> {
  const graphics = await resolvedGraphics(options);
  if (graphics.length === 0) return undefined;
  const atOutputFrame = Math.min(...graphics.map(({ startFrame }) => startFrame));
  const endOutputFrame = Math.max(...graphics.map(({ endFrame }) => endFrame));
  const overlayKey = digest(canonical({
    renderer: GRAPHIC_OVERLAY_RENDERER_VERSION,
    templateRenderer: TEMPLATE_RENDERER_VERSION,
    canvas: TEMPLATE_CANVAS_VERSION,
    geometry: { width: options.width, height: options.height, fps: options.fps },
    safeArea: safeArea(options),
    brand: { palette: options.brand.palette },
    graphics: graphics.map(({ item, layerId, layerOrder, itemOrder, startFrame, endFrame, runtime }) => ({
      layerId,
      layerOrder,
      itemOrder,
      item,
      startFrame,
      endFrame,
      template: {
        id: runtime.package.manifest.id,
        version: runtime.package.manifest.version,
        contentHash: runtime.package.contentHash,
        fonts: runtime.fonts,
      },
    })),
  }));
  const directory = join(options.cacheRoot, overlayKey);
  await mkdir(directory, { recursive: true });
  const frameHashes: string[] = [];
  for (let frame = atOutputFrame; frame < endOutputFrame; frame += 1) {
    const bytes = await paintFrame(options, graphics, frame);
    await writeFile(
      join(directory, `${String(frame - atOutputFrame).padStart(8, "0")}.png`),
      bytes,
    );
    frameHashes.push(digest(bytes));
  }
  const overlaySha256 = digest(canonical(frameHashes));
  const plan: GraphicOverlayPlan = {
    overlayKey,
    pathPattern: join(directory, "%08d.png"),
    overlaySha256,
    atOutputFrame,
    durationFrames: endOutputFrame - atOutputFrame,
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify({
    ...plan,
    frameHashes,
  }, null, 2)}\n`, "utf8");
  return plan;
}

export function graphicOverlayToolchain() {
  return {
    version: GRAPHIC_OVERLAY_RENDERER_VERSION,
    canvasVersion: TEMPLATE_CANVAS_VERSION,
  };
}
