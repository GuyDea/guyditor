import {
  failure,
  makeGuyditorError,
  success,
} from "../../core/src/index.js";
import type { Result } from "../../core/src/index.js";

import type {
  SampleTime,
  TranscriptSidecar,
  TranscriptWordRange,
} from "./types.js";

export type TranscriptRangeSnapPolicy = "none" | "zero-crossing" | "word-boundary";

export interface WordSourceRange {
  assetId: string;
  wordRange: TranscriptWordRange;
  wordIds: string[];
  start: SampleTime;
  end: SampleTime;
  paddingMs: number;
  snapPolicy: TranscriptRangeSnapPolicy;
}

export interface WordRangeMappingOptions {
  paddingMs?: number;
  snapPolicy?: TranscriptRangeSnapPolicy;
  sourceDuration?: SampleTime;
}

function rangeFailure(message: string, affected: readonly string[]) {
  return failure(makeGuyditorError("E_TRANSCRIPT_WORD_RANGE", message, { affected }));
}

function roundNearestTowardEarlier(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n <= denominator ? quotient : quotient + 1n;
}

function toRate(value: SampleTime, rate: number): Result<SampleTime> {
  const samples = roundNearestTowardEarlier(
    BigInt(value.samples) * BigInt(rate),
    BigInt(value.rate),
  );
  if (samples < 0n || samples > BigInt(Number.MAX_SAFE_INTEGER)) {
    return rangeFailure("The mapped source duration is outside the safe sample range.", []);
  }
  return success({ samples: Number(samples), rate });
}

/**
 * Resolve an inclusive canonical word-ID range to exact native sample time.
 *
 * M1 preserves non-`none` snap policies in operation parameters but deliberately
 * does not refine these exact boundaries yet. Zero-crossing and word-boundary
 * refinement remain the Part 5 §5.7 follow-up carried forward from the M0 stub.
 */
export function mapWordRangeToSourceRange(
  sidecar: TranscriptSidecar,
  wordRange: TranscriptWordRange,
  options: WordRangeMappingOptions = {},
): Result<WordSourceRange> {
  const paddingMs = options.paddingMs ?? 120;
  const snapPolicy = options.snapPolicy ?? "none";
  if (!Number.isSafeInteger(paddingMs) || paddingMs < 0) {
    return rangeFailure("Word-range padding must be a non-negative integer number of milliseconds.", [
      wordRange.fromWord,
      wordRange.toWord,
    ]);
  }
  const orderedIds = sidecar.segments.flatMap(({ words }) => words);
  const fromIndex = orderedIds.indexOf(wordRange.fromWord);
  const toIndex = orderedIds.indexOf(wordRange.toWord);
  const from = sidecar.words[wordRange.fromWord];
  const to = sidecar.words[wordRange.toWord];
  if (
    fromIndex < 0 || toIndex < fromIndex || from === undefined || to === undefined ||
    from.state !== "active" || to.state !== "active"
  ) {
    return rangeFailure(
      `Word range ${wordRange.fromWord}..${wordRange.toWord} must name active endpoints in canonical order.`,
      [wordRange.fromWord, wordRange.toWord],
    );
  }
  if (
    from.start.rate !== sidecar.audio.rate || to.end.rate !== sidecar.audio.rate
  ) {
    return rangeFailure(
      "Canonical word timing rates must match the transcript audio rate.",
      [wordRange.fromWord, wordRange.toWord],
    );
  }
  const paddingSamples = roundNearestTowardEarlier(
    BigInt(sidecar.audio.rate) * BigInt(paddingMs),
    1_000n,
  );
  const paddedStart = BigInt(from.start.samples) - paddingSamples;
  let paddedEnd = BigInt(to.end.samples) + paddingSamples;
  if (options.sourceDuration !== undefined) {
    const duration = toRate(options.sourceDuration, sidecar.audio.rate);
    if (!duration.ok) return duration;
    paddedEnd = paddedEnd > BigInt(duration.value.samples)
      ? BigInt(duration.value.samples)
      : paddedEnd;
  }
  const start = paddedStart < 0n ? 0n : paddedStart;
  if (
    start > BigInt(Number.MAX_SAFE_INTEGER) ||
    paddedEnd > BigInt(Number.MAX_SAFE_INTEGER) ||
    start >= paddedEnd
  ) {
    return rangeFailure("The padded word range does not produce a valid source interval.", [
      wordRange.fromWord,
      wordRange.toWord,
    ]);
  }
  const wordIds = orderedIds.slice(fromIndex, toIndex + 1).filter((wordId) =>
    sidecar.words[wordId]?.state === "active");
  return success({
    assetId: sidecar.assetId,
    wordRange: { ...wordRange },
    wordIds,
    start: { samples: Number(start), rate: sidecar.audio.rate },
    end: { samples: Number(paddedEnd), rate: sidecar.audio.rate },
    paddingMs,
    snapPolicy,
  });
}
