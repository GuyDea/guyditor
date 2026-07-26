import {
  absoluteSeconds,
  applyDeliverableOperation,
  applyClipOperation,
  convertTimeRounding,
  failure,
  makeGuyditorError,
  success,
} from "../../core/src/index.js";
import type {
  Clip,
  DispatchedOperationApplication,
  FrameTime,
  GuyditorProject,
  IdPrefix,
  OperationInput,
  Result,
} from "../../core/src/index.js";

import { mapWordRangeToSourceRange } from "./range-mapping.js";
import type {
  WordSourceRange,
} from "./range-mapping.js";
import type {
  TranscriptSidecar,
  TranscriptWordRange,
} from "./types.js";

type RangeOperationIdFactory = (prefix: IdPrefix | "seg" | "spk") => string;

interface CompiledSplit {
  newClipId: string;
  newEffectIds?: string[];
}

interface PrimitiveRun {
  model: GuyditorProject;
  applications: DispatchedOperationApplication[];
  compiledSplits: CompiledSplit[];
}

interface FrameInterval {
  start: number;
  end: number;
}

function operationFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function primarySequenceId(project: GuyditorProject): Result<string> {
  const deliverable = project.deliverables.find(
    ({ id }) => id === project.settings.primaryDeliverable,
  );
  return deliverable === undefined
    ? operationFailure(
        "E_OP_NOT_FOUND",
        `Primary deliverable ${project.settings.primaryDeliverable} does not exist.`,
        [project.settings.primaryDeliverable],
      )
    : success(deliverable.sequenceId);
}

function removalSequenceId(
  project: GuyditorProject,
  input: OperationInput,
): Result<string> {
  const requested = input.params["sequenceId"];
  if (requested !== undefined) {
    return typeof requested === "string" &&
      project.sequences.some(({ id }) => id === requested)
      ? success(requested)
      : operationFailure(
          "E_OP_NOT_FOUND",
          `Sequence ${String(requested)} does not exist.`,
          typeof requested === "string" ? [requested] : [],
        );
  }
  return primarySequenceId(project);
}

function sourceDuration(project: GuyditorProject, assetId: string, rate: number) {
  const duration = project.assets.find(({ id }) => id === assetId)?.probe.duration;
  if (duration === undefined) return undefined;
  if ("samples" in duration) return duration;
  const converted = convertTimeRounding(duration, `${String(rate)}/1`);
  return converted.ok
    ? { samples: converted.value.time.frames, rate }
    : undefined;
}

function mappedRange(
  project: GuyditorProject,
  sidecars: readonly TranscriptSidecar[],
  wordRange: TranscriptWordRange,
  paddingMs: number,
  snapPolicy: "none" | "zero-crossing" | "word-boundary",
): Result<WordSourceRange> {
  const sidecar = sidecars.find(({ words }) =>
    words[wordRange.fromWord] !== undefined || words[wordRange.toWord] !== undefined);
  if (sidecar === undefined ||
      sidecar.words[wordRange.fromWord] === undefined ||
      sidecar.words[wordRange.toWord] === undefined) {
    return operationFailure(
      "E_OP_NO_TRANSCRIPT",
      `Word range ${wordRange.fromWord}..${wordRange.toWord} is not backed by one canonical transcript.`,
      [wordRange.fromWord, wordRange.toWord],
    );
  }
  const duration = sourceDuration(project, sidecar.assetId, sidecar.audio.rate);
  return mapWordRangeToSourceRange(sidecar, wordRange, {
    paddingMs,
    snapPolicy,
    ...(duration === undefined ? {} : { sourceDuration: duration }),
  });
}

function sampleToFrame(
  samples: { samples: number; rate: number },
  fps: FrameTime["fps"],
): Result<number> {
  const converted = convertTimeRounding(
    { frames: samples.samples, fps: `${String(samples.rate)}/1` },
    fps,
  );
  return converted.ok ? success(converted.value.time.frames) : converted;
}

function locateClip(project: GuyditorProject, clipId: string): Clip | undefined {
  return project.sequences.flatMap(({ clips }) => clips).find(({ id }) => id === clipId);
}

