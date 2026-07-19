import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import { deriveTimeline } from "../project/derive.js";
import type {
  Clip,
  GuyditorProject,
} from "../project/model.js";
import {
  absoluteSeconds,
  compareRational,
  compareTime,
  convertTimeRounding,
  subRational,
} from "../time/index.js";
import type {
  FrameTime,
  Rational,
  TimeValue,
} from "../time/index.js";
import { parseRationalParts } from "../time/rational.js";
import { parseAnchor } from "./parser.js";
import type {
  AnchorRange,
  AnchorResolution,
  AnchorResolverDependencies,
  ParsedAnchor,
  ResolvedAnchorRange,
} from "./types.js";

function anchorFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function orphaned(reason: NonNullable<AnchorResolution["reason"]>): AnchorResolution {
  return { status: "orphaned", reason };
}

function primaryScope(project: GuyditorProject): Result<string> {
  const deliverable = project.deliverables.find(
    ({ id }) => id === project.settings.primaryDeliverable,
  );
  return deliverable === undefined
    ? anchorFailure(
        "E_ANCHOR_SCOPE",
        "The primary deliverable does not provide an anchor resolution scope.",
        [project.settings.primaryDeliverable],
      )
    : success(deliverable.sequenceId);
}

function timelineDurationFrames(
  project: GuyditorProject,
  sequenceId: string,
): Result<FrameTime> {
  const derived = deriveTimeline(project, sequenceId);
  if (!derived.ok) return derived;
  return secondsToFrames(derived.value.duration, project.settings.timeline.fps);
}

function secondsToFrames(seconds: Rational, fps: Rational): Result<FrameTime> {
  const parts = parseRationalParts(seconds);
  if (!parts.ok) return parts;
  const converted = convertTimeRounding({
    frames: Number(parts.value.numerator),
    fps: `${parts.value.denominator.toString()}/1`,
  }, fps);
  return converted.ok ? success(converted.value.time) : converted;
}

function convertValueToFrames(value: TimeValue, fps: Rational): Result<FrameTime> {
  const input: FrameTime = "frames" in value
    ? value
    : { frames: value.samples, fps: `${String(value.rate)}/1` };
  const converted = convertTimeRounding(input, fps);
  return converted.ok ? success(converted.value.time) : converted;
}

function isInsideDuration(position: FrameTime, duration: FrameTime): Result<boolean> {
  const zero = compareTime(position, { frames: 0, fps: position.fps });
  if (!zero.ok) return zero;
  const end = compareTime(position, duration);
  return end.ok ? success(zero.value >= 0 && end.value <= 0) : end;
}

function addFrames(base: FrameTime, offset: number): Result<FrameTime> {
  const frames = BigInt(base.frames) + BigInt(offset);
  if (frames < BigInt(-Number.MAX_SAFE_INTEGER) || frames > BigInt(Number.MAX_SAFE_INTEGER)) {
    return anchorFailure("E_TIME_OVERFLOW", "The anchor offset exceeds the safe frame range.");
  }
  return success({ frames: Number(frames), fps: base.fps });
}

async function applyOffset(
  project: GuyditorProject,
  sequenceId: string,
  resolution: AnchorResolution,
  offset: number,
): Promise<Result<AnchorResolution>> {
  if (resolution.status === "orphaned" || offset === 0) return success(resolution);
  const timeline = resolution.timeline;
  if (timeline === undefined) {
    return anchorFailure("E_ANCHOR_RESOLUTION", "A resolved anchor has no timeline position.");
  }
  const shifted = addFrames(timeline, offset);
  if (!shifted.ok) return shifted;
  const duration = timelineDurationFrames(project, sequenceId);
  if (!duration.ok) return duration;
  const inside = isInsideDuration(shifted.value, duration.value);
  if (!inside.ok) return inside;
  return success(inside.value
    ? { ...resolution, timeline: shifted.value }
    : orphaned("beyond-timeline"));
}

function sourceRangeLength(clip: Clip): Result<number> {
  const sourceIn = convertTimeRounding(clip.source.in, clip.source.out.fps);
  if (!sourceIn.ok) return sourceIn;
  const frames = BigInt(clip.source.out.frames) - BigInt(sourceIn.value.time.frames);
  return frames < 0n || frames > BigInt(Number.MAX_SAFE_INTEGER)
    ? anchorFailure("E_TIME_OVERFLOW", `Clip ${clip.id} has an invalid source range.`, [clip.id])
    : success(Number(frames));
}

