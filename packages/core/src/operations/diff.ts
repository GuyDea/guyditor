import {
  addRational,
  convertTimeRounding,
  subRational,
} from "../time/index.js";
import { parseRationalParts } from "../time/rational.js";
import type { FrameTime, Rational } from "../time/index.js";
import type { GuyditorProject } from "../project/index.js";
import { deriveTimeline } from "../project/index.js";
import type { ClipApplication } from "./clip.js";
import type { AppliedOperation, SemanticDiff } from "./types.js";

function totalDuration(project: GuyditorProject): Rational {
  let total: Rational = "0/1";
  for (const sequence of project.sequences) {
    const derived = deriveTimeline(project, sequence.id);
    if (!derived.ok) continue;
    const next = addRational(total, derived.value.duration);
    if (next.ok) total = next.value;
  }
  return total;
}

function durationDelta(before: GuyditorProject, after: GuyditorProject): FrameTime {
  const delta = subRational(totalDuration(after), totalDuration(before));
  if (!delta.ok) return { frames: 0, fps: before.settings.timeline.fps };
  const parts = parseRationalParts(delta.value);
  if (!parts.ok) return { frames: 0, fps: before.settings.timeline.fps };
  const exact: FrameTime = {
    frames: Number(parts.value.numerator),
    fps: `${parts.value.denominator.toString()}/1`,
  };
  const converted = convertTimeRounding(exact, before.settings.timeline.fps);
  return converted.ok
    ? converted.value.time
    : { frames: 0, fps: before.settings.timeline.fps };
}

export function buildSemanticDiff(
  base: GuyditorProject,
  result: GuyditorProject,
  applications: readonly ClipApplication[],
  applied: readonly AppliedOperation[],
): SemanticDiff {
  const mutations = applications.flatMap((application) => application.mutations);
  const affectedClipIds = new Set(
    mutations
      .filter(({ entityType }) => entityType === "clip")
      .map(({ entityId }) => entityId),
  );
  const affectedSequenceIds = new Set<string>();
  for (const project of [base, result]) {
    for (const sequence of project.sequences) {
      if (sequence.clips.some((clip) => affectedClipIds.has(clip.id))) {
        affectedSequenceIds.add(sequence.id);
      }
    }
  }

  return {
    base: base.revision,
    entries: applications.flatMap((application, applicationIndex) =>
      application.mutations.map((mutation) => ({
        summary: applied[applicationIndex]!.summary,
        op: applied[applicationIndex]!.op,
        anchors: [mutation.entityId],
        entityId: mutation.entityId,
        entityType: mutation.entityType,
        change: mutation.change,
        fields: mutation.fields,
        before: Object.fromEntries(
          mutation.fields
            .filter((field) => field.before !== undefined)
            .map((field) => [field.field, field.before]),
        ),
        after: Object.fromEntries(
          mutation.fields
            .filter((field) => field.after !== undefined)
            .map((field) => [field.field, field.after]),
        ),
      })),
    ),
    stats: {
      durationDelta: durationDelta(base, result),
      clipsAdded: mutations.filter(({ change, entityType }) =>
        entityType === "clip" && change === "added").length,
      clipsRemoved: mutations.filter(({ change, entityType }) =>
        entityType === "clip" && change === "removed").length,
      clipsModified: new Set(
        mutations
          .filter(({ change, entityType }) => entityType === "clip" && change === "modified")
          .map(({ entityId }) => entityId),
      ).size,
      affectedLayers: base.layers
        .filter((layer) => layer.sequence !== undefined && affectedSequenceIds.has(layer.sequence))
        .map((layer) => layer.id),
      affectedWordRanges: [],
      affectedDeliverables: base.deliverables
        .filter((deliverable) => affectedSequenceIds.has(deliverable.sequenceId))
        .map((deliverable) => deliverable.id),
    },
  };
}
