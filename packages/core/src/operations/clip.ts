import {
  absoluteSeconds,
  compareRational,
} from "../time/index.js";
import type { FrameTime } from "../time/index.js";
import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type {
  Asset,
  Clip,
  GuyditorProject,
  Layer,
  Sequence,
} from "../project/index.js";
import { deriveTimeline } from "../project/index.js";
import type { IdFactory } from "./engine.js";
import type {
  OperationInput,
  SemanticEntityType,
  SemanticFieldDelta,
} from "./types.js";

export interface EntityMutation {
  entityId: string;
  entityType: SemanticEntityType;
  change: "added" | "removed" | "modified";
  fields: SemanticFieldDelta[];
}

export interface ClipApplication {
  model: GuyditorProject;
  inverse: OperationInput[];
  redo?: OperationInput;
  affected: string[];
  summary: string;
  mutations: EntityMutation[];
}

interface LocatedClip {
  sequence: Sequence;
  sequenceIndex: number;
  clip: Clip;
  clipIndex: number;
  asset: Asset;
}

function opFailure(code: `E_${Uppercase<string>}`, message: string, affected: string[]) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function locateClip(project: GuyditorProject, clipId: string): Result<LocatedClip> {
  for (const [sequenceIndex, sequence] of project.sequences.entries()) {
    const clipIndex = sequence.clips.findIndex((clip) => clip.id === clipId);
    if (clipIndex === -1) continue;
    const clip = sequence.clips[clipIndex]!;
    const asset = project.assets.find((candidate) => candidate.id === clip.asset);
    if (asset === undefined) {
      return opFailure("E_OP_NOT_FOUND", `Asset ${clip.asset} does not exist.`, [clip.id, clip.asset]);
    }
    return success({ sequence, sequenceIndex, clip, clipIndex, asset });
  }
  return opFailure("E_OP_NOT_FOUND", `Clip ${clipId} does not exist.`, [clipId]);
}

function ensureUnlocked(project: GuyditorProject, located: LocatedClip): Result<LocatedClip> {
  const lockedLayer = project.layers.find(
    (layer) => layer.sequence === located.sequence.id && layer.locked,
  );
  return lockedLayer === undefined
    ? success(located)
    : opFailure(
        "E_OP_LAYER_LOCKED",
        `Layer ${lockedLayer.id} is locked.`,
        [lockedLayer.id, located.clip.id],
      );
}

function layerForSequence(
  project: GuyditorProject,
  sequenceId: string,
): Result<Layer> {
  const layer = project.layers.find((candidate) =>
    candidate.sequence === sequenceId && candidate.kind === "video");
  return layer === undefined
    ? opFailure(
        "E_OP_NOT_FOUND",
        `Sequence ${sequenceId} has no sequence-bound video layer.`,
        [sequenceId],
      )
    : success(layer);
}

function targetVideoLayer(
  project: GuyditorProject,
  layerId: string,
  sequenceId: string,
): Result<Layer> {
  const layer = project.layers.find(({ id }) => id === layerId);
  if (layer === undefined) {
    return opFailure("E_OP_NOT_FOUND", `Layer ${layerId} does not exist.`, [layerId]);
  }
  if (layer.kind !== "video" || layer.sequence !== sequenceId) {
    return opFailure(
      "E_OP_LAYER_TARGET",
      `Layer ${layerId} must be a video layer bound to sequence ${sequenceId}.`,
      [layerId, sequenceId],
    );
  }
  if (layer.locked) {
    return opFailure(
      "E_OP_LAYER_LOCKED",
      `Layer ${layer.id} is locked.`,
      [layer.id],
    );
  }
  return success(layer);
}

function replaceSequence(
  project: GuyditorProject,
  sequenceIndex: number,
  sequence: Sequence,
): GuyditorProject {
  const sequences = project.sequences.slice();
  sequences[sequenceIndex] = sequence;
  return { ...project, sequences };
}

function replaceClips(
  project: GuyditorProject,
  located: LocatedClip,
  clips: Clip[],
): GuyditorProject {
  return replaceSequence(project, located.sequenceIndex, {
    ...located.sequence,
    clips,
  });
}

function exactSeconds(time: FrameTime) {
  return absoluteSeconds(time);
}

function validRange(
  source: Clip["source"],
  asset: Asset,
): Result<true> {
  const sourceIn = exactSeconds(source.in);
  if (!sourceIn.ok) return sourceIn;
  const sourceOut = exactSeconds(source.out);
  if (!sourceOut.ok) return sourceOut;
  const inVsZero = compareRational(sourceIn.value, "0/1");
  if (!inVsZero.ok) return inVsZero;
  const inVsOut = compareRational(sourceIn.value, sourceOut.value);
  if (!inVsOut.ok) return inVsOut;
  if (inVsZero.value === -1 || inVsOut.value !== -1) {
    return opFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      "The operation would produce a source range outside the asset.",
      [],
    );
  }

  if (asset.probe.duration !== undefined) {
    const duration = absoluteSeconds(asset.probe.duration);
    if (!duration.ok) return duration;
    const outVsDuration = compareRational(sourceOut.value, duration.value);
    if (!outVsDuration.ok) return outVsDuration;
    if (outVsDuration.value === 1) {
      return opFailure(
        "E_OP_RANGE_OUT_OF_BOUNDS",
        "The operation would extend beyond the probed asset duration.",
        [asset.id],
      );
    }
  }
  return success(true);
}

