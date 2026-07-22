import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type {
  AudioChain,
  Clip,
  ColorCorrection,
  DuckingConfig,
  DuckingOverridePoint,
  Effect,
  GuyditorProject,
  Layer,
  LookApplication,
  PresetPin,
  SemanticAnchor,
  Sequence,
} from "../project/index.js";
import type { FrameTime, SampleTime } from "../time/index.js";
import type { IdFactory } from "./engine.js";
import type { ClipApplication, EntityMutation } from "./clip.js";
import type { OperationInput, SemanticFieldDelta } from "./types.js";

export const AUDIO_CHAIN_ORDER = [
  "channelSelect",
  "noiseReduction",
  "gain",
  "eq",
  "compression",
  "limiting",
] as const;

const AUDIO_ROLE_KINDS = new Set<Layer["kind"]>(["audio", "music", "ambience", "sfx"]);

const BUILTIN_LOOKS: Readonly<Record<string, ColorCorrection>> = {
  "look-neutral": { exposure: 0, contrast: 1, temperatureK: 6500, tint: 0, saturation: 1 },
  "look-warm-documentary": {
    exposure: 0.2,
    contrast: 1.08,
    temperatureK: 6200,
    tint: 0.04,
    saturation: 1.06,
  },
  "look-cool-clean": {
    exposure: 0.1,
    contrast: 1.04,
    temperatureK: 4800,
    tint: -0.02,
    saturation: 0.96,
  },
};

export function isBuiltinLookPresetPinAvailable(
  pin: Pick<PresetPin, "kind" | "path" | "version">,
): boolean {
  if (pin.kind !== "look") return false;
  const builtin = /^builtin:(look-[a-z-]+)@([0-9]+)$/u.exec(pin.path);
  return builtin !== null &&
    Number(builtin[2]) === pin.version &&
    BUILTIN_LOOKS[builtin[1]!] !== undefined;
}

function operationFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[],
): Result<never> {
  return failure(makeGuyditorError(code, message, { affected }));
}

function mutation(
  entityId: string,
  entityType: EntityMutation["entityType"],
  field: string,
  before: unknown,
  after: unknown,
): EntityMutation {
  const delta: SemanticFieldDelta = {
    field,
    ...(before === undefined ? {} : { before: structuredClone(before) }),
    ...(after === undefined ? {} : { after: structuredClone(after) }),
  };
  return { entityId, entityType, change: "modified", fields: [delta] };
}

function application(
  model: GuyditorProject,
  inverse: OperationInput[],
  affected: string[],
  summary: string,
  mutations: EntityMutation[],
  redo?: OperationInput,
): Result<ClipApplication> {
  return success({ model, inverse, affected, summary, mutations, ...(redo === undefined ? {} : { redo }) });
}

function locateClip(project: GuyditorProject, clipId: string): Result<{
  sequenceIndex: number;
  clipIndex: number;
  sequence: Sequence;
  clip: Clip;
}> {
  for (const [sequenceIndex, sequence] of project.sequences.entries()) {
    const clipIndex = sequence.clips.findIndex(({ id }) => id === clipId);
    const clip = sequence.clips[clipIndex];
    if (clip === undefined) continue;
    const locked = project.layers.find(({ sequence: id, locked: isLocked }) =>
      id === sequence.id && isLocked);
    if (locked !== undefined) {
      return operationFailure(
        "E_OP_LAYER_LOCKED",
        `Layer ${locked.id} is locked.`,
        [locked.id, clipId],
      );
    }
    return success({ sequenceIndex, clipIndex, sequence, clip });
  }
  return operationFailure("E_OP_NOT_FOUND", `Clip ${clipId} does not exist.`, [clipId]);
}

function replaceClip(
  project: GuyditorProject,
  located: { sequenceIndex: number; clipIndex: number; sequence: Sequence },
  clip: Clip,
): GuyditorProject {
  const clips = located.sequence.clips.slice();
  clips[located.clipIndex] = clip;
  const sequences = project.sequences.slice();
  sequences[located.sequenceIndex] = { ...located.sequence, clips };
  return { ...project, sequences };
}

function locateLayer(project: GuyditorProject, layerId: string): Result<{ index: number; layer: Layer }> {
  const index = project.layers.findIndex(({ id }) => id === layerId);
  const layer = project.layers[index];
  if (layer === undefined) {
    return operationFailure("E_OP_NOT_FOUND", `Layer ${layerId} does not exist.`, [layerId]);
  }
  if (layer.locked) {
    return operationFailure("E_OP_LAYER_LOCKED", `Layer ${layerId} is locked.`, [layerId]);
  }
  return success({ index, layer });
}

