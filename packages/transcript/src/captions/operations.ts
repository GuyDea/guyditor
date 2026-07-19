import {
  failure,
  makeGuyditorError,
  success,
} from "../../../core/src/index.js";
import type {
  CaptionStyle,
  CaptionTrack,
  CueBreakOverride,
  GuyditorProject,
  IdPrefix,
  OperationInput,
} from "../../../core/src/index.js";

type CaptionIdFactory = (prefix: IdPrefix | "seg" | "spk") => string;

function operationFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function located(project: GuyditorProject, captionId: string): CaptionTrack | undefined {
  return project.captions.find(({ id }) => id === captionId);
}

function replaceTrack(
  project: GuyditorProject,
  track: CaptionTrack,
): GuyditorProject {
  return {
    ...project,
    captions: project.captions.map((candidate) => candidate.id === track.id ? track : candidate),
  };
}

function application(
  model: GuyditorProject,
  inverse: OperationInput[],
  affected: string[],
  summary: string,
) {
  return success({ model, inverse, affected, summary });
}

function addTrack(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: CaptionIdFactory,
) {
  const restore = input.params["restore"] as CaptionTrack | undefined;
  const track: CaptionTrack = restore === undefined
    ? {
        id: input.params["captionId"] as string | undefined ?? idFactory("cts"),
        name: input.params["name"] as string,
        sourceLayerIds: structuredClone(input.params["sourceLayerIds"] as string[]),
        preset: structuredClone(input.params["preset"] as CaptionTrack["preset"]),
        styleOverrides: {},
        breakOverrides: [],
        emphasisOverrides: [],
        timingOffsets: [],
        enabled: input.params["enabled"] as boolean | undefined ?? true,
      }
    : structuredClone(restore);
  if (project.captions.some(({ id }) => id === track.id)) {
    return operationFailure("E_CAPTION_TRACK_EXISTS", `Caption track ${track.id} already exists.`, [track.id]);
  }
  return application(
    { ...project, captions: [...project.captions, track] },
    [{ op: "caption.track.remove", params: { captionId: track.id } }],
    [track.id, ...track.sourceLayerIds, track.preset.presetId],
    `Add caption track ${track.name}`,
  );
}

function removeTrack(project: GuyditorProject, input: OperationInput) {
  const captionId = input.params["captionId"] as string;
  const track = located(project, captionId);
  if (track === undefined) return operationFailure("E_CAPTION_TRACK_NOT_FOUND", `Caption track ${captionId} does not exist.`, [captionId]);
  const owners = project.deliverables.filter(({ captionsTrackId }) => captionsTrackId === captionId);
  if (owners.length > 0) {
    return operationFailure(
      "E_CAPTION_TRACK_REFERENCED",
      `Caption track ${captionId} is selected by a deliverable.`,
      [captionId, ...owners.map(({ id }) => id)],
    );
  }
  return application(
    { ...project, captions: project.captions.filter(({ id }) => id !== captionId) },
    [{
      op: "caption.track.add",
      params: {
        captionId: track.id,
        name: track.name,
        sourceLayerIds: structuredClone(track.sourceLayerIds),
        preset: structuredClone(track.preset),
        enabled: track.enabled,
        restore: structuredClone(track),
      },
    }],
    [captionId],
    `Remove caption track ${track.name}`,
  );
}

function setTrack(project: GuyditorProject, input: OperationInput) {
  const captionId = input.params["captionId"] as string;
  const track = located(project, captionId);
  if (track === undefined) return operationFailure("E_CAPTION_TRACK_NOT_FOUND", `Caption track ${captionId} does not exist.`, [captionId]);
  const previous: Record<string, unknown> = { captionId };
  const next = structuredClone(track);
  if (input.params["sourceLayerIds"] !== undefined) {
    previous["sourceLayerIds"] = structuredClone(track.sourceLayerIds);
    next.sourceLayerIds = structuredClone(input.params["sourceLayerIds"] as string[]);
  }
  if (input.params["preset"] !== undefined) {
    previous["preset"] = structuredClone(track.preset);
    next.preset = structuredClone(input.params["preset"] as CaptionTrack["preset"]);
  }
  if (input.params["enabled"] !== undefined) {
    previous["enabled"] = track.enabled;
    next.enabled = input.params["enabled"] as boolean;
  }
  return application(
    replaceTrack(project, next),
    [{ op: "caption.track.set", params: previous }],
    [captionId],
    `Configure caption track ${track.name}`,
  );
}

function setStyle(project: GuyditorProject, input: OperationInput) {
  const captionId = input.params["captionId"] as string;
  const track = located(project, captionId);
  if (track === undefined) return operationFailure("E_CAPTION_TRACK_NOT_FOUND", `Caption track ${captionId} does not exist.`, [captionId]);
  const previous = structuredClone(track.styleOverrides);
  const patch = structuredClone(input.params["styleOverrides"] as Partial<CaptionStyle>);
  const next = {
    ...track,
    styleOverrides: input.params["replace"] === true
      ? patch
      : { ...track.styleOverrides, ...patch },
  };
  return application(
    replaceTrack(project, next),
    [{ op: "caption.style.set", params: { captionId, styleOverrides: previous, replace: true } }],
    [captionId],
    `Style caption track ${track.name}`,
  );
}