async function resolveTimeline(
  project: GuyditorProject,
  parsed: Extract<ParsedAnchor, { kind: "timeline" }>,
  requestedScope: string,
): Promise<Result<{ resolution: AnchorResolution; sequenceId: string }>> {
  const sequenceId = "sequenceId" in parsed ? parsed.sequenceId : requestedScope;
  const derived = deriveTimeline(project, sequenceId);
  if (!derived.ok) return derived;
  const timeline = "fps" in parsed
    ? convertTimeRounding(
        { frames: parsed.frames, fps: parsed.fps },
        project.settings.timeline.fps,
      )
    : success({
        time: { frames: parsed.frames, fps: project.settings.timeline.fps },
        preRoundingFrames: `${String(parsed.frames)}/1`,
      });
  if (!timeline.ok) return timeline;
  const duration = secondsToFrames(derived.value.duration, project.settings.timeline.fps);
  if (!duration.ok) return duration;
  const inside = isInsideDuration(timeline.value.time, duration.value);
  if (!inside.ok) return inside;
  return success({
    sequenceId,
    resolution: inside.value
      ? { status: "resolved", timeline: timeline.value.time }
      : orphaned("beyond-timeline"),
  });
}

async function resolveClip(
  project: GuyditorProject,
  parsed: Extract<ParsedAnchor, { kind: "clip" }>,
  sequenceId: string,
): Promise<Result<AnchorResolution>> {
  const sequence = project.sequences.find(({ id }) => id === sequenceId);
  const clip = sequence?.clips.find(({ id }) => id === parsed.clipId);
  if (clip === undefined) return success(orphaned("clip-deleted"));
  const derived = deriveTimeline(project, sequenceId);
  if (!derived.ok) return derived;
  const derivedClip = derived.value.clips.find(({ clipId }) => clipId === clip.id);
  if (derivedClip === undefined) return success(orphaned("clip-deleted"));

  const sourceOffset = convertTimeRounding(
    { frames: parsed.offset, fps: project.settings.timeline.fps },
    clip.source.in.fps,
  );
  if (!sourceOffset.ok) return sourceOffset;
  const length = sourceRangeLength(clip);
  if (!length.ok) return length;
  const checkedRelative = BigInt(parsed.sourceFrame) +
    BigInt(sourceOffset.value.time.frames);
  if (checkedRelative < 0n || checkedRelative >= BigInt(length.value)) {
    return success(orphaned("offset-out-of-range"));
  }

  const relativeTimeline = convertTimeRounding(
    { frames: parsed.sourceFrame, fps: clip.source.in.fps },
    project.settings.timeline.fps,
  );
  if (!relativeTimeline.ok) return relativeTimeline;
  const timeline = addFrames(derivedClip.start, relativeTimeline.value.time.frames);
  if (!timeline.ok) return timeline;
  const source = addFrames(clip.source.in, parsed.sourceFrame);
  if (!source.ok) return source;
  return applyOffset(project, sequenceId, {
    status: "resolved",
    timeline: timeline.value,
    source: { assetId: clip.asset, time: source.value },
  }, parsed.offset);
}

async function containsSourceStart(clip: Clip, start: TimeValue): Promise<Result<boolean>> {
  const startSeconds = absoluteSeconds(start);
  if (!startSeconds.ok) return startSeconds;
  const inSeconds = absoluteSeconds(clip.source.in);
  if (!inSeconds.ok) return inSeconds;
  const outSeconds = absoluteSeconds(clip.source.out);
  if (!outSeconds.ok) return outSeconds;
  const afterIn = compareRational(startSeconds.value, inSeconds.value);
  if (!afterIn.ok) return afterIn;
  const beforeOut = compareRational(startSeconds.value, outSeconds.value);
  return beforeOut.ok
    ? success(afterIn.value >= 0 && beforeOut.value < 0)
    : beforeOut;
}

async function resolveWord(
  project: GuyditorProject,
  parsed: Extract<ParsedAnchor, { kind: "word" }>,
  sequenceId: string,
  dependencies: AnchorResolverDependencies,
): Promise<Result<AnchorResolution>> {
  const located = dependencies.wordLookup === undefined
    ? success(undefined)
    : await dependencies.wordLookup.resolveWord(project, parsed.wordId);
  if (!located.ok) return located;
  if (located.value === undefined) return success(orphaned("word-deleted"));

  const sequence = project.sequences.find(({ id }) => id === sequenceId);
  if (sequence === undefined) {
    return anchorFailure("E_SEQUENCE_NOT_FOUND", `Sequence ${sequenceId} does not exist.`, [sequenceId]);
  }
  const derived = deriveTimeline(project, sequenceId);
  if (!derived.ok) return derived;
  let selected: Clip | undefined;
  for (const derivedClip of derived.value.clips) {
    const clip = sequence.clips.find(({ id }) => id === derivedClip.clipId);
    if (clip === undefined || clip.asset !== located.value.assetId) continue;
    const contains = await containsSourceStart(clip, located.value.start);
    if (!contains.ok) return contains;
    if (contains.value) {
      selected = clip;
      break;
    }
  }
  if (selected === undefined) return success(orphaned("word-not-in-edit"));

  const selectedDerived = derived.value.clips.find(({ clipId }) => clipId === selected!.id)!;
  const edge = parsed.edge === "end" ? located.value.end : located.value.start;
  const edgeSeconds = absoluteSeconds(edge);
  if (!edgeSeconds.ok) return edgeSeconds;
  const clipInSeconds = absoluteSeconds(selected.source.in);
  if (!clipInSeconds.ok) return clipInSeconds;
  const relativeSeconds = subRational(edgeSeconds.value, clipInSeconds.value);
  if (!relativeSeconds.ok) return relativeSeconds;
  const relative = secondsToFrames(relativeSeconds.value, project.settings.timeline.fps);
  if (!relative.ok) return relative;
  const timeline = addFrames(selectedDerived.start, relative.value.frames);
  if (!timeline.ok) return timeline;
  const source = convertValueToFrames(edge, selected.source.in.fps);
  if (!source.ok) return source;

  return applyOffset(project, sequenceId, {
    status: "resolved",
    timeline: timeline.value,
    ...(located.value.approximate ? { approximate: true } : {}),
    source: { assetId: located.value.assetId, time: source.value },
  }, parsed.offset);
}

