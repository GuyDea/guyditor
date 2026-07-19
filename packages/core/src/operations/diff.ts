import {
  absoluteSeconds,
  addRational,
  compareRational,
  convertTimeRounding,
  subRational,
} from "../time/index.js";
import { parseRationalParts } from "../time/rational.js";
import type { FrameTime, Rational } from "../time/index.js";
import type { GuyditorProject } from "../project/index.js";
import { deriveTimeline } from "../project/index.js";
import type { ClipApplication } from "./clip.js";
import type {
  AppliedOperation,
  RiskClass,
  SemanticDiff,
  SemanticDiffEntry,
  SemanticEntityType,
  SemanticFieldDelta,
} from "./types.js";

interface SemanticEntity {
  id: string;
  type: SemanticEntityType;
  value: Record<string, unknown>;
}

interface OperationRiskMetadata {
  agentApprovedPreset?: {
    kindParameter: string;
    presetKind: string;
    presetParameter: string;
  };
}

const OPERATION_RISK_METADATA: Readonly<Record<string, OperationRiskMetadata>> = {
  "transition.set": {
    agentApprovedPreset: {
      kindParameter: "kind",
      presetKind: "preset",
      presetParameter: "presetId",
    },
  },
};

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) =>
      deepEqual(value, right[index]));
  }
  if (
    typeof left === "object" && left !== null && !Array.isArray(left) &&
    typeof right === "object" && right !== null && !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    return [...keys].every((key) => deepEqual(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function semanticFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = "",
): SemanticFieldDelta[] {
  const fields: SemanticFieldDelta[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (key === "id" || key === "name" && prefix === "sidecar") continue;
    const left = before[key];
    const right = after[key];
    if (deepEqual(left, right)) continue;
    const field = prefix === "" ? key : `${prefix}.${key}`;
    if (
      typeof left === "object" && left !== null && !Array.isArray(left) &&
      typeof right === "object" && right !== null && !Array.isArray(right)
    ) {
      fields.push(...semanticFields(
        left as Record<string, unknown>,
        right as Record<string, unknown>,
        field,
      ));
    } else {
      fields.push({
        field,
        ...(left === undefined ? {} : { before: left }),
        ...(right === undefined ? {} : { after: right }),
      });
    }
  }
  return fields;
}

function entityValue(value: object, omitted: readonly string[] = []): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.includes(key)),
  );
}

function semanticEntities(project: GuyditorProject): SemanticEntity[] {
  return [
    {
      id: project.project.id,
      type: "project" as const,
      value: {
        project: entityValue(project.project, ["id"]),
        settings: project.settings,
        transcript: project.transcript,
        annotations: project.annotations,
      },
    },
    ...project.assets.map((value) => ({ id: value.id, type: "asset" as const, value: entityValue(value) })),
    ...project.beats.map((value) => ({ id: value.id, type: "beat" as const, value: entityValue(value) })),
    ...project.sequences.flatMap((sequence) => [
      { id: sequence.id, type: "sequence" as const, value: entityValue(sequence, ["clips"]) },
      ...sequence.clips.flatMap((clip, clipIndex) => [
        {
          id: clip.id,
          type: "clip" as const,
          value: {
            ...entityValue(clip, ["effects", "transitionAfter"]),
            sequenceId: sequence.id,
            order: clipIndex,
          },
        },
        ...(clip.transitionAfter === undefined ? [] : [{
          id: clip.transitionAfter.id,
          type: "transition" as const,
          value: { ...entityValue(clip.transitionAfter), clipId: clip.id },
        }]),
        ...(clip.effects ?? []).map((value, effectIndex) => ({
          id: value.id,
          type: "effect" as const,
          value: { ...entityValue(value), ownerId: clip.id, order: effectIndex },
        })),
      ]),
    ]),
    ...project.layers.flatMap((layer) => [
      { id: layer.id, type: "layer" as const, value: entityValue(layer, ["items"]) },
      ...(layer.items ?? []).flatMap((item, itemIndex) => [
        {
          id: item.id,
          type: "item" as const,
          value: {
            ...entityValue(item, ["effects"]),
            layerId: layer.id,
            order: itemIndex,
          },
        },
        ...(item.effects ?? []).map((value, effectIndex) => ({
          id: value.id,
          type: "effect" as const,
          value: { ...entityValue(value), ownerId: item.id, order: effectIndex },
        })),
      ]),
    ]),
    ...project.captions.map((value) => ({ id: value.id, type: "caption" as const, value: entityValue(value) })),
    ...project.deliverables.map((value) => ({
      id: value.id,
      type: "deliverable" as const,
      value: entityValue(value),
    })),
    ...project.presets.map((value) => ({ id: value.id, type: "preset" as const, value: entityValue(value) })),
    ...project.skills.map((value) => ({ id: value.id, type: "skill" as const, value: entityValue(value) })),
    ...project.sidecars.map((value) => ({
      id: value.name,
      type: "sidecar" as const,
      value: entityValue(value),
    })),
  ];
}

