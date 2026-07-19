import type { CaptionFrameSpec } from "../../transcript/src/index.js";
import type { CaptionStyle } from "../../core/src/index.js";

export interface CaptionPaintContext {
  fillStyle: string;
  strokeStyle: string;
  font: string;
  letterSpacing: string;
  globalAlpha: number;
  lineJoin: "bevel" | "miter" | "round";
  lineWidth: number;
  shadowBlur: number;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  textBaseline: "alphabetic" | "bottom" | "hanging" | "ideographic" | "middle" | "top";
  beginPath(): void;
  fill(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  restore(): void;
  roundRect(x: number, y: number, width: number, height: number, radius: number): void;
  save(): void;
  scale(x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  translate(x: number, y: number): void;
}

function font(style: CaptionStyle, weight: number): string {
  return `${style.italic ? "italic " : ""}${String(weight)} 1px ${JSON.stringify(style.typeface.family)}`;
}

function rect(
  context: CaptionPaintContext,
  box: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
  color: string,
  padX: number,
  padY: number,
  radius: number,
): void {
  const x = box.x * width - padX;
  const y = box.y * height - padY;
  const w = box.w * width + padX * 2;
  const h = box.h * height + padY * 2;
  context.save();
  context.fillStyle = color;
  context.beginPath();
  context.roundRect(x, y, w, h, Math.max(0, radius));
  context.fill();
  context.restore();
}

function background(
  context: CaptionPaintContext,
  frame: CaptionFrameSpec,
  width: number,
  height: number,
): void {
  const backgroundStyle = frame.styleResolved.background;
  if (backgroundStyle === null) return;
  const padX = backgroundStyle.padXPct / 100 * width;
  const padY = backgroundStyle.padYPct / 100 * height;
  const radius = backgroundStyle.radiusPct / 100 * height;
  for (const cue of frame.cues) {
    if (backgroundStyle.scope === "block") {
      rect(context, cue.box, width, height, backgroundStyle.color, padX, padY, radius);
      continue;
    }
    for (const line of cue.lines) {
      if (backgroundStyle.scope === "line") {
        rect(context, line.box, width, height, backgroundStyle.color, padX, padY, radius);
      } else {
        for (const word of line.words) {
          rect(context, word.box, width, height, backgroundStyle.color, padX, padY, radius);
        }
      }
    }
  }
}

function wordAppearance(
  word: CaptionFrameSpec["cues"][number]["lines"][number]["words"][number],
  style: CaptionStyle,
): { color: string; opacity: number; scale: number; weight: number; underline: boolean; highlightBackground: boolean } {
  let color = style.color;
  let opacity = word.state === "past" && style.highlight.pastWords === "dim"
    ? style.highlight.dimOpacity ?? 0.55
    : 1;
  let scale = 1;
  let weight: number = style.weight;
  let underline = false;
  let highlightBackground = false;
  if (word.state === "current") {
    switch (style.highlight.style) {
      case "color": color = style.highlight.color ?? color; break;
      case "scale": scale = style.highlight.scale ?? 1.08; break;
      case "weight": weight = style.highlight.weight ?? Math.min(900, style.weight + 200); break;
      case "underline": underline = true; break;
      case "background": highlightBackground = true; break;
    }
  }
  if (word.emphasized) {
    switch (style.emphasisStyle.style) {
      case "color": color = style.emphasisStyle.color ?? color; break;
      case "scale": scale *= style.emphasisStyle.scale ?? 1.08; break;
      case "weight": weight = style.emphasisStyle.weight ?? Math.min(900, weight + 100); break;
      case "underline": underline = true; break;
    }
  }
  if (style.highlight.mode === "none") opacity = 1;
  return { color, opacity, scale, weight, underline, highlightBackground };
}

export function paintCaptionFrame(
  context: CaptionPaintContext,
  frame: CaptionFrameSpec,
  width: number,
  height: number,
): void {
  const style = frame.styleResolved;
  const fontPx = style.sizePct / 100 * height;
  background(context, frame, width, height);
  for (const cue of frame.cues) {
    for (const line of cue.lines) {
      for (const word of line.words) {
        const appearance = wordAppearance(word, style);
        const x = word.box.x * width;
        const y = word.box.y * height + word.box.h * height * 0.8;
        if (appearance.highlightBackground) {
          rect(
            context,
            word.box,
            width,
            height,
            style.highlight.color ?? "#F2B84BCC",
            fontPx * 0.14,
            fontPx * 0.08,
            fontPx * 0.08,
          );
        }
        context.save();
        context.globalAlpha = appearance.opacity;
        context.fillStyle = appearance.color;
        context.strokeStyle = style.outline?.color ?? "#00000000";
        context.lineJoin = "round";
        context.lineWidth = style.outline === null ? 0 : style.outline.widthPct / 100 * height;
        context.shadowColor = style.shadow?.color ?? "#00000000";
        context.shadowOffsetX = style.shadow === null ? 0 : style.shadow.dxPct / 100 * width;
        context.shadowOffsetY = style.shadow === null ? 0 : style.shadow.dyPct / 100 * height;
        context.shadowBlur = style.shadow === null ? 0 : style.shadow.blurPct / 100 * height;
        context.font = font(style, appearance.weight).replace("1px", `${String(fontPx)}px`);
        context.letterSpacing = `${String(style.letterSpacingPct / 100)}em`;
        context.textBaseline = "alphabetic";
        if (appearance.scale !== 1) {
          const centerX = x + word.box.w * width / 2;
          const centerY = word.box.y * height + word.box.h * height / 2;
          context.translate(centerX, centerY);
          context.scale(appearance.scale, appearance.scale);
          context.translate(-centerX, -centerY);
        }
        if (style.outline !== null && context.lineWidth > 0) context.strokeText(word.displayText, x, y);
        context.fillText(word.displayText, x, y);
        if (appearance.underline) {
          context.shadowColor = "#00000000";
          context.fillRect(x, word.box.y * height + word.box.h * height * 0.9, word.box.w * width, Math.max(1, fontPx * 0.06));
        }
        context.restore();
      }
    }
  }
}