function runPrimitive(
  run: PrimitiveRun,
  input: OperationInput,
  idFactory: RangeOperationIdFactory,
): Result<DispatchedOperationApplication> {
  const applied = applyClipOperation(
    run.model,
    input,
    (prefix) => idFactory(prefix),
  );
  if (!applied.ok) return applied;
  const application: DispatchedOperationApplication = applied.value;
  run.model = application.model;
  run.applications.push(application);
  if (input.op === "clip.split") {
    const redo = applied.value.redo?.params;
    const newClipId = redo?.["newClipId"];
    if (typeof newClipId !== "string") {
      return operationFailure("E_TRANSCRIPT_COMPILE", "A compiled split did not capture its clip ID.");
    }
    const newEffectIds = redo?.["newEffectIds"];
    run.compiledSplits.push({
      newClipId,
      ...(Array.isArray(newEffectIds) ? { newEffectIds: newEffectIds as string[] } : {}),
    });
  }
  return success(application);
}

function split(
  run: PrimitiveRun,
  clipId: string,
  at: number,
  idFactory: RangeOperationIdFactory,
  replay: readonly CompiledSplit[],
): Result<string> {
  const captured = replay[run.compiledSplits.length];
  const applied = runPrimitive(run, {
    op: "clip.split",
    params: {
      clipId,
      at,
      ...(captured === undefined ? {} : captured),
    },
  }, idFactory);
  if (!applied.ok) return applied;
  const newClipId = applied.value.redo?.params["newClipId"];
  return typeof newClipId === "string"
    ? success(newClipId)
    : operationFailure("E_TRANSCRIPT_COMPILE", "A compiled split has no replayable clip ID.");
}

function removeInterval(
  run: PrimitiveRun,
  clipId: string,
  interval: FrameInterval,
  idFactory: RangeOperationIdFactory,
  replay: readonly CompiledSplit[],
): Result<true> {
  const clip = locateClip(run.model, clipId);
  if (clip === undefined) {
    return operationFailure("E_OP_NOT_FOUND", `Clip ${clipId} does not exist.`, [clipId]);
  }
  const clipStart = clip.source.in.frames;
  const clipEnd = clip.source.out.frames;
  if (interval.start < clipStart || interval.end > clipEnd || interval.start >= interval.end) {
    return operationFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `Compiled removal ${String(interval.start)}..${String(interval.end)} is outside ${clipId}.`,
      [clipId],
    );
  }
  let removalClipId = clipId;
  if (interval.start > clipStart) {
    const right = split(run, clipId, interval.start - clipStart, idFactory, replay);
    if (!right.ok) return right;
    removalClipId = right.value;
  }
  if (interval.end < clipEnd) {
    const removal = locateClip(run.model, removalClipId);
    if (removal === undefined) {
      return operationFailure("E_OP_NOT_FOUND", `Clip ${removalClipId} does not exist.`, [removalClipId]);
    }
    const right = split(
      run,
      removalClipId,
      interval.end - removal.source.in.frames,
      idFactory,
      replay,
    );
    if (!right.ok) return right;
  }
  const removed = runPrimitive(run, {
    op: "clip.remove",
    params: { clipId: removalClipId },
  }, idFactory);
  return removed.ok ? success(true) : removed;
}

function compositeApplication(
  input: OperationInput,
  run: PrimitiveRun,
  summary: string,
  affectedExtra: readonly string[] = [],
): DispatchedOperationApplication {
  return {
    model: run.model,
    inverse: run.applications.slice().reverse().flatMap(({ inverse }) => inverse),
    redo: {
      op: input.op,
      params: {
        ...input.params,
        ...(run.compiledSplits.length === 0
          ? {}
          : { compiledSplits: run.compiledSplits }),
      },
    },
    affected: [...new Set([
      ...run.applications.flatMap(({ affected }) => affected),
      ...affectedExtra,
    ])],
    summary,
  };
}

function durationLabel(range: WordSourceRange): string {
  const samples = range.end.samples - range.start.samples;
  const milliseconds = BigInt(samples) * 1_000n;
  return milliseconds % BigInt(range.start.rate) === 0n
    ? `${String(milliseconds / BigInt(range.start.rate))} ms`
    : `${String(samples)}/${String(range.start.rate)} s`;
}

