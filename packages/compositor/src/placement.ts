import { makeGuyditorError } from "../../core/src/errors.js";
import type {
  AnchorName,
  PlacementConstraints,
} from "../../core/src/index.js";

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ANCHORS: readonly AnchorName[] = [
  "top_left", "top", "top_right", "left", "center", "right",
  "bottom_left", "bottom", "bottom_right",
];

const KEYS = [
  "anchor", "width", "height", "margin", "margin_x", "margin_y",
  "offset_x", "offset_y", "aspect", "fit",
] as const;

type ConstraintKey = typeof KEYS[number];

const PERCENT = /^(-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))%$/u;
const ASPECT = /^([1-9][0-9]*):([1-9][0-9]*)$/u;

function constraintError(token: string, detail: string): never {
  throw makeGuyditorError(
    "E_PIP_CONSTRAINT",
    `Invalid PiP constraint token '${token}': ${detail}.`,
    { affected: [token], retry: "none" },
  );
}

function percentage(value: string | undefined, key: ConstraintKey): number | undefined {
  if (value === undefined) return undefined;
  const match = PERCENT.exec(value);
  if (match === null) constraintError(`${key}: ${value}`, "expected a percentage");
  const parsed = Number(match[1]);
  const signed = key === "offset_x" || key === "offset_y";
  if (!Number.isFinite(parsed) || (!signed && parsed < 0) || parsed > 100 || (signed && parsed < -100)) {
    constraintError(`${key}: ${value}`, signed ? "expected -100%..100%" : "expected 0%..100%");
  }
  if ((key === "width" || key === "height") && parsed === 0) {
    constraintError(`${key}: ${value}`, "size must be greater than zero");
  }
  return parsed / 100;
}

function aspectValue(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const match = ASPECT.exec(value);
  if (match === null) constraintError(`aspect: ${value}`, "expected a positive W:H ratio");
  return Number(match[1]) / Number(match[2]);
}

function validateConstraints(input: PlacementConstraints): PlacementConstraints {
  if (typeof input !== "object" || input === null) constraintError(String(input), "expected an object");
  for (const key of Object.keys(input)) {
    if (!(KEYS as readonly string[]).includes(key)) constraintError(key, "unknown key");
  }
  if (!ANCHORS.includes(input.anchor)) constraintError(`anchor: ${String(input.anchor)}`, "unknown anchor");
  percentage(input.width, "width");
  percentage(input.height, "height");
  percentage(input.margin, "margin");
  percentage(input.margin_x, "margin_x");
  percentage(input.margin_y, "margin_y");
  percentage(input.offset_x, "offset_x");
  percentage(input.offset_y, "offset_y");
  aspectValue(input.aspect, 1);
  if (input.fit !== undefined && input.fit !== "contain" && input.fit !== "cover" && input.fit !== "stretch") {
    constraintError(`fit: ${String(input.fit)}`, "expected contain, cover, or stretch");
  }
  return input;
}

export function parsePlacementConstraints(text: string): PlacementConstraints {
  const parsed: Record<string, string> = {};
  const tokens = text.split(/[\n,]+/u).map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    const separator = token.indexOf(":");
    if (separator === -1) constraintError(token, "expected key: value");
    const key = token.slice(0, separator).trim();
    const value = token.slice(separator + 1).trim();
    if (!(KEYS as readonly string[]).includes(key)) constraintError(token, "unknown key");
    if (value.length === 0) constraintError(token, "value is empty");
    if (key in parsed) constraintError(token, "duplicate key");
    parsed[key] = value;
  }
  if (parsed["anchor"] === undefined) constraintError("anchor", "required key is missing");
  return validateConstraints(parsed as unknown as PlacementConstraints);
}

export function formatPlacementConstraints(constraints: PlacementConstraints): string {
  validateConstraints(constraints);
  return KEYS.flatMap((key) => {
    const value = constraints[key];
    return value === undefined ? [] : [`${key}: ${value}`];
  }).join(", ");
}

function horizontalFamily(anchor: AnchorName): "left" | "center" | "right" {
  if (anchor.endsWith("left") || anchor === "left") return "left";
  if (anchor.endsWith("right") || anchor === "right") return "right";
  return "center";
}

function verticalFamily(anchor: AnchorName): "top" | "center" | "bottom" {
  if (anchor.startsWith("top") || anchor === "top") return "top";
  if (anchor.startsWith("bottom") || anchor === "bottom") return "bottom";
  return "center";
}

function finiteDimension(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) constraintError(label, "composition dimension must be positive");
}

