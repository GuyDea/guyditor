import { createHash } from "node:crypto";

import type {
  AnchorResolution,
  AnchorResolverDependencies,
  AnnotationResolver,
} from "../anchors/index.js";
import { resolveAnchor } from "../anchors/index.js";
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
} from "../project/index.js";
import {
  compareTime,
  convertTimeRounding,
} from "../time/index.js";
import type {
  FrameTime,
  TimeValue,
} from "../time/index.js";
import { serializeAnnotationSidecar } from "./sidecar.js";
import type {
  Annotation,
  AnnotationAnchor,
  AnnotationSidecar,
  SourceTime,
} from "./types.js";

export interface ObjectTrackLookup {
  hasTrack(
    project: GuyditorProject,
    trackId: string,
    assetId: string,
  ): Result<boolean> | Promise<Result<boolean>>;
}

export interface AnnotationAnchorResolverDependencies extends AnchorResolverDependencies {
  objectTrackLookup?: ObjectTrackLookup;
}

function resolverFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function orphaned(reason: NonNullable<AnchorResolution["reason"]>): AnchorResolution {
  return { status: "orphaned", reason };
}

function frameValue(value: TimeValue, fps: string): Result<FrameTime> {
  const input: FrameTime = "frames" in value
    ? value
    : { frames: value.samples, fps: `${String(value.rate)}/1` };
  const converted = convertTimeRounding(input, fps);
  return converted.ok ? success(converted.value.time) : converted;
}

function addFrames(left: FrameTime, right: FrameTime): Result<FrameTime> {
  const converted = convertTimeRounding(right, left.fps);
  if (!converted.ok) return converted;
  const frames = BigInt(left.frames) + BigInt(converted.value.time.frames);
  if (frames < 0n || frames > BigInt(Number.MAX_SAFE_INTEGER)) {
    return resolverFailure("E_TIME_OVERFLOW", "Annotation anchor time is outside the safe frame range.");
  }
  return success({ frames: Number(frames), fps: left.fps });
}

async function insideSourceRange(clip: Clip, source: FrameTime): Promise<Result<boolean>> {
  const at = convertTimeRounding(source, clip.source.in.fps);
  if (!at.ok) return at;
  const afterIn = compareTime(at.value.time, clip.source.in);
  if (!afterIn.ok) return afterIn;
  const beforeOut = compareTime(at.value.time, clip.source.out);
  return beforeOut.ok
    ? success(afterIn.value >= 0 && beforeOut.value < 0)
    : beforeOut;
}

async function sourcePosition(
  project: GuyditorProject,
  sequenceId: string,
  assetId: string,
  source: FrameTime,
  preferredClipId?: string,
): Promise<Result<AnchorResolution>> {
  const sequence = project.sequences.find(({ id }) => id === sequenceId);
  if (sequence === undefined) return success(orphaned("clip-deleted"));
  const derived = deriveTimeline(project, sequenceId);
  if (!derived.ok) return derived;
  const preferred = preferredClipId === undefined
    ? undefined
    : sequence.clips.find((clip) =>
        clip.id === preferredClipId && clip.asset === assetId);

  let selected: Clip | undefined;
  let approximate = false;
  let selectedSource = source;
  if (preferred !== undefined) {
    const inside = await insideSourceRange(preferred, source);
    if (!inside.ok) return inside;
    selected = preferred;
    if (!inside.value) {
      const converted = convertTimeRounding(source, preferred.source.in.fps);
      if (!converted.ok) return converted;
      const nearest = converted.value.time.frames < preferred.source.in.frames
        ? preferred.source.in.frames
        : preferred.source.out.frames - 1;
      selectedSource = { frames: nearest, fps: preferred.source.in.fps };
      approximate = true;
    }
  } else {
    for (const derivedClip of derived.value.clips) {
      const clip = sequence.clips.find(({ id }) => id === derivedClip.clipId);
      if (clip === undefined || clip.asset !== assetId) continue;
      const inside = await insideSourceRange(clip, source);
      if (!inside.ok) return inside;
      if (inside.value) {
        selected = clip;
        break;
      }
    }
  }
  if (selected === undefined) return success(orphaned("clip-deleted"));
  const selectedDerived = derived.value.clips.find(({ clipId }) => clipId === selected!.id);
  if (selectedDerived === undefined) return success(orphaned("clip-deleted"));
  const convertedSource = convertTimeRounding(selectedSource, selected.source.in.fps);
  if (!convertedSource.ok) return convertedSource;
  const relativeSource: FrameTime = {
    frames: convertedSource.value.time.frames - selected.source.in.frames,
    fps: selected.source.in.fps,
  };
  const relativeTimeline = convertTimeRounding(relativeSource, project.settings.timeline.fps);
  if (!relativeTimeline.ok) return relativeTimeline;
  const timelineFrames = BigInt(selectedDerived.start.frames) +
    BigInt(relativeTimeline.value.time.frames);
  if (timelineFrames < 0n || timelineFrames > BigInt(Number.MAX_SAFE_INTEGER)) {
    return resolverFailure("E_TIME_OVERFLOW", "Resolved annotation timeline frame overflows.");
  }
  return success({
    status: "resolved",
    timeline: { frames: Number(timelineFrames), fps: project.settings.timeline.fps },
    ...(approximate ? { approximate: true } : {}),
    source: { assetId, time: convertedSource.value.time },
  });
}

