import {
  absoluteSeconds,
  addRational,
  compareRational,
  divideRational,
  parseRational,
  subRational,
} from "../time/index.js";
import { parseRationalParts } from "../time/rational.js";
import type { FrameTime, Rational, TimeValue } from "../time/index.js";
import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type { Clip, Effect, GuyditorProject } from "./model.js";

const ZERO = "0/1";
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export interface DerivedTimelineClip {
  clipId: string;
  start: FrameTime;
  duration: FrameTime;
}

export interface TimelineDerivation {
  clips: DerivedTimelineClip[];
  /** Exact sequence duration in rational seconds. */
  duration: Rational;
}

function boundaryFailure(message: string, affected: readonly string[]) {
  return failure(
    makeGuyditorError("E_TIMELINE_BOUNDARY", message, { affected }),
  );
}

function effectFailure(effect: Effect, message: string) {
  return failure(
    makeGuyditorError("E_TIMELINE_EFFECT", message, {
      affected: [effect.id],
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeValue(value: unknown): TimeValue | undefined {
  if (!isRecord(value)) return undefined;
  if (
    Number.isSafeInteger(value["frames"]) &&
    typeof value["fps"] === "string"
  ) {
    return { frames: value["frames"] as number, fps: value["fps"] };
  }
  if (
    Number.isSafeInteger(value["samples"]) &&
    Number.isSafeInteger(value["rate"])
  ) {
    return { samples: value["samples"] as number, rate: value["rate"] as number };
  }
  return undefined;
}

function clipDuration(clip: Clip): Result<Rational> {
  const sourceIn = absoluteSeconds(clip.source.in);
  if (!sourceIn.ok) return sourceIn;
  const sourceOut = absoluteSeconds(clip.source.out);
  if (!sourceOut.ok) return sourceOut;
  let duration = subRational(sourceOut.value, sourceIn.value);
  if (!duration.ok) return duration;

  for (const effect of clip.effects ?? []) {
    if (effect.kind === "speed") {
      const rate = parseRational(effect.params["rate"]);
      if (!rate.ok) {
        return effectFailure(effect, "A speed effect requires a positive rational rate.");
      }
      const positive = compareRational(rate.value, ZERO);
      if (!positive.ok || positive.value !== 1) {
        return effectFailure(effect, "A speed effect requires a positive rational rate.");
      }
      duration = divideRational(duration.value, rate.value);
      if (!duration.ok) return duration;
    } else if (effect.kind === "freeze") {
      const hold = timeValue(effect.params["hold"]);
      if (hold === undefined) {
        return effectFailure(effect, "A freeze effect requires a hold duration.");
      }
      const holdSeconds = absoluteSeconds(hold);
      if (!holdSeconds.ok) return holdSeconds;
      const nonnegative = compareRational(holdSeconds.value, ZERO);
      if (!nonnegative.ok || nonnegative.value === -1) {
        return effectFailure(effect, "A freeze hold must not be negative.");
      }
      duration = addRational(duration.value, holdSeconds.value);
      if (!duration.ok) return duration;
    }
  }

  return duration;
}

function roundedFrameTime(seconds: Rational, fps: Rational): Result<FrameTime> {
  const time = parseRationalParts(seconds);
  if (!time.ok) return time;
  const rate = parseRationalParts(fps);
  if (!rate.ok) return rate;

  const numerator = time.value.numerator * rate.value.numerator;
  const denominator = time.value.denominator * rate.value.denominator;
  let floor = numerator / denominator;
  let remainder = numerator % denominator;
  if (remainder < 0n) {
    floor -= 1n;
    remainder += denominator;
  }
  const frames = remainder * 2n <= denominator ? floor : floor + 1n;
  if (frames < -MAX_SAFE_INTEGER || frames > MAX_SAFE_INTEGER) {
    return failure(
      makeGuyditorError(
        "E_TIME_OVERFLOW",
        "The derived timeline frame is outside the ±2^53−1 limit.",
      ),
    );
  }
  return success({ frames: Number(frames), fps });
}

function seconds(value: FrameTime): Result<Rational> {
  return absoluteSeconds(value);
}

export function deriveTimeline(
  project: GuyditorProject,
  sequenceId: string,
): Result<TimelineDerivation> {
  const sequence = project.sequences.find((candidate) => candidate.id === sequenceId);
  if (sequence === undefined) {
    return failure(
      makeGuyditorError("E_SEQUENCE_NOT_FOUND", `Sequence ${sequenceId} does not exist.`, {
        affected: [sequenceId],
      }),
    );
  }

  const clips: DerivedTimelineClip[] = [];
  let timeline: Rational = ZERO;

  for (const [index, clip] of sequence.clips.entries()) {
    const previous = sequence.clips[index - 1];
    const incomingTransition = previous?.transitionAfter;
    const hasOverlap = clip.overlapPrevious !== undefined;
    const hasGap = clip.gapBefore !== undefined;

    if (
      (index === 0 && hasOverlap) ||
      (incomingTransition !== undefined && hasOverlap) ||
      (hasGap && (incomingTransition !== undefined || hasOverlap))
    ) {
      return boundaryFailure(
        `Clip ${clip.id} has mutually exclusive boundary state.`,
        previous === undefined ? [clip.id] : [previous.id, clip.id],
      );
    }

    if (clip.gapBefore !== undefined) {
      const gap = seconds(clip.gapBefore);
      if (!gap.ok) return gap;
      const next = addRational(timeline, gap.value);
      if (!next.ok) return next;
      timeline = next.value;
    } else if (incomingTransition !== undefined) {
      const transition = seconds(incomingTransition.duration);
      if (!transition.ok) return transition;
      const next = subRational(timeline, transition.value);
      if (!next.ok) return next;
      timeline = next.value;
    } else if (clip.overlapPrevious !== undefined) {
      const overlap = seconds(clip.overlapPrevious);
      if (!overlap.ok) return overlap;
      const next = subRational(timeline, overlap.value);
      if (!next.ok) return next;
      timeline = next.value;
    }

    const nonnegative = compareRational(timeline, ZERO);
    if (!nonnegative.ok) return nonnegative;
    if (nonnegative.value === -1) {
      return boundaryFailure(
        `The boundary before ${clip.id} produces a negative timeline position.`,
        previous === undefined ? [clip.id] : [previous.id, clip.id],
      );
    }

    const duration = clipDuration(clip);
    if (!duration.ok) return duration;
    const startFrames = roundedFrameTime(timeline, project.settings.timeline.fps);
    if (!startFrames.ok) return startFrames;
    const durationFrames = roundedFrameTime(duration.value, project.settings.timeline.fps);
    if (!durationFrames.ok) return durationFrames;
    clips.push({
      clipId: clip.id,
      start: startFrames.value,
      duration: durationFrames.value,
    });

    const next = addRational(timeline, duration.value);
    if (!next.ok) return next;
    timeline = next.value;
  }

  return success({ clips, duration: timeline });
}
