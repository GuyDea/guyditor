import { createHash } from "node:crypto";

import {
  createCanvas,
  Path2D,
} from "@napi-rs/canvas";
import type {
  Image,
  SKRSContext2D,
} from "@napi-rs/canvas";

import {
  LOTTIE_RENDERER_VERSION,
  analyzeLottieDocument,
} from "../../core/src/index.js";
import type { LottieFeatureProfile } from "../../core/src/index.js";
import type { AnalyzeLottieOptions } from "../../core/src/index.js";

export { LOTTIE_RENDERER_VERSION } from "../../core/src/index.js";

export const LOTTIE_SHIM_VERSION = "lottie-canvas-shim/v1";

type JsonRecord = Record<string, unknown>;

interface Point {
  x: number;
  y: number;
}

interface LottiePathValue {
  i: Point[];
  o: Point[];
  v: Point[];
  c: boolean;
}

interface Geometry {
  path: Path2D;
  length: number;
}

interface TrimSpec {
  start: number;
  end: number;
  offset: number;
}

interface FillSpec {
  color: string;
  opacity: number;
  rule: "evenodd" | "nonzero";
}

interface StrokeSpec {
  color: string;
  opacity: number;
  width: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "bevel" | "miter" | "round";
  miterLimit: number;
}

export interface LottieAnimation {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly inPoint: number;
  readonly outPoint: number;
  readonly featureProfile: LottieFeatureProfile;
  readonly rasterAssets: ReadonlyMap<string, Image>;
  readonly document: Readonly<JsonRecord>;
}

export interface DrawLottieOptions {
  animation: LottieAnimation;
  frame: number;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  colorSlots?: Readonly<Record<string, string>>;
}

export interface RenderLottiePngOptions {
  frame: number;
  width: number;
  height: number;
  colorSlots?: Readonly<Record<string, string>>;
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = record(item);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function component(value: unknown, index: number, fallback: number): number {
  return finite(array(value)[index], fallback);
}

function scalarControl(value: unknown, fallback: number): number {
  return Array.isArray(value) ? finite(value[0], fallback) : finite(value, fallback);
}

function cubicCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first +
    3 * inverse * t * t * second +
    t * t * t;
}

function bezierEasing(
  progress: number,
  outgoing: unknown,
  incoming: unknown,
): number {
  const out = record(outgoing);
  const into = record(incoming);
  if (out === undefined || into === undefined) return progress;
  const x1 = scalarControl(out["x"], 0);
  const y1 = scalarControl(out["y"], 0);
  const x2 = scalarControl(into["x"], 1);
  const y2 = scalarControl(into["y"], 1);
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const middle = (low + high) / 2;
    if (cubicCoordinate(middle, x1, x2) < progress) low = middle;
    else high = middle;
  }
  return cubicCoordinate((low + high) / 2, y1, y2);
}

function isPathValue(value: unknown): value is JsonRecord {
  const parsed = record(value);
  return parsed !== undefined &&
    Array.isArray(parsed["i"]) &&
    Array.isArray(parsed["o"]) &&
    Array.isArray(parsed["v"]);
}

function interpolated(
  start: unknown,
  end: unknown,
  progress: number,
): unknown {
  if (typeof start === "number" && typeof end === "number") {
    return start + (end - start) * progress;
  }
  if (Array.isArray(start) && Array.isArray(end)) {
    if (start.length !== end.length) {
      throw new RangeError("Lottie keyframes must preserve array topology.");
    }
    return start.map((value, index) =>
      interpolated(value, end[index] ?? value, progress));
  }
  if (isPathValue(start) && isPathValue(end)) {
    return {
      i: interpolated(start["i"], end["i"], progress),
      o: interpolated(start["o"], end["o"], progress),
      v: interpolated(start["v"], end["v"], progress),
      c: start["c"] === true,
    };
  }
  return progress < 1 ? start : end;
}

function unwrapped(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 && isPathValue(value[0])
    ? value[0]
    : value;
}

