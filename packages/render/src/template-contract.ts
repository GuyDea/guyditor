import type { Image, SKRSContext2D } from "@napi-rs/canvas";

import type { FrameTime } from "../../core/src/index.js";

export type OverlayCanvas2D = SKRSContext2D;
export type OverlayImage = Image;

export interface SeededRng {
  next(): number;
  nextUint32(): number;
  int(minimum: number, maximum: number): number;
}

export interface ResolvedFont {
  family: string;
  weight: number;
  sha256: string;
}

export type ResolvedFontMap = Readonly<Record<string, ResolvedFont>>;

export interface BrandContext {
  palette: Readonly<Record<string, string>>;
  logoSlots?: Readonly<Record<string, OverlayImage>>;
}

export interface TemplateRenderContext {
  canvas: OverlayCanvas2D;
  frame: number;
  totalFrames: number;
  fps: string;
  width: number;
  height: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
  progress: number;
  fonts: ResolvedFontMap;
  brand: BrandContext;
  rng: SeededRng;
  staticAssets(name: string): OverlayImage;
}

export interface TemplateStaticContext {
  width: number;
  height: number;
  fps: string;
}

export type DurationSpec =
  | { mode: "fixed"; frames: number; fps: string }
  | { mode: "intrinsic" }
  | { mode: "anchor_span" };

export interface TemplateModule<P = Record<string, unknown>> {
  render(ctx: TemplateRenderContext, params: P): void;
  duration?(params: P, media: TemplateStaticContext): DurationSpec;
}

export interface TemplateRenderOptions {
  params: Record<string, unknown>;
  seed: number;
  frame: number;
  totalFrames: number;
  fps: string;
  width: number;
  height: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
  brand: BrandContext;
}

export interface ResolvedTemplateDuration {
  length: FrameTime;
}