function entityKey(entity: Pick<SemanticEntity, "id" | "type">): string {
  return `${entity.type}:${entity.id}`;
}

function entryKey(entry: Pick<SemanticDiffEntry, "entityId" | "entityType">): string {
  return `${entry.entityType}:${entry.entityId}`;
}

function overlapsField(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function changedValues(
  fields: readonly SemanticFieldDelta[],
  side: "before" | "after",
): Record<string, unknown> {
  return Object.fromEntries(fields
    .filter((field) => field[side] !== undefined)
    .map((field) => [field.field, field[side]]));
}

export function structuralSemanticEntries(
  before: GuyditorProject,
  after: GuyditorProject,
  op = "project.compare",
  summary = "Compare project structure",
): SemanticDiffEntry[] {
  const left = new Map(semanticEntities(before).map((entity) => [entityKey(entity), entity]));
  const right = new Map(semanticEntities(after).map((entity) => [entityKey(entity), entity]));
  const keys = new Set([...left.keys(), ...right.keys()]);
  const entries: SemanticDiffEntry[] = [];
  for (const key of keys) {
    const a = left.get(key);
    const b = right.get(key);
    if (a === undefined && b !== undefined) {
      entries.push({
        summary,
        op,
        anchors: [b.id],
        entityId: b.id,
        entityType: b.type,
        change: "added",
        fields: [{ field: "$entity", after: b.value }],
        after: b.value,
      });
    } else if (a !== undefined && b === undefined) {
      entries.push({
        summary,
        op,
        anchors: [a.id],
        entityId: a.id,
        entityType: a.type,
        change: "removed",
        fields: [{ field: "$entity", before: a.value }],
        before: a.value,
      });
    } else if (a !== undefined && b !== undefined && !deepEqual(a.value, b.value)) {
      const fields = semanticFields(a.value, b.value);
      entries.push({
        summary,
        op,
        anchors: [a.id],
        entityId: a.id,
        entityType: a.type,
        change: "modified",
        fields,
        before: Object.fromEntries(fields
          .filter(({ before: value }) => value !== undefined)
          .map(({ field, before: value }) => [field, value])),
        after: Object.fromEntries(fields
          .filter(({ after: value }) => value !== undefined)
          .map(({ field, after: value }) => [field, value])),
      });
    }
  }
  return entries;
}

function wordRanges(applied: readonly AppliedOperation[]): Array<{
  fromWord: string;
  toWord: string;
}> {
  const ranges: Array<{ fromWord: string; toWord: string }> = [];
  for (const operation of applied) {
    const wordId = operation.params["wordId"];
    if (typeof wordId === "string") {
      ranges.push({ fromWord: wordId, toWord: wordId });
    }
    const directFrom = operation.params["fromWord"];
    const directTo = operation.params["toWord"];
    if (typeof directFrom === "string" && typeof directTo === "string") {
      ranges.push({ fromWord: directFrom, toWord: directTo });
    }
    const candidates = [
      operation.params["wordRange"],
      ...(Array.isArray(operation.params["wordRanges"])
        ? operation.params["wordRanges"]
        : []),
    ];
    for (const candidate of candidates) {
      if (
        typeof candidate === "object" && candidate !== null &&
        "fromWord" in candidate && typeof candidate.fromWord === "string" &&
        "toWord" in candidate && typeof candidate.toWord === "string"
      ) {
        ranges.push({ fromWord: candidate.fromWord, toWord: candidate.toWord });
      }
    }
  }
  return [...new Map(ranges.map((range) => [
    `${range.fromWord}:${range.toWord}`,
    range,
  ])).values()];
}

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
  orphanedAnchors: SemanticDiff["orphanedAnchors"] = [],
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

  const entries: SemanticDiffEntry[] = [];
  let previous = base;
  for (const [applicationIndex, application] of applications.entries()) {
    const operation = applied[applicationIndex];
    const structural = structuralSemanticEntries(
      previous,
      application.model,
      operation?.op,
      operation?.summary,
    );
    const structuralByEntity = new Map(structural.map((entry) => [entryKey(entry), entry]));
    for (const mutation of application.mutations) {
      const matching = structuralByEntity.get(entryKey(mutation));
      const fields = [
        ...mutation.fields,
        ...(matching?.fields ?? []).filter((candidate) =>
          !mutation.fields.some((field) => overlapsField(field.field, candidate.field))),
      ];
      entries.push({
        summary: operation?.summary ?? "Apply operation",
        op: operation?.op ?? "project.compare",
        anchors: [mutation.entityId],
        entityId: mutation.entityId,
        entityType: mutation.entityType,
        change: mutation.change,
        fields,
        before: changedValues(fields, "before"),
        after: changedValues(fields, "after"),
      });
      structuralByEntity.delete(entryKey(mutation));
    }
    entries.push(...structural.filter((entry) => structuralByEntity.has(entryKey(entry))));
    previous = application.model;
  }
  const fallback = applied.at(-1);
  entries.push(...structuralSemanticEntries(
    previous,
    result,
    fallback?.op,
    fallback?.summary,
  ));
  for (const entry of entries) {
    if (entry.entityType === "clip") affectedClipIds.add(entry.entityId);
  }
  for (const project of [base, result]) {
    for (const sequence of project.sequences) {
      if (sequence.clips.some((clip) => affectedClipIds.has(clip.id))) {
        affectedSequenceIds.add(sequence.id);
      }
    }
  }
  const directlyAffectedLayers = new Set(entries
    .filter(({ entityType }) => entityType === "layer")
    .map(({ entityId }) => entityId));
  const directlyAffectedDeliverables = new Set(entries
    .filter(({ entityType }) => entityType === "deliverable")
    .map(({ entityId }) => entityId));

  return {
    base: base.revision,
    entries,
    orphanedAnchors,
    stats: {
      durationDelta: durationDelta(base, result),
      clipsAdded: entries.filter(({ change, entityType }) =>
        entityType === "clip" && change === "added").length,
      clipsRemoved: entries.filter(({ change, entityType }) =>
        entityType === "clip" && change === "removed").length,
      clipsModified: new Set(
        entries
          .filter(({ change, entityType }) => entityType === "clip" && change === "modified")
          .map(({ entityId }) => entityId),
      ).size,
      affectedLayers: [...new Map([...base.layers, ...result.layers]
        .filter((layer) =>
          directlyAffectedLayers.has(layer.id) ||
          (layer.sequence !== undefined && affectedSequenceIds.has(layer.sequence)))
        .map((layer) => [layer.id, layer])).values()]
        .map((layer) => layer.id),
      affectedWordRanges: wordRanges(applied),
      affectedDeliverables: [...new Map([...base.deliverables, ...result.deliverables]
        .filter((deliverable) =>
          directlyAffectedDeliverables.has(deliverable.id) ||
          affectedSequenceIds.has(deliverable.sequenceId))
        .map((deliverable) => [deliverable.id, deliverable])).values()]
        .map((deliverable) => deliverable.id),
    },
  };
}