function sampled(value: unknown, frame: number): unknown {
  const property = record(value);
  if (property === undefined || !("k" in property)) return value;
  if (property["a"] !== 1) return property["k"];
  const keyframes = records(property["k"]);
  if (keyframes.length === 0) return undefined;
  const nextIndex = keyframes.findIndex((keyframe) => finite(keyframe["t"]) > frame);
  const index = nextIndex === -1
    ? keyframes.length - 1
    : Math.max(0, nextIndex - 1);
  const current = keyframes[index]!;
  const next = keyframes[index + 1];
  const start = unwrapped(current["s"]);
  if (next === undefined || current["h"] === 1) return start;
  const from = finite(current["t"]);
  const to = finite(next["t"], from);
  if (to <= from) return start;
  const raw = Math.max(0, Math.min(1, (frame - from) / (to - from)));
  const progress = bezierEasing(raw, current["o"], next["i"]);
  const end = unwrapped(current["e"] ?? next["s"] ?? start);
  return interpolated(start, end, progress);
}

function point(value: unknown, frame: number, fallback: Point): Point {
  const sampledValue = sampled(value, frame);
  return {
    x: component(sampledValue, 0, fallback.x),
    y: component(sampledValue, 1, fallback.y),
  };
}

function scalar(value: unknown, frame: number, fallback: number): number {
  const sampledValue = sampled(value, frame);
  return Array.isArray(sampledValue)
    ? finite(sampledValue[0], fallback)
    : finite(sampledValue, fallback);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function color(
  shape: JsonRecord,
  frame: number,
  colorSlots: Readonly<Record<string, string>>,
): string {
  const name = typeof shape["nm"] === "string" ? shape["nm"] : "";
  const remapped = colorSlots[name];
  if (remapped !== undefined) return remapped;
  const values = array(sampled(shape["c"], frame));
  const red = Math.round(clamp01(finite(values[0])) * 255);
  const green = Math.round(clamp01(finite(values[1])) * 255);
  const blue = Math.round(clamp01(finite(values[2])) * 255);
  const alpha = clamp01(finite(values[3], 1));
  return `rgba(${String(red)},${String(green)},${String(blue)},${String(alpha)})`;
}

function pathValue(value: unknown, frame: number): LottiePathValue | undefined {
  const parsed = record(unwrapped(sampled(value, frame)));
  if (
    parsed === undefined ||
    !Array.isArray(parsed["i"]) ||
    !Array.isArray(parsed["o"]) ||
    !Array.isArray(parsed["v"])
  ) return undefined;
  const vertices = parsed["v"].map((vertex) => ({
    x: component(vertex, 0, 0),
    y: component(vertex, 1, 0),
  }));
  const incoming = parsed["i"].map((vertex) => ({
    x: component(vertex, 0, 0),
    y: component(vertex, 1, 0),
  }));
  const outgoing = parsed["o"].map((vertex) => ({
    x: component(vertex, 0, 0),
    y: component(vertex, 1, 0),
  }));
  if (
    vertices.length === 0 ||
    incoming.length !== vertices.length ||
    outgoing.length !== vertices.length
  ) return undefined;
  return { i: incoming, o: outgoing, v: vertices, c: parsed["c"] === true };
}

function cubicPoint(
  start: Point,
  first: Point,
  second: Point,
  end: Point,
  t: number,
): Point {
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * start.x +
      3 * inverse * inverse * t * first.x +
      3 * inverse * t * t * second.x +
      t ** 3 * end.x,
    y: inverse ** 3 * start.y +
      3 * inverse * inverse * t * first.y +
      3 * inverse * t * t * second.y +
      t ** 3 * end.y,
  };
}

function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function bezierSegmentLength(
  start: Point,
  first: Point,
  second: Point,
  end: Point,
): number {
  let length = 0;
  let previous = start;
  for (let step = 1; step <= 32; step += 1) {
    const current = cubicPoint(start, first, second, end, step / 32);
    length += distance(previous, current);
    previous = current;
  }
  return length;
}

function bezierGeometry(value: LottiePathValue): Geometry {
  const path = new Path2D();
  path.moveTo(value.v[0]!.x, value.v[0]!.y);
  let length = 0;
  const limit = value.c ? value.v.length : value.v.length - 1;
  for (let index = 0; index < limit; index += 1) {
    const nextIndex = (index + 1) % value.v.length;
    const start = value.v[index]!;
    const end = value.v[nextIndex]!;
    const first = {
      x: start.x + value.o[index]!.x,
      y: start.y + value.o[index]!.y,
    };
    const second = {
      x: end.x + value.i[nextIndex]!.x,
      y: end.y + value.i[nextIndex]!.y,
    };
    path.bezierCurveTo(first.x, first.y, second.x, second.y, end.x, end.y);
    length += bezierSegmentLength(start, first, second, end);
  }
  if (value.c) path.closePath();
  return { path, length };
}