function excerpt(sidecar: TranscriptSidecar, range: WordSourceRange): string {
  const words = range.wordIds.map((wordId) => sidecar.words[wordId]!.text);
  const display = words.length <= 8
    ? words.join(" ")
    : `${words.slice(0, 4).join(" ")} … ${words.slice(-3).join(" ")}`;
  return `“${display}” (${range.wordRange.fromWord}–${range.wordRange.toWord})`;
}

function removeWordRange(
  project: GuyditorProject,
  input: OperationInput,
  sidecars: readonly TranscriptSidecar[],
  idFactory: RangeOperationIdFactory,
): Result<DispatchedOperationApplication> {
  const wordRange = input.params["wordRange"] as TranscriptWordRange;
  const paddingMs = (input.params["paddingMs"] as number | undefined) ?? 120;
  const snapPolicy = (input.params["snapPolicy"] as WordSourceRange["snapPolicy"] | undefined) ?? "none";
  const range = mappedRange(project, sidecars, wordRange, paddingMs, snapPolicy);
  if (!range.ok) return range;
  const sequenceId = removalSequenceId(project, input);
  if (!sequenceId.ok) return sequenceId;
  const sequence = project.sequences.find(({ id }) => id === sequenceId.value);
  if (sequence === undefined) {
    return operationFailure("E_OP_NOT_FOUND", `Sequence ${sequenceId.value} does not exist.`, [sequenceId.value]);
  }
  const replay = (input.params["compiledSplits"] as CompiledSplit[] | undefined) ?? [];
  const run: PrimitiveRun = { model: project, applications: [], compiledSplits: [] };
  for (const clip of sequence.clips.filter(({ asset }) => asset === range.value.assetId)) {
    const start = sampleToFrame(range.value.start, clip.source.in.fps);
    if (!start.ok) return start;
    const end = sampleToFrame(range.value.end, clip.source.in.fps);
    if (!end.ok) return end;
    const interval = {
      start: Math.max(clip.source.in.frames, start.value),
      end: Math.min(clip.source.out.frames, end.value),
    };
    if (interval.start >= interval.end) continue;
    const removed = removeInterval(run, clip.id, interval, idFactory, replay);
    if (!removed.ok) return removed;
  }
  if (run.applications.length === 0) {
    return operationFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `The word range has no editable instance in sequence ${sequence.id}.`,
      [range.value.assetId, wordRange.fromWord, wordRange.toWord],
    );
  }
  const sidecar = sidecars.find(({ assetId }) => assetId === range.value.assetId)!;
  return success(compositeApplication(
    input,
    run,
    `Remove ${excerpt(sidecar, range.value)} (${durationLabel(range.value)})`,
    [wordRange.fromWord, wordRange.toWord],
  ));
}

function mergeIntervals(intervals: readonly FrameInterval[]): FrameInterval[] {
  const sorted = intervals.slice().sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: FrameInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || interval.start > previous.end) merged.push({ ...interval });
    else previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

function complement(
  start: number,
  end: number,
  retained: readonly FrameInterval[],
): FrameInterval[] {
  const removed: FrameInterval[] = [];
  let cursor = start;
  for (const interval of retained) {
    if (cursor < interval.start) removed.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < end) removed.push({ start: cursor, end });
  return removed;
}

