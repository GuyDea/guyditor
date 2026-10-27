import type { MarkerRecord } from "../../../core/src/index.js";
import { groupTakeTranscripts, transcriptSimilarity } from "../take-comparison.js";
import type { SampleTime, TranscriptSidecar, TranscriptWord } from "../types.js";
import type { CandidateSegment, EvidenceAsset, ScriptBlock, SegmentGroup } from "./types.js";

export interface SegmentInput {
  assetId: string;
  ordinal: number;
  sidecar: TranscriptSidecar;
  markers: readonly MarkerRecord[];
}

export interface SegmentOptions {
  segmentPauseMs: number;
  lowConfidenceBelow: number;
  groupThreshold: number;
  asideMaxWords: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  segmentPauseMs: 1500,
  lowConfidenceBelow: 0.6,
  groupThreshold: 0.8,
  asideMaxWords: 6,
};

const SCRIPT_MATCH_MIN = 0.5;
const WORD_EDGE_EPSILON_S = 0.001;

interface TimedWord { id: string; word: TranscriptWord; start: number; end: number }

const seconds = (time: SampleTime): number => time.samples / time.rate;

function markerTiming(marker: MarkerRecord): { at: number; frameSeconds: number } | null {
  const match = /^([0-9]+)(?:\/([1-9][0-9]*))?$/u.exec(marker.at.fps);
  if (match === null) return null;
  const fps = Number(match[1]) / Number(match[2] ?? 1);
  if (!(fps > 0)) return null;
  const frame = "frame" in marker.at ? marker.at.frame : marker.at.start;
  return { at: frame / fps, frameSeconds: 1 / fps };
}

function activeWords(sidecar: TranscriptSidecar): TimedWord[] {
  const seen = new Set<string>();
  const out: TimedWord[] = [];
  for (const segment of sidecar.segments) {
    for (const id of segment.words) {
      const word = sidecar.words[id];
      if (word === undefined || word.state !== "active" || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, word, start: seconds(word.start), end: seconds(word.end) });
    }
  }
  return out;
}

/** Index of the word a spoken marker starts, or null when no word start is within one frame. */
function markerWordIndex(marker: MarkerRecord, words: readonly TimedWord[]): number | null {
  const anchored = marker.anchor?.startsWith("word:") === true
    ? words.findIndex(({ id }) => id === marker.anchor!.slice(5))
    : -1;
  if (anchored >= 0) return anchored;
  const timing = markerTiming(marker);
  if (timing === null) return null;
  const { at } = timing;
  const tolerance = timing.frameSeconds + WORD_EDGE_EPSILON_S;
  const next = words.findIndex(({ end }) => end > at);
  // In a gap (or exactly at a word start): the marker precedes that word.
  if (next >= 0 && at <= words[next]!.start + WORD_EDGE_EPSILON_S) return next;
  // Frame quantisation can land the marker slightly inside a word: snap to the nearest word start.
  let nearest: number | null = null;
  let distance = tolerance;
  words.forEach(({ start }, index) => {
    const d = Math.abs(start - at);
    if (d <= distance) { nearest = index; distance = d; }
  });
  return nearest;
}

function joinText(words: readonly TimedWord[]): string {
  return words.map(({ word }) => `${word.punctBefore}${word.text}${word.punctAfter}`).join(" ").trim();
}

export function segmentTranscript(
  input: SegmentInput,
  options: Partial<SegmentOptions> = {},
): CandidateSegment[] {
  const opts = { ...DEFAULT_SEGMENT_OPTIONS, ...options };
  const words = activeWords(input.sidecar);
  const phrasesAt = new Map<number, string[]>();
  const afterMarker = new Set<number>();
  for (const marker of input.markers) {
    if (marker.source !== "spoken") continue;
    const index = markerWordIndex(marker, words);
    if (index === null) continue;
    const note = marker.note ?? "";
    phrasesAt.set(index, [...(phrasesAt.get(index) ?? []), note]);
    // The spoken phrase is its own segment: the next word after it starts a new one.
    const spokenWords = Math.max(1, note.split(/\s+/u).filter(Boolean).length);
    afterMarker.add(index + spokenWords);
  }
  const groups: { words: TimedWord[]; phrases: string[]; pauseMs: number | null }[] = [];
  words.forEach((timed, index) => {
    const previous = words[index - 1];
    const gapMs = previous === undefined ? null : Math.round((timed.start - previous.end) * 1000);
    const phrases = phrasesAt.get(index) ?? [];
    const current = groups.at(-1);
    const split = current === undefined
      || (gapMs !== null && gapMs >= opts.segmentPauseMs)
      || (phrases.length > 0 && previous !== undefined)
      || afterMarker.has(index);
    if (split) groups.push({ words: [timed], phrases: [...phrases], pauseMs: gapMs });
    else {
      current.words.push(timed);
      current.phrases.push(...phrases);
    }
  });
  return groups.map((group, index) => {
    const first = group.words[0]!;
    const last = group.words.at(-1)!;
    const scores = group.words.flatMap(({ word }) => word.confidence === null ? [] : [word.confidence]);
    const confidence = scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length;
    return {
      id: `C${input.ordinal}.${String(index + 1).padStart(2, "0")}`,
      assetId: input.assetId,
      fromWord: first.id,
      toWord: last.id,
      start: first.word.start,
      end: last.word.end,
      text: joinText(group.words),
      pauseBeforeMs: group.pauseMs,
      confidence,
      lowConfidence: confidence !== null && confidence < opts.lowConfidenceBelow,
      groupId: null,
      scriptMatch: null,
      aside: group.phrases.length > 0,
      markerPhrases: group.phrases,
    };
  });
}

