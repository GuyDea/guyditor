import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import { deriveTimeline } from "../project/derive.js";
import type { GuyditorProject } from "../project/model.js";
import type {
  FrameTime,
  Rational,
} from "../time/index.js";
import { convertTimeRounding } from "../time/index.js";
import { parseRationalParts } from "../time/rational.js";
import { resolveAnchor } from "./resolver.js";
import type { AnchorResolverDependencies } from "./types.js";

export type NavigationTarget =
  | { kind: "frame"; frames: number; fps: Rational }
  | { kind: "timecode"; tc: string }
  | { kind: "clip"; clipId: string; edge: "start" | "end" }
  | { kind: "word"; wordId: string }
  | { kind: "annotation"; annotationId: string }
  | { kind: "beat"; beatId: string };

/** Exact resolved editor position: a sequence plus one frame at its timeline rate. */
export interface TimelinePosition {
  sequenceId: string;
  frame: FrameTime;
}

function navigationFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function defaultSequence(project: GuyditorProject): Result<string> {
  const deliverable = project.deliverables.find(
    ({ id }) => id === project.settings.primaryDeliverable,
  );
  return deliverable === undefined
    ? navigationFailure(
        "E_NAVIGATION_TARGET",
        "The primary deliverable does not identify a navigation sequence.",
        [project.settings.primaryDeliverable],
      )
    : success(deliverable.sequenceId);
}

function parseTimecode(tc: string, fps: Rational): Result<number> {
  const match = /^(\d{2}):([0-5]\d):([0-5]\d)([:;])(\d{2})$/u.exec(tc);
  const rate = parseRationalParts(fps);
  if (match === null || !rate.ok) {
    return navigationFailure(
      "E_NAVIGATION_SYNTAX",
      `Timecode ${JSON.stringify(tc)} is not HH:MM:SS:FF or HH:MM:SS;FF.`,
    );
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const frame = Number(match[5]);
  const nominal = Number(
    (rate.value.numerator + rate.value.denominator - 1n) /
      rate.value.denominator,
  );
  if (frame >= nominal) {
    return navigationFailure(
      "E_NAVIGATION_SYNTAX",
      `Timecode frame ${String(frame)} is outside the nominal ${String(nominal)} fps count.`,
    );
  }

  let frames = ((hours * 60 + minutes) * 60 + seconds) * nominal + frame;
  if (match[4] === ";") {
    const supportsDrop =
      rate.value.denominator === 1001n &&
      (rate.value.numerator === 30_000n || rate.value.numerator === 60_000n);
    if (!supportsDrop) {
      return navigationFailure(
        "E_NAVIGATION_SYNTAX",
        `Drop-frame timecode is not defined for ${fps}.`,
      );
    }
    const drop = nominal === 60 ? 4 : 2;
    if (seconds === 0 && minutes % 10 !== 0 && frame < drop) {
      return navigationFailure(
        "E_NAVIGATION_SYNTAX",
        `Timecode ${tc} names a dropped frame.`,
      );
    }
    const totalMinutes = hours * 60 + minutes;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return Number.isSafeInteger(frames)
    ? success(frames)
    : navigationFailure("E_TIME_OVERFLOW", "Timecode exceeds the safe frame range.");
}

async function resolvedPosition(
  project: GuyditorProject,
  anchor: string,
  sequenceId: string,
  dependencies: AnchorResolverDependencies,
): Promise<Result<TimelinePosition>> {
  const resolution = await resolveAnchor(project, anchor, sequenceId, dependencies);
  if (!resolution.ok) return resolution;
  return resolution.value.status === "resolved" && resolution.value.timeline !== undefined
    ? success({ sequenceId, frame: resolution.value.timeline })
    : navigationFailure(
        "E_NAVIGATION_ORPHANED",
        `Navigation anchor ${anchor} is orphaned (${resolution.value.reason ?? "unknown"}).`,
      );
}

export async function resolveNavigationTarget(
  project: GuyditorProject,
  target: NavigationTarget,
  dependencies: AnchorResolverDependencies = {},
  scope?: string,
): Promise<Result<TimelinePosition>> {
  const sequence = scope === undefined ? defaultSequence(project) : success(scope);
  if (!sequence.ok) return sequence;
  const sequenceId = sequence.value;

  if (target.kind === "frame") {
    if (!Number.isSafeInteger(target.frames) || target.frames < 0) {
      return navigationFailure("E_NAVIGATION_SYNTAX", "Navigation frames must be nonnegative safe integers.");
    }
    return resolvedPosition(
      project,
      `timeline:${String(target.frames)}@${target.fps}`,
      sequenceId,
      dependencies,
    );
  }
  if (target.kind === "timecode") {
    const frames = parseTimecode(target.tc, project.settings.timeline.fps);
    if (!frames.ok) return frames;
    return resolvedPosition(
      project,
      `timeline:${sequenceId}@${String(frames.value)}`,
      sequenceId,
      dependencies,
    );
  }
  if (target.kind === "word") {
    return resolvedPosition(project, `word:${target.wordId}`, sequenceId, dependencies);
  }
  if (target.kind === "annotation") {
    return resolvedPosition(project, `ann:${target.annotationId}`, sequenceId, dependencies);
  }
  if (target.kind === "beat") {
    return resolvedPosition(project, `beat:${target.beatId}`, sequenceId, dependencies);
  }

  const derived = deriveTimeline(project, sequenceId);
  if (!derived.ok) return derived;
  const clip = derived.value.clips.find(({ clipId }) => clipId === target.clipId);
  if (clip === undefined) {
    return navigationFailure(
      "E_NAVIGATION_ORPHANED",
      `Clip ${target.clipId} is not present in sequence ${sequenceId}.`,
      [target.clipId],
    );
  }
  if (target.edge === "start") {
    return success({ sequenceId, frame: clip.start });
  }
  const sourceSequence = project.sequences.find(({ id }) => id === sequenceId)!;
  const clipIndex = sourceSequence.clips.findIndex(({ id }) => id === target.clipId);
  const prefixProject: GuyditorProject = {
    ...project,
    sequences: project.sequences.map((candidate) =>
      candidate.id === sequenceId
        ? { ...candidate, clips: candidate.clips.slice(0, clipIndex + 1) }
        : candidate),
  };
  const prefix = deriveTimeline(prefixProject, sequenceId);
  if (!prefix.ok) return prefix;
  const duration = parseRationalParts(prefix.value.duration);
  if (!duration.ok) return duration;
  const converted = convertTimeRounding({
    frames: Number(duration.value.numerator),
    fps: `${duration.value.denominator.toString()}/1`,
  }, project.settings.timeline.fps);
  return converted.ok
    ? success({ sequenceId, frame: converted.value.time })
    : converted;
}
