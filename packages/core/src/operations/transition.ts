import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type {
  Clip,
  GuyditorProject,
  Sequence,
  Transition,
} from "../project/index.js";
import { deriveTimeline, isId } from "../project/index.js";
import type { FrameTime } from "../time/index.js";
import type { ClipApplication } from "./clip.js";
import type { IdFactory } from "./engine.js";
import type { OperationInput, SemanticFieldDelta } from "./types.js";

type TransitionKind = "cut" | "crossfade" | "audio-crossfade" | "preset";

interface LocatedBoundary {
  sequence: Sequence;
  sequenceIndex: number;
  before: Clip;
  beforeIndex: number;
  after: Clip;
}

function transitionFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: string[],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function ensureSequenceUnlocked(
  project: GuyditorProject,
  sequenceId: string,
  affected: string[],
): Result<true> {
  const layer = project.layers.find((candidate) =>
    candidate.sequence === sequenceId && candidate.locked);
  return layer === undefined
    ? success(true)
    : transitionFailure(
        "E_OP_LAYER_LOCKED",
        `Layer ${layer.id} is locked.`,
        [layer.id, ...affected],
      );
}

function locateBoundary(
  project: GuyditorProject,
  beforeClipId: string,
  afterClipId: string,
): Result<LocatedBoundary> {
  for (const [sequenceIndex, sequence] of project.sequences.entries()) {
    const beforeIndex = sequence.clips.findIndex(({ id }) => id === beforeClipId);
    if (beforeIndex === -1) continue;
    const before = sequence.clips[beforeIndex]!;
    const after = sequence.clips[beforeIndex + 1];
    if (after?.id !== afterClipId) {
      return transitionFailure(
        "E_OP_RANGE_OUT_OF_BOUNDS",
        `Transition clips ${beforeClipId} and ${afterClipId} must be adjacent in timeline order.`,
        [beforeClipId, afterClipId],
      );
    }
    return success({ sequence, sequenceIndex, before, beforeIndex, after });
  }
  return transitionFailure(
    "E_OP_NOT_FOUND",
    `Transition boundary starts at missing clip ${beforeClipId}.`,
    [beforeClipId, afterClipId],
  );
}

function kindAndPreset(transition: Transition): {
  kind: TransitionKind;
  presetId?: string;
} {
  return isId("pre", transition.preset)
    ? { kind: "preset", presetId: transition.preset }
    : { kind: transition.preset as Exclude<TransitionKind, "preset"> };
}

function setParams(
  boundary: { beforeClipId: string; afterClipId: string },
  transition: Transition,
): Record<string, unknown> {
  const represented = kindAndPreset(transition);
  return {
    boundary,
    kind: represented.kind,
    ...(represented.presetId === undefined ? {} : { presetId: represented.presetId }),
    duration: structuredClone(transition.duration),
    ...(transition.intent === undefined ? {} : { intent: transition.intent }),
    transitionId: transition.id,
  };
}

function replaceBefore(
  project: GuyditorProject,
  located: LocatedBoundary,
  before: Clip,
): GuyditorProject {
  const clips = located.sequence.clips.slice();
  clips[located.beforeIndex] = before;
  const sequences = project.sequences.slice();
  sequences[located.sequenceIndex] = { ...located.sequence, clips };
  return { ...project, sequences };
}