async function resolveWordAnchor(
  project: GuyditorProject,
  anchor: Extract<AnnotationAnchor, { kind: "word" }>,
  sequenceId: string,
  dependencies: AnnotationAnchorResolverDependencies,
): Promise<Result<AnchorResolution>> {
  const word = dependencies.wordLookup === undefined
    ? success(undefined)
    : await dependencies.wordLookup.resolveWord(project, anchor.wordId);
  if (!word.ok) return word;
  if (word.value === undefined) return success(orphaned("word-deleted"));
  if (word.value.approximate) return success(orphaned("word-deleted"));
  const asset = project.assets.find(({ id }) => id === word.value!.assetId);
  const fps = asset?.probe.fps ?? asset?.video?.fps ??
    project.sequences.flatMap(({ clips }) => clips)
      .find(({ asset: candidate }) => candidate === word.value!.assetId)?.source.in.fps;
  if (fps === undefined) return success(orphaned("word-not-in-edit"));
  const start = frameValue(word.value.start, fps);
  if (!start.ok) return start;
  const at = anchor.offset === undefined ? start : addFrames(start.value, anchor.offset);
  if (!at.ok) return at;
  const resolution = await sourcePosition(
    project,
    sequenceId,
    word.value.assetId,
    at.value,
  );
  return resolution.ok && resolution.value.status === "orphaned"
    ? success(orphaned("word-not-in-edit"))
    : resolution;
}

async function resolveBeatAnchor(
  project: GuyditorProject,
  anchor: Extract<AnnotationAnchor, { kind: "beat" }>,
  sequenceId: string,
  dependencies: AnnotationAnchorResolverDependencies,
): Promise<Result<AnchorResolution>> {
  const resolved = await resolveAnchor(
    project,
    `beat:${anchor.beatId}`,
    sequenceId,
    dependencies,
  );
  if (!resolved.ok || resolved.value.status === "orphaned" || anchor.offset === undefined) {
    return resolved;
  }
  if (resolved.value.timeline === undefined) {
    return resolverFailure("E_ANCHOR_RESOLUTION", "Resolved beat anchor has no timeline frame.");
  }
  const timeline = addFrames(resolved.value.timeline, anchor.offset);
  return timeline.ok
    ? success({ ...resolved.value, timeline: timeline.value })
    : timeline;
}

async function resolveTimelineAnchor(
  project: GuyditorProject,
  anchor: Extract<AnnotationAnchor, { kind: "timeline" }>,
  dependencies: AnnotationAnchorResolverDependencies,
): Promise<Result<AnchorResolution>> {
  const converted = convertTimeRounding(anchor.frame, project.settings.timeline.fps);
  if (!converted.ok) return converted;
  return resolveAnchor(
    project,
    `timeline:${anchor.sequenceId}@${String(converted.value.time.frames)}`,
    anchor.sequenceId,
    dependencies,
  );
}

export async function resolveAnnotationRecord(
  project: GuyditorProject,
  annotation: Annotation,
  sequenceId: string = annotation.canvasRef.sequenceId,
  dependencies: AnnotationAnchorResolverDependencies = {},
): Promise<Result<AnchorResolution>> {
  const anchor = annotation.anchor;
  switch (anchor.kind) {
    case "clip":
      return sourcePosition(
        project,
        sequenceId,
        anchor.assetId,
        anchor.sourceFrame,
        anchor.clipId,
      );
    case "word":
      return resolveWordAnchor(project, anchor, sequenceId, dependencies);
    case "object": {
      if (dependencies.objectTrackLookup === undefined) {
        return success(orphaned("clip-deleted"));
      }
      const exists = await dependencies.objectTrackLookup.hasTrack(
        project,
        anchor.trackId,
        anchor.assetId,
      );
      if (!exists.ok) return exists;
      if (!exists.value) return success(orphaned("clip-deleted"));
      return sourcePosition(project, sequenceId, anchor.assetId, anchor.sourceFrame);
    }
    case "beat":
      return resolveBeatAnchor(project, anchor, sequenceId, dependencies);
    case "timeline":
      return resolveTimelineAnchor(project, anchor, dependencies);
  }
}

function sidecarHash(sidecar: AnnotationSidecar): string {
  return createHash("sha256").update(serializeAnnotationSidecar(sidecar)).digest("hex");
}

export function createAnnotationAnchorResolver(
  sidecars: readonly AnnotationSidecar[],
  dependencies: AnnotationAnchorResolverDependencies = {},
): AnnotationResolver {
  return {
    async resolveAnnotation(project, annotationId, sequenceId) {
      const variants = sidecars.map((sidecar) => ({
        sidecar,
        sha256: sidecarHash(sidecar),
      }));
      const reference = project.sidecars.find(({ name }) =>
        name === project.annotations.sidecar);
      const annotationReference = reference?.schema === "guyditor.annotations/v1"
        ? reference
        : undefined;
      const selected = annotationReference === undefined
        ? undefined
        : variants.find(({ sha256 }) => sha256 === annotationReference.sha256)?.sidecar;
      const annotation = selected?.annotations.find(({ id }) => id === annotationId);
      return annotation === undefined
        ? success(undefined)
        : resolveAnnotationRecord(project, annotation, sequenceId, dependencies);
    },
  };
}

export function annotationLastResolved(
  annotation: Annotation,
): { sequenceId: string; timelineFrame: SourceTime } | undefined {
  return annotation.orphan?.lastResolved;
}
