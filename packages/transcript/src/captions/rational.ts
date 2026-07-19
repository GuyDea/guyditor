import type { RationalSec } from "./types.js";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = absolute(left);
  let b = absolute(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function safe(value: bigint): number {
  if (absolute(value) > MAX_SAFE) throw new RangeError("Caption rational exceeds safe integer bounds.");
  return Number(value);
}

export function rational(num: number | bigint, den: number | bigint): RationalSec {
  let numerator = BigInt(num);
  let denominator = BigInt(den);
  if (denominator === 0n) throw new RangeError("Caption rational denominator must not be zero.");
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const divisor = gcd(numerator, denominator);
  return { num: safe(numerator / divisor), den: safe(denominator / divisor) };
}

export function add(left: RationalSec, right: RationalSec): RationalSec {
  return rational(
    BigInt(left.num) * BigInt(right.den) + BigInt(right.num) * BigInt(left.den),
    BigInt(left.den) * BigInt(right.den),
  );
}

export function subtract(left: RationalSec, right: RationalSec): RationalSec {
  return rational(
    BigInt(left.num) * BigInt(right.den) - BigInt(right.num) * BigInt(left.den),
    BigInt(left.den) * BigInt(right.den),
  );
}

export function multiply(left: RationalSec, right: RationalSec): RationalSec {
  return rational(BigInt(left.num) * BigInt(right.num), BigInt(left.den) * BigInt(right.den));
}

export function divide(left: RationalSec, right: RationalSec): RationalSec {
  if (right.num === 0) throw new RangeError("Caption rational division by zero.");
  return rational(BigInt(left.num) * BigInt(right.den), BigInt(left.den) * BigInt(right.num));
}

export function compare(left: RationalSec, right: RationalSec): -1 | 0 | 1 {
  const difference = BigInt(left.num) * BigInt(right.den) - BigInt(right.num) * BigInt(left.den);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function minimum(left: RationalSec, right: RationalSec): RationalSec {
  return compare(left, right) <= 0 ? left : right;
}

export function maximum(left: RationalSec, right: RationalSec): RationalSec {
  return compare(left, right) >= 0 ? left : right;
}

export function milliseconds(value: number): RationalSec {
  if (!Number.isSafeInteger(value)) throw new RangeError("Caption millisecond values must be safe integers.");
  return rational(value, 1_000);
}

export function parseString(value: string): RationalSec {
  const match = /^(-?\d+)\/(\d+)$/u.exec(value);
  if (match === null || match[2] === "0") throw new TypeError(`Invalid rational ${value}.`);
  return rational(BigInt(match[1]!), BigInt(match[2]!));
}

export function floorFrames(time: RationalSec, fps: string): number {
  const rate = parseString(fps);
  const numerator = BigInt(time.num) * BigInt(rate.num);
  const denominator = BigInt(time.den) * BigInt(rate.den);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder < 0n) quotient -= 1n;
  return safe(quotient);
}

export function ceilFrames(time: RationalSec, fps: string): number {
  const rate = parseString(fps);
  const numerator = BigInt(time.num) * BigInt(rate.num);
  const denominator = BigInt(time.den) * BigInt(rate.den);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder > 0n) quotient += 1n;
  return safe(quotient);
}

export function halfEvenMilliseconds(time: RationalSec): number {
  const numerator = BigInt(time.num) * 1_000n;
  const denominator = BigInt(time.den);
  let quotient = numerator / denominator;
  let remainder = numerator % denominator;
  if (remainder < 0n) {
    quotient -= 1n;
    remainder += denominator;
  }
  const doubled = remainder * 2n;
  if (doubled > denominator || (doubled === denominator && quotient % 2n !== 0n)) quotient += 1n;
  return safe(quotient);
}

export function toNumber(value: RationalSec): number {
  return value.num / value.den;
}
