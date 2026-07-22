import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  compareTime,
  type CreateProposalRequest,
  convertTimeRounding,
  deriveTimeline,
  failure,
  makeGuyditorError,
  success,
} from "../../core/src/index.js";
import type {
  FrameTime,
  GuyditorProject,
  OperationInput,
  Proposal,
  Result,
  SourceRangeRef,
  TransactionRecord,
  WordRange,
} from "../../core/src/index.js";

export interface DeliverableTranscriptWord {
  id: string;
  text: string;
  punctAfter: string;
  state: "active" | "deleted";
  start: { samples: number; rate: number };
  end: { samples: number; rate: number };
}

export interface DeliverableTranscript {
  assetId: string;
  words: DeliverableTranscriptWord[];
}

export type DerivationSelection =
  | { words: WordRange }
  | { clips: readonly string[] }
  | { beats: readonly string[] }
  | { timelineRange: { start: FrameTime; end: FrameTime } };

export interface ShortCandidate {
  candidateId: string;
  words: WordRange;
  beats: string[];
  durationSeconds: number;
  scores: { hook: number; coherence: number; payoff: number; overall: number };
  evidence: { hookLine: string; reasons: string[]; criteria: string[] };
}

export interface CandidateDiscoveryInput {
  project: GuyditorProject;
  transcripts: readonly DeliverableTranscript[];
  profile: string;
  duration: { minSeconds: number; maxSeconds: number };
  maxCandidates?: number;
  constraints?: {
    mustIncludeBeats?: string[];
    durationSeconds?: { min: number; max: number };
  };
}

export interface RefreshOperationInput {
  project: GuyditorProject;
  transcripts: readonly DeliverableTranscript[];
  deliverableId: string;
  history: readonly TransactionRecord[];
}

export interface CreateRefreshProposalInput extends RefreshOperationInput {
  createProposal: (request: CreateProposalRequest) => Promise<Result<Proposal>>;
  attachPreview: (proposal: Proposal) => Promise<string>;
  updateProposal: (proposal: Proposal) => Promise<Result<Proposal>>;
}

function serviceFailure(message: string, affected: readonly string[] = []) {
  return failure(makeGuyditorError("E_DERIVATION_SELECTION", message, { affected }));
}

function longform(project: GuyditorProject) {
  const deliverable = project.deliverables.find(({ kind }) => kind === "longform");
  const sequence = deliverable === undefined
    ? undefined
    : project.sequences.find(({ id }) => id === deliverable.sequenceId);
  return deliverable === undefined || sequence === undefined ? undefined : { deliverable, sequence };
}

function frameFromSample(
  sample: { samples: number; rate: number },
  fps: string,
): Result<FrameTime> {
  const converted = convertTimeRounding(
    { frames: sample.samples, fps: `${String(sample.rate)}/1` },
    fps,
  );
  return converted.ok ? success(converted.value.time) : converted;
}

function orderedActiveWords(transcripts: readonly DeliverableTranscript[]) {
  return transcripts.flatMap((transcript) => transcript.words
    .filter(({ state }) => state === "active")
    .map((word) => ({ ...word, assetId: transcript.assetId })));
}

function wordSlice(
  transcripts: readonly DeliverableTranscript[],
  range: WordRange,
) {
  const words = orderedActiveWords(transcripts);
  const start = words.findIndex(({ id }) => id === range.startWordId);
  const end = words.findIndex(({ id }) => id === range.endWordId);
  return start < 0 || end < start ? undefined : words.slice(start, end + 1);
}

function wordsCoveredByRange(
  transcript: DeliverableTranscript | undefined,
  range: SourceRangeRef["range"],
): WordRange | undefined {
  if (transcript === undefined) return undefined;
  const covered = transcript.words.filter(({ state, start, end }) => {
    if (state !== "active") return false;
    const startFrame = frameFromSample(start, range.start.fps);
    const endFrame = frameFromSample(end, range.end.fps);
    return startFrame.ok && endFrame.ok &&
      startFrame.value.frames < range.end.frames && endFrame.value.frames > range.start.frames;
  });
  return covered.length === 0 ? undefined : {
    startWordId: covered[0]!.id,
    endWordId: covered.at(-1)!.id,
  };
}

