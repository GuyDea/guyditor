import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import type { WordLookup } from "../anchors/index.js";
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
  Layer,
} from "../project/index.js";
import type { ProjectStore } from "../store/index.js";
import {
  absoluteSeconds,
  convertTimeRounding,
  subRational,
} from "../time/index.js";
import type {
  FrameTime,
  TimeValue,
} from "../time/index.js";
import { parseRationalParts } from "../time/rational.js";
import { resolveAnnotationRecord } from "./resolver.js";
import { AnnotationService } from "./service.js";
import type { Annotation } from "./types.js";

export type DataClass =
  | "metadata"
  | "prompt"
  | "transcript"
  | "frames"
  | "audio"
  | "video";

export interface AnnotationTranscriptWord {
  id: string;
  text: string;
  assetId: string;
  start: TimeValue;
  end: TimeValue;
}

export interface AnnotationTranscriptSource extends WordLookup {
  listWords(
    project: GuyditorProject,
    assetId: string,
  ): Result<AnnotationTranscriptWord[]> |
    Promise<Result<AnnotationTranscriptWord[]>>;
}

export interface AnnotationContextProject {
  store: ProjectStore;
  transcript?: AnnotationTranscriptSource;
  now?: () => Date;
}

export interface AnnotationContextPackage {
  requestedFor: { annotationId?: string; anchor: string };
  revision: string;
  proposalId?: string;
  builtAt: string;
  position: { sequenceId: string; timelineFrame: FrameTime; approximate: boolean };
  files: {
    markedFrame?: string;
    cleanFrame: string;
    proxyClip?: string;
    audioExcerpt?: string;
  };
  clip?: { startTimelineFrame: FrameTime; durationMs: number; truncated: boolean };
  clipPending?: string;
  transcript: {
    words: Array<{
      id: string;
      text: string;
      startMs: number;
      endMs: number;
      anchor?: true;
    }>;
  };
  layers: unknown[];
  annotation?: Annotation;
  dataClasses: DataClass[];
}

export interface FrameExtractionLayerRequest {
  layerId: string;
  proxyPath: string;
  frameIndex: number;
}

export interface FrameExtractionRequest {
  kind: "frame-extraction";
  sequenceId: string;
  timelineFrame: FrameTime;
  layers: FrameExtractionLayerRequest[];
  overlay?: { annotationId: string };
}

export interface NearbyFramesExtractionRequest {
  kind: "nearby-frame-extraction";
  sequenceId: string;
  frames: FrameExtractionRequest[];
}

interface VisibleLayer {
  metadata: {
    layerId: string;
    zOrder: number;
    type: Layer["kind"];
    clipId: string;
    assetId: string;
    enabled: boolean;
    locked: boolean;
    opacity: number;
    effectiveTransform: unknown;
    boundingBox: { x: number; y: number; width: number; height: number };
    effects: unknown[];
  };
  request: FrameExtractionLayerRequest;
  clip: Clip;
}

function contextFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function roundedRatio(numerator: bigint, denominator: bigint): number {
  let floor = numerator / denominator;
  let remainder = numerator % denominator;
  if (remainder < 0n) {
    floor -= 1n;
    remainder += denominator;
  }
  const rounded = remainder * 2n <= denominator ? floor : floor + 1n;
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) throw new RangeError("Context time conversion overflowed.");
  return value;
}

function secondsToFrames(seconds: string, fps: string): number {
  const time = parseRationalParts(seconds);
  const rate = parseRationalParts(fps);
  if (!time.ok || !rate.ok) throw new RangeError("Context duration has an invalid rational.");
  return roundedRatio(
    time.value.numerator * rate.value.numerator,
    time.value.denominator * rate.value.denominator,
  );
}

function milliseconds(time: string): number {
  const parts = parseRationalParts(time);
  if (!parts.ok) throw new RangeError("Context timestamp has an invalid rational.");
  return roundedRatio(parts.value.numerator * 1_000n, parts.value.denominator);
}

function defaultProxyPath(assetId: string, sha256: string): string {
  return posix.join(
    ".guyditor/cache/proxies",
    `${assetId}.${sha256.slice(0, 8)}.edit.mp4`,
  );
}

function timelineDurationFrames(project: GuyditorProject, sequenceId: string): Result<number> {
  const derived = deriveTimeline(project, sequenceId);
  if (!derived.ok) return derived;
  try {
    return success(secondsToFrames(derived.value.duration, project.settings.timeline.fps));
  } catch (error: unknown) {
    return contextFailure(
      "E_ANNCTX_TIME",
      error instanceof Error ? error.message : String(error),
      [sequenceId],
    );
  }
}