function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function humanClip(located: LocatedClip): string {
  return `${fileName(located.asset.path)} (${located.clip.id})`;
}

function humanDelta(delta: FrameTime): string {
  const seconds = absoluteSeconds(delta);
  const exact = seconds.ok ? seconds.value : "invalid";
  const sign = delta.frames >= 0 ? "+" : "";
  return `${sign}${String(delta.frames)} frames (${exact} s)`;
}

function optionalSnapPolicy(params: Record<string, unknown>): Record<string, unknown> {
  return params["snapPolicy"] === undefined
    ? {}
    : { snapPolicy: params["snapPolicy"] };
}

function applyTrim(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const edge = input.params["edge"] as "head" | "tail";
  const delta = input.params["delta"] as FrameTime;
  const found = locateClip(project, clipId);
  if (!found.ok) return found;
  const unlocked = ensureUnlocked(project, found.value);
  if (!unlocked.ok) return unlocked;
  const located = unlocked.value;
  const assetRate = located.asset.probe.fps ?? located.asset.video?.fps ?? located.clip.source.in.fps;
  if (delta.fps !== assetRate) {
    return opFailure(
      "E_OP_RATE_MISMATCH",
      `Trim delta rate ${delta.fps} does not match asset rate ${assetRate}.`,
      [clipId, located.asset.id],
    );
  }

  const source = {
    in: { ...located.clip.source.in },
    out: { ...located.clip.source.out },
  };
  if (edge === "head") source.in.frames += delta.frames;
  else source.out.frames -= delta.frames;
  const range = validRange(source, located.asset);
  if (!range.ok) {
    return opFailure(
      range.error.code,
      range.error.message,
      [clipId, ...range.error.affected],
    );
  }

  const clips = located.sequence.clips.slice();
  clips[located.clipIndex] = { ...located.clip, source };
  const inverseParams: Record<string, unknown> = {
    clipId,
    edge,
    delta: { frames: -delta.frames, fps: delta.fps },
    ...optionalSnapPolicy(input.params),
  };
  return success({
    model: replaceClips(project, located, clips),
    inverse: [{ op: "clip.trim", params: inverseParams }],
    affected: [clipId],
    summary: `Trim ${edge} of ${humanClip(located)} by ${humanDelta(delta)}`,
    mutations: [{
      entityId: clipId,
      entityType: "clip",
      change: "modified",
      fields: [{
        field: edge === "head" ? "source.in" : "source.out",
        before: located.clip.source[edge === "head" ? "in" : "out"],
        after: source[edge === "head" ? "in" : "out"],
      }],
    }],
  });
}

function duplicateEffects(
  clip: Clip,
  idFactory: IdFactory,
  restoredIds?: readonly string[],
): Result<Clip["effects"]> {
  if (restoredIds !== undefined && restoredIds.length !== (clip.effects?.length ?? 0)) {
    return opFailure(
      "E_OP_SCHEMA",
      "A replayed split must supply one restored effect ID per duplicated effect.",
      [clip.id],
    );
  }
  return success(clip.effects?.map((effect, index) => ({
    ...structuredClone(effect),
    id: restoredIds?.[index] ?? idFactory("fx"),
  })));
}

function applySplit(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const at = input.params["at"] as number;
  const found = locateClip(project, clipId);
  if (!found.ok) return found;
  const unlocked = ensureUnlocked(project, found.value);
  if (!unlocked.ok) return unlocked;
  const located = unlocked.value;
  const length = located.clip.source.out.frames - located.clip.source.in.frames;
  if (at <= 0 || at >= length) {
    return opFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `Split position ${String(at)} must be inside clip ${clipId}.`,
      [clipId],
    );
  }

  const boundary = {
    frames: located.clip.source.in.frames + at,
    fps: located.clip.source.in.fps,
  };
  const first: Clip = {
    ...located.clip,
    source: { in: located.clip.source.in, out: boundary },
  };
  delete first.transitionAfter;
  const second: Clip = {
    ...located.clip,
    id: typeof input.params["newClipId"] === "string"
      ? input.params["newClipId"]
      : idFactory("clp"),
    source: { in: boundary, out: located.clip.source.out },
  };
  const effects = duplicateEffects(
    located.clip,
    idFactory,
    Array.isArray(input.params["newEffectIds"])
      ? input.params["newEffectIds"] as string[]
      : undefined,
  );
  if (!effects.ok) return effects;
  if (effects.value !== undefined) second.effects = effects.value;
  delete second.gapBefore;
  delete second.overlapPrevious;

  const clips = located.sequence.clips.slice();
  clips.splice(located.clipIndex, 1, first, second);
  const firstFields: SemanticFieldDelta[] = [
    { field: "source.out", before: located.clip.source.out, after: boundary },
    ...(located.clip.transitionAfter === undefined
      ? []
      : [{ field: "transitionAfter", before: located.clip.transitionAfter }]),
  ];
  const mutations: EntityMutation[] = [
    {
      entityId: first.id,
      entityType: "clip",
      change: "modified",
      fields: firstFields,
    },
    {
      entityId: second.id,
      entityType: "clip",
      change: "added",
      fields: [{ field: "$entity", after: second }],
    },
    ...(second.effects ?? []).map((effect) => ({
      entityId: effect.id,
      entityType: "effect" as const,
      change: "added" as const,
      fields: [{ field: "$entity", after: effect }],
    })),
  ];
  return success({
    model: replaceClips(project, located, clips),
    inverse: [{
      op: "clip.join",
      params: { clipIds: [first.id, second.id] },
    }],
    redo: {
      op: "clip.split",
      params: {
        ...input.params,
        newClipId: second.id,
        ...(second.effects === undefined
          ? {}
          : { newEffectIds: second.effects.map(({ id }) => id) }),
      },
    },
    affected: mutations.map(({ entityId }) => entityId),
    summary: `Split ${humanClip(located)} at ${String(at)} frames (effects duplicated)`,
    mutations,
  });
}

