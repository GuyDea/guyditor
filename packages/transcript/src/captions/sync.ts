import { deriveTimeline } from "../../../core/src/index.js";
import type { Clip, Layer } from "../../../core/src/index.js";
import type { TranscriptSidecar, TranscriptWord } from "../types.js";
import {
  add,
  compare,
  divide,
  maximum,
  minimum,
  multiply,
  parseString,
  rational,
  subtract,
  toNumber,
} from "./rational.js";
import type {
  BuildWordTimelineMapOptions,
  RationalSec,
  SyncDiagnostics,
  WordInstance,
  WordTimelineMap,
} from "./types.js";

function frameSeconds(time: { frames: number; fps: string }): RationalSec {
  return divide(rational(time.frames, 1), parseString(time.fps));
}

function sampleSeconds(time: { samples: number; rate: number }): RationalSec {
  return rational(time.samples, time.rate);
}

function speed(clip: Clip): RationalSec {
  const effects = (clip.effects ?? []).filter(({ kind }) => kind === "speed");
  if (effects.length > 1) throw new TypeError(`Clip ${clip.id} has multiple speed effects.`);
  const value = effects[0]?.params["rate"];
  if (value === undefined) return rational(1, 1);
  if (typeof value !== "string") throw new TypeError(`Clip ${clip.id} has a non-rational speed effect.`);
  const parsed = parseString(value);
  if (parsed.num <= 0) throw new TypeError(`Clip ${clip.id} has a non-positive speed effect.`);
  return parsed;
}

function orderedWords(sidecar: TranscriptSidecar): Array<{
  wordId: string;
  word: TranscriptWord;
}> {
  return sidecar.segments.flatMap(({ words }) => words.flatMap((wordId) => {
    const word = sidecar.words[wordId];
    return word === undefined || word.state !== "active" ? [] : [{ wordId, word }];
  }));
}

interface TimedClip {
  clip: Clip;
  layer: Layer;
  start: RationalSec;
  end: RationalSec;
  unsupportedRetime: boolean;
}

function timedClips(options: BuildWordTimelineMapOptions): TimedClip[] {
  const sequence = options.project.sequences.find(({ id }) => id === options.sequenceId);
  if (sequence === undefined) throw new TypeError(`Sequence ${options.sequenceId} does not exist.`);
  const derived = deriveTimeline(options.project, options.sequenceId);
  if (!derived.ok) throw derived.error;
  const derivedByClip = new Map(derived.value.clips.map((clip) => [clip.clipId, clip] as const));
  const selectedLayers = options.project.layers
    .filter(({ id, enabled, sequence: owner }) =>
      enabled && owner === options.sequenceId && options.track.sourceLayerIds.includes(id))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const layer = selectedLayers[0];
  if (layer === undefined) return [];

  const result: TimedClip[] = [];
  for (const clip of sequence.clips) {
    const timed = derivedByClip.get(clip.id);
    if (timed === undefined) throw new TypeError(`Derived timeline omitted clip ${clip.id}.`);
    const start = frameSeconds(timed.start);
    const end = add(start, frameSeconds(timed.duration));
    const unsupportedRetime = (clip.effects ?? []).some(({ kind }) =>
      kind === "freeze" || kind === "retime" || kind === "speed-ramp" || kind === "time-remap");
    result.push({ clip, layer, start, end, unsupportedRetime });
  }
  return result;
}

function sourceSidecar(
  sidecars: readonly TranscriptSidecar[],
  assetId: string,
): TranscriptSidecar | undefined {
  return sidecars.find(({ assetId: candidate }) => candidate === assetId);
}

function overlapRange(
  leftStart: RationalSec,
  leftEnd: RationalSec,
  rightStart: RationalSec,
  rightEnd: RationalSec,
): { start: RationalSec; end: RationalSec } | undefined {
  const start = maximum(leftStart, rightStart);
  const end = minimum(leftEnd, rightEnd);
  return compare(start, end) < 0 ? { start, end } : undefined;
}