function containsTimelineFrame(
  start: FrameTime,
  duration: FrameTime,
  frame: number,
): boolean {
  return frame >= start.frames && frame < start.frames + duration.frames;
}

function sourceFrameFor(
  clip: Clip,
  derivedStart: FrameTime,
  timelineFrame: FrameTime,
): Result<FrameTime> {
  const offset: FrameTime = {
    frames: timelineFrame.frames - derivedStart.frames,
    fps: timelineFrame.fps,
  };
  const converted = convertTimeRounding(offset, clip.source.in.fps);
  if (!converted.ok) return converted;
  return success({
    frames: clip.source.in.frames + converted.value.time.frames,
    fps: clip.source.in.fps,
  });
}

function visibleLayers(
  project: GuyditorProject,
  sequenceId: string,
  timelineFrame: FrameTime,
): Result<VisibleLayer[]> {
  const sequence = project.sequences.find(({ id }) => id === sequenceId);
  if (sequence === undefined) {
    return contextFailure("E_SEQUENCE_NOT_FOUND", `Sequence ${sequenceId} does not exist.`, [sequenceId]);
  }
  const derived = deriveTimeline(project, sequenceId);
  if (!derived.ok) return derived;
  const active = derived.value.clips.find(({ start, duration }) =>
    containsTimelineFrame(start, duration, timelineFrame.frames));
  if (active === undefined) return success([]);
  const clip = sequence.clips.find(({ id }) => id === active.clipId);
  if (clip === undefined) return success([]);
  const sourceFrame = sourceFrameFor(clip, active.start, timelineFrame);
  if (!sourceFrame.ok) return sourceFrame;
  const asset = project.assets.find(({ id }) => id === clip.asset);
  if (asset === undefined) return success([]);
  return success(project.layers
    .filter((layer) =>
      layer.enabled && layer.sequence === sequenceId &&
      (layer.kind === "video" || layer.kind === "image" || layer.kind === "animation"))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((layer) => ({
      metadata: {
        layerId: layer.id,
        zOrder: layer.order,
        type: layer.kind,
        clipId: clip.id,
        assetId: asset.id,
        enabled: layer.enabled,
        locked: layer.locked,
        opacity: layer.opacity ?? 1,
        effectiveTransform: structuredClone(layer.transform ?? {}),
        boundingBox: { x: 0, y: 0, width: 1, height: 1 },
        effects: structuredClone(clip.effects ?? []),
      },
      request: {
        layerId: layer.id,
        proxyPath: defaultProxyPath(asset.id, asset.sha256),
        frameIndex: sourceFrame.value.frames,
      },
      clip,
    })));
}

function extractionRequest(
  project: GuyditorProject,
  sequenceId: string,
  timelineFrame: FrameTime,
  annotationId?: string,
): Result<FrameExtractionRequest> {
  const layers = visibleLayers(project, sequenceId, timelineFrame);
  if (!layers.ok) return layers;
  return success({
    kind: "frame-extraction",
    sequenceId,
    timelineFrame,
    layers: layers.value.map(({ request }) => request),
    ...(annotationId === undefined ? {} : { overlay: { annotationId } }),
  });
}

async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function clipForSource(
  project: GuyditorProject,
  sequenceId: string,
  assetId: string,
  source: FrameTime,
): Clip | undefined {
  const sequence = project.sequences.find(({ id }) => id === sequenceId);
  if (sequence === undefined) return undefined;
  return sequence.clips.find((clip) => {
    if (clip.asset !== assetId) return false;
    const converted = convertTimeRounding(source, clip.source.in.fps);
    if (!converted.ok) return false;
    return converted.value.time.frames >= clip.source.in.frames &&
      converted.value.time.frames < clip.source.out.frames;
  });
}

