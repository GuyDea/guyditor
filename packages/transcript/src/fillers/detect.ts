import { fillerLexicon } from "../../../core/src/index.js";

import type {
  TranscriptSegment,
  TranscriptWord,
} from "../types.js";
import type {
  DetectFillerCandidatesInput,
  FillerCandidate,
  FillerDetectionResult,
  FillerReviewWindow,
  ProtectedSourceRange,
  SourceSampleRange,
  VadActivity,
} from "./types.js";

export const DEFAULT_FILLER_RULE_SET = Object.freeze({
  version: 1,
  pauses: {
    minRemovableMs: 700,
    keepAtSentenceBoundaryMs: 1_200,
    retainMs: 200,
  },
  fillers: {
    remove: ["um", "uh", "erm"],
    review: ["like", "you know", "so"],
    keep: [],
  },
  repeats: { enabled: true, minWords: 3 },
  falseStarts: { enabled: true },
  limits: {
    maxDensityPerMinute: 12,
    protectAnnotatedRanges: true,
    protectBeats: ["dramatic-pause"],
  },
  padding: { cutPaddingMs: 120 },
}) satisfies Readonly<DetectFillerCandidatesInput["rules"]>;

interface OrderedWord {
  id: string;
  word: TranscriptWord;
  segment: TranscriptSegment;
  normalized: string;
}

interface CandidateDraft extends Omit<FillerCandidate, "warnings" | "defaultSelected"> {
  selection: "remove-filler" | "pause" | "review";
  protectionRange?: SourceSampleRange;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().normalize("NFKC");
}

function orderedWords(input: DetectFillerCandidatesInput): OrderedWord[] {
  return input.sidecar.segments.flatMap((segment) => segment.words.flatMap((id) => {
    const word = input.sidecar.words[id];
    return word?.state === "active"
      ? [{ id, word, segment, normalized: normalized(word.text) }]
      : [];
  }));
}

