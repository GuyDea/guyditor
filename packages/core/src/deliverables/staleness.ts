import type { AppliedOperation } from "../operations/types.js";
import type { Clip, GuyditorProject } from "../project/model.js";
import { parseWordId } from "../project/ids.js";
import type { RestyleChunk, RestyleSeam } from "../restyle/types.js";
import { compareTime } from "../time/index.js";
import type { FrameTime } from "../time/index.js";
import type {
  DependencyEntry,
  SourceRangeRef,
  WordRange,
} from "./types.js";

interface SourceChange {
  operation: string;
  summary: string;
  assetId?: string;
  range?: SourceRangeRef["range"];
  words?: WordRange;
}

function before(left: FrameTime, right: FrameTime): boolean {
  const compared = compareTime(left, right);
  if (!compared.ok) throw new RangeError(compared.error.message);
  return compared.value === -1;
}

export function integerRangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

export interface AcceptedRangeStalenessMark {
  transactionId: string;
  detectedAt: string;
}

interface RestyleStalenessPlan {
  chunks: RestyleChunk[];
  seams: RestyleSeam[];
}

/**
 * Applies accepted-transaction range intersections to frozen restyle chunks.
 * This lives beside derivative dependency staleness so both features share the
 * same half-open overlap semantics and one status/seam-marking implementation.
 */
export function markRestylePlanStaleness<Plan extends RestyleStalenessPlan>(
  plan: Plan,
  changedRanges: readonly { start: number; end: number }[],
  mark: AcceptedRangeStalenessMark,
): { plan: Plan; changed: boolean } {
  const next = structuredClone(plan);
  let changed = false;
  for (const chunk of next.chunks) {
    if (
      (chunk.status !== "approved" && chunk.status !== "generated") ||
      !changedRanges.some((range) => integerRangesOverlap(
        { start: chunk.sourceRange.startFrame, end: chunk.sourceRange.endFrame },
        range,
      ))
    ) continue;
    chunk.status = "stale";
    chunk.stale = {
      reason: "source-range-overlap",
      markedAt: mark.detectedAt,
      transactionId: mark.transactionId,
    };
    for (const seam of next.seams) {
      if (seam.beforeChunkId !== chunk.id && seam.afterChunkId !== chunk.id) continue;
      seam.status = "review";
      seam.review = {
        reason: "adjacent-chunk-stale",
        markedAt: mark.detectedAt,
        transactionId: mark.transactionId,
      };
      delete seam.application;
    }
    changed = true;
  }
  return { plan: next, changed };
}

export function sourceRangesOverlap(
  left: SourceRangeRef["range"],
  right: SourceRangeRef["range"],
): boolean {
  return before(left.start, right.end) && before(right.start, left.end);
}