function normalizedEffects(clip: Clip): unknown {
  return clip.effects?.map((effect) => ({
    kind: effect.kind,
    params: effect.params,
  })) ?? [];
}

function clipPayload(clip: Clip): unknown {
  return {
    effects: normalizedEffects(clip),
    audio: clip.audio,
    loop: clip.loop,
    anchor: clip.anchor,
    punchIn: clip.punchIn,
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (
    typeof left === "object" && left !== null && !Array.isArray(left) &&
    typeof right === "object" && right !== null && !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined).sort();
    const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined).sort();
    return deepEqual(leftKeys, rightKeys) && leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function locateJoinClips(
  project: GuyditorProject,
  clipIds: readonly string[],
): Result<{ located: LocatedClip; clips: Clip[] }> {
  const first = locateClip(project, clipIds[0]!);
  if (!first.ok) return first;
  const unlocked = ensureUnlocked(project, first.value);
  if (!unlocked.ok) return unlocked;
  const clips = clipIds.map((id, offset) =>
    unlocked.value.sequence.clips[unlocked.value.clipIndex + offset]?.id === id
      ? unlocked.value.sequence.clips[unlocked.value.clipIndex + offset]
      : undefined,
  );
  if (clips.some((clip) => clip === undefined)) {
    return opFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      "Joined clips must be adjacent and listed in timeline order.",
      [...clipIds],
    );
  }
  return success({ located: unlocked.value, clips: clips as Clip[] });
}

function validateJoin(clips: readonly Clip[]): Result<true> {
  const first = clips[0]!;
  for (const [index, clip] of clips.entries()) {
    if (clip.asset !== first.asset || !deepEqual(clipPayload(clip), clipPayload(first))) {
      return opFailure(
        "E_OP_RANGE_OUT_OF_BOUNDS",
        "Joined clips must use the same asset and compatible clip state.",
        clips.map(({ id }) => id),
      );
    }
    if (index === 0) continue;
    const previous = clips[index - 1]!;
    const contiguous =
      previous.source.out.fps === clip.source.in.fps &&
      previous.source.out.frames === clip.source.in.frames;
    const internalBoundary =
      previous.transitionAfter !== undefined ||
      clip.gapBefore !== undefined ||
      clip.overlapPrevious !== undefined;
    if (!contiguous || internalBoundary) {
      return opFailure(
        "E_OP_RANGE_OUT_OF_BOUNDS",
        "Joined clips must be source-contiguous with no internal gap, overlap, or transition.",
        [previous.id, clip.id],
      );
    }
  }
  return success(true);
}

function applyJoin(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const clipIds = input.params["clipIds"] as string[];
  const found = locateJoinClips(project, clipIds);
  if (!found.ok) return found;
  const compatibility = validateJoin(found.value.clips);
  if (!compatibility.ok) return compatibility;
  const first = found.value.clips[0]!;
  const last = found.value.clips.at(-1)!;
  const joined: Clip = {
    ...first,
    source: { in: first.source.in, out: last.source.out },
  };
  if (last.transitionAfter === undefined) delete joined.transitionAfter;
  else joined.transitionAfter = last.transitionAfter;

  const clips = found.value.located.sequence.clips.slice();
  clips.splice(found.value.located.clipIndex, found.value.clips.length, joined);
  const inverse: OperationInput[] = [];
  for (let index = found.value.clips.length - 1; index >= 1; index -= 1) {
    inverse.push({
      op: "clip.split",
      params: {
        clipId: joined.id,
        at: found.value.clips[index]!.source.in.frames - first.source.in.frames,
        newClipId: found.value.clips[index]!.id,
        ...(found.value.clips[index]!.effects === undefined
          ? {}
          : { newEffectIds: found.value.clips[index]!.effects!.map(({ id }) => id) }),
      },
    });
  }
  const joinedFields: SemanticFieldDelta[] = [
    { field: "source.out", before: first.source.out, after: last.source.out },
    ...(last.transitionAfter === undefined
      ? []
      : [{ field: "transitionAfter", after: last.transitionAfter }]),
  ];
  const mutations: EntityMutation[] = [
    {
      entityId: joined.id,
      entityType: "clip",
      change: "modified",
      fields: joinedFields,
    },
    ...found.value.clips.slice(1).flatMap((clip) => [
      {
        entityId: clip.id,
        entityType: "clip" as const,
        change: "removed" as const,
        fields: [{ field: "$entity", before: clip }],
      },
      ...(clip.effects ?? []).map((effect) => ({
        entityId: effect.id,
        entityType: "effect" as const,
        change: "removed" as const,
        fields: [{ field: "$entity", before: effect }],
      })),
    ]),
  ];
  return success({
    model: replaceClips(project, found.value.located, clips),
    inverse,
    affected: mutations.map(({ entityId }) => entityId),
    summary: `Join ${String(clipIds.length)} clips of ${fileName(found.value.located.asset.path)}`,
    mutations,
  });
}