function compareTime(
  left: { samples: number; rate: number },
  right: { samples: number; rate: number },
): number {
  const difference = BigInt(left.samples) * BigInt(right.rate) -
    BigInt(right.samples) * BigInt(left.rate);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function durationAtLeast(
  activity: VadActivity,
  milliseconds: number,
): boolean {
  return BigInt(activity.end.samples - activity.start.samples) * 1_000n >=
    BigInt(milliseconds) * BigInt(activity.start.rate);
}

function milliseconds(samples: number, rate: number): string {
  const scaled = BigInt(samples) * 1_000n;
  return scaled % BigInt(rate) === 0n
    ? String(scaled / BigInt(rate))
    : `${String(scaled)}/${String(rate)}`;
}

function candidateId(
  kind: FillerCandidate["kind"],
  range: SourceSampleRange,
  ordinal: number,
): string {
  return [
    "filler",
    kind,
    range.assetId,
    String(range.start.samples),
    String(range.end.samples),
    String(ordinal),
  ].join(":");
}

function sourceRange(
  input: DetectFillerCandidatesInput,
  first: OrderedWord,
  last: OrderedWord,
  paddingMs = 0,
): SourceSampleRange {
  const padding = Number(
    (BigInt(first.word.start.rate) * BigInt(paddingMs) + 500n) / 1_000n,
  );
  return {
    assetId: input.sidecar.assetId,
    start: {
      samples: Math.max(0, first.word.start.samples - padding),
      rate: first.word.start.rate,
    },
    end: {
      samples: last.word.end.samples + padding,
      rate: last.word.end.rate,
    },
  };
}

function overlaps(left: SourceSampleRange, right: ProtectedSourceRange): boolean {
  if (left.assetId !== right.assetId) return false;
  return compareTime(left.start, right.end) < 0 && compareTime(right.start, left.end) < 0;
}

function isProtected(
  range: SourceSampleRange,
  protectedRanges: readonly ProtectedSourceRange[],
): boolean {
  return protectedRanges.some((protectedRange) => overlaps(range, protectedRange));
}

function precedingWord(words: readonly OrderedWord[], start: VadActivity["start"]): OrderedWord | undefined {
  return words.filter(({ word }) => compareTime(word.end, start) <= 0).at(-1);
}

function pauseDrafts(
  input: DetectFillerCandidatesInput,
  words: readonly OrderedWord[],
): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const activity of input.vad) {
    if (activity.kind !== "silence") continue;
    const preceding = precedingWord(words, activity.start);
    const boundary = preceding !== undefined && /[.!?…]/u.test(preceding.word.punctAfter);
    const threshold = boundary
      ? input.rules.pauses.keepAtSentenceBoundaryMs
      : input.rules.pauses.minRemovableMs;
    if (!durationAtLeast(activity, threshold)) continue;
    const retainedSamples = Number(
      (BigInt(activity.start.rate) * BigInt(input.rules.pauses.retainMs) + 500n) / 1_000n,
    );
    const leadingRetained = Math.floor(retainedSamples / 2);
    const trailingRetained = retainedSamples - leadingRetained;
    const range: SourceSampleRange = {
      assetId: input.sidecar.assetId,
      start: {
        samples: activity.start.samples + leadingRetained,
        rate: activity.start.rate,
      },
      end: {
        samples: activity.end.samples - trailingRetained,
        rate: activity.end.rate,
      },
    };
    if (range.start.samples >= range.end.samples) continue;
    drafts.push({
      id: candidateId("pause", range, drafts.length),
      kind: "pause",
      sourceRange: range,
      protectionRange: {
        assetId: input.sidecar.assetId,
        start: { ...activity.start },
        end: { ...activity.end },
      },
      rule: boundary
        ? "pauses.keepAtSentenceBoundaryMs"
        : "pauses.minRemovableMs",
      evidence: `VAD silence ${milliseconds(
        activity.start.samples,
        activity.start.rate,
      )}–${milliseconds(activity.end.samples, activity.end.rate)} ms; retain ${String(
        input.rules.pauses.retainMs,
      )} ms (${boundary ? "sentence boundary" : "sentence internal"}).`,
      selection: "pause",
    });
  }
  return drafts;
}

function phraseMatches(
  input: DetectFillerCandidatesInput,
  words: readonly OrderedWord[],
): CandidateDraft[] {
  const lexicon = fillerLexicon(input.sidecar.language);
  const keep = new Set(input.rules.fillers.keep.map(normalized));
  const classes = [
    ...input.rules.fillers.remove.map((phrase) => ({ phrase, selection: "remove-filler" as const })),
    ...input.rules.fillers.review.map((phrase) => ({ phrase, selection: "review" as const })),
  ].filter(({ phrase }) => !keep.has(normalized(phrase)))
    .sort((left, right) => right.phrase.split(/\s+/u).length - left.phrase.split(/\s+/u).length);
  const drafts: CandidateDraft[] = [];
  const occupied = new Set<number>();
  for (const entry of classes) {
    const phrase = normalized(entry.phrase);
    const tokens = phrase.split(/\s+/u);
    for (let index = 0; index + tokens.length <= words.length; index += 1) {
      if (tokens.some((token, offset) => words[index + offset]?.normalized !== token)) continue;
      if (tokens.some((_token, offset) => occupied.has(index + offset))) continue;
      const first = words[index]!;
      const last = words[index + tokens.length - 1]!;
      const range = sourceRange(input, first, last, input.rules.padding.cutPaddingMs);
      drafts.push({
        id: candidateId("filler", range, drafts.length),
        kind: "filler",
        wordRange: { fromWord: first.id, toWord: last.id },
        sourceRange: range,
        rule: `fillers.${entry.selection === "remove-filler" ? "remove" : "review"}:${phrase}`,
        evidence: `Matched ${lexicon.language} ${
          lexicon.entries.find(({ phrase: candidate }) => normalized(candidate) === phrase)?.tag ?? "override"
        } phrase “${phrase}”.`,
        selection: entry.selection,
      });
      tokens.forEach((_token, offset) => occupied.add(index + offset));
    }
  }
  return drafts;
}

