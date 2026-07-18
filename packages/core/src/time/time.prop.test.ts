import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  addTime,
  compareTime,
  convertTime,
  parseTime,
  serializeTime,
  subTime,
} from "../index.js";
import type {
  FrameTime,
  Rational,
  Result,
  SampleTime,
  TimeValue,
} from "../index.js";

const PROPERTY_PARAMETERS = { numRuns: 500, verbose: true } as const;
const FRAME_LIMIT = 2n ** 40n;

const COMMON_RATES: readonly Rational[] = [
  "30000/1001",
  "24000/1001",
  "25/1",
  "30/1",
  "60/1",
  "24/1",
];

function valueOf<T>(result: Result<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function parts(value: Rational): readonly [bigint, bigint] {
  const separator = value.indexOf("/");
  return [
    BigInt(value.slice(0, separator)),
    BigInt(value.slice(separator + 1)),
  ];
}

const randomSmallRateArbitrary = fc
  .tuple(
    fc.integer({ min: 1, max: 120_000 }),
    fc.integer({ min: 1, max: 2_000 }),
  )
  .map(([numerator, denominator]) => {
    const bigNumerator = BigInt(numerator);
    const bigDenominator = BigInt(denominator);
    const divisor = gcd(bigNumerator, bigDenominator);
    return `${(bigNumerator / divisor).toString()}/${(
      bigDenominator / divisor
    ).toString()}`;
  });

const rateArbitrary = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...COMMON_RATES) },
  { weight: 3, arbitrary: randomSmallRateArbitrary },
);

const signedFramesArbitrary = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  {
    weight: 9,
    arbitrary: fc
      .bigInt({ min: -FRAME_LIMIT, max: FRAME_LIMIT })
      .map((value) => Number(value)),
  },
);

const durationFramesArbitrary = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  {
    weight: 9,
    arbitrary: fc
      .bigInt({ min: 0n, max: FRAME_LIMIT })
      .map((value) => Number(value)),
  },
);

const frameTimeArbitrary: fc.Arbitrary<FrameTime> = fc.record({
  frames: signedFramesArbitrary,
  fps: rateArbitrary,
});

const sampleTimeArbitrary: fc.Arbitrary<SampleTime> = fc.record({
  samples: signedFramesArbitrary,
  rate: fc.oneof(
    fc.constantFrom(44_100, 48_000, 96_000, 192_000),
    fc.integer({ min: 1, max: 384_000 }),
  ),
});

const timeValueArbitrary: fc.Arbitrary<TimeValue> = fc.oneof(
  frameTimeArbitrary,
  sampleTimeArbitrary,
);

describe("rational-time properties", () => {
  it("P-T1: add is associative and commutative, and subtraction is its inverse", () => {
    fc.assert(
      fc.property(
        rateArbitrary,
        durationFramesArbitrary,
        durationFramesArbitrary,
        durationFramesArbitrary,
        (fps, firstFrames, secondFrames, thirdFrames) => {
          const first = { frames: firstFrames, fps };
          const second = { frames: secondFrames, fps };
          const third = { frames: thirdFrames, fps };

          const firstPlusSecond = valueOf(addTime(first, second));
          const secondPlusThird = valueOf(addTime(second, third));
          const leftAssociated = valueOf(addTime(firstPlusSecond, third));
          const rightAssociated = valueOf(addTime(first, secondPlusThird));

          expect(leftAssociated).toEqual(rightAssociated);
          expect(firstPlusSecond).toEqual(valueOf(addTime(second, first)));
          expect(valueOf(subTime(firstPlusSecond, second))).toEqual(first);
        },
      ),
      PROPERTY_PARAMETERS,
    );
  });

  it("P-T2: parse and serialize round-trip with one canonical byte form", () => {
    fc.assert(
      fc.property(timeValueArbitrary, (time) => {
        const serialized = valueOf(serializeTime(time));
        const expected =
          "frames" in time
            ? `{"frames":${String(time.frames)},"fps":"${time.fps}"}`
            : `{"samples":${String(time.samples)},"rate":${String(time.rate)}}`;

        expect(serialized).toBe(expected);
        expect(valueOf(serializeTime(time))).toBe(serialized);
        expect(valueOf(parseTime(serialized))).toEqual(time);
      }),
      PROPERTY_PARAMETERS,
    );
  });

  it("P-T3: cross-rate comparison agrees with an independent BigInt oracle", () => {
    fc.assert(
      fc.property(frameTimeArbitrary, frameTimeArbitrary, (left, right) => {
        const [leftNumerator, leftDenominator] = parts(left.fps);
        const [rightNumerator, rightDenominator] = parts(right.fps);
        const oracleLeft =
          BigInt(left.frames) * leftDenominator * rightNumerator;
        const oracleRight =
          BigInt(right.frames) * rightDenominator * leftNumerator;
        const expected =
          oracleLeft < oracleRight ? -1 : oracleLeft > oracleRight ? 1 : 0;

        expect(valueOf(compareTime(left, right))).toBe(expected);
      }),
      PROPERTY_PARAMETERS,
    );
  });

  it("P-T4: commensurate conversions round-trip losslessly", () => {
    fc.assert(
      fc.property(
        rateArbitrary,
        rateArbitrary,
        fc.integer({ min: 0, max: 1_000 }),
        (sourceFps, targetFps, multiplier) => {
          const [sourceNumerator] = parts(sourceFps);
          const [, targetDenominator] = parts(targetFps);
          const frames = Number(
            BigInt(multiplier) * sourceNumerator * targetDenominator,
          );
          const source = { frames, fps: sourceFps };

          const converted = valueOf(convertTime(source, targetFps));
          expect(valueOf(convertTime(converted, sourceFps))).toEqual(source);
        },
      ),
      PROPERTY_PARAMETERS,
    );
  });

  it("P-T4: incommensurate conversions return the required envelope", () => {
    const incommensurateCaseArbitrary = fc
      .tuple(rateArbitrary, rateArbitrary)
      .filter(([sourceFps, targetFps]) => {
        const [sourceNumerator, sourceDenominator] = parts(sourceFps);
        const [targetNumerator, targetDenominator] = parts(targetFps);
        const ratioNumerator = sourceDenominator * targetNumerator;
        const ratioDenominator = sourceNumerator * targetDenominator;
        return ratioDenominator / gcd(ratioNumerator, ratioDenominator) > 1n;
      })
      .chain(([sourceFps, targetFps]) => {
        const [sourceNumerator, sourceDenominator] = parts(sourceFps);
        const [targetNumerator, targetDenominator] = parts(targetFps);
        const ratioNumerator = sourceDenominator * targetNumerator;
        const ratioDenominator = sourceNumerator * targetDenominator;
        const exactFrameMultiple =
          ratioDenominator / gcd(ratioNumerator, ratioDenominator);
        const maximumMultiplier = (FRAME_LIMIT - 1n) / exactFrameMultiple;

        return fc
          .bigInt({
            min: 0n,
            max: maximumMultiplier < 1_000n ? maximumMultiplier : 1_000n,
          })
          .map((multiplier) => ({
            source: {
              frames: Number(multiplier * exactFrameMultiple + 1n),
              fps: sourceFps,
            },
            targetFps,
          }));
      });

    fc.assert(
      fc.property(incommensurateCaseArbitrary, ({ source, targetFps }) => {
        const result = convertTime(source, targetFps);

        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "E_TIME_INCOMMENSURATE",
            acceptedStateChanged: false,
            affected: [],
            retry: "none",
          },
        });
      }),
      PROPERTY_PARAMETERS,
    );
  });
});
