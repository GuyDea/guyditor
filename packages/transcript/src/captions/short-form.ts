import type { CaptionStyle } from "../../../core/src/index.js";

import { compileCaptionTrack } from "./compiler.js";
import { resolveCaptionStyle } from "./preset.js";
import type {
  CaptionRenderModel,
  CompileDerivativeCaptionTrackOptions,
  NormRect,
} from "./types.js";

function titleSafeArea(
  insets: CompileDerivativeCaptionTrackOptions["profile"]["safeAreas"]["title"],
): NormRect {
  const width = 1 - insets.left - insets.right;
  const height = 1 - insets.top - insets.bottom;
  if (width <= 0 || height <= 0) throw new TypeError("Caption title-safe area has no drawable extent.");
  return { x: insets.left, y: insets.top, w: width, h: height };
}

function profileStyle(
  options: CompileDerivativeCaptionTrackOptions,
  safeArea: NormRect,
): Partial<CaptionStyle> {
  const defaults = options.profile.captionDefaults;
  const offsetYPct = (defaults.placement.verticalCenter - (safeArea.y + safeArea.h / 2)) /
    safeArea.h * 100;
  return {
    ...(defaults.fontSizePct === undefined ? {} : { sizePct: defaults.fontSizePct }),
    ...(defaults.weight === undefined ? {} : { weight: defaults.weight }),
    maxLines: defaults.maxLines,
    placement: {
      anchor: "middle",
      offsetYPct,
      align: defaults.placement.anchor,
    },
    safeArea: "platform",
    highlight: {
      ...options.presetStyle.highlight,
      mode: defaults.perWordHighlight ? "per-word" : "none",
    },
  };
}

export function compileDerivativeCaptionTrack(
  options: CompileDerivativeCaptionTrackOptions,
): CaptionRenderModel {
  const safeArea = titleSafeArea(options.profile.safeAreas.title);
  const withProfile = resolveCaptionStyle(
    options.presetStyle,
    profileStyle(options, safeArea),
  );
  const style = resolveCaptionStyle(withProfile, options.track.styleOverrides);
  return compileCaptionTrack({
    track: options.track,
    timeline: options.timeline,
    sidecars: options.sidecars,
    style,
    safeArea,
    output: {
      width: options.profile.video.resolution.width,
      height: options.profile.video.resolution.height,
      fps: options.profile.video.fps.default,
    },
    maxCharsPerLine: options.profile.captionDefaults.maxCharsPerLine,
    ...(options.measureText === undefined ? {} : { measureText: options.measureText }),
  });
}
