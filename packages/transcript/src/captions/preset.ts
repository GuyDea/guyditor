import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { CaptionStyle } from "../../../core/src/index.js";
import type { CaptionPreset } from "./types.js";

export const DEFAULT_CAPTION_STYLE = Object.freeze({
  typeface: {
    family: "Inconsolata Guyditor",
    fontAssetId: "font_inconsolata_001010",
    fallbackAssetIds: [],
  },
  sizePct: 5.2,
  weight: 700,
  italic: false,
  letterSpacingPct: 0,
  lineSpacing: 1.08,
  color: "#FFFFFFFF",
  outline: { color: "#000000FF", widthPct: 0.45 },
  shadow: { color: "#00000099", dxPct: 0.18, dyPct: 0.24, blurPct: 0.18 },
  background: null,
  transform: "none",
  wordsPerLine: 4,
  maxLines: 2,
  maxWidthPct: 90,
  placement: { anchor: "bottom", offsetYPct: -5, align: "center" },
  safeArea: "platform",
  highlight: {
    mode: "per-word",
    style: "color",
    color: "#F2B84BFF",
    pastWords: "keep",
    maxGapMs: 400,
    holdMs: 0,
    leadInMs: 0,
  },
  emphasisStyle: { style: "scale", scale: 1.08 },
  cueGapMs: 800,
  maxCueDurationMs: 7_000,
  speakerStyles: {},
} satisfies CaptionStyle);

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string.`);
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number.`);
  }
  return value;
}

function integer(value: unknown, path: string): number {
  const parsed = number(value, path);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${path} must be a safe integer.`);
  return parsed;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean.`);
  return value;
}

function oneOf<Value extends string>(value: unknown, values: readonly Value[], path: string): Value {
  const parsed = string(value, path);
  if (!values.includes(parsed as Value)) {
    throw new TypeError(`${path} must be one of ${values.join(", ")}.`);
  }
  return parsed as Value;
}

function color(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!/^#[0-9A-Fa-f]{8}$/u.test(parsed)) throw new TypeError(`${path} must be #RRGGBBAA.`);
  return parsed.toUpperCase();
}

function nullableRecord(value: unknown, path: string): Record<string, unknown> | null {
  return value === null ? null : record(value, path);
}

function optionalNumber(source: Record<string, unknown>, key: string, path: string): number | undefined {
  return source[key] === undefined ? undefined : number(source[key], `${path}.${key}`);
}

function optionalColor(source: Record<string, unknown>, key: string, path: string): string | undefined {
  return source[key] === undefined ? undefined : color(source[key], `${path}.${key}`);
}