function replaceLayer(project: GuyditorProject, index: number, layer: Layer): GuyditorProject {
  const layers = project.layers.slice();
  layers[index] = layer;
  return { ...project, layers };
}

function withAudio(clip: Clip, update: (audio: NonNullable<Clip["audio"]>) => void): Clip {
  const replacement = { ...clip };
  const audio = { ...clip.audio };
  update(audio);
  if (Object.keys(audio).length === 0) delete replacement.audio;
  else replacement.audio = audio;
  return replacement;
}

function canonicalChain(chain: AudioChain | null, affected: string): Result<AudioChain | null> {
  if (chain === null) return success(null);
  const types = chain.nodes.map(({ type }) => type);
  if (
    types.length !== AUDIO_CHAIN_ORDER.length ||
    AUDIO_CHAIN_ORDER.some((type, index) => types[index] !== type)
  ) {
    return operationFailure(
      "E_OP_AUDIO_CHAIN_ORDER",
      `Audio chain nodes must serialize as ${AUDIO_CHAIN_ORDER.join(" → ")}.`,
      [affected],
    );
  }
  return success(structuredClone(chain));
}

function applyClipAudioField(
  project: GuyditorProject,
  input: OperationInput,
  field: "offset" | "channels",
  parameter: "offset" | "mapping",
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const located = locateClip(project, clipId);
  if (!located.ok) return located;
  const before = located.value.clip.audio?.[field];
  const after = input.params[parameter] as NonNullable<Clip["audio"]>[typeof field] | null;
  const replacement = withAudio(located.value.clip, (audio) => {
    if (after === null) delete audio[field];
    else Object.assign(audio, { [field]: structuredClone(after) });
  });
  const summary = field === "offset"
    ? `Shift ${clipId} audio by ${after === null
      ? "default"
      : `${String((after as SampleTime).samples)} samples`}`
    : `Use ${after === null ? "default" : JSON.stringify(after)} channel(s) on ${clipId}`;
  return application(
    replaceClip(project, located.value, replacement),
    [{ op: input.op, params: { clipId, [parameter]: before ?? null } }],
    [clipId],
    summary,
    [mutation(clipId, "clip", `audio.${field}`, before, after ?? undefined)],
  );
}

function applyAudioChainSet(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string | undefined;
  const layerId = input.params["layerId"] as string | undefined;
  const targetId = clipId ?? layerId;
  if (targetId === undefined) {
    return operationFailure("E_OP_SCHEMA", "Audio chain target is missing.", []);
  }
  const chain = canonicalChain(input.params["chain"] as AudioChain | null, targetId);
  if (!chain.ok) return chain;
  if (clipId !== undefined) {
    const located = locateClip(project, clipId);
    if (!located.ok) return located;
    const before = located.value.clip.audio?.chain;
    const replacement = withAudio(located.value.clip, (audio) => {
      if (chain.value === null) delete audio.chain;
      else audio.chain = chain.value;
    });
    return application(
      replaceClip(project, located.value, replacement),
      [{ op: input.op, params: { clipId, chain: before ?? null } }],
      [clipId],
      `Set audio chain on ${clipId}: ${chain.value?.nodes.filter(({ enabled }) => enabled).map(({ type }) => type).join(", ") ?? "none"}`,
      [mutation(clipId, "clip", "audio.chain", before, chain.value ?? undefined)],
    );
  }
  const located = locateLayer(project, layerId!);
  if (!located.ok) return located;
  if (!AUDIO_ROLE_KINDS.has(located.value.layer.kind)) {
    return operationFailure(
      "E_OP_LAYER_TARGET",
      `Layer ${layerId!} must be an audio-role layer to own an audio chain.`,
      [layerId!],
    );
  }
  const before = located.value.layer.audio?.chain;
  const replacement = { ...located.value.layer };
  if (chain.value === null) delete replacement.audio;
  else replacement.audio = { chain: chain.value };
  return application(
    replaceLayer(project, located.value.index, replacement),
    [{ op: input.op, params: { layerId, chain: before ?? null } }],
    [layerId!],
    `Set audio chain on ${layerId!}: ${chain.value?.nodes.filter(({ enabled }) => enabled).map(({ type }) => type).join(", ") ?? "none"}`,
    [mutation(layerId!, "layer", "audio.chain", before, chain.value ?? undefined)],
  );
}

