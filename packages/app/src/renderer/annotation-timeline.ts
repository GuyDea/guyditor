import { useEffect, useMemo, useState } from "react";

import {
  convertTimeRounding,
} from "../../../core/src/time/index.js";
import type {
  Annotation,
  FrameTime,
} from "../../../core/src/index.js";

export type AnnotationTimelineFrames = Readonly<Record<string, FrameTime>>;

type AnnotationPositionResolver = (
  annotation: Annotation,
) => Promise<{ frame: FrameTime }>;

export function annotationTimelineRequestKey(
  annotations: readonly Annotation[],
  projectPath: string | undefined,
  sequenceId: string | undefined,
  fps: FrameTime["fps"],
  revision: string | undefined,
): string {
  return JSON.stringify([
    projectPath ?? null,
    sequenceId ?? null,
    fps,
    revision ?? null,
    annotations.map(({ id, canvasRef, anchor, orphan }) => [
      id,
      canvasRef.sequenceId,
      anchor,
      orphan?.lastResolved ?? null,
    ]),
  ]);
}

export function mergeAnnotationTimelineFrames(
  direct: AnnotationTimelineFrames,
  resolved: AnnotationTimelineFrames,
  resolvedMatchesRequest: boolean,
): AnnotationTimelineFrames {
  return resolvedMatchesRequest
    ? { ...resolved, ...direct }
    : direct;
}

export function annotationNavigationRequest(
  annotation: Annotation,
): Record<string, unknown> {
  return {
    target: { kind: "annotation", annotationId: annotation.id },
    scope: annotation.canvasRef.sequenceId,
  };
}

function atRate(
  frame: FrameTime,
  fps: FrameTime["fps"],
): FrameTime | undefined {
  if (frame.fps === fps) return frame;
  const converted = convertTimeRounding(frame, fps);
  return converted.ok ? converted.value.time : undefined;
}

export function directAnnotationTimelineFrame(
  annotation: Annotation,
  sequenceId: string,
  fps: FrameTime["fps"],
): FrameTime | undefined {
  if (annotation.canvasRef.sequenceId !== sequenceId) return undefined;
  if (
    annotation.anchor.kind === "timeline" &&
    annotation.anchor.sequenceId === sequenceId
  ) {
    return atRate(annotation.anchor.frame, fps);
  }
  const lastResolved = annotation.orphan?.lastResolved;
  return lastResolved?.sequenceId === sequenceId
    ? atRate(lastResolved.timelineFrame, fps)
    : undefined;
}

export function annotationIsVisibleAtFrame(
  annotation: Annotation,
  position: FrameTime,
  playhead: FrameTime,
): boolean {
  const start = atRate(position, playhead.fps);
  const extent = atRate(annotation.extent, playhead.fps);
  if (start === undefined || extent === undefined) return false;
  const duration = Math.max(1, extent.frames);
  return playhead.frames >= start.frames &&
    playhead.frames < start.frames + duration;
}

export async function resolveAnnotationTimelineFrames(
  annotations: readonly Annotation[],
  sequenceId: string,
  fps: FrameTime["fps"],
  resolve: AnnotationPositionResolver,
): Promise<AnnotationTimelineFrames> {
  const entries = await Promise.all(annotations.flatMap((annotation) =>
    annotation.canvasRef.sequenceId === sequenceId ? [annotation] : []).map(
      async (annotation): Promise<readonly [string, FrameTime] | undefined> => {
        const direct = directAnnotationTimelineFrame(annotation, sequenceId, fps);
        if (direct !== undefined) return [annotation.id, direct];
        try {
          const resolved = await resolve(annotation);
          const frame = atRate(resolved.frame, fps);
          return frame === undefined ? undefined : [annotation.id, frame];
        } catch {
          return undefined;
        }
      },
    ));
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, FrameTime] =>
      entry !== undefined),
  );
}

export function useAnnotationTimelineFrames(
  annotations: readonly Annotation[],
  projectPath: string | undefined,
  sequenceId: string | undefined,
  fps: FrameTime["fps"],
  revision: string | undefined,
): AnnotationTimelineFrames {
  const direct = useMemo(() => {
    if (sequenceId === undefined) return {};
    return Object.fromEntries(annotations.flatMap((annotation) => {
      const frame = directAnnotationTimelineFrame(annotation, sequenceId, fps);
      return frame === undefined ? [] : [[annotation.id, frame]];
    }));
  }, [annotations, fps, sequenceId]);
  const key = annotationTimelineRequestKey(
    annotations,
    projectPath,
    sequenceId,
    fps,
    revision,
  );
  const [resolved, setResolved] = useState<{
    key: string;
    frames: AnnotationTimelineFrames;
  }>({ key: "unresolved", frames: {} });

  useEffect(() => {
    let current = true;
    if (sequenceId === undefined) {
      setResolved({ key, frames: {} });
      return () => { current = false; };
    }
    void resolveAnnotationTimelineFrames(
      annotations,
      sequenceId,
      fps,
      (annotation) => window.guyditor.call<{ frame: FrameTime }>(
        "OperationEngine",
        "resolveNavigation",
        annotationNavigationRequest(annotation),
      ),
    ).then((frames) => {
      if (current) setResolved({ key, frames });
    });
    return () => { current = false; };
  }, [annotations, fps, key, sequenceId]);

  return mergeAnnotationTimelineFrames(direct, resolved.frames, resolved.key === key);
}