function clipSources(
  project: GuyditorProject,
  transcripts: readonly DeliverableTranscript[],
  clipIds: readonly string[],
): Result<SourceRangeRef[]> {
  const owner = longform(project);
  if (owner === undefined) return serviceFailure("The long-form sequence is unavailable.");
  const positions = new Map(owner.sequence.clips.map((clip, index) => [clip.id, index] as const));
  const ordered = [...clipIds].sort((left, right) =>
    (positions.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (positions.get(right) ?? Number.MAX_SAFE_INTEGER));
  const missing = ordered.find((id) => !positions.has(id));
  if (missing !== undefined) {
    return serviceFailure(`Clip ${missing} is not in the long-form sequence.`, [missing]);
  }
  return success(ordered.map((id) => {
    const clip = owner.sequence.clips[positions.get(id)!]!;
    const range = { start: structuredClone(clip.source.in), end: structuredClone(clip.source.out) };
    const words = wordsCoveredByRange(
      transcripts.find(({ assetId }) => assetId === clip.asset),
      range,
    );
    return {
      assetId: clip.asset,
      range,
      ...(words === undefined ? {} : { words }),
      longformClipId: clip.id,
    };
  }));
}

function wordSources(
  project: GuyditorProject,
  transcripts: readonly DeliverableTranscript[],
  range: WordRange,
): Result<SourceRangeRef[]> {
  const selected = wordSlice(transcripts, range);
  if (selected === undefined || selected.length === 0) {
    return serviceFailure(
      `Word range ${range.startWordId}..${range.endWordId} is not active and ordered.`,
      [range.startWordId, range.endWordId],
    );
  }
  const assetId = selected[0]!.assetId;
  if (!selected.every((word) => word.assetId === assetId)) {
    return serviceFailure("A derivative word range must belong to one source asset.", [range.startWordId, range.endWordId]);
  }
  const fps = project.settings.timeline.fps;
  const start = frameFromSample(selected[0]!.start, fps);
  if (!start.ok) return start;
  const end = frameFromSample(selected.at(-1)!.end, fps);
  if (!end.ok) return end;
  const owner = longform(project);
  const overlapping = owner?.sequence.clips.filter((clip) =>
    clip.asset === assetId && clip.source.in.frames < end.value.frames &&
    start.value.frames < clip.source.out.frames) ?? [];
  if (overlapping.length === 0) {
    return serviceFailure("The selected words are not present in the long-form cut.", [range.startWordId, range.endWordId]);
  }
  return success(overlapping.map((clip) => {
    const sourceStart = Math.max(start.value.frames, clip.source.in.frames);
    const sourceEnd = Math.min(end.value.frames, clip.source.out.frames);
    return {
      assetId,
      range: { start: { frames: sourceStart, fps }, end: { frames: sourceEnd, fps } },
      words: range,
      longformClipId: clip.id,
    };
  }));
}

function timelineSources(
  project: GuyditorProject,
  transcripts: readonly DeliverableTranscript[],
  range: { start: FrameTime; end: FrameTime },
): Result<SourceRangeRef[]> {
  const ordered = compareTime(range.start, range.end);
  if (!ordered.ok || ordered.value !== -1) return serviceFailure("Timeline selection must be nonempty.");
  const owner = longform(project);
  if (owner === undefined) return serviceFailure("The long-form sequence is unavailable.");
  const timeline = deriveTimeline(project, owner.sequence.id);
  if (!timeline.ok) return timeline;
  const references: SourceRangeRef[] = [];
  for (const position of timeline.value.clips) {
    const clip = owner.sequence.clips.find(({ id }) => id === position.clipId)!;
    const clipStart = position.start.frames;
    const clipEnd = clipStart + position.duration.frames;
    const start = Math.max(range.start.frames, clipStart);
    const end = Math.min(range.end.frames, clipEnd);
    if (start >= end) continue;
    const sourceStart = clip.source.in.frames + start - clipStart;
    const sourceEnd = clip.source.in.frames + end - clipStart;
    const sourceRange = {
      start: { frames: sourceStart, fps: clip.source.in.fps },
      end: { frames: sourceEnd, fps: clip.source.out.fps },
    };
    const words = wordsCoveredByRange(
      transcripts.find(({ assetId }) => assetId === clip.asset),
      sourceRange,
    );
    references.push({
      assetId: clip.asset,
      range: sourceRange,
      ...(words === undefined ? {} : { words }),
      longformClipId: clip.id,
    });
  }
  return references.length === 0
    ? serviceFailure("The timeline selection does not cover long-form media.")
    : success(references);
}

function beatWords(
  project: GuyditorProject,
  transcripts: readonly DeliverableTranscript[],
  beatIds: readonly string[],
): Result<WordRange> {
  const order = orderedActiveWords(transcripts).map(({ id }) => id);
  const positions = beatIds.map((id) => {
    const beat = project.beats.find(({ id: candidate }) => candidate === id);
    const word = beat === undefined ? undefined : /^word:(w[0-9]{6})/u.exec(beat.anchor)?.[1];
    return { id, word, index: word === undefined ? -1 : order.indexOf(word) };
  });
  const invalid = positions.find(({ index }) => index < 0);
  if (invalid !== undefined) return serviceFailure(`Beat ${invalid.id} has no resolvable word anchor.`, [invalid.id]);
  const start = Math.min(...positions.map(({ index }) => index));
  const selectedBeatSet = new Set(beatIds);
  const laterBoundary = project.beats.flatMap((beat) => {
    if (selectedBeatSet.has(beat.id)) return [];
    const word = /^word:(w[0-9]{6})/u.exec(beat.anchor)?.[1];
    const index = word === undefined ? -1 : order.indexOf(word);
    return index > Math.max(...positions.map(({ index: value }) => value)) ? [index] : [];
  }).sort((left, right) => left - right)[0];
  const end = laterBoundary === undefined ? order.length - 1 : laterBoundary - 1;
  return success({ startWordId: order[start]!, endWordId: order[end]! });
}

export function resolveDerivationSources(
  project: GuyditorProject,
  transcripts: readonly DeliverableTranscript[],
  selection: DerivationSelection,
): Result<SourceRangeRef[]> {
  if ("words" in selection) return wordSources(project, transcripts, selection.words);
  if ("clips" in selection) return clipSources(project, transcripts, selection.clips);
  if ("timelineRange" in selection) return timelineSources(project, transcripts, selection.timelineRange);
  const words = beatWords(project, transcripts, selection.beats);
  return words.ok ? wordSources(project, transcripts, words.value) : words;
}

function nestedStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(nestedStrings);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(nestedStrings);
}

