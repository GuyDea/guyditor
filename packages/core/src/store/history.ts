import { deriveTimeline } from "../project/index.js";
import type { GuyditorProject } from "../project/index.js";
import { parseAnchor } from "../anchors/index.js";
import {
  absoluteSeconds,
  addTime,
  compareRational,
  convertTimeRounding,
} from "../time/index.js";
import type { FrameTime } from "../time/index.js";
import type { ChangedTimelineRange } from "./types.js";

interface ObjectExtent {
  start: FrameTime;
  end: FrameTime;
}

function addFrames(left: FrameTime, right: FrameTime): FrameTime | undefined {
  const conversion = right.fps === left.fps
    ? undefined
    : convertTimeRounding(right, left.fps);
  const converted = right.fps === left.fps
    ? right
    : conversion?.ok
      ? conversion.value.time
      : undefined;
  if (converted === undefined) return undefined;
  const added = addTime(left, converted);
  return added.ok ? added.value : undefined;
}

function timelineExtents(project: GuyditorProject): Map<string, ObjectExtent> {
  const extents = new Map<string, ObjectExtent>();
  const layerSequences = new Map(project.layers
    .filter((layer) => layer.sequence !== undefined)
    .map((layer) => [layer.id, layer.sequence!]));
  for (const sequence of project.sequences) {
    const derived = deriveTimeline(project, sequence.id);
    if (!derived.ok) continue;
    const byClip = new Map(derived.value.clips.map((clip) => [clip.clipId, clip]));
    for (const clip of sequence.clips) {
      const timeline = byClip.get(clip.id);
      if (timeline === undefined) continue;
      const end = addFrames(timeline.start, timeline.duration);
      if (end === undefined) continue;
      extents.set(clip.id, { start: timeline.start, end });
      if (clip.transitionAfter !== undefined) {
        const conversion = clip.transitionAfter.duration.fps === end.fps
          ? undefined
          : convertTimeRounding(clip.transitionAfter.duration, end.fps);
        const duration = clip.transitionAfter.duration.fps === end.fps
          ? clip.transitionAfter.duration
          : conversion?.ok
            ? conversion.value.time
            : undefined;
        if (duration !== undefined) {
          extents.set(clip.transitionAfter.id, {
            start: { frames: end.frames - duration.frames, fps: end.fps },
            end,
          });
        }
      }
    }
    const sequenceEnd = derived.value.clips.at(-1);
    if (sequenceEnd !== undefined) {
      const end = addFrames(sequenceEnd.start, sequenceEnd.duration);
      if (end !== undefined) {
        for (const caption of project.captions) {
          if (caption.sourceLayerIds.some((id) => layerSequences.get(id) === sequence.id)) {
            extents.set(caption.id, {
              start: { frames: 0, fps: project.settings.timeline.fps },
              end,
            });
          }
        }
      }
    }
  }
  for (const layer of project.layers) {
    for (const item of layer.items ?? []) {
      const start = item.anchorMetadata?.["/at"]?.lastResolved.timeline ??
        timelineAnchor(project, item.at);
      if (start === undefined) continue;
      const end = typeof item.duration === "object" && "frames" in item.duration
        ? addFrames(start, item.duration)
        : typeof item.duration === "object" && "until" in item.duration
          ? timelineAnchor(project, item.duration.until)
          : undefined;
      if (end !== undefined) extents.set(item.id, { start, end });
    }
  }
  return extents;
}

function convertedExtent(extent: ObjectExtent, fps: FrameTime["fps"]): ObjectExtent | undefined {
  const startConversion = extent.start.fps === fps
    ? undefined
    : convertTimeRounding(extent.start, fps);
  const start = extent.start.fps === fps
    ? extent.start
    : startConversion?.ok
      ? startConversion.value.time
      : undefined;
  const endConversion = extent.end.fps === fps
    ? undefined
    : convertTimeRounding(extent.end, fps);
  const end = extent.end.fps === fps
    ? extent.end
    : endConversion?.ok
      ? endConversion.value.time
      : undefined;
  return start === undefined || end === undefined ? undefined : { start, end };
}

function timelineAnchor(
  project: GuyditorProject,
  anchor: string,
): FrameTime | undefined {
  const parsed = parseAnchor(anchor);
  if (!parsed.ok || parsed.value.kind !== "timeline") return undefined;
  const time: FrameTime = {
    frames: parsed.value.frames,
    fps: "fps" in parsed.value ? parsed.value.fps : project.settings.timeline.fps,
  };
  if (time.fps === project.settings.timeline.fps) return time;
  const converted = convertTimeRounding(time, project.settings.timeline.fps);
  return converted.ok ? converted.value.time : undefined;
}

export function computeChangedRanges(
  before: GuyditorProject,
  after: GuyditorProject,
  affectedObjectIds: readonly string[],
): ChangedTimelineRange[] {
  const fps = before.settings.timeline.fps;
  const beforeExtents = timelineExtents(before);
  const afterExtents = timelineExtents(after);
  const ranges: ChangedTimelineRange[] = [];
  for (const objectId of [...new Set(affectedObjectIds)]) {
    const left = beforeExtents.get(objectId);
    const right = afterExtents.get(objectId);
    const extents = [left, right]
      .filter((extent): extent is ObjectExtent => extent !== undefined)
      .map((extent) => convertedExtent(extent, fps))
      .filter((extent): extent is ObjectExtent => extent !== undefined);
    if (extents.length === 0) continue;
    ranges.push({
      start: {
        frames: Math.min(...extents.map(({ start }) => start.frames)),
        fps,
      },
      end: {
        frames: Math.max(...extents.map(({ end }) => end.frames)),
        fps,
      },
      affectedObjects: [objectId],
    });
  }
  ranges.sort((left, right) => left.start.frames - right.start.frames);
  const merged: ChangedTimelineRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    const gap = previous === undefined
      ? undefined
      : absoluteSeconds({
          frames: range.start.frames - previous.end.frames,
          fps,
        });
    const isClose = gap?.ok
      ? compareRational(gap.value, "2/1")
      : undefined;
    if (previous !== undefined && isClose?.ok && isClose.value === -1) {
      previous.end.frames = Math.max(previous.end.frames, range.end.frames);
      previous.affectedObjects.push(...range.affectedObjects);
    } else {
      merged.push(structuredClone(range));
    }
  }
  return merged;
}