function addedClipMutations(clip: Clip): EntityMutation[] {
  return [
    {
      entityId: clip.id,
      entityType: "clip",
      change: "added",
      fields: [{ field: "$entity", after: clip }],
    },
    ...(clip.effects ?? []).map((effect) => ({
      entityId: effect.id,
      entityType: "effect" as const,
      change: "added" as const,
      fields: [{ field: "$entity", after: effect }],
    })),
  ];
}

function applyInsert(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  const sequenceId = input.params["sequenceId"] as string;
  const index = input.params["index"] as number;
  const layerId = input.params["layerId"] as string;
  const sourceParam = input.params["source"] as {
    assetId: string;
    in: FrameTime;
    out: FrameTime;
  };
  const sequenceIndex = project.sequences.findIndex(({ id }) => id === sequenceId);
  const sequence = project.sequences[sequenceIndex];
  if (sequence === undefined) {
    return opFailure("E_OP_NOT_FOUND", `Sequence ${sequenceId} does not exist.`, [sequenceId]);
  }
  const layer = targetVideoLayer(project, layerId, sequenceId);
  if (!layer.ok) return layer;
  if (index > sequence.clips.length) {
    return opFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `Insert index ${String(index)} is outside sequence ${sequenceId}.`,
      [sequenceId],
    );
  }
  const asset = project.assets.find(({ id }) => id === sourceParam.assetId);
  if (asset === undefined) {
    return opFailure("E_OP_NOT_FOUND", `Asset ${sourceParam.assetId} does not exist.`, [sourceParam.assetId]);
  }
  const range = validRange({ in: sourceParam.in, out: sourceParam.out }, asset);
  if (!range.ok) return range;
  const clipId = typeof input.params["clipId"] === "string"
    ? input.params["clipId"]
    : idFactory("clp");
  if (project.sequences.some(({ clips }) => clips.some(({ id }) => id === clipId))) {
    return opFailure("E_OP_ID_CONFLICT", `Clip ${clipId} already exists.`, [clipId]);
  }
  const restored = input.params["restore"] as Clip | undefined;
  const clip: Clip = restored === undefined
    ? {
        id: clipId,
        asset: sourceParam.assetId,
        source: structuredClone({ in: sourceParam.in, out: sourceParam.out }),
      }
    : structuredClone(restored);
  if (
    clip.id !== clipId || clip.asset !== sourceParam.assetId ||
    !deepEqual(clip.source, { in: sourceParam.in, out: sourceParam.out })
  ) {
    return opFailure(
      "E_OP_CAPTURE_MISMATCH",
      "Captured clip payload does not match clip.insert addressing fields.",
      [clipId, sourceParam.assetId],
    );
  }

  const clips = sequence.clips.slice();
  const followingClipId = input.params["followingClipId"];
  if (typeof followingClipId === "string") {
    const following = clips[index];
    if (following?.id !== followingClipId) {
      return opFailure(
        "E_OP_CAPTURE_MISMATCH",
        `Captured following clip ${followingClipId} is not at insertion index ${String(index)}.`,
        [followingClipId, sequenceId],
      );
    }
    const restoredFollowing = { ...following };
    const priorGap = input.params["followingGapBefore"] as FrameTime | null;
    if (priorGap === null) delete restoredFollowing.gapBefore;
    else restoredFollowing.gapBefore = structuredClone(priorGap);
    clips[index] = restoredFollowing;
  }
  clips.splice(index, 0, clip);
  const mutations = addedClipMutations(clip);
  const redoParams = { ...input.params, clipId };
  return success({
    model: replaceSequence(project, sequenceIndex, { ...sequence, clips }),
    inverse: [{ op: "clip.remove", params: { clipId, closeGap: true } }],
    redo: { op: "clip.insert", params: redoParams },
    affected: mutations.map(({ entityId }) => entityId),
    summary: `Insert ${fileName(asset.path)} range at position ${String(index)}`,
    mutations,
  });
}