export function solvePlacement(
  constraints: PlacementConstraints,
  compW: number,
  compH: number,
  sourceAspect = compW / compH,
): NormalizedRect {
  const c = validateConstraints(constraints);
  finiteDimension(compW, "composition width");
  finiteDimension(compH, "composition height");
  if (!Number.isFinite(sourceAspect) || sourceAspect <= 0) constraintError("source aspect", "must be positive");
  const aspect = aspectValue(c.aspect, sourceAspect);
  const width = percentage(c.width, "width");
  const height = percentage(c.height, "height");
  let boxW: number;
  let boxH: number;
  if (width !== undefined && height === undefined) {
    boxW = width * compW;
    boxH = boxW / aspect;
  } else if (width === undefined && height !== undefined) {
    boxH = height * compH;
    boxW = boxH * aspect;
  } else if (width !== undefined && height !== undefined) {
    const boundW = width * compW;
    const boundH = height * compH;
    if ((c.fit ?? "contain") === "contain") {
      boxW = Math.min(boundW, boundH * aspect);
      boxH = boxW / aspect;
    } else {
      boxW = boundW;
      boxH = boundH;
    }
  } else {
    boxW = compW;
    boxH = boxW / aspect;
    if (boxH > compH) {
      boxH = compH;
      boxW = boxH * aspect;
    }
  }

  const commonMargin = percentage(c.margin, "margin");
  const marginX = (percentage(c.margin_x, "margin_x") ?? commonMargin ?? 0) * compW;
  const marginY = c.margin_y === undefined
    ? (commonMargin ?? 0) * compW
    : percentage(c.margin_y, "margin_y")! * compW;
  const offsetX = (percentage(c.offset_x, "offset_x") ?? 0) * compW;
  const offsetY = (percentage(c.offset_y, "offset_y") ?? 0) * compH;
  const horizontal = horizontalFamily(c.anchor);
  const vertical = verticalFamily(c.anchor);
  const x = (horizontal === "left" ? marginX
    : horizontal === "right" ? compW - boxW - marginX
      : (compW - boxW) / 2) + offsetX;
  const y = (vertical === "top" ? marginY
    : vertical === "bottom" ? compH - boxH - marginY
      : (compH - boxH) / 2) + offsetY;
  return { x: x / compW, y: y / compH, w: boxW / compW, h: boxH / compH };
}

function nearestEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function solvePlacementPixels(
  constraints: PlacementConstraints,
  compW: number,
  compH: number,
  sourceAspect = compW / compH,
): PixelRect {
  const rect = solvePlacement(constraints, compW, compH, sourceAspect);
  return {
    x: Math.round(rect.x * compW),
    y: Math.round(rect.y * compH),
    w: nearestEven(rect.w * compW),
    h: nearestEven(rect.h * compH),
  };
}

function percentText(value: number): string {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return `${String(Object.is(rounded, -0) ? 0 : rounded)}%`;
}

function anchorPoint(anchor: AnchorName): { x: number; y: number } {
  const horizontal = horizontalFamily(anchor);
  const vertical = verticalFamily(anchor);
  return {
    x: horizontal === "left" ? 0 : horizontal === "right" ? 1 : 0.5,
    y: vertical === "top" ? 0 : vertical === "bottom" ? 1 : 0.5,
  };
}

interface SnapCandidate {
  anchor: AnchorName;
  errorPx: number;
  marginPx: number;
}

function snapCandidate(rect: NormalizedRect, anchor: AnchorName, compW: number, compH: number): SnapCandidate {
  const horizontal = horizontalFamily(anchor);
  const vertical = verticalFamily(anchor);
  const left = rect.x * compW;
  const right = (1 - rect.x - rect.w) * compW;
  const top = rect.y * compH;
  const bottom = (1 - rect.y - rect.h) * compH;
  const centerXError = Math.abs((rect.x + rect.w / 2 - 0.5) * compW);
  const centerYError = Math.abs((rect.y + rect.h / 2 - 0.5) * compH);
  const xMargin = horizontal === "left" ? left : horizontal === "right" ? right : undefined;
  const yMargin = vertical === "top" ? top : vertical === "bottom" ? bottom : undefined;
  if (xMargin !== undefined && yMargin !== undefined) {
    return { anchor, errorPx: Math.abs(xMargin - yMargin), marginPx: (xMargin + yMargin) / 2 };
  }
  if (xMargin !== undefined) {
    return { anchor, errorPx: centerYError, marginPx: xMargin };
  }
  if (yMargin !== undefined) {
    return { anchor, errorPx: centerXError, marginPx: yMargin };
  }
  return { anchor, errorPx: centerXError + centerYError, marginPx: 0 };
}

export function constraintsFromDrag(
  rect: NormalizedRect,
  compW: number,
  compH: number,
  previous: PlacementConstraints,
): PlacementConstraints {
  finiteDimension(compW, "composition width");
  finiteDimension(compH, "composition height");
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) {
    constraintError(JSON.stringify(rect), "drag rectangle must be finite and positive");
  }
  const width = percentText(rect.w * 100);
  const aspect = previous.aspect ?? `${String(Math.round(rect.w * compW))}:${String(Math.round(rect.h * compH))}`;
  const candidates = ANCHORS.map((anchor) => snapCandidate(rect, anchor, compW, compH))
    .sort((left, right) => left.errorPx - right.errorPx || ANCHORS.indexOf(left.anchor) - ANCHORS.indexOf(right.anchor));
  const snapped = candidates[0]!;
  if (snapped.errorPx <= compW * 0.015 && snapped.marginPx >= 0) {
    return {
      anchor: snapped.anchor,
      width,
      ...(snapped.marginPx === 0 ? {} : { margin: percentText(snapped.marginPx / compW * 100) }),
      aspect,
      ...(previous.fit === undefined ? {} : { fit: previous.fit }),
    };
  }

  const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const anchor = ANCHORS.slice().sort((left, right) => {
    const a = anchorPoint(left);
    const b = anchorPoint(right);
    const da = Math.hypot((center.x - a.x) * compW, (center.y - a.y) * compH);
    const db = Math.hypot((center.x - b.x) * compW, (center.y - b.y) * compH);
    return da - db || ANCHORS.indexOf(left) - ANCHORS.indexOf(right);
  })[0]!;
  const base: PlacementConstraints = { anchor, width, aspect };
  const solved = solvePlacement(base, compW, compH);
  return {
    ...base,
    offset_x: percentText((rect.x - solved.x) * 100),
    offset_y: percentText((rect.y - solved.y) * 100),
    ...(previous.fit === undefined ? {} : { fit: previous.fit }),
  };
}
