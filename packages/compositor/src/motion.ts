import { makeGuyditorError } from "../../core/src/errors.js";
import type {
  PipConfig,
  PipStyle,
  PresetPin,
} from "../../core/src/index.js";

import type { NormalizedRect } from "./placement.js";
import { solvePlacement } from "./placement.js";

export interface MotionPreset {
  id: string;
  version: number;
  name:
    | "fade_in" | "fade_out" | "pop_in" | "pop_out"
    | "scale_in" | "scale_out" | "slide_in" | "slide_out"
    | "smooth_move" | "expand_fullscreen" | "collapse_fullscreen"
    | "swap_background";
  label: string;
  kind: "entrance" | "exit" | "movement" | "swap";
  defaultDurationFrames: number;
  easing: [number, number, number, number];
  params?: { direction?: "left" | "right" | "up" | "down"; overshoot?: number };
}

function preset(
  id: string,
  name: MotionPreset["name"],
  kind: MotionPreset["kind"],
  defaultDurationFrames: number,
  easing: MotionPreset["easing"],
  params?: MotionPreset["params"],
): MotionPreset {
  return {
    id,
    version: 1,
    name,
    label: `pip-${name.replaceAll("_", "-")}`,
    kind,
    defaultDurationFrames,
    easing,
    ...(params === undefined ? {} : { params }),
  };
}

export const MOTION_PRESETS: readonly MotionPreset[] = Object.freeze([
  preset("pre_pipfadeina", "fade_in", "entrance", 12, [0.25, 0.1, 0.25, 1]),
  preset("pre_pipfadeout", "fade_out", "exit", 12, [0.25, 0.1, 0.25, 1]),
  preset("pre_pippopinaa", "pop_in", "entrance", 15, [0.2, 0.9, 0.3, 1], { overshoot: 0.08 }),
  preset("pre_pippopouta", "pop_out", "exit", 12, [0.4, 0, 1, 1], { overshoot: 0.04 }),
  preset("pre_pipscalein", "scale_in", "entrance", 15, [0.2, 0.8, 0.2, 1]),
  preset("pre_pipscaleou", "scale_out", "exit", 12, [0.4, 0, 1, 1]),
  preset("pre_pipslidein", "slide_in", "entrance", 18, [0.2, 0.8, 0.2, 1], { direction: "right" }),
  preset("pre_pipslideou", "slide_out", "exit", 18, [0.4, 0, 1, 1], { direction: "right" }),
  preset("pre_pipsmoothm", "smooth_move", "movement", 18, [0.4, 0, 0.2, 1]),
  preset("pre_pipexpandf", "expand_fullscreen", "movement", 24, [0.4, 0, 0.2, 1]),
  preset("pre_pipcollaps", "collapse_fullscreen", "movement", 24, [0.4, 0, 0.2, 1]),
  preset("pre_pipswapbac", "swap_background", "swap", 24, [0.4, 0, 0.2, 1]),
]);

export function motionPreset(reference: string, version = 1): MotionPreset {
  const normalized = reference.startsWith("pip-")
    ? reference.slice(4).replaceAll("-", "_")
    : reference.replaceAll("-", "_");
  const found = MOTION_PRESETS.find((candidate) =>
    (candidate.id === reference || candidate.name === normalized || candidate.label === reference) &&
    candidate.version === version);
  if (found === undefined) {
    throw makeGuyditorError(
      "E_PIP_PRESET_NOT_FOUND",
      `PiP motion preset ${reference}@${String(version)} is not installed.`,
      { affected: [reference] },
    );
  }
  return found;
}

export function motionPresetPin(reference: string, version = 1): PresetPin {
  const resolved = motionPreset(reference, version);
  return {
    id: resolved.id,
    name: resolved.label,
    kind: "motion",
    version: resolved.version,
    path: `builtin:${resolved.label}@${String(resolved.version)}`,
    sha256: "6".repeat(64),
  };
}

export interface MotionState {
  rect: NormalizedRect;
  opacity: number;
}

export interface DerivedPipSample extends MotionState {
  atOutputFrame: number;
  source: "base" | "transition" | string;
  presetId?: string;
  style?: PipStyle | Partial<PipStyle>;
}

export interface CompiledPipTimeline {
  samples: DerivedPipSample[];
}

function cubicCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}

function cubicDerivative(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * first + 6 * inverse * t * (second - first) +
    3 * t * t * (1 - second);
}