function applyRemove(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const found = locateClip(project, clipId);
  if (!found.ok) return found;
  const unlocked = ensureUnlocked(project, found.value);
  if (!unlocked.ok) return unlocked;
  const located = unlocked.value;
  const layer = layerForSequence(project, located.sequence.id);
  if (!layer.ok) return layer;
  const clips = located.sequence.clips.slice();
  const closeGap = input.params["closeGap"] !== false;
  let followingClipId: string | undefined;
  let followingGapBefore: FrameTime | null | undefined;
  if (!closeGap) {
    const following = clips[located.clipIndex + 1];
    const previous = clips[located.clipIndex - 1];
    if (following !== undefined) {
      if (
        previous?.transitionAfter !== undefined || located.clip.overlapPrevious !== undefined ||
        located.clip.transitionAfter !== undefined || following.overlapPrevious !== undefined
      ) {
        return opFailure(
          "E_OP_BOUNDARY_CONFLICT",
          "Keeping a removed clip as a gap requires an otherwise empty boundary.",
          [located.clip.id, following.id],
        );
      }
      const derivation = deriveTimeline(project, located.sequence.id);
      if (!derivation.ok) return derivation;
      const duration = derivation.value.clips.find(
        ({ clipId: derivedClipId }) => derivedClipId === located.clip.id,
      )?.duration;
      if (duration === undefined) {
        return opFailure(
          "E_OP_NOT_FOUND",
          `Clip ${located.clip.id} has no derived timeline duration.`,
          [located.clip.id],
        );
      }
      const existingGap = following.gapBefore?.frames ?? 0;
      const removedGap = located.clip.gapBefore?.frames ?? 0;
      followingClipId = following.id;
      followingGapBefore = following.gapBefore === undefined
        ? null
        : structuredClone(following.gapBefore);
      clips[located.clipIndex + 1] = {
        ...following,
        gapBefore: {
          frames: existingGap + removedGap + duration.frames,
          fps: project.settings.timeline.fps,
        },
      };
    }
  }
  clips.splice(located.clipIndex, 1);
  const removed = structuredClone(located.clip);
  const mutations: EntityMutation[] = [
    {
      entityId: removed.id,
      entityType: "clip",
      change: "removed",
      fields: [{ field: "$entity", before: removed }],
    },
    ...(removed.effects ?? []).map((effect) => ({
      entityId: effect.id,
      entityType: "effect" as const,
      change: "removed" as const,
      fields: [{ field: "$entity", before: effect }],
    })),
  ];
  return success({
    model: replaceClips(project, located, clips),
    inverse: [{
      op: "clip.insert",
      params: {
        sequenceId: located.sequence.id,
        index: located.clipIndex,
        layerId: layer.value.id,
        clipId: removed.id,
        source: {
          assetId: removed.asset,
          in: removed.source.in,
          out: removed.source.out,
        },
        restore: removed,
        ...(followingClipId === undefined
          ? {}
          : { followingClipId, followingGapBefore }),
      },
    }],
    affected: mutations.map(({ entityId }) => entityId),
    summary: `Remove ${humanClip(located)} (${String(
      located.clip.source.out.frames - located.clip.source.in.frames
    )} frames)`,
    mutations,
  });
}

function applyRestore(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const sequenceId = input.params["sequenceId"] as string;
  const targetIndex = input.params["targetIndex"] as number;
  const restored = structuredClone(input.params["clips"] as Clip[]);
  const sequenceIndex = project.sequences.findIndex(({ id }) => id === sequenceId);
  const sequence = project.sequences[sequenceIndex];
  if (sequence === undefined) {
    return opFailure("E_OP_NOT_FOUND", `Sequence ${sequenceId} does not exist.`, [sequenceId]);
  }
  const lockedLayer = project.layers.find((layer) => layer.sequence === sequenceId && layer.locked);
  if (lockedLayer !== undefined) {
    return opFailure(
      "E_OP_LAYER_LOCKED",
      `Layer ${lockedLayer.id} is locked.`,
      [lockedLayer.id, sequenceId],
    );
  }
  if (targetIndex > sequence.clips.length) {
    return opFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `Restore index ${String(targetIndex)} is outside sequence ${sequenceId}.`,
      [sequenceId],
    );
  }
  const existingIds = new Set(project.sequences.flatMap(({ clips }) => clips.map(({ id }) => id)));
  for (const clip of restored) {
    if (existingIds.has(clip.id)) {
      return opFailure("E_OP_ID_CONFLICT", `Clip ${clip.id} already exists.`, [clip.id]);
    }
    const asset = project.assets.find(({ id }) => id === clip.asset);
    if (asset === undefined) {
      return opFailure("E_OP_NOT_FOUND", `Asset ${clip.asset} does not exist.`, [clip.id, clip.asset]);
    }
    const range = validRange(clip.source, asset);
    if (!range.ok) return range;
    existingIds.add(clip.id);
  }
  const clips = sequence.clips.slice();
  clips.splice(targetIndex, 0, ...restored);
  const model = replaceSequence(project, sequenceIndex, { ...sequence, clips });
  const mutations: EntityMutation[] = restored.flatMap((clip) => [
    {
      entityId: clip.id,
      entityType: "clip" as const,
      change: "added" as const,
      fields: [{ field: "$entity", after: clip }],
    },
    ...(clip.effects ?? []).map((effect) => ({
      entityId: effect.id,
      entityType: "effect" as const,
      change: "added" as const,
      fields: [{ field: "$entity", after: effect }],
    })),
  ]);
  return success({
    model,
    inverse: restored.slice().reverse().map(({ id }) => ({
      op: "clip.remove",
      params: { clipId: id },
    })),
    affected: mutations.map(({ entityId }) => entityId),
    summary: `Restore ${String(restored.length)} clip${restored.length === 1 ? "" : "s"} in ${sequence.name}`,
    mutations,
  });
}