function rectangleGeometry(shape: JsonRecord, frame: number): Geometry {
  const center = point(shape["p"], frame, { x: 0, y: 0 });
  const size = point(shape["s"], frame, { x: 0, y: 0 });
  const radius = Math.max(
    0,
    Math.min(
      scalar(shape["r"], frame, 0),
      Math.abs(size.x) / 2,
      Math.abs(size.y) / 2,
    ),
  );
  const path = new Path2D();
  path.roundRect(
    center.x - size.x / 2,
    center.y - size.y / 2,
    size.x,
    size.y,
    radius,
  );
  return {
    path,
    length: Math.max(
      0,
      2 * (Math.abs(size.x) + Math.abs(size.y) - 4 * radius) +
      2 * Math.PI * radius,
    ),
  };
}

function ellipseGeometry(shape: JsonRecord, frame: number): Geometry {
  const center = point(shape["p"], frame, { x: 0, y: 0 });
  const size = point(shape["s"], frame, { x: 0, y: 0 });
  const radiusX = Math.abs(size.x) / 2;
  const radiusY = Math.abs(size.y) / 2;
  const path = new Path2D();
  path.ellipse(center.x, center.y, radiusX, radiusY, 0, 0, Math.PI * 2);
  const h = ((radiusX - radiusY) ** 2) / ((radiusX + radiusY) ** 2 || 1);
  return {
    path,
    length: Math.PI * (radiusX + radiusY) *
      (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h))),
  };
}

function geometry(shape: JsonRecord, frame: number): Geometry | undefined {
  if (shape["ty"] === "rc") return rectangleGeometry(shape, frame);
  if (shape["ty"] === "el") return ellipseGeometry(shape, frame);
  if (shape["ty"] === "sh") {
    const value = pathValue(shape["ks"], frame);
    return value === undefined ? undefined : bezierGeometry(value);
  }
  return undefined;
}

function applyTransform(
  painter: SKRSContext2D,
  value: unknown,
  frame: number,
): void {
  const transform = record(value);
  if (transform === undefined) return;
  const anchor = point(transform["a"], frame, { x: 0, y: 0 });
  const position = point(transform["p"], frame, { x: 0, y: 0 });
  const scale = point(transform["s"], frame, { x: 100, y: 100 });
  const rotation = scalar(transform["r"] ?? transform["rz"], frame, 0);
  const opacity = scalar(transform["o"], frame, 100);
  painter.translate(position.x, position.y);
  painter.rotate(rotation * Math.PI / 180);
  painter.scale(scale.x / 100, scale.y / 100);
  painter.translate(-anchor.x, -anchor.y);
  painter.globalAlpha *= clamp01(opacity / 100);
}

function fillSpec(
  shape: JsonRecord,
  frame: number,
  colorSlots: Readonly<Record<string, string>>,
): FillSpec {
  return {
    color: color(shape, frame, colorSlots),
    opacity: clamp01(scalar(shape["o"], frame, 100) / 100),
    rule: shape["r"] === 2 ? "evenodd" : "nonzero",
  };
}

function strokeSpec(
  shape: JsonRecord,
  frame: number,
  colorSlots: Readonly<Record<string, string>>,
): StrokeSpec {
  const caps: StrokeSpec["lineCap"][] = ["butt", "butt", "round", "square"];
  const joins: StrokeSpec["lineJoin"][] = ["miter", "miter", "round", "bevel"];
  return {
    color: color(shape, frame, colorSlots),
    opacity: clamp01(scalar(shape["o"], frame, 100) / 100),
    width: Math.max(0, scalar(shape["w"], frame, 1)),
    lineCap: caps[finite(shape["lc"], 1)] ?? "butt",
    lineJoin: joins[finite(shape["lj"], 1)] ?? "miter",
    miterLimit: Math.max(0, finite(shape["ml"], 4)),
  };
}

function trimSpec(shape: JsonRecord, frame: number): TrimSpec {
  return {
    start: scalar(shape["s"], frame, 0),
    end: scalar(shape["e"], frame, 100),
    offset: scalar(shape["o"], frame, 0),
  };
}