export function wordRangesOverlap(left: WordRange, right: WordRange): boolean {
  const leftStart = parseWordId(left.startWordId);
  const leftEnd = parseWordId(left.endWordId);
  const rightStart = parseWordId(right.startWordId);
  const rightEnd = parseWordId(right.endWordId);
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function clipIn(project: GuyditorProject, clipId: string): Clip | undefined {
  return project.sequences.flatMap(({ clips }) => clips).find(({ id }) => id === clipId);
}

function longformSequenceIds(project: GuyditorProject): Set<string> {
  return new Set(project.deliverables
    .filter(({ kind }) => kind === "longform")
    .map(({ sequenceId }) => sequenceId));
}

function longformClips(project: GuyditorProject): Clip[] {
  const ids = longformSequenceIds(project);
  return project.sequences.filter(({ id }) => ids.has(id)).flatMap(({ clips }) => clips);
}

function frameRange(clip: Clip): SourceRangeRef["range"] {
  return { start: structuredClone(clip.source.in), end: structuredClone(clip.source.out) };
}

function trimChange(
  beforeClip: Clip,
  afterClip: Clip,
  edge: "head" | "tail",
): SourceRangeRef["range"] | undefined {
  const first = edge === "head" ? beforeClip.source.in : afterClip.source.out;
  const second = edge === "head" ? afterClip.source.in : beforeClip.source.out;
  if (!before(first, second)) return undefined;
  return { start: structuredClone(first), end: structuredClone(second) };
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(strings);
}

function wordChange(operation: AppliedOperation): WordRange | undefined {
  const words = strings(operation.params)
    .filter((value) => /^w[0-9]{6}$/u.test(value))
    .sort((left, right) => parseWordId(left) - parseWordId(right));
  return words.length === 0
    ? undefined
    : { startWordId: words[0]!, endWordId: words.at(-1)! };
}

function operationChanges(
  beforeProject: GuyditorProject,
  afterProject: GuyditorProject,
  operation: AppliedOperation,
): SourceChange[] {
  if (operation.op.startsWith("deliverable.") || operation.op.startsWith("restyle.") ||
      operation.op.startsWith("seam.")) return [];
  const mentioned = new Set([...operation.affected, ...strings(operation.params)]);
  const beforeLongformIds = longformSequenceIds(beforeProject);
  const afterLongformIds = longformSequenceIds(afterProject);
  const masterScope = new Set([
    ...beforeLongformIds,
    ...afterLongformIds,
    ...longformClips(beforeProject).map(({ id }) => id),
    ...longformClips(afterProject).map(({ id }) => id),
    ...[...beforeProject.layers, ...afterProject.layers]
      .filter(({ sequence }) => sequence !== undefined &&
        (beforeLongformIds.has(sequence) || afterLongformIds.has(sequence)))
      .map(({ id }) => id),
    ...[...beforeProject.deliverables, ...afterProject.deliverables]
      .filter(({ kind }) => kind === "longform")
      .flatMap(({ captionsTrackId }) => captionsTrackId === undefined ? [] : [captionsTrackId]),
  ]);
  const shortSequenceIds = new Set([...beforeProject.deliverables, ...afterProject.deliverables]
    .filter(({ kind }) => kind === "short").map(({ sequenceId }) => sequenceId));
  const derivativeScope = new Set([
    ...shortSequenceIds,
    ...[...beforeProject.deliverables, ...afterProject.deliverables]
      .filter(({ kind }) => kind === "short")
      .flatMap(({ id, captionsTrackId }) => captionsTrackId === undefined ? [id] : [id, captionsTrackId]),
    ...[...beforeProject.sequences, ...afterProject.sequences]
      .filter(({ id }) => shortSequenceIds.has(id)).flatMap(({ clips }) => clips.map(({ id }) => id)),
    ...[...beforeProject.layers, ...afterProject.layers]
      .filter(({ sequence }) => sequence !== undefined && shortSequenceIds.has(sequence)).map(({ id }) => id),
  ]);
  if (
    [...mentioned].some((id) => derivativeScope.has(id)) &&
    ![...mentioned].some((id) => masterScope.has(id))
  ) return [];
  const words = wordChange(operation);
  const changes: SourceChange[] = words === undefined ? [] : [{
    operation: operation.op,
    summary: operation.summary,
    words,
  }];
  for (const beatId of [...mentioned].filter((id) => /^beat_[a-z2-7]{10}$/u.test(id))) {
    const beat = beforeProject.beats.find(({ id }) => id === beatId) ??
      afterProject.beats.find(({ id }) => id === beatId);
    const wordId = beat === undefined ? undefined : /^word:(w[0-9]{6})/u.exec(beat.anchor)?.[1];
    if (wordId !== undefined) changes.push({
      operation: operation.op,
      summary: operation.summary,
      words: { startWordId: wordId, endWordId: wordId },
    });
  }
  const longformIds = new Set([
    ...longformSequenceIds(beforeProject),
    ...longformSequenceIds(afterProject),
  ]);
  const longformLayerIds = new Set([
    ...beforeProject.layers,
    ...afterProject.layers,
  ].filter(({ sequence }) => sequence !== undefined && longformIds.has(sequence)).map(({ id }) => id));
  const longformCaptionIds = new Set([
    ...beforeProject.deliverables,
    ...afterProject.deliverables,
  ].filter(({ kind }) => kind === "longform").flatMap(({ captionsTrackId }) =>
    captionsTrackId === undefined ? [] : [captionsTrackId]));
  if ([...mentioned].some((id) => longformLayerIds.has(id) || longformCaptionIds.has(id))) {
    changes.push(...longformClips(beforeProject).map((clip) => ({
      operation: operation.op,
      summary: operation.summary,
      assetId: clip.asset,
      range: frameRange(clip),
    })));
  }
  const beforeLongform = new Set(longformClips(beforeProject).map(({ id }) => id));
  const afterLongform = new Set(longformClips(afterProject).map(({ id }) => id));
  const explicitClipIds = new Set([
    ...mentioned,
  ].filter((id) => /^clp_[a-z2-7]{10}$/u.test(id) &&
    (beforeLongform.has(id) || afterLongform.has(id))));

  for (const clipId of explicitClipIds) {
    const prior = clipIn(beforeProject, clipId);
    const current = clipIn(afterProject, clipId);
    if (prior === undefined && current === undefined) continue;
    let range: SourceRangeRef["range"] | undefined;
    if (
      operation.op === "clip.trim" && prior !== undefined && current !== undefined &&
      (operation.params["edge"] === "head" || operation.params["edge"] === "tail")
    ) {
      range = trimChange(prior, current, operation.params["edge"]);
    } else {
      range = frameRange(prior ?? current!);
    }
    if (range !== undefined) changes.push({
      operation: operation.op,
      summary: operation.summary,
      assetId: (prior ?? current)!.asset,
      range,
    });
  }

  const affectedAssets = new Set([
    ...mentioned,
  ].filter((id) => /^ast_[a-z2-7]{10}$/u.test(id)));
  for (const clip of longformClips(beforeProject)) {
    if (!affectedAssets.has(clip.asset)) continue;
    changes.push({
      operation: operation.op,
      summary: operation.summary,
      assetId: clip.asset,
      range: frameRange(clip),
    });
  }
  return changes;
}

function intersects(change: SourceChange, dependency: DependencyEntry): boolean {
  if (change.words !== undefined && dependency.source.words !== undefined) {
    return wordRangesOverlap(change.words, dependency.source.words);
  }
  return change.assetId === dependency.source.assetId && change.range !== undefined &&
    sourceRangesOverlap(change.range, dependency.source.range);
}

function changeText(change: SourceChange, dependency: DependencyEntry): string {
  const range = change.range === undefined
    ? "word anchors"
    : `${String(change.range.start.frames)}–${String(change.range.end.frames)} @ ${change.range.start.fps}`;
  return `${change.operation}: ${change.summary}; affected ${range} used by derivative clip ${dependency.derivativeClipId}`;
}

export interface AcceptedStalenessInput {
  before: GuyditorProject;
  after: GuyditorProject;
  applied: readonly AppliedOperation[];
  transactionId: string;
  revision: string;
  detectedAt: string;
}

export function markAcceptedDeliverableStaleness(input: AcceptedStalenessInput): GuyditorProject {
  const changes = input.applied.flatMap((operation) =>
    operationChanges(input.before, input.after, operation));
  if (changes.length === 0) return input.after;
  let changed = false;
  const deliverables = input.after.deliverables.map((deliverable) => {
    if (
      deliverable.kind !== "short" ||
      (deliverable.status !== "approved" && deliverable.status !== "in-review")
    ) return deliverable;
    const affected = (deliverable.dependencies ?? []).flatMap((dependency) => {
      const change = changes.find((candidate) => intersects(candidate, dependency));
      return change === undefined ? [] : [{
        dependency: structuredClone(dependency),
        change: changeText(change, dependency),
      }];
    });
    if (affected.length === 0) return deliverable;
    changed = true;
    return {
      ...deliverable,
      status: "stale" as const,
      staleReasons: [
        ...(deliverable.staleReasons ?? []),
        {
          transactionId: input.transactionId,
          revision: input.revision,
          affected,
          detectedAt: input.detectedAt,
        },
      ],
    };
  });
  return changed ? { ...input.after, deliverables } : input.after;
}