async function transcriptWindow(
  project: AnnotationContextProject,
  annotation: Annotation,
  sequenceId: string,
  source: { assetId: string; time: FrameTime } | undefined,
): Promise<Result<AnnotationContextPackage["transcript"]>> {
  if (project.transcript === undefined || source === undefined) {
    return success({ words: [] });
  }
  const listed = await project.transcript.listWords(
    project.store.currentProject,
    source.assetId,
  );
  if (!listed.ok) return listed;
  const clip = clipForSource(
    project.store.currentProject,
    sequenceId,
    source.assetId,
    source.time,
  );
  if (clip === undefined) return success({ words: [] });
  const anchorAt = convertTimeRounding(source.time, clip.source.in.fps);
  if (!anchorAt.ok) return anchorAt;
  const extent = convertTimeRounding(annotation.extent, clip.source.in.fps);
  if (!extent.ok) return extent;
  const anchorEnd = anchorAt.value.time.frames + extent.value.time.frames;
  const prepared: Array<{
    source: AnnotationTranscriptWord;
    start: FrameTime;
    end: FrameTime;
  }> = [];
  for (const word of listed.value) {
    const start = "frames" in word.start
      ? convertTimeRounding(word.start, clip.source.in.fps)
      : convertTimeRounding(
          { frames: word.start.samples, fps: `${String(word.start.rate)}/1` },
          clip.source.in.fps,
        );
    if (!start.ok) return start;
    const end = "frames" in word.end
      ? convertTimeRounding(word.end, clip.source.in.fps)
      : convertTimeRounding(
          { frames: word.end.samples, fps: `${String(word.end.rate)}/1` },
          clip.source.in.fps,
        );
    if (!end.ok) return end;
    prepared.push({ source: word, start: start.value.time, end: end.value.time });
  }
  prepared.sort((left, right) =>
    left.start.frames - right.start.frames || left.source.id.localeCompare(right.source.id));
  const before = prepared.filter(({ end }) => end.frames < anchorAt.value.time.frames).slice(-60);
  const inside = prepared.filter(({ start, end }) =>
    start.frames <= anchorEnd && end.frames >= anchorAt.value.time.frames).slice(0, 380);
  const after = prepared.filter(({ start }) => start.frames > anchorEnd).slice(0, 60);
  const selected = [...before, ...inside, ...after]
    .filter((entry, index, all) =>
      all.findIndex(({ source: word }) => word.id === entry.source.id) === index)
    .slice(0, 500);
  const anchorWordId = annotation.anchor.kind === "word"
    ? annotation.anchor.wordId
    : annotation.context?.nearestWordId;
  const clipStartSeconds = absoluteSeconds(clip.source.in);
  if (!clipStartSeconds.ok) return clipStartSeconds;
  const words: AnnotationContextPackage["transcript"]["words"] = [];
  for (const entry of selected) {
    const startSeconds = absoluteSeconds(entry.source.start);
    if (!startSeconds.ok) return startSeconds;
    const endSeconds = absoluteSeconds(entry.source.end);
    if (!endSeconds.ok) return endSeconds;
    const relativeStart = subRational(startSeconds.value, clipStartSeconds.value);
    if (!relativeStart.ok) return relativeStart;
    const relativeEnd = subRational(endSeconds.value, clipStartSeconds.value);
    if (!relativeEnd.ok) return relativeEnd;
    words.push({
      id: entry.source.id,
      text: entry.source.text,
      startMs: milliseconds(relativeStart.value),
      endMs: milliseconds(relativeEnd.value),
      ...(entry.source.id === anchorWordId ? { anchor: true } : {}),
    });
  }
  return success({ words });
}

function contextClip(
  project: GuyditorProject,
  sequenceId: string,
  position: FrameTime,
  extent: FrameTime,
): Result<NonNullable<AnnotationContextPackage["clip"]>> {
  const duration = timelineDurationFrames(project, sequenceId);
  if (!duration.ok) return duration;
  try {
    const pad = secondsToFrames("2/1", position.fps);
    const tenSeconds = secondsToFrames("10/1", position.fps);
    const twelveSeconds = secondsToFrames("12/1", position.fps);
    const convertedExtent = convertTimeRounding(extent, position.fps);
    if (!convertedExtent.ok) return convertedExtent;
    const anchorEnd = position.frames + convertedExtent.value.time.frames;
    const start = Math.max(0, position.frames - pad);
    let end = Math.min(duration.value, anchorEnd + pad);
    let truncated = false;
    if (end - start > twelveSeconds) {
      end = Math.min(duration.value, position.frames + tenSeconds);
      truncated = true;
    }
    const spanSeconds = absoluteSeconds({ frames: Math.max(0, end - start), fps: position.fps });
    if (!spanSeconds.ok) return spanSeconds;
    return success({
      startTimelineFrame: { frames: start, fps: position.fps },
      durationMs: milliseconds(spanSeconds.value),
      truncated,
    });
  } catch (error: unknown) {
    return contextFailure(
      "E_ANNCTX_TIME",
      error instanceof Error ? error.message : String(error),
      [sequenceId],
    );
  }
}

/**
 * Assemble the Part 8 §8.7 manifest without rendering media. The `files`
 * entries point to JSON frame-extraction requests containing proxy paths and
 * exact frame indices; Part 10/12 replaces those requests with PNG/MP4 output.
 */