function retainWordRanges(
  project: GuyditorProject,
  input: OperationInput,
  sidecars: readonly TranscriptSidecar[],
  idFactory: RangeOperationIdFactory,
): Result<DispatchedOperationApplication> {
  const scope = input.params["scope"] as { sequenceId: string };
  const wordRanges = input.params["wordRanges"] as TranscriptWordRange[];
  const sequence = project.sequences.find(({ id }) => id === scope.sequenceId);
  if (sequence === undefined) {
    return operationFailure("E_OP_NOT_FOUND", `Sequence ${scope.sequenceId} does not exist.`, [scope.sequenceId]);
  }
  const sidecarByAsset = new Map(sidecars.map((sidecar) => [sidecar.assetId, sidecar]));
  const missing = sequence.clips.filter(({ asset }) => !sidecarByAsset.has(asset));
  if (missing.length > 0) {
    return operationFailure(
      "E_OP_NO_TRANSCRIPT",
      `Retain requires a canonical transcript for every clip asset in ${scope.sequenceId}.`,
      missing.map(({ id }) => id),
    );
  }
  const ranges: WordSourceRange[] = [];
  for (const wordRange of wordRanges) {
    const mapped = mappedRange(project, sidecars, wordRange, 0, "none");
    if (!mapped.ok) return mapped;
    ranges.push(mapped.value);
  }
  const replay = (input.params["compiledSplits"] as CompiledSplit[] | undefined) ?? [];
  const run: PrimitiveRun = { model: project, applications: [], compiledSplits: [] };
  for (const clip of sequence.clips) {
    const retained: FrameInterval[] = [];
    for (const range of ranges.filter(({ assetId }) => assetId === clip.asset)) {
      const start = sampleToFrame(range.start, clip.source.in.fps);
      if (!start.ok) return start;
      const end = sampleToFrame(range.end, clip.source.in.fps);
      if (!end.ok) return end;
      const interval = {
        start: Math.max(clip.source.in.frames, start.value),
        end: Math.min(clip.source.out.frames, end.value),
      };
      if (interval.start < interval.end) retained.push(interval);
    }
    const removals = complement(
      clip.source.in.frames,
      clip.source.out.frames,
      mergeIntervals(retained),
    ).reverse();
    for (const interval of removals) {
      const removed = removeInterval(run, clip.id, interval, idFactory, replay);
      if (!removed.ok) return removed;
    }
  }
  if (run.applications.length === 0) {
    return operationFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      "Retain did not remove any material from the scoped sequence.",
      [scope.sequenceId],
    );
  }
  const total = ranges.reduce((samples, range) => {
    const seconds = absoluteSeconds({
      samples: range.end.samples - range.start.samples,
      rate: range.start.rate,
    });
    return seconds.ok ? [...samples, seconds.value] : samples;
  }, [] as string[]);
  return success(compositeApplication(
    input,
    run,
    `Retain only ${String(wordRanges.length)} passages (${total.join(" + ")}) in ${sequence.name}`,
    [scope.sequenceId, ...wordRanges.flatMap(({ fromWord, toWord }) => [fromWord, toWord])],
  ));
}

function createClipFromRange(
  project: GuyditorProject,
  input: OperationInput,
  sidecars: readonly TranscriptSidecar[],
  idFactory: RangeOperationIdFactory,
): Result<DispatchedOperationApplication> {
  const wordRange = input.params["wordRange"] as TranscriptWordRange;
  const range = mappedRange(project, sidecars, wordRange, 0, "none");
  if (!range.ok) return range;
  const layerId = input.params["targetLayerId"] as string;
  const layer = project.layers.find(({ id }) => id === layerId);
  if (layer?.sequence === undefined) {
    return operationFailure(
      "E_OP_NOT_FOUND",
      `Target layer ${layerId} does not own a sequence.`,
      [layerId],
    );
  }
  if (layer.locked) {
    return operationFailure("E_OP_LAYER_LOCKED", `Layer ${layerId} is locked.`, [layerId]);
  }
  const sequence = project.sequences.find(({ id }) => id === layer.sequence);
  const targetIndex = input.params["targetIndex"] as number;
  if (sequence === undefined || targetIndex > sequence.clips.length) {
    return operationFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `Target index ${String(targetIndex)} is outside layer ${layerId}.`,
      [layerId],
    );
  }
  const asset = project.assets.find(({ id }) => id === range.value.assetId);
  const fps = asset?.probe.fps ?? project.settings.timeline.fps;
  const start = sampleToFrame(range.value.start, fps);
  if (!start.ok) return start;
  const end = sampleToFrame(range.value.end, fps);
  if (!end.ok) return end;
  const clip: Clip = {
    id: (input.params["createdClipId"] as string | undefined) ?? idFactory("clp"),
    asset: range.value.assetId,
    source: {
      in: { frames: start.value, fps },
      out: { frames: end.value, fps },
    },
  };
  const restored = applyClipOperation(project, {
    op: "clip.restore",
    params: { sequenceId: sequence.id, targetIndex, clips: [clip] },
  }, (prefix) => idFactory(prefix));
  if (!restored.ok) return restored;
  const sidecar = sidecars.find(({ assetId }) => assetId === range.value.assetId)!;
  return success({
    model: restored.value.model,
    inverse: restored.value.inverse,
    redo: {
      op: input.op,
      params: { ...input.params, createdClipId: clip.id },
    },
    affected: [clip.id, layerId, wordRange.fromWord, wordRange.toWord],
    summary: `Create clip from ${excerpt(sidecar, range.value)}`,
  });
}