export function buildRefreshOperation(input: RefreshOperationInput): Result<OperationInput> {
  const deliverable = input.project.deliverables.find(({ id }) => id === input.deliverableId);
  if (deliverable === undefined || deliverable.kind !== "short" || deliverable.status !== "stale") {
    return serviceFailure(
      `Deliverable ${input.deliverableId} must be a stale short before refresh.`,
      [input.deliverableId],
    );
  }
  const sequence = input.project.sequences.find(({ id }) => id === deliverable.sequenceId);
  if (sequence === undefined) return serviceFailure(`Derivative sequence ${deliverable.sequenceId} is unavailable.`, [deliverable.sequenceId]);
  const stalenessTransactionId = deliverable.staleReasons?.at(-1)?.transactionId;
  if (stalenessTransactionId === undefined) {
    return serviceFailure(
      `Stale deliverable ${deliverable.id} has no accepted transaction explaining its staleness.`,
      [deliverable.id],
    );
  }
  const fullyDeletedOrphans: Array<{ transactionId: string; explanation: string }> = [];
  const refreshedDependencies: NonNullable<typeof deliverable.dependencies> = [];
  const refreshedClips = sequence.clips.flatMap((clip) => {
    if (clip.origin === "local") return [structuredClone(clip)];
    const dependency = deliverable.dependencies?.find(({ derivativeClipId }) => derivativeClipId === clip.id);
    if (dependency === undefined) return [];
    const words = dependency.source.words;
    if (words === undefined) {
      refreshedDependencies.push(structuredClone(dependency));
      return [structuredClone(clip)];
    }
    const allWords = input.transcripts.flatMap((transcript) => transcript.words
      .map((word) => ({ ...word, assetId: transcript.assetId })));
    const selected = allWords.filter(({ id, assetId, state }) =>
      assetId === dependency.source.assetId && state === "active" &&
      id >= words.startWordId && id <= words.endWordId);
    if (selected.length === 0) {
      fullyDeletedOrphans.push({
        transactionId: stalenessTransactionId,
        explanation: `All anchored words ${words.startWordId}–${words.endWordId} for derivative clip ${clip.id} were deleted; retain this missing entry for creator resolution.`,
      });
      return [];
    }
    const fps = dependency.source.range.start.fps;
    const start = frameFromSample(selected[0]!.start, fps);
    const end = frameFromSample(selected.at(-1)!.end, fps);
    if (!start.ok || !end.ok) return [];
    const remappedStart = Math.max(start.value.frames, clip.source.in.frames);
    const remappedEnd = Math.min(end.value.frames, clip.source.out.frames);
    if (remappedStart >= remappedEnd) return [];
    const replacement = {
      ...structuredClone(clip),
      source: {
        in: { frames: remappedStart, fps },
        out: { frames: remappedEnd, fps },
      },
    };
    refreshedDependencies.push({
      derivativeClipId: clip.id,
      source: {
        ...structuredClone(dependency.source),
        range: { start: structuredClone(replacement.source.in), end: structuredClone(replacement.source.out) },
      },
    });
    return [replacement];
  });
  const divergenceIds = new Set((deliverable.divergences ?? []).flatMap(({ transactionIds }) => transactionIds));
  const activeWords = new Set(orderedActiveWords(input.transcripts).map(({ id }) => id));
  const divergenceHistory = input.history.filter(({ id }) => divergenceIds.has(id));
  const orphaned = [...fullyDeletedOrphans, ...divergenceHistory.flatMap((transaction) => {
    const missing = transaction.operations.flatMap(({ params }) => nestedStrings(params))
      .filter((value) => /^w[0-9]{6}$/u.test(value) && !activeWords.has(value));
    return missing.length === 0 ? [] : [{
      transactionId: transaction.id,
      explanation: `Word anchor${missing.length === 1 ? "" : "s"} ${missing.join(", ")} no longer resolve; retain and resolve this divergence during review.`,
    }];
  })];
  return success({
    op: "deliverable.refresh",
    params: {
      deliverableId: deliverable.id,
      clips: refreshedClips,
      dependencies: refreshedDependencies,
      replayedTransactionIds: divergenceHistory.map(({ id }) => id),
      orphaned,
    },
  });
}