export function validateCaptionStyle(value: unknown, path = "style"): CaptionStyle {
  const source = record(value, path);
  const typeface = record(source["typeface"], `${path}.typeface`);
  const outline = nullableRecord(source["outline"], `${path}.outline`);
  const shadow = nullableRecord(source["shadow"], `${path}.shadow`);
  const background = nullableRecord(source["background"], `${path}.background`);
  const placement = record(source["placement"], `${path}.placement`);
  const highlight = record(source["highlight"], `${path}.highlight`);
  const emphasis = record(source["emphasisStyle"], `${path}.emphasisStyle`);
  const speakerSource = record(source["speakerStyles"], `${path}.speakerStyles`);
  const weight = integer(source["weight"], `${path}.weight`);
  const maxLines = integer(source["maxLines"], `${path}.maxLines`);
  if (![100, 200, 300, 400, 500, 600, 700, 800, 900].includes(weight)) {
    throw new TypeError(`${path}.weight is not a CSS hundred weight.`);
  }
  if (![1, 2, 3].includes(maxLines)) throw new TypeError(`${path}.maxLines must be 1, 2, or 3.`);
  const fallbackSource = typeface["fallbackAssetIds"];
  if (!Array.isArray(fallbackSource)) throw new TypeError(`${path}.typeface.fallbackAssetIds must be an array.`);
  const highlightColor = optionalColor(highlight, "color", `${path}.highlight`);
  const highlightScale = optionalNumber(highlight, "scale", `${path}.highlight`);
  const highlightWeight = optionalNumber(highlight, "weight", `${path}.highlight`);
  const dimOpacity = optionalNumber(highlight, "dimOpacity", `${path}.highlight`);
  const emphasisColor = optionalColor(emphasis, "color", `${path}.emphasisStyle`);
  const emphasisScale = optionalNumber(emphasis, "scale", `${path}.emphasisStyle`);
  const emphasisWeight = optionalNumber(emphasis, "weight", `${path}.emphasisStyle`);

  const style: CaptionStyle = {
    typeface: {
      family: string(typeface["family"], `${path}.typeface.family`),
      fontAssetId: string(typeface["fontAssetId"], `${path}.typeface.fontAssetId`),
      fallbackAssetIds: fallbackSource.map((entry, index) =>
        string(entry, `${path}.typeface.fallbackAssetIds[${String(index)}]`)),
    },
    sizePct: number(source["sizePct"], `${path}.sizePct`),
    weight: weight as CaptionStyle["weight"],
    italic: boolean(source["italic"], `${path}.italic`),
    letterSpacingPct: number(source["letterSpacingPct"], `${path}.letterSpacingPct`),
    lineSpacing: number(source["lineSpacing"], `${path}.lineSpacing`),
    color: color(source["color"], `${path}.color`),
    outline: outline === null ? null : {
      color: color(outline["color"], `${path}.outline.color`),
      widthPct: number(outline["widthPct"], `${path}.outline.widthPct`),
    },
    shadow: shadow === null ? null : {
      color: color(shadow["color"], `${path}.shadow.color`),
      dxPct: number(shadow["dxPct"], `${path}.shadow.dxPct`),
      dyPct: number(shadow["dyPct"], `${path}.shadow.dyPct`),
      blurPct: number(shadow["blurPct"], `${path}.shadow.blurPct`),
    },
    background: background === null ? null : {
      color: color(background["color"], `${path}.background.color`),
      padXPct: number(background["padXPct"], `${path}.background.padXPct`),
      padYPct: number(background["padYPct"], `${path}.background.padYPct`),
      radiusPct: number(background["radiusPct"], `${path}.background.radiusPct`),
      scope: oneOf(background["scope"], ["word", "line", "block"], `${path}.background.scope`),
    },
    transform: oneOf(source["transform"], ["none", "upper", "lower", "title"], `${path}.transform`),
    wordsPerLine: integer(source["wordsPerLine"], `${path}.wordsPerLine`),
    maxLines: maxLines as CaptionStyle["maxLines"],
    maxWidthPct: number(source["maxWidthPct"], `${path}.maxWidthPct`),
    placement: {
      anchor: oneOf(placement["anchor"], ["top", "middle", "bottom"], `${path}.placement.anchor`),
      offsetYPct: number(placement["offsetYPct"], `${path}.placement.offsetYPct`),
      align: oneOf(placement["align"], ["left", "center", "right"], `${path}.placement.align`),
    },
    safeArea: oneOf(source["safeArea"], ["platform", "none"], `${path}.safeArea`),
    highlight: {
      mode: oneOf(highlight["mode"], ["per-word", "per-line", "none"], `${path}.highlight.mode`),
      style: oneOf(highlight["style"], ["color", "scale", "weight", "underline", "background"], `${path}.highlight.style`),
      ...(highlightColor === undefined ? {} : { color: highlightColor }),
      ...(highlightScale === undefined ? {} : { scale: highlightScale }),
      ...(highlightWeight === undefined ? {} : { weight: highlightWeight }),
      pastWords: oneOf(highlight["pastWords"], ["keep", "dim"], `${path}.highlight.pastWords`),
      ...(dimOpacity === undefined ? {} : { dimOpacity }),
      maxGapMs: integer(highlight["maxGapMs"], `${path}.highlight.maxGapMs`),
      holdMs: integer(highlight["holdMs"], `${path}.highlight.holdMs`),
      leadInMs: integer(highlight["leadInMs"], `${path}.highlight.leadInMs`),
    },
    emphasisStyle: {
      style: oneOf(emphasis["style"], ["color", "scale", "weight", "underline"], `${path}.emphasisStyle.style`),
      ...(emphasisColor === undefined ? {} : { color: emphasisColor }),
      ...(emphasisScale === undefined ? {} : { scale: emphasisScale }),
      ...(emphasisWeight === undefined ? {} : { weight: emphasisWeight }),
    },
    cueGapMs: integer(source["cueGapMs"], `${path}.cueGapMs`),
    maxCueDurationMs: integer(source["maxCueDurationMs"], `${path}.maxCueDurationMs`),
    speakerStyles: Object.fromEntries(Object.entries(speakerSource).map(([speakerId, override]) => [
      speakerId,
      record(override, `${path}.speakerStyles.${speakerId}`) as Partial<CaptionStyle>,
    ])),
  };
  if (style.sizePct <= 0 || style.lineSpacing <= 0 || style.wordsPerLine < 1 || style.maxWidthPct <= 0) {
    throw new TypeError(`${path} contains a non-positive size or line-breaking limit.`);
  }
  return style;
}

export function parseCaptionPreset(content: string): CaptionPreset {
  const source = record(parseYaml(content, { schema: "core" }), "caption preset");
  const format = string(source["format"], "caption preset.format");
  if (format !== "guyditor.caption-preset/v1") throw new TypeError(`Unsupported caption preset format ${format}.`);
  const presetId = string(source["presetId"], "caption preset.presetId");
  if (!/^pre_[a-z2-7]{10}$/u.test(presetId)) throw new TypeError("caption preset.presetId is invalid.");
  const version = integer(source["version"], "caption preset.version");
  if (version < 1) throw new TypeError("caption preset.version must be positive.");
  return {
    format,
    presetId,
    name: string(source["name"], "caption preset.name"),
    version,
    style: validateCaptionStyle(source["style"]),
  };
}

export function serializeCaptionPreset(preset: CaptionPreset): string {
  const validated = parseCaptionPreset(stringifyYaml(preset, { lineWidth: 0 }));
  return stringifyYaml(validated, { lineWidth: 0 });
}

function mergeRecords(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = typeof current === "object" && current !== null && !Array.isArray(current) &&
        typeof value === "object" && value !== null && !Array.isArray(value)
      ? mergeRecords(current as Record<string, unknown>, value as Record<string, unknown>)
      : structuredClone(value);
  }
  return merged;
}

export function resolveCaptionStyle(
  preset: CaptionStyle,
  overrides: Partial<CaptionStyle>,
  speakerId?: string,
): CaptionStyle {
  const trackStyle = validateCaptionStyle(mergeRecords(
    preset as unknown as Record<string, unknown>,
    overrides as unknown as Record<string, unknown>,
  ));
  const speaker = speakerId === undefined ? undefined : trackStyle.speakerStyles[speakerId];
  return speaker === undefined
    ? trackStyle
    : validateCaptionStyle(mergeRecords(
        trackStyle as unknown as Record<string, unknown>,
        speaker as unknown as Record<string, unknown>,
      ));
}