function removesMoreThanThirtySeconds(diff: SemanticDiff): boolean {
  const seconds = absoluteSeconds(diff.stats.durationDelta);
  if (!seconds.ok) return false;
  const comparison = compareRational(seconds.value, "-30/1");
  return comparison.ok && comparison.value === -1;
}

function removesMoreThanThirtyTimelineSeconds(
  before: GuyditorProject,
  after: GuyditorProject,
  applied: readonly AppliedOperation[],
): boolean {
  let removed: Rational = "0/1";
  const preservedClipIds = new Set<string>();
  for (const operation of applied) {
    if (operation.op === "clip.split") {
      const clipId = operation.params["clipId"];
      if (typeof clipId === "string") preservedClipIds.add(clipId);
    } else if (operation.op === "clip.join") {
      const clipIds = operation.params["clipIds"];
      if (Array.isArray(clipIds)) {
        for (const clipId of clipIds) {
          if (typeof clipId === "string") preservedClipIds.add(clipId);
        }
      }
    }
  }
  for (const sequence of before.sequences) {
    const beforeTimeline = deriveTimeline(before, sequence.id);
    if (!beforeTimeline.ok) continue;
    const afterSequence = after.sequences.find(({ id }) => id === sequence.id);
    const afterTimeline = afterSequence === undefined
      ? undefined
      : deriveTimeline(after, afterSequence.id);
    const afterDurations = new Map(
      afterTimeline?.ok
        ? afterTimeline.value.clips.map(({ clipId, duration }) => [clipId, duration])
        : [],
    );
    for (const clip of beforeTimeline.value.clips) {
      if (preservedClipIds.has(clip.clipId)) continue;
      const beforeSeconds = absoluteSeconds(clip.duration);
      if (!beforeSeconds.ok) continue;
      const afterDuration = afterDurations.get(clip.clipId);
      let removedForClip = beforeSeconds.value;
      if (afterDuration !== undefined) {
        const afterSeconds = absoluteSeconds(afterDuration);
        if (!afterSeconds.ok) continue;
        const difference = subRational(beforeSeconds.value, afterSeconds.value);
        if (!difference.ok) continue;
        const positive = compareRational(difference.value, "0/1");
        if (!positive.ok || positive.value !== 1) continue;
        removedForClip = difference.value;
      }
      const total = addRational(removed, removedForClip);
      if (total.ok) removed = total.value;
    }
  }
  const comparison = compareRational(removed, "30/1");
  return comparison.ok && comparison.value === 1;
}