function mappedInstance(
  timed: TimedClip,
  wordId: string,
  word: TranscriptWord,
  outputFrame: RationalSec,
  diagnostics: SyncDiagnostics,
): WordInstance | undefined {
  const clipIn = frameSeconds(timed.clip.source.in);
  const clipOut = frameSeconds(timed.clip.source.out);
  const wordStart = sampleSeconds(word.start);
  const wordEnd = sampleSeconds(word.end);
  const overlap = overlapRange(wordStart, wordEnd, clipIn, clipOut);
  if (overlap === undefined) return undefined;
  const wordDuration = subtract(wordEnd, wordStart);
  const overlapDuration = subtract(overlap.end, overlap.start);
  const full = compare(overlap.start, wordStart) === 0 && compare(overlap.end, wordEnd) === 0;
  const halfCovered = compare(multiply(overlapDuration, rational(2, 1)), wordDuration) >= 0;
  const atLeastFrame = compare(overlapDuration, outputFrame) >= 0;
  if (!full && (!halfCovered || !atLeastFrame)) {
    diagnostics.clippedWords.push({
      wordId,
      clipId: timed.clip.id,
      coverage: toNumber(divide(overlapDuration, wordDuration)),
    });
    return undefined;
  }
  const rate = speed(timed.clip);
  return {
    wordId,
    clipId: timed.clip.id,
    layerId: timed.layer.id,
    clipStart: timed.start,
    start: add(timed.start, divide(subtract(overlap.start, clipIn), rate)),
    end: add(timed.start, divide(subtract(overlap.end, clipIn), rate)),
    truncated: !full,
  };
}

function overlappingAmbiguities(instances: readonly WordInstance[]): SyncDiagnostics["ambiguousRanges"] {
  const ambiguities: SyncDiagnostics["ambiguousRanges"] = [];
  for (const [index, left] of instances.entries()) {
    for (const right of instances.slice(index + 1)) {
      if (left.layerId === right.layerId || left.wordId === right.wordId) continue;
      const overlap = overlapRange(left.start, left.end, right.start, right.end);
      if (overlap !== undefined) {
        ambiguities.push({
          ...overlap,
          layerIds: [left.layerId, right.layerId].sort(),
        });
      }
    }
  }
  return ambiguities;
}

export function buildWordTimelineMap(options: BuildWordTimelineMapOptions): WordTimelineMap {
  const diagnostics: SyncDiagnostics = {
    clippedWords: [],
    ambiguousRanges: [],
    provisionalAssetIds: [],
    orphanedAnchors: [],
  };
  const outputFrame = divide(rational(1, 1), parseString(options.project.settings.timeline.fps));
  const instances = timedClips(options).flatMap((timed) => {
    const sidecar = sourceSidecar(options.sidecars, timed.clip.asset);
    if (sidecar?.provisional === true &&
        !diagnostics.provisionalAssetIds?.includes(sidecar.assetId)) {
      diagnostics.provisionalAssetIds?.push(sidecar.assetId);
    }
    if (timed.unsupportedRetime) {
      diagnostics.ambiguousRanges.push({
        start: timed.start,
        end: timed.end,
        layerIds: [timed.layer.id],
      });
      return [];
    }
    return sidecar === undefined
      ? []
      : orderedWords(sidecar).flatMap(({ wordId, word }) => {
          const mapped = mappedInstance(timed, wordId, word, outputFrame, diagnostics);
          return mapped === undefined ? [] : [mapped];
        });
  }).sort((left, right) =>
    compare(left.start, right.start) ||
    options.project.layers.find(({ id }) => id === left.layerId)!.order -
      options.project.layers.find(({ id }) => id === right.layerId)!.order ||
    left.wordId.localeCompare(right.wordId));
  diagnostics.ambiguousRanges.push(...overlappingAmbiguities(instances));

  const mapped = new Set(instances.map(({ wordId }) => wordId));
  const deleted = new Set(options.sidecars.flatMap(({ words }) =>
    Object.entries(words).flatMap(([wordId, word]) => word.state === "deleted" ? [wordId] : [])));
  const anchors = [
    ...options.track.breakOverrides.map(({ afterWordId }) => afterWordId),
    ...options.track.emphasisOverrides.map(({ wordId }) => wordId),
    ...options.track.timingOffsets.map(({ firstWordId }) => firstWordId),
  ];
  for (const anchor of [...new Set(anchors)].sort()) {
    if (!mapped.has(anchor)) {
      diagnostics.orphanedAnchors.push({
        anchor,
        owner: options.track.id,
        reason: deleted.has(anchor) ? "deleted" : "unmapped",
      });
    }
  }
  return { sequenceId: options.sequenceId, instances, diagnostics };
}