export async function buildAnnotationContext(
  project: AnnotationContextProject,
  annotationId: string,
): Promise<Result<AnnotationContextPackage>> {
  const now = project.now ?? (() => new Date());
  const service = new AnnotationService({
    now,
    ...(project.transcript === undefined
      ? {}
      : { anchorResolvers: { wordLookup: project.transcript } }),
  });
  const loaded = await service.get(project.store, annotationId);
  if (!loaded.ok) return loaded;
  const annotation = loaded.value;
  if (annotation === undefined) {
    return contextFailure("E_ANN_NOT_FOUND", `Annotation ${annotationId} does not exist.`, [annotationId]);
  }
  const resolved = await resolveAnnotationRecord(
    project.store.currentProject,
    annotation,
    annotation.canvasRef.sequenceId,
    project.transcript === undefined ? {} : { wordLookup: project.transcript },
  );
  if (!resolved.ok) return resolved;
  const orphanPosition = annotation.orphan?.lastResolved;
  const timelineFrame = resolved.value.status === "resolved"
    ? resolved.value.timeline
    : orphanPosition?.timelineFrame;
  const sequenceId = resolved.value.status === "resolved"
    ? annotation.canvasRef.sequenceId
    : orphanPosition?.sequenceId;
  if (timelineFrame === undefined || sequenceId === undefined) {
    return contextFailure(
      "E_ANN_ORPHANED",
      `Annotation ${annotationId} has no last resolved position.`,
      [annotationId],
    );
  }
  const cleanRequest = extractionRequest(
    project.store.currentProject,
    sequenceId,
    timelineFrame,
  );
  if (!cleanRequest.ok) return cleanRequest;
  const markedRequest = extractionRequest(
    project.store.currentProject,
    sequenceId,
    timelineFrame,
    annotationId,
  );
  if (!markedRequest.ok) return markedRequest;
  const duration = timelineDurationFrames(project.store.currentProject, sequenceId);
  if (!duration.ok) return duration;
  const nearbyFrames = uniqueFrameNumbers([
    timelineFrame.frames - 1,
    timelineFrame.frames,
    timelineFrame.frames + 1,
  ], duration.value);
  const nearbyRequests: FrameExtractionRequest[] = [];
  for (const frame of nearbyFrames) {
    const request = extractionRequest(
      project.store.currentProject,
      sequenceId,
      { frames: frame, fps: timelineFrame.fps },
    );
    if (!request.ok) return request;
    nearbyRequests.push(request.value);
  }
  const nearbyRequest: NearbyFramesExtractionRequest = {
    kind: "nearby-frame-extraction",
    sequenceId,
    frames: nearbyRequests,
  };
  const revision = project.store.currentProject.revision;
  const cache = posix.join(".guyditor/cache/annctx", annotationId, revision);
  const files = {
    markedFrame: posix.join(cache, "marked.frame-request.json"),
    cleanFrame: posix.join(cache, "clean.frame-request.json"),
    proxyClip: posix.join(cache, "nearby-frames.request.json"),
  };
  try {
    await Promise.all([
      writeJson(project.store.root, files.cleanFrame, cleanRequest.value),
      writeJson(project.store.root, files.markedFrame, markedRequest.value),
      writeJson(project.store.root, files.proxyClip, nearbyRequest),
    ]);
  } catch (error: unknown) {
    return contextFailure(
      "E_ANNCTX_WRITE",
      `Could not write annotation context requests: ${
        error instanceof Error ? error.message : String(error)
      }`,
      [annotationId],
    );
  }
  const transcript = await transcriptWindow(
    project,
    annotation,
    sequenceId,
    resolved.value.source,
  );
  if (!transcript.ok) return transcript;
  const layers = visibleLayers(project.store.currentProject, sequenceId, timelineFrame);
  if (!layers.ok) return layers;
  const clip = contextClip(
    project.store.currentProject,
    sequenceId,
    timelineFrame,
    annotation.extent,
  );
  if (!clip.ok) return clip;
  const context: AnnotationContextPackage = {
    requestedFor: { annotationId, anchor: `ann:${annotationId}` },
    revision,
    builtAt: now().toISOString(),
    position: {
      sequenceId,
      timelineFrame,
      approximate: resolved.value.status === "orphaned" || resolved.value.approximate === true,
    },
    files,
    clip: clip.value,
    transcript: transcript.value,
    layers: layers.value.map(({ metadata }) => metadata),
    annotation,
    dataClasses: [
      "frames",
      ...(transcript.value.words.length === 0 ? [] : ["transcript" as const]),
      "metadata",
    ],
  };
  try {
    await writeJson(project.store.root, posix.join(cache, "manifest.json"), context);
  } catch (error: unknown) {
    return contextFailure(
      "E_ANNCTX_WRITE",
      `Could not write annotation context manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
      [annotationId],
    );
  }
  return success(context);
}

function uniqueFrameNumbers(values: readonly number[], duration: number): number[] {
  return [...new Set(values.map((value) =>
    Math.max(0, Math.min(Math.max(0, duration - 1), value))))];
}