function normalizedTurn(value: number): number {
  return ((value % 1) + 1) % 1;
}

function strokeGeometry(
  painter: SKRSContext2D,
  item: Geometry,
  style: StrokeSpec,
  trim: TrimSpec | undefined,
): void {
  painter.save();
  painter.strokeStyle = style.color;
  painter.globalAlpha *= style.opacity;
  painter.lineWidth = style.width;
  painter.lineCap = style.lineCap;
  painter.lineJoin = style.lineJoin;
  painter.miterLimit = style.miterLimit;
  if (trim !== undefined && item.length > 0) {
    const rawSpan = (trim.end - trim.start) / 100;
    const span = Math.abs(rawSpan) >= 1
      ? 1
      : normalizedTurn(rawSpan);
    const start = normalizedTurn(trim.start / 100 + trim.offset / 360);
    if (span <= 0) {
      painter.restore();
      return;
    }
    if (span < 1) {
      painter.setLineDash([item.length * span, item.length * (1 - span)]);
      painter.lineDashOffset = -item.length * start;
    }
  }
  painter.stroke(item.path);
  painter.restore();
}

function paintShapeGroup(
  painter: SKRSContext2D,
  items: unknown,
  frame: number,
  colorSlots: Readonly<Record<string, string>>,
): void {
  const shapes = records(items).filter((shape) => shape["hd"] !== true);
  const transform = shapes.find((shape) => shape["ty"] === "tr");
  const geometries = shapes.flatMap((shape) => {
    const item = geometry(shape, frame);
    return item === undefined ? [] : [item];
  });
  const fills = shapes
    .filter((shape) => shape["ty"] === "fl")
    .map((shape) => fillSpec(shape, frame, colorSlots));
  const strokes = shapes
    .filter((shape) => shape["ty"] === "st")
    .map((shape) => strokeSpec(shape, frame, colorSlots));
  const trimShape = shapes.find((shape) => shape["ty"] === "tm");
  const trim = trimShape === undefined ? undefined : trimSpec(trimShape, frame);
  painter.save();
  if (transform !== undefined) applyTransform(painter, transform, frame);
  for (const fill of fills) {
    painter.save();
    painter.fillStyle = fill.color;
    painter.globalAlpha *= fill.opacity;
    for (const item of geometries) painter.fill(item.path, fill.rule);
    painter.restore();
  }
  for (const stroke of strokes) {
    for (const item of geometries) strokeGeometry(painter, item, stroke, trim);
  }
  for (const group of shapes.filter((shape) => shape["ty"] === "gr")) {
    paintShapeGroup(painter, group["it"], frame, colorSlots);
  }
  painter.restore();
}

function maskGeometry(mask: JsonRecord, frame: number): Geometry | undefined {
  const value = pathValue(mask["pt"], frame);
  return value === undefined ? undefined : bezierGeometry(value);
}

function applyMasks(
  painter: SKRSContext2D,
  layer: JsonRecord,
  frame: number,
): void {
  const masks = records(layer["masksProperties"]);
  const additive = new Path2D();
  let hasAdditive = false;
  for (const mask of masks.filter(({ mode }) => mode === "a")) {
    const item = maskGeometry(mask, frame);
    if (item === undefined) continue;
    additive.addPath(item.path);
    hasAdditive = true;
  }
  if (hasAdditive) painter.clip(additive);
  for (const mask of masks.filter(({ mode }) => mode === "i")) {
    const item = maskGeometry(mask, frame);
    if (item !== undefined) painter.clip(item.path);
  }
}

function active(layer: JsonRecord, frame: number): boolean {
  return frame >= finite(layer["ip"], Number.NEGATIVE_INFINITY) &&
    frame < finite(layer["op"], Number.POSITIVE_INFINITY) &&
    layer["hd"] !== true;
}