function withinFifteenSeconds(first: OrderedWord, second: OrderedWord): boolean {
  const delta = BigInt(second.word.start.samples) * BigInt(first.word.start.rate) -
    BigInt(first.word.start.samples) * BigInt(second.word.start.rate);
  return delta >= 0n && delta <=
    15n * BigInt(first.word.start.rate) * BigInt(second.word.start.rate);
}

function repeatDrafts(
  input: DetectFillerCandidatesInput,
  words: readonly OrderedWord[],
): CandidateDraft[] {
  if (!input.rules.repeats.enabled) return [];
  const drafts: CandidateDraft[] = [];
  const seen = new Set<string>();
  const minimum = input.rules.repeats.minWords;
  for (let windowStart = 0; windowStart < words.length; windowStart += 1) {
    const windowEnd = Math.min(words.length, windowStart + 8);
    let matched = false;
    for (let length = Math.floor((windowEnd - windowStart) / 2); length >= minimum && !matched; length -= 1) {
      for (let firstStart = windowStart; firstStart + length * 2 <= windowEnd && !matched; firstStart += 1) {
        for (
          let secondStart = firstStart + length;
          secondStart + length <= windowEnd && !matched;
          secondStart += 1
        ) {
          const firstTokens = words.slice(firstStart, firstStart + length).map(({ normalized }) => normalized);
          const secondTokens = words.slice(secondStart, secondStart + length).map(({ normalized }) => normalized);
          if (firstTokens.some((token, index) => token !== secondTokens[index])) continue;
          const first = words[firstStart]!;
          const second = words[secondStart]!;
          if (!withinFifteenSeconds(first, second)) continue;
          const last = words[firstStart + length - 1]!;
          const key = `${first.id}:${last.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const range = sourceRange(input, first, last, input.rules.padding.cutPaddingMs);
          drafts.push({
            id: candidateId("repeat", range, drafts.length),
            kind: "repeat",
            wordRange: { fromWord: first.id, toWord: last.id },
            sourceRange: range,
            rule: `repeats.verbatim-${String(length)}gram-within-15s`,
            evidence: `“${firstTokens.join(" ")}” repeats at ${second.id} within 15 seconds in an 8-word window.`,
            selection: "review",
          });
          matched = true;
        }
      }
    }
  }
  return drafts;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function cutoffWord(words: readonly OrderedWord[], candidate: OrderedWord): boolean {
  if (candidate.word.confidence === null || candidate.word.confidence >= 0.5) return false;
  const durations = words
    .filter(({ id, normalized: token }) => id !== candidate.id && token === candidate.normalized)
    .map(({ word }) => word.end.samples - word.start.samples);
  const typical = median(durations);
  const duration = candidate.word.end.samples - candidate.word.start.samples;
  return typical !== undefined && duration * 100 < typical * 60;
}

function falseStartDrafts(
  input: DetectFillerCandidatesInput,
  words: readonly OrderedWord[],
): CandidateDraft[] {
  if (!input.rules.falseStarts.enabled) return [];
  const drafts: CandidateDraft[] = [];
  for (let index = 0; index + 1 < input.sidecar.segments.length; index += 1) {
    const current = input.sidecar.segments[index]!;
    const next = input.sidecar.segments[index + 1]!;
    const currentWords = current.words.flatMap((id) => words.find((entry) => entry.id === id) ?? []);
    const nextWords = next.words.flatMap((id) => words.find((entry) => entry.id === id) ?? []);
    const maximum = Math.min(currentWords.length, nextWords.length);
    let match = 0;
    for (let length = maximum; length >= 2; length -= 1) {
      const trailing = currentWords.slice(-length);
      const leading = nextWords.slice(0, length);
      if (trailing.every(({ normalized: token }, offset) => token === leading[offset]?.normalized)) {
        match = length;
        break;
      }
    }
    if (match < 2) continue;
    const first = currentWords[currentWords.length - match]!;
    const last = currentWords.at(-1)!;
    const nextFirst = nextWords[0];
    if (nextFirst === undefined) continue;
    const pauseSamples = BigInt(nextFirst.word.start.samples) * BigInt(last.word.end.rate) -
      BigInt(last.word.end.samples) * BigInt(nextFirst.word.start.rate);
    const hasPause = pauseSamples * 1_000n >=
      250n * BigInt(last.word.end.rate) * BigInt(nextFirst.word.start.rate);
    const cutoff = cutoffWord(words, last);
    if (!hasPause && !cutoff) continue;
    const range = sourceRange(input, first, last, input.rules.padding.cutPaddingMs);
    drafts.push({
      id: candidateId("false-start", range, drafts.length),
      kind: "false-start",
      wordRange: { fromWord: first.id, toWord: last.id },
      sourceRange: range,
      rule: "falseStarts.trailing-leading-match",
      evidence: `${String(match)} trailing tokens match the next segment; ${
        hasPause ? "intervening pause is at least 250 ms" : "last word is a low-confidence short cutoff"
      }.`,
      selection: "review",
    });
  }
  return drafts;
}

function densityWindows(
  candidates: FillerCandidate[],
  maximum: number,
): FillerReviewWindow[] {
  const windows: FillerReviewWindow[] = [];
  const marked = new Set<string>();
  for (const candidate of candidates) {
    const start = candidate.sourceRange.start;
    const inWindow = candidates.filter((other) =>
      other.sourceRange.assetId === candidate.sourceRange.assetId &&
      compareTime(other.sourceRange.start, start) >= 0 &&
      BigInt(other.sourceRange.start.samples) * BigInt(start.rate) -
        BigInt(start.samples) * BigInt(other.sourceRange.start.rate) <=
        60n * BigInt(start.rate) * BigInt(other.sourceRange.start.rate));
    if (inWindow.length <= maximum || inWindow.every(({ id }) => marked.has(id))) continue;
    const end = inWindow.reduce((latest, entry) =>
      compareTime(entry.sourceRange.end, latest) > 0 ? entry.sourceRange.end : latest,
    start);
    inWindow.forEach((entry) => {
      marked.add(entry.id);
      entry.defaultSelected = false;
      entry.reviewRequired = true;
    });
    windows.push({
      assetId: candidate.sourceRange.assetId,
      start: { ...start },
      end: { ...end },
      reviewRequired: true,
      candidateIds: inWindow.map(({ id }) => id),
    });
  }
  return windows;
}

export async function detectFillerCandidates(
  input: DetectFillerCandidatesInput,
): Promise<FillerDetectionResult> {
  const words = orderedWords(input);
  const protectedRanges = input.protectedRanges ?? [];
  const drafts = [
    ...pauseDrafts(input, words),
    ...phraseMatches(input, words),
    ...repeatDrafts(input, words),
    ...falseStartDrafts(input, words),
  ].filter(({ protectionRange, sourceRange }) =>
    !isProtected(protectionRange ?? sourceRange, protectedRanges));
  const candidates: FillerCandidate[] = [];
  for (const draft of drafts) {
    const warnings = await input.continuityWarnings?.(draft.sourceRange) ?? [];
    const { selection, ...candidate } = draft;
    delete candidate.protectionRange;
    candidates.push({
      ...candidate,
      warnings,
      defaultSelected: selection === "remove-filler" ||
        (selection === "pause" && warnings.length === 0),
    });
  }
  return {
    candidates,
    reviewWindows: densityWindows(candidates, input.rules.limits.maxDensityPerMinute),
  };
}
