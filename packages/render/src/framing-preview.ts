import type { FramingDecision } from "../../deliver/src/index.js";
import type { FramingOverride, FramingRect } from "../../core/src/index.js";
import type { MlworkerTrackBox } from "../../media/src/index.js";

export interface FramingPreviewSpec {
  decisionId: string;
  mode: "crop" | "recompose";
  sourceFrame: number;
  crop?: FramingRect;
  boxes: MlworkerTrackBox[];
  output: { width: number; height: number };
  safeArea: { top: number; bottom: number; left: number; right: number };
  overridden: boolean;
  warnings: string[];
}

export interface FramingPreviewSpecInput {
  decision: FramingDecision;
  sourceFrame: number;
  override?: FramingOverride;
  boxes: readonly MlworkerTrackBox[];
  output: FramingPreviewSpec["output"];
  safeArea: FramingPreviewSpec["safeArea"];
}

function interpolate(left: FramingRect, right: FramingRect, amount: number): FramingRect {
  const value = (key: keyof FramingRect) =>
    Math.round((left[key] + (right[key] - left[key]) * amount) * 1_000_000_000_000) /
    1_000_000_000_000;
  return { x: value("x"), y: value("y"), w: value("w"), h: value("h") };
}

function cropAtFrame(
  crop: NonNullable<FramingDecision["crop"]> | undefined,
  sourceFrame: number,
): FramingRect | undefined {
  const keyframes = [...(crop?.keyframes ?? [])].sort((left, right) =>
    left.at.frames - right.at.frames);
  if (keyframes.length === 0) return undefined;
  const after = keyframes.find(({ at }) => at.frames >= sourceFrame) ?? keyframes.at(-1)!;
  const before = keyframes.filter(({ at }) => at.frames <= sourceFrame).at(-1) ?? keyframes[0]!;
  if (after.at.frames === before.at.frames) return structuredClone(before.rect);
  return interpolate(
    before.rect,
    after.rect,
    (sourceFrame - before.at.frames) / (after.at.frames - before.at.frames),
  );
}

export function framingPreviewSpec(input: FramingPreviewSpecInput): FramingPreviewSpec {
  const mode = input.override?.crop !== undefined
    ? "crop"
    : input.override?.layout !== undefined ? "recompose" : input.decision.mode;
  const crop = mode === "crop"
    ? cropAtFrame(input.override?.crop ?? input.decision.crop, input.sourceFrame)
    : undefined;
  return {
    decisionId: input.decision.decisionId,
    mode,
    sourceFrame: input.sourceFrame,
    ...(crop === undefined ? {} : { crop }),
    boxes: input.boxes.map((box) => ({ ...box })),
    output: structuredClone(input.output),
    safeArea: structuredClone(input.safeArea),
    overridden: input.override !== undefined,
    warnings: [...input.decision.warnings],
  };
}