function applyMasterSet(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const sequenceId = input.params["sequenceId"] as string;
  const index = project.sequences.findIndex(({ id }) => id === sequenceId);
  const sequence = project.sequences[index];
  if (sequence === undefined) {
    return operationFailure("E_OP_NOT_FOUND", `Sequence ${sequenceId} does not exist.`, [sequenceId]);
  }
  const targetLufs = input.params["targetLufs"] as number | null;
  const truePeakDb = input.params["truePeakDb"] as number | null;
  if ((targetLufs === null) !== (truePeakDb === null)) {
    return operationFailure(
      "E_OP_SCHEMA",
      "Master loudness target and true-peak ceiling must both be set or both be null.",
      [sequenceId],
    );
  }
  const before = sequence.audio;
  const replacement = { ...sequence };
  if (targetLufs === null || truePeakDb === null) delete replacement.audio;
  else replacement.audio = { targetLufs, truePeakDb };
  const sequences = project.sequences.slice();
  sequences[index] = replacement;
  return application(
    { ...project, sequences },
    [{
      op: input.op,
      params: {
        sequenceId,
        targetLufs: before?.targetLufs ?? null,
        truePeakDb: before?.truePeakDb ?? null,
      },
    }],
    [sequenceId],
    targetLufs === null
      ? `Clear master loudness target on ${sequenceId}`
      : `Set master loudness target ${String(targetLufs)} LUFS / ${String(truePeakDb)} dBTP`,
    [mutation(sequenceId, "sequence", "audio", before, replacement.audio)],
  );
}

function applyLoopSet(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const located = locateClip(project, clipId);
  if (!located.ok) return located;
  const enabled = input.params["loop"] as boolean | null;
  const crossfade = input.params["loopCrossfade"] as { t: FrameTime } | null;
  if (enabled === null && crossfade !== null) {
    return operationFailure(
      "E_OP_SCHEMA",
      "A cleared loop cannot retain a crossfade.",
      [clipId],
    );
  }
  if (crossfade !== null && crossfade.t.fps !== project.settings.timeline.fps) {
    return operationFailure(
      "E_OP_RATE_MISMATCH",
      `Loop crossfade rate ${crossfade.t.fps} does not match timeline rate ${project.settings.timeline.fps}.`,
      [clipId],
    );
  }
  const before = located.value.clip.loop;
  const replacement = { ...located.value.clip };
  if (enabled === null) delete replacement.loop;
  else replacement.loop = { enabled, ...(crossfade === null ? {} : { crossfade: structuredClone(crossfade.t) }) };
  return application(
    replaceClip(project, located.value, replacement),
    [{
      op: input.op,
      params: {
        clipId,
        loop: before?.enabled ?? null,
        loopCrossfade: before?.crossfade === undefined ? null : { t: before.crossfade },
      },
    }],
    [clipId],
    enabled === null
      ? `Clear looping on ${clipId}`
      : `Loop ${clipId} with ${crossfade === null ? "no" : String(crossfade.t.frames)} crossfade`,
    [mutation(clipId, "clip", "loop", before, replacement.loop)],
  );
}

function applyAnchorSet(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const located = locateClip(project, clipId);
  if (!located.ok) return located;
  const before = located.value.clip.anchor;
  const anchor = input.params["anchor"] as SemanticAnchor | null;
  const replacement = { ...located.value.clip };
  if (anchor === null) {
    delete replacement.anchor;
    delete replacement.anchorMetadata;
  } else replacement.anchor = anchor;
  return application(
    replaceClip(project, located.value, replacement),
    [{ op: input.op, params: { clipId, anchor: before ?? null } }],
    [clipId],
    `${anchor === null ? "Clear" : "Anchor"} ${clipId}${anchor === null ? "" : ` start to ${anchor}`}`,
    [mutation(clipId, "clip", "anchor", before, anchor ?? undefined)],
  );
}

function applyDuckingSet(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const layerId = input.params["layerId"] as string;
  const located = locateLayer(project, layerId);
  if (!located.ok) return located;
  if (!AUDIO_ROLE_KINDS.has(located.value.layer.kind)) {
    return operationFailure(
      "E_OP_LAYER_TARGET",
      `Layer ${layerId} must be an audio-role layer to use ducking.`,
      [layerId],
    );
  }
  const before = located.value.layer.ducking;
  const config = input.params["config"] as DuckingConfig | null;
  const replacement = { ...located.value.layer };
  if (config === null) delete replacement.ducking;
  else replacement.ducking = { ...structuredClone(config), overrides: before?.overrides ?? [] };
  return application(
    replaceLayer(project, located.value.index, replacement),
    [{ op: input.op, params: { layerId, config: before === undefined ? null : configOnly(before) } }],
    [layerId],
    config === null
      ? `Clear ducking on '${located.value.layer.name}'`
      : `Set ducking on '${located.value.layer.name}': ${String(config.duckDb)} dB under speech`,
    [mutation(layerId, "layer", "ducking", before, replacement.ducking)],
  );
}