export function scoreScriptMatch(text: string, block: ScriptBlock): number {
  const sentences = block.sentences;
  let best = transcriptSimilarity(text, block.text);
  for (let size = 1; size <= 3; size += 1) {
    for (let from = 0; from + size <= sentences.length; from += 1) {
      best = Math.max(best, transcriptSimilarity(text, sentences.slice(from, from + size).join(" ")));
    }
  }
  return best;
}

function bestBlock(text: string, blocks: readonly ScriptBlock[]): { block: string; score: number } | null {
  let best: { block: string; score: number } | null = null;
  for (const block of blocks) {
    const score = scoreScriptMatch(text, block);
    if (best === null || score > best.score) best = { block: block.id, score };
  }
  return best;
}

const wordCount = (text: string): number => text.split(/\s+/u).filter(Boolean).length;

export function groupSegments(
  segments: CandidateSegment[],
  scriptBlocks: ScriptBlock[],
  options: Partial<SegmentOptions> = {},
): { segments: CandidateSegment[]; groups: SegmentGroup[] } {
  const opts = { ...DEFAULT_SEGMENT_OPTIONS, ...options };
  const copies = segments.map((segment) => structuredClone(segment));
  for (const segment of copies) {
    const best = bestBlock(segment.text, scriptBlocks);
    segment.scriptMatch = best !== null && best.score >= SCRIPT_MATCH_MIN ? best : null;
    segment.aside = segment.markerPhrases.length > 0
      || (scriptBlocks.length > 0 && best !== null && best.score < SCRIPT_MATCH_MIN
        && wordCount(segment.text) <= opts.asideMaxWords);
    if (segment.aside) segment.scriptMatch = null;
  }
  const position = new Map(copies.map((segment, index) => [segment.id, index]));
  const byId = new Map(copies.map((segment) => [segment.id, segment]));
  const candidates = copies.filter(({ aside }) => !aside)
    .map(({ id, text }) => ({ takeId: id, transcriptText: text }));
  const raw = groupTakeTranscripts(candidates, opts.groupThreshold)
    .map(({ candidates: members }) => members.map(({ takeId }) => takeId)
      .sort((a, b) => position.get(a)! - position.get(b)!))
    .sort((a, b) => position.get(a[0]!)! - position.get(b[0]!)!);
  const groups = raw.map((memberIds, index): SegmentGroup => {
    const id = `G${index + 1}`;
    const totals = new Map<string, number>();
    for (const memberId of memberIds) {
      const member = byId.get(memberId)!;
      member.groupId = id;
      for (const block of scriptBlocks) {
        totals.set(block.id, (totals.get(block.id) ?? 0) + scoreScriptMatch(member.text, block));
      }
    }
    let scriptBlock: string | null = null;
    let top = SCRIPT_MATCH_MIN;
    for (const [blockId, total] of totals) {
      const mean = total / memberIds.length;
      if (mean >= top && (scriptBlock === null || mean > top)) {
        scriptBlock = blockId;
        top = mean;
      }
    }
    return { id, memberIds, scriptBlock };
  });
  return { segments: copies, groups };
}

export function orderAssets(
  assets: {
    assetId: string;
    fileName: string;
    capturedAt: string;
    captureSource: "container" | "file-mtime";
    durationMs: number;
  }[],
): EvidenceAsset[] {
  const byName = (a: { fileName: string }, b: { fileName: string }): number =>
    a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0;
  const sorted = [...assets].sort((a, b) =>
    Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || byName(a, b));
  const nameOrder = [...assets].sort(byName).map(({ assetId }) => assetId);
  return sorted.map((asset, index) => {
    const warnings: string[] = [];
    if (asset.captureSource === "file-mtime") {
      warnings.push("capture time is the file modified time, not recorded in the container");
    }
    const twins = sorted.filter((other) => other !== asset
      && Date.parse(other.capturedAt) === Date.parse(asset.capturedAt));
    if (twins.length > 0) {
      warnings.push(`same capture time as ${twins.map(({ fileName }) => fileName).join(", ")}`);
    }
    if (nameOrder[index] !== asset.assetId) {
      warnings.push("capture order disagrees with file name order");
    }
    return {
      assetId: asset.assetId,
      ordinal: index + 1,
      fileName: asset.fileName,
      capturedAt: asset.capturedAt,
      captureSource: asset.captureSource,
      durationMs: asset.durationMs,
      orderWarning: warnings.length === 0 ? null : warnings.join("; "),
    };
  });
}
