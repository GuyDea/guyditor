import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type { Ordering, Rational } from "./types.js";

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const RATIONAL_PATTERN = /^-?(?:0|[1-9]\d*)\/(?:[1-9]\d*)$/;

export interface RationalParts {
  numerator: bigint;
  denominator: bigint;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = absolute(left);
  let b = absolute(right);

  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a;
}

function formatError(message: string): ReturnType<typeof failure> {
  return failure(makeGuyditorError("E_TIME_FORMAT", message));
}

function overflowError(message: string): ReturnType<typeof failure> {
  return failure(makeGuyditorError("E_TIME_OVERFLOW", message));
}

function toBigInt(value: number | bigint, name: string): Result<bigint> {
  if (typeof value === "bigint") {
    if (absolute(value) > MAX_SAFE_INTEGER) {
      return formatError(`${name} must be within ±2^53−1.`);
    }
    return success(value);
  }

  if (!Number.isSafeInteger(value)) {
    return formatError(`${name} must be a safe integer.`);
  }

  return success(BigInt(value));
}

function normalizeParts(
  numerator: bigint,
  denominator: bigint,
): RationalParts {
  const sign = denominator < 0n ? -1n : 1n;
  const signedNumerator = numerator * sign;
  const positiveDenominator = denominator * sign;
  const divisor = gcd(signedNumerator, positiveDenominator);

  return {
    numerator: signedNumerator / divisor,
    denominator: positiveDenominator / divisor,
  };
}

export function makeRationalFromBigInts(
  numerator: bigint,
  denominator: bigint,
): Result<Rational> {
  if (denominator === 0n) {
    return formatError("A rational denominator must not be zero.");
  }

  const normalized = normalizeParts(numerator, denominator);
  if (
    absolute(normalized.numerator) > MAX_SAFE_INTEGER ||
    normalized.denominator > MAX_SAFE_INTEGER
  ) {
    return overflowError(
      "The normalized rational is outside the ±2^53−1 representation limit.",
    );
  }

  return success(
    `${normalized.numerator.toString()}/${normalized.denominator.toString()}`,
  );
}

export function makeRational(
  numerator: number | bigint,
  denominator: number | bigint,
): Result<Rational> {
  const parsedNumerator = toBigInt(numerator, "Rational numerator");
  if (!parsedNumerator.ok) return parsedNumerator;

  const parsedDenominator = toBigInt(denominator, "Rational denominator");
  if (!parsedDenominator.ok) return parsedDenominator;

  return makeRationalFromBigInts(
    parsedNumerator.value,
    parsedDenominator.value,
  );
}

export function parseRationalParts(value: unknown): Result<RationalParts> {
  if (typeof value !== "string" || !RATIONAL_PATTERN.test(value)) {
    return formatError(
      'A rational must use the normalized string form "<num>/<den>".',
    );
  }

  const separator = value.indexOf("/");
  const numerator = BigInt(value.slice(0, separator));
  const denominator = BigInt(value.slice(separator + 1));

  if (
    absolute(numerator) > MAX_SAFE_INTEGER ||
    denominator > MAX_SAFE_INTEGER
  ) {
    return formatError(
      "Rational components must be within the ±2^53−1 representation limit.",
    );
  }

  const normalized = normalizeParts(numerator, denominator);
  const canonical =
    `${normalized.numerator.toString()}/${normalized.denominator.toString()}`;
  if (canonical !== value) {
    return formatError("The rational is valid but not normalized.");
  }

  return success(normalized);
}

export function parseRational(value: unknown): Result<Rational> {
  const parsed = parseRationalParts(value);
  if (!parsed.ok) return parsed;
  return success(value as Rational);
}

function parsePair(
  left: Rational,
  right: Rational,
): Result<readonly [RationalParts, RationalParts]> {
  const parsedLeft = parseRationalParts(left);
  if (!parsedLeft.ok) return parsedLeft;

  const parsedRight = parseRationalParts(right);
  if (!parsedRight.ok) return parsedRight;

  return success([parsedLeft.value, parsedRight.value] as const);
}

export function addRational(
  left: Rational,
  right: Rational,
): Result<Rational> {
  const pair = parsePair(left, right);
  if (!pair.ok) return pair;
  const [a, b] = pair.value;
  return makeRationalFromBigInts(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function subRational(
  left: Rational,
  right: Rational,
): Result<Rational> {
  const pair = parsePair(left, right);
  if (!pair.ok) return pair;
  const [a, b] = pair.value;
  return makeRationalFromBigInts(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function multiplyRational(
  left: Rational,
  right: Rational,
): Result<Rational> {
  const pair = parsePair(left, right);
  if (!pair.ok) return pair;
  const [a, b] = pair.value;
  return makeRationalFromBigInts(
    a.numerator * b.numerator,
    a.denominator * b.denominator,
  );
}

export function divideRational(
  left: Rational,
  right: Rational,
): Result<Rational> {
  const pair = parsePair(left, right);
  if (!pair.ok) return pair;
  const [a, b] = pair.value;
  if (b.numerator === 0n) {
    return failure(
      makeGuyditorError(
        "E_TIME_DIVIDE_BY_ZERO",
        "A rational cannot be divided by zero.",
      ),
    );
  }
  return makeRationalFromBigInts(
    a.numerator * b.denominator,
    a.denominator * b.numerator,
  );
}

export function compareRational(
  left: Rational,
  right: Rational,
): Result<Ordering> {
  const pair = parsePair(left, right);
  if (!pair.ok) return pair;
  const [a, b] = pair.value;
  const leftProduct = a.numerator * b.denominator;
  const rightProduct = b.numerator * a.denominator;

  return success(
    leftProduct < rightProduct ? -1 : leftProduct > rightProduct ? 1 : 0,
  );
}
