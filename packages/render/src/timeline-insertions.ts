import {
  convertTime,
  makeGuyditorError,
  placedItemAppliesToSequence,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  PlacedItem,
} from "../../core/src/index.js";

export interface RestyleTimelineInsertion {
  seamId: string;
  sourceFrame: number;
  durationFrames: number;
}

function invalid(message: string, affected: readonly string[]): never {
  throw makeGuyditorError("E_RENDER_GRAPH_INVALID", message, { affected });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactItemFrame(item: PlacedItem, sequenceId: string, fps: string): number {
  const scoped = new RegExp(`^timeline:${sequenceId}@([0-9]+)$`, "u").exec(item.at);
  if (scoped !== null) return Number(scoped[1]);
  const absolute = /^timeline:([0-9]+)@([0-9]+\/[1-9][0-9]*)$/u.exec(item.at);
  if (absolute === null) {
    invalid(`Restyle seam ${item.id} requires an exact timeline anchor.`, [item.id, item.at]);
  }
  const converted = convertTime(
    { frames: Number(absolute[1]), fps: absolute[2]! },
    fps,
  );
  if (!converted.ok) throw converted.error;
  return converted.value.frames;
}

function exactItemDuration(item: PlacedItem, fps: string): number {
  if (item.duration === "intrinsic" || "until" in item.duration) {
    invalid(`Restyle seam ${item.id} requires a fixed exact duration.`, [item.id]);
  }
  const converted = convertTime(item.duration, fps);
  if (!converted.ok) throw converted.error;
  return converted.value.frames;
}

export function restyleTimelineInsertionForItem(
  item: PlacedItem,
): RestyleTimelineInsertion | undefined {
  const seam = record(item.layout?.["restyleSeam"]);
  if (seam === undefined) return undefined;
  const seamId = seam["seamId"];
  const sourceFrame = seam["sourceFrame"];
  const durationFrames = seam["durationFrames"];
  if (
    typeof seamId !== "string" || seamId.length === 0 ||
    typeof sourceFrame !== "number" || !Number.isSafeInteger(sourceFrame) || sourceFrame < 0 ||
    typeof durationFrames !== "number" || !Number.isSafeInteger(durationFrames) || durationFrames < 1 ||
    seam["resumeExact"] !== true
  ) {
    invalid(`Graphic ${item.id} has invalid exact-resume seam metadata.`, [item.id]);
  }
  return { seamId, sourceFrame, durationFrames };
}

export function restyleTimelineInsertions(
  project: GuyditorProject,
  sequenceId: string,
): RestyleTimelineInsertion[] {
  const fps = project.settings.timeline.fps;
  const insertions: RestyleTimelineInsertion[] = [];
  const seamIds = new Set<string>();
  const sourceFrames = new Set<number>();
  for (const layer of project.layers) {
    if (!layer.enabled || (layer.sequence !== undefined && layer.sequence !== sequenceId)) continue;
    for (const item of layer.items ?? []) {
      if (!placedItemAppliesToSequence(project, item, sequenceId)) continue;
      const insertion = restyleTimelineInsertionForItem(item);
      if (insertion === undefined) continue;
      if (item.template === undefined) {
        invalid(`Restyle seam ${insertion.seamId} must be a template item.`, [item.id]);
      }
      if (exactItemFrame(item, sequenceId, fps) !== insertion.sourceFrame) {
        invalid(`Restyle seam ${insertion.seamId} anchor does not match its source frame.`, [item.id]);
      }
      if (exactItemDuration(item, fps) !== insertion.durationFrames) {
        invalid(`Restyle seam ${insertion.seamId} item duration does not match its insertion.`, [item.id]);
      }
      if (seamIds.has(insertion.seamId) || sourceFrames.has(insertion.sourceFrame)) {
        invalid(`Restyle seam ${insertion.seamId} duplicates an exact-resume insertion.`, [item.id]);
      }
      seamIds.add(insertion.seamId);
      sourceFrames.add(insertion.sourceFrame);
      insertions.push(insertion);
    }
  }
  return insertions.sort((left, right) =>
    left.sourceFrame - right.sourceFrame || left.seamId.localeCompare(right.seamId));
}

export function insertedDurationFrames(insertions: readonly RestyleTimelineInsertion[]): number {
  return insertions.reduce((total, insertion) => total + insertion.durationFrames, 0);
}

export function sourceFrameToOutputFrame(
  sourceFrame: number,
  insertions: readonly RestyleTimelineInsertion[],
  includeInsertionAtFrame = true,
): number {
  return sourceFrame + insertions.reduce(
    (total, insertion) => total + (
      insertion.sourceFrame < sourceFrame ||
      (includeInsertionAtFrame && insertion.sourceFrame === sourceFrame)
        ? insertion.durationFrames
        : 0
    ),
    0,
  );
}