export async function createRefreshProposal(
  input: CreateRefreshProposalInput,
): Promise<Result<Proposal>> {
  const operation = buildRefreshOperation(input);
  if (!operation.ok) return operation;
  const proposal = await input.createProposal({
    operations: [operation.value],
    instruction: {
      kind: "user-text",
      text: `Refresh stale deliverable ${input.deliverableId}`,
    },
    actor: { kind: "tool", id: "deliverable-service" },
    reason: {
      text: "Re-derive the changed source ranges and review the semantic diff and preview before acceptance.",
      sources: [{ kind: "media-evidence", ref: input.deliverableId }],
    },
    addresses: [],
  });
  if (!proposal.ok) return proposal;
  try {
    const previewJobId = await input.attachPreview(proposal.value);
    return input.updateProposal({ ...proposal.value, previewJobId });
  } catch (error: unknown) {
    return failure(makeGuyditorError(
      "E_REFRESH_PREVIEW",
      `Could not attach a refresh preview: ${error instanceof Error ? error.message : String(error)}`,
      { affected: [proposal.value.id], retry: "safe" },
    ));
  }
}

function sentenceText(words: readonly DeliverableTranscriptWord[]): string {
  return words.map(({ text, punctAfter }) => `${text}${punctAfter}`).join(" ")
    .replace(/\s+([,.;:!?])/gu, "$1");
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function candidateFor(
  profile: string,
  words: readonly DeliverableTranscriptWord[],
  beats: readonly { id: string; wordIndex: number; name: string }[],
): ShortCandidate {
  const text = sentenceText(words);
  const hookWords = words.filter(({ start }) =>
    start.samples / start.rate - words[0]!.start.samples / words[0]!.start.rate <= 2.5);
  const hookText = sentenceText(hookWords);
  const criteria: string[] = [];
  if (/\?/u.test(hookText)) criteria.push("question");
  if (/\b\d+(?:\.\d+)?\b/u.test(hookText)) criteria.push("number");
  if (/^(?:try|stop|start|make|use|watch|look|imagine)\b/iu.test(hookText)) criteria.push("imperative");
  if (/\b(?:not|never|no|wrong|myth|but|however)\b/iu.test(hookText)) criteria.push("contrarian-or-negation");
  const conclusion = /\b(?:so|therefore|thus|result|that's why|this means)\b/iu.test(text);
  if (conclusion) criteria.push("conclusion-marker");
  const selectedBeatIds = beats.filter(({ wordIndex }) => wordIndex >= 0 && wordIndex < words.length)
    .map(({ id }) => id);
  const payoffBeat = beats.some(({ wordIndex, name }) =>
    /payoff/iu.test(name) && wordIndex >= Math.floor(words.length * 2 / 3));
  if (payoffBeat) criteria.push("payoff-beat-final-third");
  const initialReference = /^(?:it|this|that|they|he|she|there|these|those)\b/iu.test(text);
  const cutClause = !/[.!?]$/u.test(text);
  const hook = rounded(Math.min(1, criteria.filter((item) =>
    item === "question" || item === "number" || item === "imperative" ||
    item === "contrarian-or-negation").length * 0.4 + (/^[A-Z][a-z]+\b/u.test(hookText) ? 0.2 : 0)));
  const coherence = rounded(Math.max(0, 1 - (initialReference ? 0.35 : 0) - (cutClause ? 0.25 : 0)));
  const payoff = rounded(Math.min(1, (conclusion ? 0.55 : 0) + (payoffBeat ? 0.45 : 0)));
  const overall = rounded(0.4 * hook + 0.35 * coherence + 0.25 * payoff);
  const durationSeconds = rounded(
    words.at(-1)!.end.samples / words.at(-1)!.end.rate -
    words[0]!.start.samples / words[0]!.start.rate,
  );
  const identity = `${profile}:${words[0]!.id}:${words.at(-1)!.id}`;
  return {
    candidateId: `candidate-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`,
    words: { startWordId: words[0]!.id, endWordId: words.at(-1)!.id },
    beats: selectedBeatIds,
    durationSeconds,
    scores: { hook, coherence, payoff, overall },
    evidence: {
      hookLine: hookText,
      reasons: [
        `hook=${String(hook)} from the first 2.5 seconds`,
        `coherence=${String(coherence)} after boundary/reference penalties`,
        `payoff=${String(payoff)} from conclusion and payoff markers`,
      ],
      criteria,
    },
  };
}

function overlapRatio(left: ShortCandidate, right: ShortCandidate, order: readonly string[]): number {
  const leftStart = order.indexOf(left.words.startWordId);
  const leftEnd = order.indexOf(left.words.endWordId);
  const rightStart = order.indexOf(right.words.startWordId);
  const rightEnd = order.indexOf(right.words.endWordId);
  const intersection = Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart) + 1);
  return intersection / Math.min(leftEnd - leftStart + 1, rightEnd - rightStart + 1);
}