function applyMove(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const found = locateClip(project, clipId);
  if (!found.ok) return found;
  const unlocked = ensureUnlocked(project, found.value);
  if (!unlocked.ok) return unlocked;
  const source = unlocked.value;
  const sourceLayer = layerForSequence(project, source.sequence.id);
  if (!sourceLayer.ok) return sourceLayer;

  const requestedLayerId = input.params["toLayerId"] as string | undefined;
  const requestedLayer = requestedLayerId === undefined
    ? undefined
    : project.layers.find(({ id }) => id === requestedLayerId);
  if (requestedLayerId !== undefined && requestedLayer === undefined) {
    return opFailure("E_OP_NOT_FOUND", `Layer ${requestedLayerId} does not exist.`, [requestedLayerId]);
  }
  const toSequenceId = input.params["toSequenceId"] as string | undefined ??
    requestedLayer?.sequence ?? source.sequence.id;
  const toSequenceIndex = project.sequences.findIndex(({ id }) => id === toSequenceId);
  const toSequence = project.sequences[toSequenceIndex];
  if (toSequence === undefined) {
    return opFailure("E_OP_NOT_FOUND", `Sequence ${toSequenceId} does not exist.`, [toSequenceId]);
  }
  const inferredLayer = requestedLayerId === undefined
    ? layerForSequence(project, toSequenceId)
    : success(requestedLayer!);
  if (!inferredLayer.ok) return inferredLayer;
  const destinationLayer = targetVideoLayer(project, inferredLayer.value.id, toSequenceId);
  if (!destinationLayer.ok) return destinationLayer;

  const toIndex = input.params["toIndex"] as number;
  const sameSequence = source.sequence.id === toSequenceId;
  const maximumIndex = toSequence.clips.length - (sameSequence ? 1 : 0);
  if (toIndex > maximumIndex) {
    return opFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `Move index ${String(toIndex)} is outside sequence ${toSequenceId}.`,
      [clipId, toSequenceId],
    );
  }

  const sourceClips = source.sequence.clips.slice();
  const [moved] = sourceClips.splice(source.clipIndex, 1);
  if (moved === undefined) {
    return opFailure("E_OP_NOT_FOUND", `Clip ${clipId} disappeared during move.`, [clipId]);
  }
  let model: GuyditorProject;
  if (sameSequence) {
    sourceClips.splice(toIndex, 0, moved);
    model = replaceSequence(project, source.sequenceIndex, {
      ...source.sequence,
      clips: sourceClips,
    });
  } else {
    const destinationClips = toSequence.clips.slice();
    destinationClips.splice(toIndex, 0, moved);
    const sequences = project.sequences.slice();
    sequences[source.sequenceIndex] = { ...source.sequence, clips: sourceClips };
    sequences[toSequenceIndex] = { ...toSequence, clips: destinationClips };
    model = { ...project, sequences };
  }
  const fields: SemanticFieldDelta[] = [
    { field: "order", before: source.clipIndex, after: toIndex },
    ...(sameSequence
      ? []
      : [{ field: "sequenceId", before: source.sequence.id, after: toSequenceId }]),
  ];
  return success({
    model,
    inverse: [{
      op: "clip.move",
      params: {
        clipId,
        toSequenceId: source.sequence.id,
        toLayerId: sourceLayer.value.id,
        toIndex: source.clipIndex,
      },
    }],
    affected: [...new Set([clipId, source.sequence.id, toSequenceId])],
    summary: `Move ${humanClip(source)} to ${destinationLayer.value.name} position ${String(toIndex)}`,
    mutations: [{
      entityId: clipId,
      entityType: "clip",
      change: "modified",
      fields,
    }],
  });
}

function applyDuplicate(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const found = locateClip(project, clipId);
  if (!found.ok) return found;
  const unlocked = ensureUnlocked(project, found.value);
  if (!unlocked.ok) return unlocked;
  const located = unlocked.value;
  const toIndex = input.params["toIndex"] as number;
  if (toIndex > located.sequence.clips.length) {
    return opFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `Duplicate index ${String(toIndex)} is outside sequence ${located.sequence.id}.`,
      [clipId],
    );
  }
  const duplicateClipId = input.params["duplicateClipId"] as string | undefined ?? idFactory("clp");
  if (project.sequences.some(({ clips }) => clips.some(({ id }) => id === duplicateClipId))) {
    return opFailure("E_OP_ID_CONFLICT", `Clip ${duplicateClipId} already exists.`, [duplicateClipId]);
  }
  const duplicateEffectIds = input.params["duplicateEffectIds"] as string[] | undefined;
  if (
    duplicateEffectIds !== undefined &&
    duplicateEffectIds.length !== (located.clip.effects?.length ?? 0)
  ) {
    return opFailure(
      "E_OP_CAPTURE_MISMATCH",
      "A replayed duplicate must supply one effect ID per duplicated effect.",
      [clipId],
    );
  }
  const duplicate: Clip = structuredClone(located.clip);
  duplicate.id = duplicateClipId;
  if (duplicate.effects !== undefined) {
    duplicate.effects = duplicate.effects.map((effect, index) => ({
      ...effect,
      id: duplicateEffectIds?.[index] ?? idFactory("fx"),
    }));
  }
  if (duplicate.transitionAfter !== undefined) {
    duplicate.transitionAfter = {
      ...duplicate.transitionAfter,
      id: input.params["duplicateTransitionId"] as string | undefined ?? idFactory("trn"),
    };
  }
  const clips = located.sequence.clips.slice();
  clips.splice(toIndex, 0, duplicate);
  const mutations = addedClipMutations(duplicate);
  return success({
    model: replaceClips(project, located, clips),
    inverse: [{
      op: "clip.remove",
      params: { clipId: duplicate.id, closeGap: true },
    }],
    redo: {
      op: "clip.duplicate",
      params: {
        ...input.params,
        duplicateClipId: duplicate.id,
        ...(duplicate.effects === undefined
          ? {}
          : { duplicateEffectIds: duplicate.effects.map(({ id }) => id) }),
        ...(duplicate.transitionAfter === undefined
          ? {}
          : { duplicateTransitionId: duplicate.transitionAfter.id }),
      },
    },
    affected: mutations.map(({ entityId }) => entityId),
    summary: `Duplicate ${humanClip(located)}`,
    mutations,
  });
}