export function cubicBezierProgress(progress: number, easing: MotionPreset["easing"]): number {
  const x = Math.max(0, Math.min(1, progress));
  if (x === 0 || x === 1) return x;
  const [x1, y1, x2, y2] = easing;
  let parameter = x;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const error = cubicCoordinate(parameter, x1, x2) - x;
    const derivative = cubicDerivative(parameter, x1, x2);
    if (Math.abs(error) < 1e-7 || Math.abs(derivative) < 1e-7) break;
    parameter = Math.max(0, Math.min(1, parameter - error / derivative));
  }
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const coordinate = cubicCoordinate(parameter, x1, x2);
    if (Math.abs(coordinate - x) < 1e-7) break;
    if (coordinate < x) lower = parameter;
    else upper = parameter;
    parameter = (lower + upper) / 2;
  }
  return cubicCoordinate(parameter, y1, y2);
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function interpolateRect(from: NormalizedRect, to: NormalizedRect, progress: number): NormalizedRect {
  return {
    x: lerp(from.x, to.x, progress),
    y: lerp(from.y, to.y, progress),
    w: lerp(from.w, to.w, progress),
    h: lerp(from.h, to.h, progress),
  };
}

function scaled(rect: NormalizedRect, scale: number): NormalizedRect {
  const w = rect.w * scale;
  const h = rect.h * scale;
  return {
    x: rect.x + (rect.w - w) / 2,
    y: rect.y + (rect.h - h) / 2,
    w,
    h,
  };
}

function offscreen(
  rect: NormalizedRect,
  direction: "left" | "right" | "up" | "down",
): NormalizedRect {
  switch (direction) {
    case "left": return { ...rect, x: -rect.w };
    case "right": return { ...rect, x: 1 };
    case "up": return { ...rect, y: -rect.h };
    case "down": return { ...rect, y: 1 };
  }
}

function transitionEndpoints(
  presetValue: MotionPreset,
  from: MotionState,
  to: MotionState,
  params: MotionPreset["params"] | undefined,
): { from: MotionState; to: MotionState } {
  const direction = params?.direction ?? presetValue.params?.direction ?? "right";
  switch (presetValue.name) {
    case "fade_in": return { from: { ...from, opacity: 0 }, to };
    case "fade_out": return { from, to: { ...to, opacity: 0 } };
    case "pop_in": return { from: { rect: scaled(to.rect, 0.72), opacity: 0 }, to };
    case "pop_out": return { from, to: { rect: scaled(from.rect, 0.72), opacity: 0 } };
    case "scale_in": return { from: { rect: scaled(to.rect, 0.05), opacity: to.opacity }, to };
    case "scale_out": return { from, to: { rect: scaled(from.rect, 0.05), opacity: from.opacity } };
    case "slide_in": return { from: { rect: offscreen(to.rect, direction), opacity: to.opacity }, to };
    case "slide_out": return { from, to: { rect: offscreen(from.rect, direction), opacity: from.opacity } };
    default: return { from, to };
  }
}

export interface CompileMotionTransitionOptions {
  preset: MotionPreset;
  from: MotionState;
  to: MotionState;
  startFrame: number;
  endFrame: number;
  params?: MotionPreset["params"];
  sampleEveryFrames?: number;
}

export function compileMotionTransition(
  options: CompileMotionTransitionOptions,
): DerivedPipSample[] {
  const {
    preset: presetValue,
    startFrame,
    endFrame,
    params,
  } = options;
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || endFrame <= startFrame) {
    throw makeGuyditorError("E_PIP_KEYFRAME_RANGE", "PiP transition frames must increase.");
  }
  const endpoints = transitionEndpoints(presetValue, options.from, options.to, params);
  const interval = Math.max(1, Math.floor(options.sampleEveryFrames ?? 3));
  const frames: number[] = [];
  for (let frame = startFrame; frame < endFrame; frame += interval) frames.push(frame);
  frames.push(endFrame);
  return frames.map((frame) => {
    const linear = (frame - startFrame) / (endFrame - startFrame);
    const progress = cubicBezierProgress(linear, presetValue.easing);
    let rect = interpolateRect(endpoints.from.rect, endpoints.to.rect, progress);
    if (presetValue.name === "pop_in" || presetValue.name === "pop_out") {
      const amount = params?.overshoot ?? presetValue.params?.overshoot ?? 0;
      const pulse = Math.sin(Math.PI * progress) * amount;
      rect = scaled(rect, 1 + pulse);
    }
    return {
      atOutputFrame: frame,
      rect,
      opacity: lerp(endpoints.from.opacity, endpoints.to.opacity, progress),
      source: "transition" as const,
      presetId: presetValue.id,
    };
  });
}

export interface CompilePipTimelineOptions {
  pip: PipConfig;
  compWidth: number;
  compHeight: number;
  sourceAspect?: number;
  anchorFrames: Readonly<Record<string, number>>;
  sampleEveryFrames?: number;
}

