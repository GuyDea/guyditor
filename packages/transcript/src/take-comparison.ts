import type { TakeRecord } from "../../core/src/index.js";
import type { TranscriptSidecar } from "./types.js";

export interface TakeTranscriptCandidate {
  takeId: string;
  transcriptText: string;
  wordRange?: { from: string; to: string };
  wordCount?: number;
}

export interface TakeTranscriptGroup {
  leadTakeId: string;
  candidates: Array<TakeTranscriptCandidate & { similarityToLead: number }>;
}

function rate(value: string): number {
  const match = /^([0-9]+)\/([1-9][0-9]*)$/u.exec(value);
  if (match === null) throw new TypeError(`Take fps ${value} is malformed.`);
  return Number(match[1]) / Number(match[2]);
}

export function extractTakeTranscript(
  take: TakeRecord,
  sidecar: TranscriptSidecar,
): TakeTranscriptCandidate {
  if (take.assetId !== sidecar.assetId) {
    throw new TypeError(`Take ${take.id} and transcript ${sidecar.assetId} belong to different assets.`);
  }
  const fps = rate(take.range.fps);
  const startSeconds = take.range.start / fps;
  const endSeconds = take.range.end / fps;
  const ordered = sidecar.segments.flatMap(({ words }) => words)
    .filter((wordId, index, values) => values.indexOf(wordId) === index)
    .flatMap((wordId) => {
      const word = sidecar.words[wordId];
      if (word === undefined || word.state !== "active") return [];
      const midpoint = (word.start.samples / word.start.rate + word.end.samples / word.end.rate) / 2;
      return midpoint >= startSeconds && midpoint < endSeconds
        ? [{ wordId, word }]
        : [];
    });
  const first = ordered[0];
  const last = ordered.at(-1);
  return {
    takeId: take.id,
    transcriptText: ordered.map(({ word }) =>
      `${word.punctBefore}${word.text}${word.punctAfter}`).join(" ").trim(),
    ...(first === undefined || last === undefined
      ? {}
      : { wordRange: { from: first.wordId, to: last.wordId } }),
    wordCount: ordered.length,
  };
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase("en")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}']+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

export function transcriptSimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 1 : 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return Number((1 - previous[b.length]! / Math.max(a.length, b.length)).toFixed(6));
}

export function groupTakeTranscripts(
  candidates: readonly TakeTranscriptCandidate[],
  threshold = 0.8,
): TakeTranscriptGroup[] {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError("Take transcript similarity threshold must be within 0..1.");
  }
  const groups: TakeTranscriptGroup[] = [];
  for (const candidate of [...candidates].sort((left, right) =>
    left.takeId.localeCompare(right.takeId))) {
    const group = groups.find(({ candidates: grouped }) =>
      transcriptSimilarity(grouped[0]!.transcriptText, candidate.transcriptText) >= threshold);
    if (group === undefined) {
      groups.push({
        leadTakeId: candidate.takeId,
        candidates: [{ ...structuredClone(candidate), similarityToLead: 1 }],
      });
      continue;
    }
    group.candidates.push({
      ...structuredClone(candidate),
      similarityToLead: transcriptSimilarity(group.candidates[0]!.transcriptText, candidate.transcriptText),
    });
  }
  return groups;
}