function boundaryTime(
  project: GuyditorProject,
  value: FrameTime | null,
  label: string,
  clipId: string,
): Result<FrameTime | undefined> {
  if (value === null || value.frames === 0) return success(undefined);
  if (value.fps !== project.settings.timeline.fps) {
    return opFailure(
      "E_OP_RATE_MISMATCH",
      `${label} rate ${value.fps} does not match timeline rate ${project.settings.timeline.fps}.`,
      [clipId],
    );
  }
  return success(structuredClone(value));
}

function applyGapSet(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const found = locateClip(project, clipId);
  if (!found.ok) return found;
  const unlocked = ensureUnlocked(project, found.value);
  if (!unlocked.ok) return unlocked;
  const located = unlocked.value;
  const leadingGap = boundaryTime(
    project,
    input.params["leadingGap"] as FrameTime | null,
    "Gap",
    clipId,
  );
  if (!leadingGap.ok) return leadingGap;
  const previous = located.sequence.clips[located.clipIndex - 1];
  if (
    leadingGap.value !== undefined &&
    (located.clip.overlapPrevious !== undefined || previous?.transitionAfter !== undefined)
  ) {
    return opFailure(
      "E_OP_BOUNDARY_CONFLICT",
      `Gap before ${clipId} is exclusive with overlap and transition state.`,
      [clipId, ...(previous === undefined ? [] : [previous.id])],
    );
  }
  const replacement = { ...located.clip };
  if (leadingGap.value === undefined) delete replacement.gapBefore;
  else replacement.gapBefore = leadingGap.value;
  const clips = located.sequence.clips.slice();
  clips[located.clipIndex] = replacement;
  return success({
    model: replaceClips(project, located, clips),
    inverse: [{
      op: "clip.gap.set",
      params: {
        clipId,
        leadingGap: located.clip.gapBefore === undefined
          ? null
          : structuredClone(located.clip.gapBefore),
      },
    }],
    affected: [clipId],
    summary: `Set gap before ${humanClip(located)} to ${leadingGap.value === undefined
      ? "0 frames"
      : `${String(leadingGap.value.frames)} frames`}`,
    mutations: [{
      entityId: clipId,
      entityType: "clip",
      change: "modified",
      fields: [{
        field: "gapBefore",
        ...(located.clip.gapBefore === undefined ? {} : { before: located.clip.gapBefore }),
        ...(leadingGap.value === undefined ? {} : { after: leadingGap.value }),
      }],
    }],
  });
}

function applyOverlapSet(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const found = locateClip(project, clipId);
  if (!found.ok) return found;
  const unlocked = ensureUnlocked(project, found.value);
  if (!unlocked.ok) return unlocked;
  const located = unlocked.value;
  const overlap = boundaryTime(
    project,
    input.params["overlapWithPrevious"] as FrameTime | null,
    "Overlap",
    clipId,
  );
  if (!overlap.ok) return overlap;
  const previous = located.sequence.clips[located.clipIndex - 1];
  if (overlap.value !== undefined && previous === undefined) {
    return opFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `First clip ${clipId} cannot overlap a previous clip.`,
      [clipId],
    );
  }
  if (
    overlap.value !== undefined &&
    (located.clip.gapBefore !== undefined || previous?.transitionAfter !== undefined)
  ) {
    return opFailure(
      "E_OP_BOUNDARY_CONFLICT",
      `Overlap before ${clipId} is exclusive with gap and transition state.`,
      [clipId, ...(previous === undefined ? [] : [previous.id])],
    );
  }
  const replacement = { ...located.clip };
  if (overlap.value === undefined) delete replacement.overlapPrevious;
  else replacement.overlapPrevious = overlap.value;
  const clips = located.sequence.clips.slice();
  clips[located.clipIndex] = replacement;
  const model = replaceClips(project, located, clips);
  const derived = deriveTimeline(model, located.sequence.id);
  if (!derived.ok) return derived;
  return success({
    model,
    inverse: [{
      op: "clip.overlap.set",
      params: {
        clipId,
        overlapWithPrevious: located.clip.overlapPrevious === undefined
          ? null
          : structuredClone(located.clip.overlapPrevious),
      },
    }],
    affected: [clipId],
    summary: `Overlap ${humanClip(located)} with previous by ${overlap.value === undefined
      ? "0 frames"
      : `${String(overlap.value.frames)} frames`}`,
    mutations: [{
      entityId: clipId,
      entityType: "clip",
      change: "modified",
      fields: [{
        field: "overlapPrevious",
        ...(located.clip.overlapPrevious === undefined
          ? {}
          : { before: located.clip.overlapPrevious }),
        ...(overlap.value === undefined ? {} : { after: overlap.value }),
      }],
    }],
  });
}

function withoutEmptyAudio(audio: NonNullable<Clip["audio"]>): Clip["audio"] {
  return Object.keys(audio).length === 0 ? undefined : audio;
}