function renderLayers(
  painter: SKRSContext2D,
  animation: LottieAnimation,
  layers: unknown,
  frame: number,
  colorSlots: Readonly<Record<string, string>>,
  assets: ReadonlyMap<string, JsonRecord>,
): void {
  for (const layer of records(layers).reverse()) {
    if (!active(layer, frame)) continue;
    const localFrame = frame - finite(layer["st"], 0);
    painter.save();
    applyTransform(painter, layer["ks"], localFrame);
    applyMasks(painter, layer, localFrame);
    if (layer["ty"] === 4) {
      paintShapeGroup(painter, layer["shapes"], localFrame, colorSlots);
    } else if (layer["ty"] === 0 && typeof layer["refId"] === "string") {
      const asset = assets.get(layer["refId"]);
      if (asset !== undefined) {
        painter.beginPath();
        painter.rect(
          0,
          0,
          finite(asset["w"], animation.width),
          finite(asset["h"], animation.height),
        );
        painter.clip();
        renderLayers(
          painter,
          animation,
          asset["layers"],
          localFrame,
          colorSlots,
          assets,
        );
      }
    } else if (layer["ty"] === 2 && typeof layer["refId"] === "string") {
      const image = animation.rasterAssets.get(layer["refId"]);
      const asset = assets.get(layer["refId"]);
      if (image !== undefined && asset !== undefined) {
        painter.drawImage(
          image,
          0,
          0,
          finite(asset["w"], image.width),
          finite(asset["h"], image.height),
        );
      }
    }
    painter.restore();
  }
}

export function lottieToolchainHash(
  shimVersion = LOTTIE_SHIM_VERSION,
): string {
  return createHash("sha256").update(JSON.stringify({
    renderer: LOTTIE_RENDERER_VERSION,
    shim: shimVersion,
  })).digest("hex");
}

export function createLottieAnimation(
  value: unknown,
  rasterAssets: ReadonlyMap<string, Image> = new Map(),
  analysisOptions: AnalyzeLottieOptions = {},
): LottieAnimation {
  const document = record(value);
  if (document === undefined) throw new TypeError("Lottie animation must be a JSON object.");
  const analysis = analyzeLottieDocument(document, analysisOptions);
  if (!analysis.ok) {
    throw new TypeError(
      `Unsupported Lottie features: ${analysis.unsupported.map(({ feature, layerPath }) =>
        `${feature} at ${layerPath}`).join("; ")}.`,
    );
  }
  return Object.freeze({
    width: analysis.profile.width,
    height: analysis.profile.height,
    frameRate: analysis.profile.frameRate,
    inPoint: analysis.profile.inPoint,
    outPoint: analysis.profile.outPoint,
    featureProfile: structuredClone(analysis.profile),
    rasterAssets,
    document,
  });
}

export function drawLottie(
  painter: SKRSContext2D,
  options: DrawLottieOptions,
): void {
  if (!Number.isFinite(options.frame)) {
    throw new TypeError("Lottie frame must be finite.");
  }
  if (
    !Number.isFinite(options.x) || !Number.isFinite(options.y) ||
    !Number.isFinite(options.width) || options.width <= 0 ||
    !Number.isFinite(options.height) || options.height <= 0
  ) {
    throw new RangeError("Lottie placement must have finite positive geometry.");
  }
  const opacity = options.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new RangeError("Lottie opacity must be between zero and one.");
  }
  const animation = options.animation;
  const frame = Math.max(
    animation.inPoint,
    Math.min(animation.outPoint - Number.EPSILON, options.frame),
  );
  const assets = new Map(records(animation.document["assets"]).flatMap((asset) =>
    typeof asset["id"] === "string" ? [[asset["id"], asset] as const] : []));
  painter.save();
  painter.translate(options.x, options.y);
  painter.scale(
    options.width / animation.width,
    options.height / animation.height,
  );
  painter.globalAlpha *= opacity;
  renderLayers(
    painter,
    animation,
    animation.document["layers"],
    frame,
    options.colorSlots ?? {},
    assets,
  );
  painter.restore();
}

export function renderLottiePng(
  animation: LottieAnimation,
  options: RenderLottiePngOptions,
): Buffer {
  if (
    !Number.isSafeInteger(options.width) || options.width < 1 ||
    !Number.isSafeInteger(options.height) || options.height < 1
  ) {
    throw new RangeError("Lottie output geometry must use positive integer pixels.");
  }
  const canvas = createCanvas(options.width, options.height);
  drawLottie(canvas.getContext("2d"), {
    animation,
    frame: options.frame,
    x: 0,
    y: 0,
    width: options.width,
    height: options.height,
    ...(options.colorSlots === undefined
      ? {}
      : { colorSlots: options.colorSlots }),
  });
  return canvas.toBuffer("image/png");
}
