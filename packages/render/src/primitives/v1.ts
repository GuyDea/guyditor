import type {
  Image,
  SKRSContext2D,
} from "@napi-rs/canvas";
import { drawLottie } from "../lottie.js";

export const PRIMITIVES_V1_VERSION = "primitives/v1@1";

export type PrimitiveEasing =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out";

export interface PrimitiveFrameTime {
  frames: number;
  fps: string;
}

export interface PrimitiveWordTiming {
  wordId: string;
  start: PrimitiveFrameTime;
  end: PrimitiveFrameTime;
  approximate: boolean;
}

interface Point {
  x: number;
  y: number;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  return value;
}

function positive(value: number, label: string): number {
  if (finite(value, label) <= 0) throw new RangeError(`${label} must be positive.`);
  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, finite(value, "progress")));
}

function rounded(value: number): number {
  return Number(value.toFixed(12));
}

function sampleEasing(easing: PrimitiveEasing, progress: number): number {
  const t = clamp01(progress);
  if (easing === "linear") return t;
  if (easing === "ease-in") return t * t * t;
  if (easing === "ease-out") return 1 - (1 - t) ** 3;
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function fixedStepSpring(
  progress: number,
  options: {
    stiffness: number;
    damping: number;
    mass: number;
    steps?: number;
  },
): number {
  const t = clamp01(progress);
  const stiffness = positive(options.stiffness, "spring stiffness");
  const damping = finite(options.damping, "spring damping");
  const mass = positive(options.mass, "spring mass");
  if (damping < 0) throw new RangeError("spring damping must not be negative.");
  const steps = options.steps ?? 120;
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > 10_000) {
    throw new RangeError("spring steps must be an integer from 1 to 10000.");
  }
  const count = Math.round(t * steps);
  const dt = 1 / steps;
  let position = 0;
  let velocity = 0;
  for (let index = 0; index < count; index += 1) {
    const acceleration = (-stiffness * (position - 1) - damping * velocity) / mass;
    velocity += acceleration * dt;
    position += velocity * dt;
  }
  return rounded(position);
}

interface ParsedRate {
  numerator: bigint;
  denominator: bigint;
}

function rate(value: string): ParsedRate {
  const match = /^([0-9]+)\/([1-9][0-9]*)$/u.exec(value);
  if (match === null) throw new TypeError(`Invalid rational frame rate ${value}.`);
  const numerator = BigInt(match[1]!);
  const denominator = BigInt(match[2]!);
  if (numerator === 0n) throw new RangeError("Frame-rate numerator must be positive.");
  return { numerator, denominator };
}

function requireFrameTime(value: PrimitiveFrameTime, label: string): void {
  if (!Number.isSafeInteger(value.frames)) {
    throw new RangeError(`${label} frames must be a safe integer.`);
  }
  rate(value.fps);
}

function subtractTime(
  left: PrimitiveFrameTime,
  right: PrimitiveFrameTime,
): { numerator: bigint; denominator: bigint } {
  const leftRate = rate(left.fps);
  const rightRate = rate(right.fps);
  return {
    numerator:
      BigInt(left.frames) * leftRate.denominator * rightRate.numerator -
      BigInt(right.frames) * rightRate.denominator * leftRate.numerator,
    denominator: leftRate.numerator * rightRate.numerator,
  };
}