function applyAudioGainSet(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const found = locateClip(project, clipId);
  if (!found.ok) return found;
  const unlocked = ensureUnlocked(project, found.value);
  if (!unlocked.ok) return unlocked;
  const located = unlocked.value;
  const gainDb = input.params["gainDb"] as number | null;
  const audio = { ...located.clip.audio };
  if (gainDb === null) delete audio.gainDb;
  else audio.gainDb = gainDb;
  const replacement = { ...located.clip };
  const nextAudio = withoutEmptyAudio(audio);
  if (nextAudio === undefined) delete replacement.audio;
  else replacement.audio = nextAudio;
  const clips = located.sequence.clips.slice();
  clips[located.clipIndex] = replacement;
  return success({
    model: replaceClips(project, located, clips),
    inverse: [{
      op: "clip.audio.gain.set",
      params: { clipId, gainDb: located.clip.audio?.gainDb ?? null },
    }],
    affected: [clipId],
    summary: `Set ${humanClip(located)} gain to ${gainDb === null ? "default" : String(gainDb)} dB`,
    mutations: [{
      entityId: clipId,
      entityType: "clip",
      change: "modified",
      fields: [{
        field: "audio.gainDb",
        ...(located.clip.audio?.gainDb === undefined ? {} : { before: located.clip.audio.gainDb }),
        ...(gainDb === null ? {} : { after: gainDb }),
      }],
    }],
  });
}

interface FadeParameter {
  t: FrameTime;
  curve: string;
}

function applyAudioFadeSet(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const found = locateClip(project, clipId);
  if (!found.ok) return found;
  const unlocked = ensureUnlocked(project, found.value);
  if (!unlocked.ok) return unlocked;
  const located = unlocked.value;
  const fadeIn = input.params["fadeIn"] as FadeParameter | null;
  const fadeOut = input.params["fadeOut"] as FadeParameter | null;
  for (const [name, fade] of [["Fade-in", fadeIn], ["Fade-out", fadeOut]] as const) {
    if (fade !== null && fade.t.fps !== project.settings.timeline.fps) {
      return opFailure(
        "E_OP_RATE_MISMATCH",
        `${name} rate ${fade.t.fps} does not match timeline rate ${project.settings.timeline.fps}.`,
        [clipId],
      );
    }
  }
  const audio = { ...located.clip.audio };
  if (fadeIn === null) {
    delete audio.fadeIn;
    delete audio.fadeInCurve;
  } else {
    audio.fadeIn = structuredClone(fadeIn.t);
    audio.fadeInCurve = fadeIn.curve;
  }
  if (fadeOut === null) {
    delete audio.fadeOut;
    delete audio.fadeOutCurve;
  } else {
    audio.fadeOut = structuredClone(fadeOut.t);
    audio.fadeOutCurve = fadeOut.curve;
  }
  const replacement = { ...located.clip };
  const nextAudio = withoutEmptyAudio(audio);
  if (nextAudio === undefined) delete replacement.audio;
  else replacement.audio = nextAudio;
  const clips = located.sequence.clips.slice();
  clips[located.clipIndex] = replacement;
  const priorFadeIn: FadeParameter | null = located.clip.audio?.fadeIn === undefined
    ? null
    : {
        t: structuredClone(located.clip.audio.fadeIn),
        curve: located.clip.audio.fadeInCurve ?? "linear",
      };
  const priorFadeOut: FadeParameter | null = located.clip.audio?.fadeOut === undefined
    ? null
    : {
        t: structuredClone(located.clip.audio.fadeOut),
        curve: located.clip.audio.fadeOutCurve ?? "linear",
      };
  return success({
    model: replaceClips(project, located, clips),
    inverse: [{
      op: "clip.audio.fade.set",
      params: { clipId, fadeIn: priorFadeIn, fadeOut: priorFadeOut },
    }],
    affected: [clipId],
    summary: `Set audio fades on ${humanClip(located)}`,
    mutations: [{
      entityId: clipId,
      entityType: "clip",
      change: "modified",
      fields: [
        { field: "audio.fadeIn", before: priorFadeIn, after: fadeIn },
        { field: "audio.fadeOut", before: priorFadeOut, after: fadeOut },
      ],
    }],
  });
}

export function applyClipOperation(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  if (input.op === "clip.trim") return applyTrim(project, input);
  if (input.op === "clip.split") return applySplit(project, input, idFactory);
  if (input.op === "clip.remove") return applyRemove(project, input);
  if (input.op === "clip.restore") return applyRestore(project, input);
  if (input.op === "clip.join") return applyJoin(project, input);
  if (input.op === "clip.insert") return applyInsert(project, input, idFactory);
  if (input.op === "clip.move") return applyMove(project, input);
  if (input.op === "clip.duplicate") return applyDuplicate(project, input, idFactory);
  if (input.op === "clip.gap.set") return applyGapSet(project, input);
  if (input.op === "clip.overlap.set") return applyOverlapSet(project, input);
  if (input.op === "clip.audio.gain.set") return applyAudioGainSet(project, input);
  return applyAudioFadeSet(project, input);
}

// TODO(Part 5 §5.3): resolve `word:` split anchors after transcript sidecars land.
// TODO(Part 5 §5.3): implement zero-crossing and word-boundary snap policies;
// M0 accepts the values but applies the requested exact trim.