async function resolveBeat(
  project: GuyditorProject,
  parsed: Extract<ParsedAnchor, { kind: "beat" }>,
  sequenceId: string,
  dependencies: AnchorResolverDependencies,
): Promise<Result<AnchorResolution>> {
  const beat = project.beats.find(({ id }) => id === parsed.beatId);
  if (beat === undefined) return success(orphaned("beat-orphaned"));
  const stored = parseAnchor(beat.anchor);
  if (!stored.ok) return stored;
  if (stored.value.kind === "beat" || stored.value.kind === "ann") {
    return success(orphaned("beat-orphaned"));
  }
  const resolution = await resolveParsed(project, stored.value, sequenceId, dependencies);
  if (!resolution.ok) return resolution;
  const resolvedSequenceId =
    stored.value.kind === "timeline" && "sequenceId" in stored.value
      ? stored.value.sequenceId
      : sequenceId;
  return resolution.value.status === "orphaned"
    ? success(orphaned("beat-orphaned"))
    : applyOffset(project, resolvedSequenceId, resolution.value, parsed.offset);
}

async function resolveAnnotation(
  project: GuyditorProject,
  parsed: Extract<ParsedAnchor, { kind: "ann" }>,
  sequenceId: string,
  dependencies: AnchorResolverDependencies,
): Promise<Result<AnchorResolution>> {
  if (dependencies.annotationResolver === undefined) {
    return success(orphaned("ann-orphaned"));
  }
  const resolution = await dependencies.annotationResolver.resolveAnnotation(
    project,
    parsed.annotationId,
    sequenceId,
  );
  return !resolution.ok
    ? resolution
    : success(resolution.value?.status === "resolved"
      ? resolution.value
      : orphaned("ann-orphaned"));
}

async function resolveParsed(
  project: GuyditorProject,
  parsed: ParsedAnchor,
  sequenceId: string,
  dependencies: AnchorResolverDependencies,
): Promise<Result<AnchorResolution>> {
  if (parsed.kind === "timeline") {
    const resolution = await resolveTimeline(project, parsed, sequenceId);
    return resolution.ok ? success(resolution.value.resolution) : resolution;
  }
  if (parsed.kind === "clip") return resolveClip(project, parsed, sequenceId);
  if (parsed.kind === "word") return resolveWord(project, parsed, sequenceId, dependencies);
  if (parsed.kind === "beat") return resolveBeat(project, parsed, sequenceId, dependencies);
  return resolveAnnotation(project, parsed, sequenceId, dependencies);
}

export async function resolveAnchor(
  project: GuyditorProject,
  anchor: string,
  scope: string | undefined = undefined,
  dependencies: AnchorResolverDependencies = {},
): Promise<Result<AnchorResolution>> {
  const parsed = parseAnchor(anchor);
  if (!parsed.ok) return parsed;
  const sequenceId = scope === undefined ? primaryScope(project) : success(scope);
  if (!sequenceId.ok) return sequenceId;
  return resolveParsed(project, parsed.value, sequenceId.value, dependencies);
}

export async function resolveAnchorRange(
  project: GuyditorProject,
  range: AnchorRange,
  scope: string | undefined = undefined,
  dependencies: AnchorResolverDependencies = {},
): Promise<Result<ResolvedAnchorRange>> {
  const start = await resolveAnchor(project, range.start, scope, dependencies);
  if (!start.ok) return start;
  const end = await resolveAnchor(project, range.end, scope, dependencies);
  if (!end.ok) return end;
  if (
    start.value.status === "resolved" &&
    end.value.status === "resolved" &&
    start.value.timeline !== undefined &&
    end.value.timeline !== undefined
  ) {
    const order = compareTime(start.value.timeline, end.value.timeline);
    if (!order.ok) return order;
    if (order.value !== -1) {
      return anchorFailure(
        "E_ANCHOR_RANGE",
        "AnchorRange.end must resolve strictly after AnchorRange.start.",
      );
    }
  }
  return success({ start: start.value, end: end.value });
}