export function discoverShortCandidates(input: CandidateDiscoveryInput): ShortCandidate[] {
  const words = orderedActiveWords(input.transcripts);
  if (words.length === 0) return [];
  const order = words.map(({ id }) => id);
  const beatPositions = input.project.beats.flatMap((beat) => {
    const wordId = /^word:(w[0-9]{6})/u.exec(beat.anchor)?.[1];
    const wordIndex = wordId === undefined ? -1 : order.indexOf(wordId);
    return wordIndex < 0 ? [] : [{ id: beat.id, name: beat.name, wordIndex }];
  }).sort((left, right) => left.wordIndex - right.wordIndex);
  const boundaries = [...new Set([0, ...beatPositions.map(({ wordIndex }) => wordIndex), words.length])]
    .sort((left, right) => left - right);
  const limit = input.constraints?.durationSeconds ?? {
    min: input.duration.minSeconds,
    max: input.duration.maxSeconds,
  };
  const candidates: ShortCandidate[] = [];
  for (let startBoundary = 0; startBoundary < boundaries.length - 1; startBoundary += 1) {
    for (let endBoundary = startBoundary + 1; endBoundary < boundaries.length; endBoundary += 1) {
      const window = words.slice(boundaries[startBoundary], boundaries[endBoundary]);
      if (window.length === 0) continue;
      const candidate = candidateFor(input.profile, window, beatPositions.map((beat) => ({
        ...beat,
        wordIndex: beat.wordIndex - boundaries[startBoundary]!,
      })));
      if (candidate.durationSeconds < limit.min || candidate.durationSeconds > limit.max) continue;
      if (!(input.constraints?.mustIncludeBeats ?? []).every((id) => candidate.beats.includes(id))) continue;
      candidates.push(candidate);
    }
  }
  const ranked = candidates.sort((left, right) =>
    right.scores.overall - left.scores.overall ||
    right.durationSeconds - left.durationSeconds ||
    left.candidateId.localeCompare(right.candidateId));
  const selected: ShortCandidate[] = [];
  for (const candidate of ranked) {
    if (selected.some((kept) => overlapRatio(candidate, kept, order) > 0.5)) continue;
    selected.push(candidate);
    if (selected.length >= (input.maxCandidates ?? 8)) break;
  }
  return selected;
}

export async function writeCandidateCache(
  projectRoot: string,
  revision: string,
  candidates: readonly ShortCandidate[],
): Promise<string> {
  const directory = join(projectRoot, ".guyditor", "cache", "candidates");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${revision}.json`);
  await writeFile(path, `${JSON.stringify({ revision, candidates }, null, 2)}\n`, "utf8");
  return path;
}