function removesNonEmptyLayer(project: GuyditorProject, diff: SemanticDiff): boolean {
  const removed = new Set(diff.entries
    .filter(({ entityType, change }) => entityType === "layer" && change === "removed")
    .map(({ entityId }) => entityId));
  return project.layers.some((layer) => {
    if (!removed.has(layer.id)) return false;
    if ((layer.items?.length ?? 0) > 0) return true;
    return layer.sequence !== undefined &&
      (project.sequences.find(({ id }) => id === layer.sequence)?.clips.length ?? 0) > 0;
  });
}

function hasAgentRiskEscalation(
  applied: readonly AppliedOperation[],
  approvedTransitionPresets: readonly string[],
): boolean {
  const approved = new Set(approvedTransitionPresets);
  return applied.some((operation) => {
    const metadata = OPERATION_RISK_METADATA[operation.op]?.agentApprovedPreset;
    if (metadata === undefined) return false;
    const preset = operation.params[metadata.presetParameter];
    return operation.params[metadata.kindParameter] !== metadata.presetKind ||
      typeof preset !== "string" || !approved.has(preset);
  });
}

export function assessBatchRisk(
  project: GuyditorProject,
  applied: readonly AppliedOperation[],
  diff: SemanticDiff,
  origin: "ui" | "agent" | "system",
  approvedTransitionPresets: readonly string[] = [],
  memberRisk: RiskClass = "normal",
  result?: GuyditorProject,
): RiskClass {
  const touchedClips = new Set(diff.entries
    .filter(({ entityType, change }) =>
      entityType === "clip" && (change === "modified" || change === "removed"))
    .map(({ entityId }) => entityId));
  const escalated = touchedClips.size > 20 ||
    removesMoreThanThirtySeconds(diff) ||
    (result !== undefined && removesMoreThanThirtyTimelineSeconds(project, result, applied)) ||
    removesNonEmptyLayer(project, diff) ||
    (origin === "agent" && hasAgentRiskEscalation(applied, approvedTransitionPresets));
  return escalated ? "consequential" : memberRisk;
}