function shortCandidate(
  project: GuyditorProject,
  input: OperationInput,
  sidecars: readonly TranscriptSidecar[],
  idFactory: RangeOperationIdFactory,
): Result<DispatchedOperationApplication> {
  const removeCandidateId = input.params["removeCandidateId"] as string | undefined;
  if (removeCandidateId !== undefined) {
    return applyDeliverableOperation(project, {
      op: "deliverable.remove",
      params: { deliverableId: removeCandidateId },
    }, idFactory);
  }
  const wordRange = input.params["wordRange"] as TranscriptWordRange;
  const range = mappedRange(project, sidecars, wordRange, 0, "none");
  if (!range.ok) return range;
  const sidecar = sidecars.find(({ assetId }) => assetId === range.value.assetId)!;
  const name = (input.params["title"] as string | undefined) ??
    `Short candidate: ${excerpt(sidecar, range.value)}`;
  const fps = project.settings.timeline.fps;
  const start = sampleToFrame(range.value.start, fps);
  if (!start.ok) return start;
  const end = sampleToFrame(range.value.end, fps);
  if (!end.ok) return end;
  const longformSequenceId = primarySequenceId(project);
  if (!longformSequenceId.ok) return longformSequenceId;
  const longformClipId = project.sequences
    .find(({ id }) => id === longformSequenceId.value)
    ?.clips.find((clip) =>
      clip.asset === range.value.assetId &&
      clip.source.in.frames <= start.value && clip.source.out.frames >= end.value)?.id;
  const created = input.params["created"] as {
    deliverableId: string;
    sequenceId: string;
    layerId: string;
    additionalLayerIds?: string[];
    captionsTrackId: string;
    clipIds: string[];
  } | undefined;
  const application = applyDeliverableOperation(project, {
    op: "deliverable.derive",
    params: {
      kind: "short",
      name,
      profile: (input.params["profile"] as string | undefined) ?? "youtube-shorts@1.0.0",
      from: { words: { startWordId: wordRange.fromWord, endWordId: wordRange.toWord } },
      resolvedSources: [{
        assetId: range.value.assetId,
        range: {
          start: { frames: start.value, fps },
          end: { frames: end.value, fps },
        },
        words: { startWordId: wordRange.fromWord, endWordId: wordRange.toWord },
        ...(longformClipId === undefined ? {} : { longformClipId }),
      }],
      ...(created === undefined ? {} : { created }),
    },
  }, idFactory);
  if (!application.ok) return application;
  const captured = application.value.redo?.params["created"];
  return success({
    ...application.value,
    inverse: application.value.inverse,
    redo: { op: input.op, params: { ...input.params, created: captured } },
    affected: [...application.value.affected, wordRange.fromWord, wordRange.toWord],
    summary: `Mark ${excerpt(sidecar, range.value)} as short-form candidate`,
  });
}

export function applyTranscriptRangeOperation(
  project: GuyditorProject,
  input: OperationInput,
  sidecars: readonly TranscriptSidecar[],
  idFactory: RangeOperationIdFactory,
): Result<DispatchedOperationApplication> | undefined {
  switch (input.op) {
    case "transcript.range.remove":
      return removeWordRange(project, input, sidecars, idFactory);
    case "transcript.range.retain":
      return retainWordRanges(project, input, sidecars, idFactory);
    case "transcript.range.createClip":
      return createClipFromRange(project, input, sidecars, idFactory);
    case "transcript.range.shortCandidate":
      return shortCandidate(project, input, sidecars, idFactory);
    default:
      return undefined;
  }
}
