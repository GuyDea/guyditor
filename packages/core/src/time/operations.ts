import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import {
  makeRationalFromBigInts,
  parseRationalParts,
} from "./rational.js";
import type {
  FrameTime,
  Ordering,
  Rational,
  RoundedFrameTime,
  TimeValue,
} from "./types.js";
import {
  validateFrameRate,
  validateFrameTime,
  validateTimeValue,
} from "./validation.js";

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function overflowError(message: string): ReturnType<typeof failure> {
  return failure(makeGuyditorError("E_TIME_OVERFLOW", message));
}

function frameTimeFromBigInt(
  frames: bigint,
  fps: Rational,
): Result<FrameTime> {
  if (frames < -MAX_SAFE_INTEGER || frames > MAX_SAFE_INTEGER) {
    return overflowError("The frame count is outside the ±2^53−1 limit.");
  }
  return success({ frames: Number(frames), fps });
}

function validatedPair(
  left: FrameTime,
  right: FrameTime,
): Result<readonly [FrameTime, FrameTime]> {
  const validatedLeft = validateFrameTime(left);
  if (!validatedLeft.ok) return validatedLeft;
  const validatedRight = validateFrameTime(right);
  if (!validatedRight.ok) return validatedRight;
  return success([validatedLeft.value, validatedRight.value] as const);
}

function sameRatePair(
  left: FrameTime,
  right: FrameTime,
): Result<readonly [FrameTime, FrameTime]> {
  const pair = validatedPair(left, right);
  if (!pair.ok) return pair;
  if (pair.value[0].fps !== pair.value[1].fps) {
    return failure(
      makeGuyditorError(
        "E_TIME_RATE_MISMATCH",
        "FrameTime addition and subtraction require identical frame rates.",
        { suggestion: "Convert one value explicitly before arithmetic." },
      ),
    );
  }
  return pair;
}

export function addTime(
  left: FrameTime,
  right: FrameTime,
): Result<FrameTime> {
  const pair = sameRatePair(left, right);
  if (!pair.ok) return pair;
  const [a, b] = pair.value;
  return frameTimeFromBigInt(BigInt(a.frames) + BigInt(b.frames), a.fps);
}

export function subTime(
  left: FrameTime,
  right: FrameTime,
): Result<FrameTime> {
  const pair = sameRatePair(left, right);
  if (!pair.ok) return pair;
  const [a, b] = pair.value;
  const difference = BigInt(a.frames) - BigInt(b.frames);
  if (difference < 0n) {
    return failure(
      makeGuyditorError(
        "E_TIME_NEGATIVE",
        "Subtracting these frame durations would produce a negative duration.",
      ),
    );
  }
  return frameTimeFromBigInt(difference, a.fps);
}

export function compareTime(
  left: FrameTime,
  right: FrameTime,
): Result<Ordering> {
  const pair = validatedPair(left, right);
  if (!pair.ok) return pair;
  const [a, b] = pair.value;
  const aRate = parseRationalParts(a.fps);
  if (!aRate.ok) return aRate;
  const bRate = parseRationalParts(b.fps);
  if (!bRate.ok) return bRate;

  const leftProduct =
    BigInt(a.frames) * aRate.value.denominator * bRate.value.numerator;
  const rightProduct =
    BigInt(b.frames) * bRate.value.denominator * aRate.value.numerator;

  return success(
    leftProduct < rightProduct ? -1 : leftProduct > rightProduct ? 1 : 0,
  );
}

export function absoluteSeconds(time: TimeValue): Result<Rational> {
  const validated = validateTimeValue(time);
  if (!validated.ok) return validated;

  if ("frames" in validated.value) {
    const rate = parseRationalParts(validated.value.fps);
    if (!rate.ok) return rate;
    return makeRationalFromBigInts(
      BigInt(validated.value.frames) * rate.value.denominator,
      rate.value.numerator,
    );
  }

  return makeRationalFromBigInts(
    BigInt(validated.value.samples),
    BigInt(validated.value.rate),
  );
}

interface TargetFrameParts {
  targetFps: Rational;
  numerator: bigint;
  denominator: bigint;
}

function targetFrameParts(
  time: FrameTime,
  targetFps: Rational,
): Result<TargetFrameParts> {
  const source = validateFrameTime(time);
  if (!source.ok) return source;
  const target = validateFrameRate(targetFps);
  if (!target.ok) return target;
  const sourceRate = parseRationalParts(source.value.fps);
  if (!sourceRate.ok) return sourceRate;

  return success({
    targetFps: target.value.fps,
    numerator:
      BigInt(source.value.frames) *
      sourceRate.value.denominator *
      target.value.parts.numerator,
    denominator:
      sourceRate.value.numerator * target.value.parts.denominator,
  });
}

export function convertTime(
  time: FrameTime,
  targetFps: Rational,
): Result<FrameTime> {
  const conversion = targetFrameParts(time, targetFps);
  if (!conversion.ok) return conversion;
  if (conversion.value.numerator % conversion.value.denominator !== 0n) {
    return failure(
      makeGuyditorError(
        "E_TIME_INCOMMENSURATE",
        "This time is not an integer frame at the target rate.",
        { suggestion: "Use convertTimeRounding for an explicit lossy conversion." },
      ),
    );
  }
  return frameTimeFromBigInt(
    conversion.value.numerator / conversion.value.denominator,
    conversion.value.targetFps,
  );
}

function roundNearestTowardEarlier(
  numerator: bigint,
  denominator: bigint,
): bigint {
  let floor = numerator / denominator;
  let remainder = numerator % denominator;
  if (remainder < 0n) {
    floor -= 1n;
    remainder += denominator;
  }

  return remainder * 2n <= denominator ? floor : floor + 1n;
}

export function convertTimeRounding(
  time: FrameTime,
  targetFps: Rational,
): Result<RoundedFrameTime> {
  const conversion = targetFrameParts(time, targetFps);
  if (!conversion.ok) return conversion;
  const preRoundingFrames = makeRationalFromBigInts(
    conversion.value.numerator,
    conversion.value.denominator,
  );
  if (!preRoundingFrames.ok) return preRoundingFrames;
  const parts = parseRationalParts(preRoundingFrames.value);
  if (!parts.ok) return parts;
  const roundedFrames = roundNearestTowardEarlier(
    parts.value.numerator,
    parts.value.denominator,
  );
  const rounded = frameTimeFromBigInt(
    roundedFrames,
    conversion.value.targetFps,
  );
  if (!rounded.ok) return rounded;

  return success({
    time: rounded.value,
    preRoundingFrames: preRoundingFrames.value,
  });
}
