import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import { parseRationalParts } from "./rational.js";
import type { RationalParts } from "./rational.js";
import type { FrameTime, Rational, SampleTime, TimeValue } from "./types.js";

function formatError(message: string): ReturnType<typeof failure> {
  return failure(makeGuyditorError("E_TIME_FORMAT", message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export interface ValidatedFrameRate {
  fps: Rational;
  parts: RationalParts;
}

export function validateFrameRate(value: unknown): Result<ValidatedFrameRate> {
  const parsed = parseRationalParts(value);
  if (!parsed.ok) return parsed;
  if (parsed.value.numerator <= 0n) {
    return formatError("A frame rate must be greater than zero.");
  }
  return success({ fps: value as Rational, parts: parsed.value });
}

export function validateFrameTime(value: unknown): Result<FrameTime> {
  if (!isRecord(value) || !hasExactlyKeys(value, ["frames", "fps"])) {
    return formatError("FrameTime must contain exactly frames and fps.");
  }
  if (!isSafeInteger(value.frames)) {
    return formatError("FrameTime.frames must be a safe integer.");
  }

  const rate = validateFrameRate(value.fps);
  if (!rate.ok) return rate;
  return success({ frames: value.frames, fps: rate.value.fps });
}

export function validateSampleTime(value: unknown): Result<SampleTime> {
  if (!isRecord(value) || !hasExactlyKeys(value, ["samples", "rate"])) {
    return formatError("SampleTime must contain exactly samples and rate.");
  }
  if (!isSafeInteger(value.samples)) {
    return formatError("SampleTime.samples must be a safe integer.");
  }
  if (!isSafeInteger(value.rate) || value.rate <= 0) {
    return formatError("SampleTime.rate must be a positive safe integer.");
  }
  return success({ samples: value.samples, rate: value.rate });
}

export function validateTimeValue(value: unknown): Result<TimeValue> {
  if (!isRecord(value)) {
    return formatError("A time value must be an object.");
  }
  if (Object.hasOwn(value, "frames") || Object.hasOwn(value, "fps")) {
    return validateFrameTime(value);
  }
  if (Object.hasOwn(value, "samples") || Object.hasOwn(value, "rate")) {
    return validateSampleTime(value);
  }
  return formatError("A time value must be FrameTime or SampleTime.");
}
