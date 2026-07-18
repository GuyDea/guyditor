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
  Sequence,
} from "../project/index.js";
import type { IdFactory } from "./engine.js";
import type {
  OperationInput,
  SemanticFieldDelta,
} from "./types.js";

export interface EntityMutation {
  entityId: string;
  entityType: "asset" | "clip" | "effect";
  change: "added" | "removed" | "modified";
  fields: SemanticFieldDelta[];
}

export interface ClipApplication {
  model: GuyditorProject;
  inverse: OperationInput[];
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

function duplicateEffects(clip: Clip, idFactory: IdFactory): Clip["effects"] {
  return clip.effects?.map((effect) => ({
    ...structuredClone(effect),
    id: idFactory("fx"),
  }));
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
    id: idFactory("clp"),
    source: { in: boundary, out: located.clip.source.out },
  };
  const effects = duplicateEffects(located.clip, idFactory);
  if (effects !== undefined) second.effects = effects;
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

export function applyClipOperation(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  if (input.op === "clip.trim") return applyTrim(project, input);
  if (input.op === "clip.split") return applySplit(project, input, idFactory);
  return applyJoin(project, input);
}

// TODO(Part 5 §5.3): resolve `word:` split anchors after transcript sidecars land.
// TODO(Part 5 §5.3): implement zero-crossing and word-boundary snap policies;
// M0 accepts the values but applies the requested exact trim.