function setBreak(project: GuyditorProject, input: OperationInput) {
  const captionId = input.params["captionId"] as string;
  const wordId = input.params["afterWordId"] as string;
  const track = located(project, captionId);
  if (track === undefined) return operationFailure("E_CAPTION_TRACK_NOT_FOUND", `Caption track ${captionId} does not exist.`, [captionId]);
  const previous = track.breakOverrides.find(({ afterWordId }) => afterWordId === wordId);
  const override: CueBreakOverride = { afterWordId: wordId, kind: input.params["kind"] as CueBreakOverride["kind"] };
  const breaks = [...track.breakOverrides.filter(({ afterWordId }) => afterWordId !== wordId), override]
    .sort((left, right) => left.afterWordId.localeCompare(right.afterWordId));
  return application(
    replaceTrack(project, { ...track, breakOverrides: breaks }),
    [{
      op: previous === undefined ? "caption.break.clear" : "caption.break.set",
      params: previous === undefined ? { captionId, afterWordId: wordId } : { captionId, ...previous },
    }],
    [captionId, wordId],
    `Set ${override.kind} caption break after ${wordId}`,
  );
}

function clearBreak(project: GuyditorProject, input: OperationInput) {
  const captionId = input.params["captionId"] as string;
  const wordId = input.params["afterWordId"] as string;
  const track = located(project, captionId);
  if (track === undefined) return operationFailure("E_CAPTION_TRACK_NOT_FOUND", `Caption track ${captionId} does not exist.`, [captionId]);
  const previous = track.breakOverrides.find(({ afterWordId }) => afterWordId === wordId);
  return application(
    replaceTrack(project, { ...track, breakOverrides: track.breakOverrides.filter(({ afterWordId }) => afterWordId !== wordId) }),
    previous === undefined ? [] : [{ op: "caption.break.set", params: { captionId, ...previous } }],
    [captionId, wordId],
    `Clear caption break after ${wordId}`,
  );
}

function setEmphasis(project: GuyditorProject, input: OperationInput) {
  const captionId = input.params["captionId"] as string;
  const wordId = input.params["wordId"] as string;
  const track = located(project, captionId);
  if (track === undefined) return operationFailure("E_CAPTION_TRACK_NOT_FOUND", `Caption track ${captionId} does not exist.`, [captionId]);
  const previous = track.emphasisOverrides.find(({ wordId: candidate }) => candidate === wordId);
  const emphasis = input.params["emphasis"] as boolean;
  const emphasisOverrides = [
    ...track.emphasisOverrides.filter(({ wordId: candidate }) => candidate !== wordId),
    { wordId, emphasis },
  ].sort((left, right) => left.wordId.localeCompare(right.wordId));
  return application(
    replaceTrack(project, { ...track, emphasisOverrides }),
    [{
      op: "caption.word.emphasis.set",
      params: { captionId, wordId, emphasis: previous?.emphasis ?? false },
    }],
    [captionId, wordId],
    `${emphasis ? "Emphasize" : "Remove emphasis from"} ${wordId}`,
  );
}

function retimeCue(project: GuyditorProject, input: OperationInput) {
  const captionId = input.params["captionId"] as string;
  const firstWordId = input.params["firstWordId"] as string;
  const track = located(project, captionId);
  if (track === undefined) return operationFailure("E_CAPTION_TRACK_NOT_FOUND", `Caption track ${captionId} does not exist.`, [captionId]);
  const previous = track.timingOffsets.find(({ firstWordId: candidate }) => candidate === firstWordId);
  const timingOffsets = track.timingOffsets.filter(({ firstWordId: candidate }) => candidate !== firstWordId);
  if (input.params["clear"] !== true) {
    timingOffsets.push({
      firstWordId,
      ...(input.params["startMs"] === undefined ? {} : { startMs: input.params["startMs"] as number }),
      ...(input.params["endMs"] === undefined ? {} : { endMs: input.params["endMs"] as number }),
    });
  }
  timingOffsets.sort((left, right) => left.firstWordId.localeCompare(right.firstWordId));
  return application(
    replaceTrack(project, { ...track, timingOffsets }),
    [{
      op: "caption.cue.retime",
      params: previous === undefined ? { captionId, firstWordId, clear: true } : { captionId, ...previous },
    }],
    [captionId, firstWordId],
    `Nudge caption cue ${firstWordId}`,
  );
}

function upgradePreset(project: GuyditorProject, input: OperationInput) {
  const captionId = input.params["captionId"] as string;
  const track = located(project, captionId);
  if (track === undefined) return operationFailure("E_CAPTION_TRACK_NOT_FOUND", `Caption track ${captionId} does not exist.`, [captionId]);
  const preset = structuredClone(input.params["preset"] as CaptionTrack["preset"]);
  const pin = project.presets.find(({ id, version, kind }) =>
    id === preset.presetId && version === preset.version && kind === "caption");
  if (pin === undefined) {
    return operationFailure("E_CAPTION_PRESET_NOT_PINNED", `Caption preset ${preset.presetId}@${String(preset.version)} is not pinned.`, [preset.presetId]);
  }
  return application(
    replaceTrack(project, { ...track, preset }),
    [{ op: "caption.preset.upgrade", params: { captionId, preset: structuredClone(track.preset) } }],
    [captionId, preset.presetId],
    `Upgrade ${track.name} to ${pin.name}@${String(pin.version)}`,
  );
}

export function applyCaptionOperation(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: CaptionIdFactory,
): ReturnType<typeof application> | ReturnType<typeof operationFailure> | undefined {
  switch (input.op) {
    case "caption.track.add": return addTrack(project, input, idFactory);
    case "caption.track.remove": return removeTrack(project, input);
    case "caption.track.set": return setTrack(project, input);
    case "caption.style.set": return setStyle(project, input);
    case "caption.break.set": return setBreak(project, input);
    case "caption.break.clear": return clearBreak(project, input);
    case "caption.word.emphasis.set": return setEmphasis(project, input);
    case "caption.cue.retime": return retimeCue(project, input);
    case "caption.preset.upgrade": return upgradePreset(project, input);
    default: return undefined;
  }
}