function configOnly(config: DuckingConfig): DuckingConfig {
  return {
    enabled: config.enabled,
    mode: config.mode,
    duckDb: config.duckDb,
    attackMs: config.attackMs,
    releaseMs: config.releaseMs,
    holdMs: config.holdMs,
    minGapMs: config.minGapMs,
  };
}

function applyDuckingOverride(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const layerId = input.params["layerId"] as string;
  const located = locateLayer(project, layerId);
  if (!located.ok) return located;
  const ducking = located.value.layer.ducking;
  if (ducking === undefined) {
    return operationFailure(
      "E_OP_DUCKING_CONFIG_REQUIRED",
      `Layer ${layerId} needs layer.ducking.set before manual overrides.`,
      [layerId],
    );
  }
  const points = structuredClone(input.params["points"] as DuckingOverridePoint[]);
  const replacement = {
    ...located.value.layer,
    ducking: { ...ducking, overrides: points },
  };
  return application(
    replaceLayer(project, located.value.index, replacement),
    [{ op: input.op, params: { layerId, points: ducking.overrides } }],
    [layerId],
    `Add ${String(points.length)} manual ducking points on '${located.value.layer.name}'`,
    [mutation(layerId, "layer", "ducking.overrides", ducking.overrides, points)],
  );
}

function effectIndex(clip: Clip, kind: "color" | "look"): number {
  return clip.effects?.findIndex((effect) => effect.kind === kind) ?? -1;
}

function replaceEffect(clip: Clip, index: number, effect: Effect | undefined): Clip {
  const replacement = { ...clip };
  const effects = [...(clip.effects ?? [])];
  if (index === -1 && effect !== undefined) effects.push(effect);
  else if (index !== -1 && effect === undefined) effects.splice(index, 1);
  else if (index !== -1 && effect !== undefined) effects[index] = effect;
  if (effects.length === 0) delete replacement.effects;
  else replacement.effects = effects;
  return replacement;
}

function applyColorSet(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string;
  const located = locateClip(project, clipId);
  if (!located.ok) return located;
  const index = effectIndex(located.value.clip, "color");
  const before = located.value.clip.effects?.[index];
  const reset = input.params["reset"] === true;
  const correction: ColorCorrection | undefined = reset
    ? undefined
    : {
        exposure: input.params["exposureEv"] as number,
        contrast: input.params["contrast"] as number,
        temperatureK: (input.params["whiteBalance"] as { tempK: number }).tempK,
        tint: (input.params["whiteBalance"] as { tint: number }).tint,
        saturation: input.params["saturation"] as number,
      };
  const effectId = input.params["effectId"] as string | undefined ?? before?.id ?? idFactory("fx");
  const effect = correction === undefined
    ? undefined
    : { id: effectId, kind: "color", params: correction as unknown as Record<string, unknown> };
  const replacement = replaceEffect(located.value.clip, index, effect);
  const inverseParams = before === undefined
    ? { clipId, reset: true }
    : {
        clipId,
        effectId: before.id,
        exposureEv: before.params["exposure"],
        contrast: before.params["contrast"],
        whiteBalance: {
          tempK: before.params["temperatureK"],
          tint: before.params["tint"],
        },
        saturation: before.params["saturation"],
      };
  return application(
    replaceClip(project, located.value, replacement),
    [{ op: input.op, params: inverseParams }],
    [clipId, ...(effect === undefined ? [] : [effect.id])],
    `${reset ? "Clear" : "Adjust"} color on ${clipId}`,
    [mutation(clipId, "clip", "effects.color", before, effect)],
    effect === undefined ? undefined : { op: input.op, params: { ...input.params, effectId } },
  );
}