function compareTime(left: PrimitiveFrameTime, right: PrimitiveFrameTime): number {
  const difference = subtractTime(left, right).numerator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function wordTimingProgress(
  timeline: PrimitiveFrameTime,
  timing: PrimitiveWordTiming,
): number {
  requireFrameTime(timeline, "timeline");
  requireFrameTime(timing.start, "word start");
  requireFrameTime(timing.end, "word end");
  if (compareTime(timing.start, timing.end) >= 0) {
    throw new RangeError(`Word ${timing.wordId} must end after it starts.`);
  }
  if (compareTime(timeline, timing.start) <= 0) return 0;
  if (compareTime(timeline, timing.end) >= 0) return 1;
  const elapsed = subtractTime(timeline, timing.start);
  const duration = subtractTime(timing.end, timing.start);
  return Number(elapsed.numerator * duration.denominator) /
    Number(elapsed.denominator * duration.numerator);
}

function revealUnits(text: string, mode: "word" | "character"): string[] {
  if (mode === "character") return [...text];
  return text.match(/\S+\s*/gu) ?? [];
}

export interface TextRevealOptions {
  text: string;
  mode: "word" | "character";
  easing?: PrimitiveEasing;
  progress?: number;
  timeline?: PrimitiveFrameTime;
  wordTiming?: PrimitiveWordTiming;
}

export interface TextRevealResult {
  progress: number;
  visibleUnits: number;
  totalUnits: number;
  visibleText: string;
}

function revealText(options: TextRevealOptions): TextRevealResult {
  const raw = options.wordTiming === undefined
    ? options.progress ?? 0
    : options.timeline === undefined
      ? (() => {
          throw new TypeError("A word-timed reveal requires the current timeline time.");
        })()
      : wordTimingProgress(options.timeline, options.wordTiming);
  const progress = sampleEasing(options.easing ?? "linear", raw);
  const units = revealUnits(options.text, options.mode);
  const visibleUnits = progress >= 1
    ? units.length
    : Math.max(0, Math.min(units.length, Math.floor(progress * units.length)));
  return {
    progress: rounded(clamp01(raw)),
    visibleUnits,
    totalUnits: units.length,
    visibleText: units.slice(0, visibleUnits).join("").trimEnd(),
  };
}

interface DrawRevealOptions extends TextRevealOptions {
  x: number;
  y: number;
  font?: string;
  fill?: string;
  maxWidth?: number;
}

function drawReveal(
  painter: SKRSContext2D,
  options: DrawRevealOptions,
): TextRevealResult {
  const result = revealText(options);
  painter.save();
  if (options.font !== undefined) painter.font = options.font;
  if (options.fill !== undefined) painter.fillStyle = options.fill;
  if (result.visibleText.length > 0) {
    if (options.maxWidth === undefined) {
      painter.fillText(result.visibleText, options.x, options.y);
    } else {
      painter.fillText(result.visibleText, options.x, options.y, options.maxWidth);
    }
  }
  painter.restore();
  return result;
}

interface ShapeStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

function applyShapeStyle(painter: SKRSContext2D, style: ShapeStyle): void {
  if (style.fill !== undefined) {
    painter.fillStyle = style.fill;
    painter.fill();
  }
  if (style.stroke !== undefined) {
    painter.strokeStyle = style.stroke;
    painter.lineWidth = style.strokeWidth ?? 1;
    painter.stroke();
  }
}

function roundedRectPath(
  painter: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  painter.beginPath();
  painter.moveTo(x + r, y);
  painter.lineTo(x + width - r, y);
  painter.quadraticCurveTo(x + width, y, x + width, y + r);
  painter.lineTo(x + width, y + height - r);
  painter.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  painter.lineTo(x + r, y + height);
  painter.quadraticCurveTo(x, y + height, x, y + height - r);
  painter.lineTo(x, y + r);
  painter.quadraticCurveTo(x, y, x + r, y);
  painter.closePath();
}

function roundedRect(
  painter: SKRSContext2D,
  options: ShapeStyle & {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
  },
): void {
  positive(options.width, "rounded rectangle width");
  positive(options.height, "rounded rectangle height");
  roundedRectPath(
    painter,
    options.x,
    options.y,
    options.width,
    options.height,
    options.radius,
  );
  applyShapeStyle(painter, options);
}

function ellipse(
  painter: SKRSContext2D,
  options: ShapeStyle & {
    centerX: number;
    centerY: number;
    radiusX: number;
    radiusY: number;
    rotation?: number;
  },
): void {
  painter.beginPath();
  painter.ellipse(
    options.centerX,
    options.centerY,
    positive(options.radiusX, "ellipse radiusX"),
    positive(options.radiusY, "ellipse radiusY"),
    options.rotation ?? 0,
    0,
    Math.PI * 2,
  );
  applyShapeStyle(painter, options);
}

function polygon(
  painter: SKRSContext2D,
  options: ShapeStyle & { points: readonly Point[] },
): void {
  if (options.points.length < 3) throw new RangeError("A polygon needs at least three points.");
  painter.beginPath();
  painter.moveTo(options.points[0]!.x, options.points[0]!.y);
  for (const point of options.points.slice(1)) painter.lineTo(point.x, point.y);
  painter.closePath();
  applyShapeStyle(painter, options);
}

type MaskShape =
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | {
      kind: "rounded";
      x: number;
      y: number;
      width: number;
      height: number;
      radius: number;
    }
  | {
      kind: "ellipse";
      centerX: number;
      centerY: number;
      radiusX: number;
      radiusY: number;
    }
  | { kind: "polygon"; points: readonly Point[] };

function maskPath(painter: SKRSContext2D, shape: MaskShape): void {
  if (shape.kind === "rect") {
    painter.beginPath();
    painter.rect(shape.x, shape.y, shape.width, shape.height);
    return;
  }
  if (shape.kind === "rounded") {
    roundedRectPath(
      painter,
      shape.x,
      shape.y,
      shape.width,
      shape.height,
      shape.radius,
    );
    return;
  }
  if (shape.kind === "ellipse") {
    painter.beginPath();
    painter.ellipse(
      shape.centerX,
      shape.centerY,
      shape.radiusX,
      shape.radiusY,
      0,
      0,
      Math.PI * 2,
    );
    return;
  }
  polygon(painter, { points: shape.points });
}

function withMask(
  painter: SKRSContext2D,
  shape: MaskShape,
  draw: () => void,
): void {
  painter.save();
  maskPath(painter, shape);
  painter.clip();
  draw();
  painter.restore();
}

interface WipeOptions {
  direction: "left-to-right" | "right-to-left" | "top-to-bottom" | "bottom-to-top";
  progress: number;
  easing?: PrimitiveEasing;
  x: number;
  y: number;
  width: number;
  height: number;
}

function withRectWipe(
  painter: SKRSContext2D,
  options: WipeOptions,
  draw: () => void,
): void {
  const progress = sampleEasing(options.easing ?? "linear", options.progress);
  const horizontal = options.direction === "left-to-right" ||
    options.direction === "right-to-left";
  const width = horizontal ? options.width * progress : options.width;
  const height = horizontal ? options.height : options.height * progress;
  const x = options.direction === "right-to-left"
    ? options.x + options.width - width
    : options.x;
  const y = options.direction === "bottom-to-top"
    ? options.y + options.height - height
    : options.y;
  withMask(painter, { kind: "rect", x, y, width, height }, draw);
}

function barChart(
  painter: SKRSContext2D,
  options: {
    values: readonly number[];
    max: number;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    gap?: number;
    progress?: number;
  },
): void {
  if (options.values.length === 0) throw new RangeError("A bar chart requires values.");
  const maximum = positive(options.max, "bar chart maximum");
  const gap = Math.max(0, options.gap ?? 4);
  const barWidth = (options.width - gap * (options.values.length - 1)) /
    options.values.length;
  positive(barWidth, "bar width");
  const progress = clamp01(options.progress ?? 1);
  painter.save();
  painter.fillStyle = options.color;
  for (const [index, rawValue] of options.values.entries()) {
    const value = Math.max(0, Math.min(maximum, finite(rawValue, "bar value")));
    const height = options.height * value / maximum * progress;
    painter.fillRect(
      options.x + index * (barWidth + gap),
      options.y + options.height - height,
      barWidth,
      height,
    );
  }
  painter.restore();
}

function lineChart(
  painter: SKRSContext2D,
  options: {
    values: readonly number[];
    min: number;
    max: number;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    strokeWidth?: number;
    progress?: number;
  },
): void {
  if (options.values.length < 2) throw new RangeError("A line chart needs at least two values.");
  if (!(options.max > options.min)) throw new RangeError("Line chart max must exceed min.");
  const progress = clamp01(options.progress ?? 1);
  const last = (options.values.length - 1) * progress;
  const point = (index: number, value: number): Point => ({
    x: options.x + options.width * index / (options.values.length - 1),
    y: options.y + options.height -
      options.height * (Math.max(options.min, Math.min(options.max, value)) - options.min) /
      (options.max - options.min),
  });
  painter.save();
  painter.beginPath();
  const first = point(0, finite(options.values[0]!, "line value"));
  painter.moveTo(first.x, first.y);
  const whole = Math.floor(last);
  for (let index = 1; index <= whole; index += 1) {
    const next = point(index, finite(options.values[index]!, "line value"));
    painter.lineTo(next.x, next.y);
  }
  if (whole < options.values.length - 1 && last > whole) {
    const start = point(whole, finite(options.values[whole]!, "line value"));
    const end = point(whole + 1, finite(options.values[whole + 1]!, "line value"));
    const fraction = last - whole;
    painter.lineTo(
      start.x + (end.x - start.x) * fraction,
      start.y + (end.y - start.y) * fraction,
    );
  }
  painter.strokeStyle = options.color;
  painter.lineWidth = options.strokeWidth ?? 2;
  painter.lineJoin = "round";
  painter.lineCap = "round";
  painter.stroke();
  painter.restore();
}

function counter(
  painter: SKRSContext2D,
  options: {
    from: number;
    to: number;
    progress: number;
    decimals: number;
    prefix?: string;
    suffix?: string;
    x: number;
    y: number;
    font?: string;
    fill?: string;
  },
): string {
  if (!Number.isSafeInteger(options.decimals) || options.decimals < 0 || options.decimals > 12) {
    throw new RangeError("Counter decimals must be an integer from 0 to 12.");
  }
  const value = finite(options.from, "counter from") +
    (finite(options.to, "counter to") - options.from) * clamp01(options.progress);
  const text = `${options.prefix ?? ""}${value.toFixed(options.decimals)}${options.suffix ?? ""}`;
  painter.save();
  if (options.font !== undefined) painter.font = options.font;
  if (options.fill !== undefined) painter.fillStyle = options.fill;
  painter.fillText(text, options.x, options.y);
  painter.restore();
  return text;
}

function pieChart(
  painter: SKRSContext2D,
  options: {
    values: readonly number[];
    colors: readonly string[];
    centerX: number;
    centerY: number;
    radius: number;
    progress?: number;
  },
): void {
  if (options.values.length === 0 || options.values.length !== options.colors.length) {
    throw new RangeError("Pie values and colors must be non-empty and have equal length.");
  }
  const values = options.values.map((value) => {
    finite(value, "pie value");
    if (value < 0) throw new RangeError("Pie values must not be negative.");
    return value;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  positive(total, "pie total");
  const limit = Math.PI * 2 * clamp01(options.progress ?? 1);
  let start = -Math.PI / 2;
  for (const [index, value] of values.entries()) {
    const naturalEnd = start + Math.PI * 2 * value / total;
    const end = Math.min(naturalEnd, -Math.PI / 2 + limit);
    if (end > start) {
      painter.beginPath();
      painter.moveTo(options.centerX, options.centerY);
      painter.arc(
        options.centerX,
        options.centerY,
        positive(options.radius, "pie radius"),
        start,
        end,
      );
      painter.closePath();
      painter.fillStyle = options.colors[index]!;
      painter.fill();
    }
    start = naturalEnd;
    if (start >= -Math.PI / 2 + limit) break;
  }
}

function geoHighlight(
  painter: SKRSContext2D,
  options: {
    map: Image;
    x: number;
    y: number;
    width: number;
    height: number;
    path: ReadonlyArray<readonly [number, number]>;
    color: string;
    strokeWidth?: number;
    progress?: number;
  },
): void {
  if (options.path.length < 2) throw new RangeError("A geo highlight needs at least two points.");
  painter.save();
  painter.drawImage(options.map, options.x, options.y, options.width, options.height);
  const progress = clamp01(options.progress ?? 1);
  const last = (options.path.length - 1) * progress;
  const point = (index: number): Point => ({
    x: options.x + options.path[index]![0] * options.width,
    y: options.y + options.path[index]![1] * options.height,
  });
  const first = point(0);
  painter.beginPath();
  painter.moveTo(first.x, first.y);
  const whole = Math.floor(last);
  for (let index = 1; index <= whole; index += 1) {
    const next = point(index);
    painter.lineTo(next.x, next.y);
  }
  if (whole < options.path.length - 1 && last > whole) {
    const start = point(whole);
    const end = point(whole + 1);
    const fraction = last - whole;
    painter.lineTo(
      start.x + (end.x - start.x) * fraction,
      start.y + (end.y - start.y) * fraction,
    );
  }
  painter.strokeStyle = options.color;
  painter.lineWidth = options.strokeWidth ?? 2;
  painter.lineJoin = "round";
  painter.lineCap = "round";
  painter.stroke();
  painter.restore();
}

function placeCutout(
  painter: SKRSContext2D,
  options: {
    image: Image;
    x: number;
    y: number;
    width: number;
    height: number;
    border?: { width: number; color: string };
    shadow?: { dx: number; dy: number; blur: number; color: string };
  },
): void {
  painter.save();
  if (options.shadow !== undefined) {
    painter.shadowOffsetX = options.shadow.dx;
    painter.shadowOffsetY = options.shadow.dy;
    painter.shadowBlur = Math.max(0, options.shadow.blur);
    painter.shadowColor = options.shadow.color;
  }
  painter.drawImage(options.image, options.x, options.y, options.width, options.height);
  painter.restore();
  if (options.border !== undefined && options.border.width > 0) {
    painter.save();
    painter.strokeStyle = options.border.color;
    painter.lineWidth = options.border.width;
    painter.strokeRect(options.x, options.y, options.width, options.height);
    painter.restore();
  }
}

function nextTextureSeed(state: number): number {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}

function textureFill(
  painter: SKRSContext2D,
  options: {
    kind: "dots" | "stripes" | "noise";
    x: number;
    y: number;
    width: number;
    height: number;
    foreground: string;
    background?: string;
    spacing?: number;
    size?: number;
    seed?: number;
  },
): void {
  const spacing = positive(options.spacing ?? 10, "texture spacing");
  const size = positive(options.size ?? 1, "texture size");
  let state = options.seed ?? 0;
  if (!Number.isSafeInteger(state) || state < 0 || state > 0xffff_ffff) {
    throw new RangeError("Texture seed must be a uint32.");
  }
  painter.save();
  if (options.background !== undefined) {
    painter.fillStyle = options.background;
    painter.fillRect(options.x, options.y, options.width, options.height);
  }
  painter.fillStyle = options.foreground;
  if (options.kind === "stripes") {
    for (
      let offset = -options.height;
      offset < options.width + options.height;
      offset += spacing
    ) {
      painter.beginPath();
      painter.moveTo(options.x + offset, options.y + options.height);
      painter.lineTo(options.x + offset + options.height, options.y);
      painter.lineWidth = size;
      painter.strokeStyle = options.foreground;
      painter.stroke();
    }
  } else {
    for (let y = options.y; y < options.y + options.height; y += spacing) {
      for (let x = options.x; x < options.x + options.width; x += spacing) {
        state = nextTextureSeed(state);
        const jitterX = ((state & 0xff) / 255 - 0.5) * spacing * 0.24;
        state = nextTextureSeed(state);
        const jitterY = ((state & 0xff) / 255 - 0.5) * spacing * 0.24;
        if (options.kind === "dots") {
          painter.beginPath();
          painter.arc(x + jitterX, y + jitterY, size, 0, Math.PI * 2);
          painter.fill();
        } else {
          painter.globalAlpha = 0.18 + ((state >>> 8) & 0xff) / 255 * 0.55;
          painter.fillRect(x + jitterX, y + jitterY, size, size);
        }
      }
    }
  }
  painter.restore();
}

export const primitivesV1 = Object.freeze({
  version: PRIMITIVES_V1_VERSION,
  easing: Object.freeze({
    sample: sampleEasing,
    spring: fixedStepSpring,
  }),
  text: Object.freeze({
    reveal: revealText,
    drawReveal,
    wordTimingProgress,
  }),
  shapes: Object.freeze({
    roundedRect,
    ellipse,
    polygon,
  }),
  masks: Object.freeze({
    withShape: withMask,
  }),
  wipes: Object.freeze({
    withRect: withRectWipe,
  }),
  charts: Object.freeze({
    bar: barChart,
    line: lineChart,
    counter,
    pie: pieChart,
  }),
  geo: Object.freeze({
    highlightPath: geoHighlight,
  }),
  cutout: Object.freeze({
    place: placeCutout,
  }),
  texture: Object.freeze({
    fill: textureFill,
  }),
  lottie: Object.freeze({
    draw: drawLottie,
  }),
});

export type PrimitivesV1 = typeof primitivesV1;