export function compilePipTimeline(options: CompilePipTimelineOptions): CompiledPipTimeline {
  const sourceAspect = options.sourceAspect ?? options.compWidth / options.compHeight;
  let state: MotionState = {
    rect: solvePlacement(
      options.pip.placement.base,
      options.compWidth,
      options.compHeight,
      sourceAspect,
    ),
    opacity: 1,
  };
  let style: PipStyle | Partial<PipStyle> = options.pip.style;
  const samples: DerivedPipSample[] = [{
    atOutputFrame: 0,
    ...state,
    source: "base",
    style,
  }];
  const resolved = options.pip.keyframes.map((keyframe) => {
    const frame = options.anchorFrames[keyframe.at];
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw makeGuyditorError(
        "E_PIP_ANCHOR_UNRESOLVED",
        `PiP keyframe ${keyframe.id} anchor ${keyframe.at} did not resolve.`,
        { affected: [keyframe.id, keyframe.at] },
      );
    }
    return { frame, keyframe };
  }).sort((left, right) => left.frame - right.frame || left.keyframe.id.localeCompare(right.keyframe.id));

  for (const { frame, keyframe } of resolved) {
    const target: MotionState = {
      rect: solvePlacement(
        keyframe.placement,
        options.compWidth,
        options.compHeight,
        sourceAspect,
      ),
      opacity: state.opacity,
    };
    const nextStyle = keyframe.style === undefined ? style : { ...style, ...keyframe.style };
    if (keyframe.transition === undefined) {
      samples.push({
        atOutputFrame: frame,
        ...target,
        source: keyframe.id,
        style: nextStyle,
      });
    } else {
      const presetValue = motionPreset(keyframe.transition.preset);
      const startFrame = Math.max(0, frame - keyframe.transition.durationFrames);
      const transition = compileMotionTransition({
        preset: presetValue,
        from: state,
        to: target,
        startFrame,
        endFrame: frame,
        ...(keyframe.transition.params === undefined ? {} : { params: keyframe.transition.params }),
        ...(options.sampleEveryFrames === undefined
          ? {}
          : { sampleEveryFrames: options.sampleEveryFrames }),
      });
      for (const sample of transition) {
        samples.push({
          ...sample,
          source: sample.atOutputFrame === frame ? keyframe.id : "transition",
          style: sample.atOutputFrame === frame ? nextStyle : style,
        });
      }
    }
    state = target;
    style = nextStyle;
  }
  const byFrame = new Map<number, DerivedPipSample>();
  for (const sample of samples) byFrame.set(sample.atOutputFrame, sample);
  return { samples: [...byFrame.values()].sort((left, right) => left.atOutputFrame - right.atOutputFrame) };
}

export function evaluatePipAtFrame(timeline: CompiledPipTimeline, frame: number): DerivedPipSample {
  const samples = timeline.samples;
  const before = samples.filter(({ atOutputFrame }) => atOutputFrame <= frame).at(-1) ?? samples[0];
  const after = samples.find(({ atOutputFrame }) => atOutputFrame >= frame) ?? samples.at(-1);
  if (before === undefined || after === undefined) {
    throw makeGuyditorError("E_PIP_TIMELINE_EMPTY", "A compiled PiP timeline has no samples.");
  }
  if (before.atOutputFrame === after.atOutputFrame) return structuredClone(before);
  const progress = (frame - before.atOutputFrame) / (after.atOutputFrame - before.atOutputFrame);
  return {
    atOutputFrame: frame,
    rect: interpolateRect(before.rect, after.rect, progress),
    opacity: lerp(before.opacity, after.opacity, progress),
    source: "transition",
    ...(after.presetId === undefined ? {} : { presetId: after.presetId }),
    ...(before.style === undefined ? {} : { style: before.style }),
  };
}

export function compileSwapBackground(options: {
  pipRect: NormalizedRect;
  backgroundRect: NormalizedRect;
  startFrame: number;
  endFrame: number;
  sampleEveryFrames?: number;
}): { pip: DerivedPipSample[]; background: DerivedPipSample[] } {
  const presetValue = motionPreset("swap_background");
  const common = {
    preset: presetValue,
    startFrame: options.startFrame,
    endFrame: options.endFrame,
    ...(options.sampleEveryFrames === undefined
      ? {}
      : { sampleEveryFrames: options.sampleEveryFrames }),
  };
  return {
    pip: compileMotionTransition({
      ...common,
      from: { rect: options.pipRect, opacity: 1 },
      to: { rect: options.backgroundRect, opacity: 1 },
    }),
    background: compileMotionTransition({
      ...common,
      from: { rect: options.backgroundRect, opacity: 1 },
      to: { rect: options.pipRect, opacity: 1 },
    }),
  };
}