function resolveLook(project: GuyditorProject, presetId: string, version: number): Result<LookApplication> {
  const pin = project.presets.find(({ id, kind, version: pinned }) =>
    id === presetId && kind === "look" && pinned === version);
  if (pin === undefined) {
    return operationFailure(
      "E_OP_PRESET_NOT_PINNED",
      `Look preset ${presetId}@${String(version)} is not pinned.`,
      [presetId],
    );
  }
  const builtin = /^builtin:(look-[a-z-]+)@([0-9]+)$/u.exec(pin.path);
  const correction = builtin === null ? undefined : BUILTIN_LOOKS[builtin[1]!];
  if (correction === undefined || Number(builtin?.[2]) !== version) {
    return operationFailure(
      "E_OP_PRESET_UNAVAILABLE",
      `Pinned look ${presetId}@${String(version)} has no deterministic built-in payload.`,
      [presetId],
    );
  }
  return success({ presetId, presetVersion: version, ...structuredClone(correction) });
}

function applyLook(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  const clipId = input.params["clipId"] as string | undefined;
  const layerId = input.params["layerId"] as string | undefined;
  const presetId = input.params["presetId"] as string | null;
  const presetVersion = input.params["presetVersion"] as number | null;
  const look = presetId === null || presetVersion === null
    ? success<LookApplication | undefined>(undefined)
    : resolveLook(project, presetId, presetVersion);
  if (!look.ok) return look;
  if (clipId !== undefined) {
    const located = locateClip(project, clipId);
    if (!located.ok) return located;
    const index = effectIndex(located.value.clip, "look");
    const before = located.value.clip.effects?.[index];
    const effectId = input.params["effectId"] as string | undefined ?? before?.id ?? idFactory("fx");
    const effect = look.value === undefined
      ? undefined
      : {
          id: effectId,
          kind: "look",
          params: look.value as unknown as Record<string, unknown>,
        };
    const replacement = replaceEffect(located.value.clip, index, effect);
    return application(
      replaceClip(project, located.value, replacement),
      [{
        op: input.op,
        params: {
          clipId,
          presetId: before?.params["presetId"] ?? null,
          presetVersion: before?.params["presetVersion"] ?? null,
          ...(before === undefined ? {} : { effectId: before.id }),
        },
      }],
      [clipId, ...(effect === undefined ? [] : [effect.id])],
      look.value === undefined
        ? `Clear look on ${clipId}`
        : `Apply look '${presetId!}' v${String(presetVersion!)} to ${clipId}`,
      [mutation(clipId, "clip", "effects.look", before, effect)],
      effect === undefined ? undefined : { op: input.op, params: { ...input.params, effectId } },
    );
  }
  const located = locateLayer(project, layerId!);
  if (!located.ok) return located;
  const before = located.value.layer.look;
  const replacement = { ...located.value.layer };
  if (look.value === undefined) delete replacement.look;
  else replacement.look = look.value;
  return application(
    replaceLayer(project, located.value.index, replacement),
    [{
      op: input.op,
      params: {
        layerId,
        presetId: before?.presetId ?? null,
        presetVersion: before?.presetVersion ?? null,
      },
    }],
    [layerId!],
    look.value === undefined
      ? `Clear look on ${layerId!}`
      : `Apply look '${presetId!}' v${String(presetVersion!)} to ${layerId!}`,
    [mutation(layerId!, "layer", "look", before, look.value)],
  );
}

export function isAudioColorOperation(operation: string): boolean {
  return operation === "clip.audio.offset.set" ||
    operation === "clip.audio.channels.set" ||
    operation === "clip.audio.chain.set" ||
    operation === "sequence.audio.master.set" ||
    operation === "clip.loop.set" ||
    operation === "clip.anchor.set" ||
    operation === "layer.ducking.set" ||
    operation === "layer.ducking.override" ||
    operation === "clip.color.set" ||
    operation === "clip.look.apply";
}

export function applyAudioColorOperation(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  if (input.op === "clip.audio.offset.set") return applyClipAudioField(project, input, "offset", "offset");
  if (input.op === "clip.audio.channels.set") return applyClipAudioField(project, input, "channels", "mapping");
  if (input.op === "clip.audio.chain.set") return applyAudioChainSet(project, input);
  if (input.op === "sequence.audio.master.set") return applyMasterSet(project, input);
  if (input.op === "clip.loop.set") return applyLoopSet(project, input);
  if (input.op === "clip.anchor.set") return applyAnchorSet(project, input);
  if (input.op === "layer.ducking.set") return applyDuckingSet(project, input);
  if (input.op === "layer.ducking.override") return applyDuckingOverride(project, input);
  if (input.op === "clip.color.set") return applyColorSet(project, input, idFactory);
  return applyLook(project, input, idFactory);
}