function applySet(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  const boundary = input.params["boundary"] as {
    beforeClipId: string;
    afterClipId: string;
  };
  const located = locateBoundary(project, boundary.beforeClipId, boundary.afterClipId);
  if (!located.ok) return located;
  const unlocked = ensureSequenceUnlocked(project, located.value.sequence.id, [
    boundary.beforeClipId,
    boundary.afterClipId,
  ]);
  if (!unlocked.ok) return unlocked;
  const kind = input.params["kind"] as TransitionKind;
  const duration = input.params["duration"] as FrameTime;
  if (duration.fps !== project.settings.timeline.fps) {
    return transitionFailure(
      "E_OP_RATE_MISMATCH",
      `Transition rate ${duration.fps} does not match timeline rate ${project.settings.timeline.fps}.`,
      [boundary.beforeClipId, boundary.afterClipId],
    );
  }
  if ((kind === "cut") !== (duration.frames === 0)) {
    return transitionFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      "Cut transitions require zero duration; all other transitions require positive duration.",
      [boundary.beforeClipId, boundary.afterClipId],
    );
  }
  if (
    located.value.after.gapBefore !== undefined ||
    located.value.after.overlapPrevious !== undefined
  ) {
    return transitionFailure(
      "E_OP_BOUNDARY_CONFLICT",
      `Transition into ${boundary.afterClipId} is exclusive with gap and overlap state.`,
      [boundary.beforeClipId, boundary.afterClipId],
    );
  }
  const presetId = input.params["presetId"] as string | undefined;
  if ((kind === "preset") !== (presetId !== undefined)) {
    return transitionFailure(
      "E_OP_SCHEMA",
      "presetId is required exactly when transition kind is preset.",
      [boundary.beforeClipId, boundary.afterClipId],
    );
  }
  if (presetId !== undefined) {
    const preset = project.presets.find(({ id }) => id === presetId);
    if (preset === undefined || preset.kind !== "transition") {
      return transitionFailure(
        "E_OP_NOT_FOUND",
        `Transition preset ${presetId} does not exist.`,
        [presetId],
      );
    }
  }
  const prior = located.value.before.transitionAfter;
  const transitionId = input.params["transitionId"] as string | undefined ??
    prior?.id ?? idFactory("trn");
  if (prior === undefined) {
    const duplicate = project.sequences.some(({ clips }) => clips.some(({ transitionAfter }) =>
      transitionAfter?.id === transitionId));
    if (duplicate) {
      return transitionFailure(
        "E_OP_ID_CONFLICT",
        `Transition ${transitionId} already exists.`,
        [transitionId],
      );
    }
  } else if (transitionId !== prior.id) {
    return transitionFailure(
      "E_OP_CAPTURE_MISMATCH",
      `Replacing transition ${prior.id} cannot change its stable ID to ${transitionId}.`,
      [prior.id, transitionId],
    );
  }
  const transition: Transition = {
    id: transitionId,
    preset: kind === "preset" ? presetId! : kind,
    duration: structuredClone(duration),
    ...(input.params["intent"] === undefined
      ? {}
      : { intent: input.params["intent"] as string }),
  };
  const before = { ...located.value.before, transitionAfter: transition };
  const model = replaceBefore(project, located.value, before);
  const derived = deriveTimeline(model, located.value.sequence.id);
  if (!derived.ok) return derived;
  const inverse: OperationInput[] = prior === undefined
    ? [{ op: "transition.remove", params: { transitionId } }]
    : [{ op: "transition.set", params: setParams(boundary, prior) }];
  const fields: SemanticFieldDelta[] = prior === undefined
    ? [{ field: "$entity", after: transition }]
    : [{ field: "$entity", before: prior, after: transition }];
  return success({
    model,
    inverse,
    redo: {
      op: "transition.set",
      params: { ...input.params, transitionId },
    },
    affected: [boundary.beforeClipId, transitionId],
    summary: `Set ${kind} (${String(duration.frames)} frames) between ${boundary.beforeClipId} and ${boundary.afterClipId}`,
    mutations: [{
      entityId: transitionId,
      entityType: "transition",
      change: prior === undefined ? "added" : "modified",
      fields,
    }],
  });
}

function applyRemove(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const transitionId = input.params["transitionId"] as string;
  for (const [sequenceIndex, sequence] of project.sequences.entries()) {
    const beforeIndex = sequence.clips.findIndex(({ transitionAfter }) =>
      transitionAfter?.id === transitionId);
    if (beforeIndex === -1) continue;
    const before = sequence.clips[beforeIndex]!;
    const after = sequence.clips[beforeIndex + 1];
    if (after === undefined) {
      return transitionFailure(
        "E_OP_RANGE_OUT_OF_BOUNDS",
        `Transition ${transitionId} has no following clip.`,
        [transitionId, before.id],
      );
    }
    const unlocked = ensureSequenceUnlocked(project, sequence.id, [transitionId]);
    if (!unlocked.ok) return unlocked;
    const removed = structuredClone(before.transitionAfter!);
    const replacement = { ...before };
    delete replacement.transitionAfter;
    const clips = sequence.clips.slice();
    clips[beforeIndex] = replacement;
    const sequences = project.sequences.slice();
    sequences[sequenceIndex] = { ...sequence, clips };
    const represented = kindAndPreset(removed);
    return success({
      model: { ...project, sequences },
      inverse: [{
        op: "transition.set",
        params: setParams({ beforeClipId: before.id, afterClipId: after.id }, removed),
      }],
      affected: [before.id, transitionId],
      summary: `Remove ${represented.kind} between ${before.id} and ${after.id}`,
      mutations: [{
        entityId: transitionId,
        entityType: "transition",
        change: "removed",
        fields: [{ field: "$entity", before: removed }],
      }],
    });
  }
  return transitionFailure(
    "E_OP_NOT_FOUND",
    `Transition ${transitionId} does not exist.`,
    [transitionId],
  );
}

export function applyTransitionOperation(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  return input.op === "transition.set"
    ? applySet(project, input, idFactory)
    : applyRemove(project, input);
}
