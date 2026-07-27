import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

import projectSchema from "../../schema/guyditor-v1.schema.json" with { type: "json" };
import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import { compareTime } from "../time/index.js";
import type { FrameTime } from "../time/index.js";
import type {
  Clip,
  Effect,
  GuyditorProject,
  PlacedItem,
} from "./model.js";
import { isId } from "./ids.js";
import { parseAnchor } from "../anchors/parser.js";
import { placedItemOwnershipConsistency } from "../anchors/applicability.js";
import { storedAnchors } from "../anchors/owners.js";

// TODO(part 3/4/5/7/9/11): replace the true schemas for fields owned by
// later parts (automation, sync, chain, ducking, breakOverrides, watchFolders,
// dependencies, staleReasons)
// when their normative sub-schemas land.
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateShape = ajv.compile<GuyditorProject>(projectSchema);

function formatAjvError(error: ErrorObject): string {
  const location = error.instancePath === "" ? "/" : error.instancePath;
  const detail = error.message ?? error.keyword;
  return `${location} ${error.keyword}: ${detail} ${JSON.stringify(error.params)}`;
}

function schemaFailure(errors: readonly ErrorObject[] | null | undefined) {
  const detail = errors?.map(formatAjvError).join("; ") ?? "unknown schema error";
  return failure(
    makeGuyditorError(
      "E_SCHEMA_INVALID",
      `Project schema validation failed: ${detail}`,
    ),
  );
}

function invariantFailure(name: string, affected: readonly string[]) {
  return failure(
    makeGuyditorError(
      "E_PROJECT_INVARIANT",
      `Project invariant failed: ${name}.`,
      { affected },
    ),
  );
}

function effectsFromItem(item: Clip | PlacedItem): readonly Effect[] {
  return item.effects ?? [];
}

function allIds(project: GuyditorProject): string[] {
  const ids = [
    project.project.id,
    ...project.assets.map((asset) => asset.id),
    ...project.beats.map((beat) => beat.id),
    ...project.sequences.map((sequence) => sequence.id),
    ...project.layers.map((layer) => layer.id),
    ...project.captions.map((caption) => caption.id),
    ...project.deliverables.map((deliverable) => deliverable.id),
    ...Object.keys(project.templates ?? {}),
    ...project.presets.map((preset) => preset.id),
    ...project.skills.map((skill) => skill.id),
    ...(project.avoidRegions ?? []).map((region) => region.id),
  ];

  for (const sequence of project.sequences) {
    for (const clip of sequence.clips) {
      ids.push(clip.id);
      if (clip.transitionAfter !== undefined) ids.push(clip.transitionAfter.id);
      ids.push(...effectsFromItem(clip).map((effect) => effect.id));
    }
  }

  for (const layer of project.layers) {
    ids.push(...(layer.pip?.keyframes ?? []).map((keyframe) => keyframe.id));
    for (const item of layer.items ?? []) {
      ids.push(item.id, ...effectsFromItem(item).map((effect) => effect.id));
    }
  }

  return ids;
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function validateUniqueIds(project: GuyditorProject): Result<GuyditorProject> | undefined {
  const duplicateId = firstDuplicate(allIds(project));
  if (duplicateId !== undefined) {
    return invariantFailure("globally unique IDs", [duplicateId]);
  }

  const duplicateSidecarName = firstDuplicate(
    project.sidecars.map((sidecar) => sidecar.name),
  );
  if (duplicateSidecarName !== undefined) {
    return invariantFailure("unique sidecar registry names", [duplicateSidecarName]);
  }

  return undefined;
}

function missingReference(
  name: string,
  owner: string,
  reference: string,
) {
  return invariantFailure(name, owner === reference ? [owner] : [owner, reference]);
}

function validateReferences(project: GuyditorProject): Result<GuyditorProject> | undefined {
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const sequenceIds = new Set(project.sequences.map((sequence) => sequence.id));
  const layerIds = new Set(project.layers.map((layer) => layer.id));
  const captionIds = new Set(project.captions.map((caption) => caption.id));
  const deliverableIds = new Set(
    project.deliverables.map((deliverable) => deliverable.id),
  );
  const presetById = new Map(
    project.presets.map((preset) => [preset.id, preset] as const),
  );
  const skillIds = new Set(project.skills.map((skill) => skill.id));
  const templateIds = new Set([
    ...Object.keys(project.templates ?? {}),
    ["tpl", "callout", "text"].join("_"),
    ["tpl", "callout", "pin"].join("_"),
    ["tpl", "highlight", "box"].join("_"),
    ["tpl", "arrow"].join("_"),
    ["tpl", "spotlight"].join("_"),
  ]);
  const sidecarNames = new Set(project.sidecars.map((sidecar) => sidecar.name));

  if (!deliverableIds.has(project.settings.primaryDeliverable)) {
    return missingReference(
      "settings.primaryDeliverable reference",
      project.project.id,
      project.settings.primaryDeliverable,
    );
  }

  for (const sequence of project.sequences) {
    for (const clip of sequence.clips) {
      if (!assetIds.has(clip.asset)) {
        return missingReference("clip asset reference", clip.id, clip.asset);
      }
      const preset = clip.transitionAfter?.preset;
      if (preset !== undefined && isId("pre", preset) && !presetById.has(preset)) {
        return missingReference("transition preset reference", clip.transitionAfter!.id, preset);
      }
      const key = clip.effects?.find(({ kind }) => kind === "key");
      const neural = key?.params["neural"];
      if (
        typeof neural === "object" && neural !== null &&
        "matteAssetId" in neural && typeof neural.matteAssetId === "string" &&
        !assetIds.has(neural.matteAssetId)
      ) {
        return missingReference("neural matte asset reference", clip.id, neural.matteAssetId);
      }
    }
  }

  for (const layer of project.layers) {
    if (layer.sequence !== undefined && !sequenceIds.has(layer.sequence)) {
      return missingReference("layer sequence reference", layer.id, layer.sequence);
    }
    if (layer.matte !== undefined && !layerIds.has(layer.matte.layerId)) {
      return missingReference("matte layer reference", layer.id, layer.matte.layerId);
    }
    const deviceFrame = layer.pip?.style.deviceFrame?.templateId;
    if (deviceFrame !== undefined && !templateIds.has(deviceFrame)) {
      return missingReference("PiP device-frame template reference", layer.id, deviceFrame);
    }
    for (const keyframe of layer.pip?.keyframes ?? []) {
      const preset = keyframe.transition?.preset;
      if (preset !== undefined && !presetById.has(preset)) {
        return missingReference("PiP motion preset reference", keyframe.id, preset);
      }
      const keyframeDevice = keyframe.style?.deviceFrame?.templateId;
      if (keyframeDevice !== undefined && !templateIds.has(keyframeDevice)) {
        return missingReference("PiP keyframe device-frame template reference", keyframe.id, keyframeDevice);
      }
    }
    const avoidPreset = layer.pip?.avoid?.moveTransition.preset;
    if (avoidPreset !== undefined && !presetById.has(avoidPreset)) {
      return missingReference("PiP avoid motion preset reference", layer.id, avoidPreset);
    }
    for (const item of layer.items ?? []) {
      if (item.sequenceId !== undefined && !sequenceIds.has(item.sequenceId)) {
        return missingReference("placed item sequence reference", item.id, item.sequenceId);
      }
      const ownership = placedItemOwnershipConsistency(project, item);
      if (!ownership.consistent) {
        return invariantFailure(
          "placed item sequence ownership consistency",
          [
            item.id,
            ...new Set([
              ...(ownership.explicitSequenceId === undefined
                ? []
                : [ownership.explicitSequenceId]),
              ...ownership.inferredSequenceIds,
            ]),
          ],
        );
      }
      if (item.asset !== undefined && !assetIds.has(item.asset)) {
        return missingReference("placed item asset reference", item.id, item.asset);
      }
      if (item.template !== undefined && !templateIds.has(item.template)) {
        return missingReference("placed item template reference", item.id, item.template);
      }
    }
  }

  for (const caption of project.captions) {
    for (const layerId of caption.sourceLayerIds) {
      if (!layerIds.has(layerId)) {
        return missingReference("caption sourceLayerIds reference", caption.id, layerId);
      }
    }
    const preset = presetById.get(caption.preset.presetId);
    if (preset === undefined || preset.version !== caption.preset.version) {
      return missingReference(
        "caption preset reference",
        caption.id,
        caption.preset.presetId,
      );
    }
  }

  for (const deliverable of project.deliverables) {
    if (!sequenceIds.has(deliverable.sequenceId)) {
      return missingReference(
        "deliverable sequence reference",
        deliverable.id,
        deliverable.sequenceId,
      );
    }
    if (
      deliverable.captionsTrackId !== undefined &&
      !captionIds.has(deliverable.captionsTrackId)
    ) {
      return missingReference(
        "deliverable caption reference",
        deliverable.id,
        deliverable.captionsTrackId,
      );
    }
  }

  for (const asset of project.assets) {
    if (
      asset.provenance !== undefined &&
      !sidecarNames.has(asset.provenance.sidecar)
    ) {
      return missingReference(
        "asset provenance sidecar reference",
        asset.id,
        asset.provenance.sidecar,
      );
    }
  }

  for (const sidecar of project.sidecars) {
    const tool = sidecar.generatedBy?.tool;
    if (tool !== undefined && isId("skl", tool) && !skillIds.has(tool)) {
      return missingReference("sidecar skill reference", sidecar.name, tool);
    }
    for (const input of sidecar.inputs) {
      if (input.asset !== undefined && !assetIds.has(input.asset)) {
        return missingReference("sidecar input reference", sidecar.name, input.asset);
      }
      if (input.sidecar !== undefined && !sidecarNames.has(input.sidecar)) {
        return missingReference(
          "sidecar input reference",
          sidecar.name,
          input.sidecar,
        );
      }
    }
  }

  return undefined;
}

function validateDeliverables(project: GuyditorProject): Result<GuyditorProject> | undefined {
  const longform = project.deliverables.filter(({ kind }) => kind === "longform");
  if (longform.length !== 1) {
    return invariantFailure(
      "exactly one longform deliverable",
      longform.length === 0
        ? [project.project.id]
        : longform.map(({ id }) => id),
    );
  }
  if (longform[0]!.id !== project.settings.primaryDeliverable) {
    return invariantFailure("primary deliverable is longform", [
      project.settings.primaryDeliverable,
      longform[0]!.id,
    ]);
  }
  const ownerBySequence = new Map<string, string>();
  for (const deliverable of project.deliverables) {
    const owner = ownerBySequence.get(deliverable.sequenceId);
    if (owner !== undefined) {
      return invariantFailure("deliverable sequence ownership is exclusive", [
        owner,
        deliverable.id,
      ]);
    }
    ownerBySequence.set(deliverable.sequenceId, deliverable.id);
  }
  return undefined;
}

function validateComposition(project: GuyditorProject): Result<GuyditorProject> | undefined {
  const layerById = new Map(project.layers.map((layer) => [layer.id, layer] as const));
  for (const layer of project.layers) {
    if (layer.sequence !== undefined && layer.items !== undefined) {
      return invariantFailure("layer content sequence xor items", [layer.id]);
    }
    if (
      layer.pip !== undefined &&
      layer.kind !== "video" && layer.kind !== "image" && layer.kind !== "animation"
    ) {
      return invariantFailure("PiP belongs to video, image, or animation layer", [layer.id]);
    }
    if (layer.kind === "adjustment") {
      if (layer.sequence !== undefined || layer.items !== undefined || layer.adjustment === undefined) {
        return invariantFailure("adjustment layer holds only ColorCorrection", [layer.id]);
      }
    } else if (layer.adjustment !== undefined) {
      return invariantFailure("ColorCorrection belongs to adjustment layer", [layer.id]);
    }
    if (layer.matte !== undefined) {
      const matteLayer = layerById.get(layer.matte.layerId);
      if (matteLayer?.kind !== "matte" || matteLayer.id === layer.id) {
        return invariantFailure("matte reference targets another matte layer", [
          layer.id,
          layer.matte.layerId,
        ]);
      }
    }
    const crop = layer.transform?.crop;
    if (crop !== undefined && (crop.x + crop.w > 1 || crop.y + crop.h > 1)) {
      return invariantFailure("Transform2D crop remains within source", [layer.id]);
    }
  }

  for (const sequence of project.sequences) {
    for (const clip of sequence.clips) {
      const keyEffects = clip.effects?.filter(({ kind }) => kind === "key") ?? [];
      if (keyEffects.length > 1) {
        return invariantFailure("one key effect per clip", [clip.id]);
      }
      const masks = keyEffects[0]?.params["masks"];
      if (!Array.isArray(masks)) continue;
      const ids = masks.flatMap((mask) =>
        typeof mask === "object" && mask !== null && "id" in mask && typeof mask.id === "string"
          ? [mask.id]
          : []);
      const duplicate = firstDuplicate(ids);
      if (duplicate !== undefined) {
        return invariantFailure("unique key mask IDs per clip", [clip.id, duplicate]);
      }
      for (const mask of masks) {
        if (typeof mask !== "object" || mask === null || !("frames" in mask)) continue;
        const frames = mask.frames;
        if (
          typeof frames === "object" && frames !== null &&
          "from" in frames && typeof frames.from === "number" &&
          "to" in frames && typeof frames.to === "number" &&
          frames.from > frames.to
        ) {
          return invariantFailure("key mask frame range", [clip.id]);
        }
      }
    }
  }
  return undefined;
}

function validateSourceRange(
  owner: string,
  source: { in: FrameTime; out: FrameTime },
): Result<GuyditorProject> | undefined {
  if (source.in.fps !== source.out.fps) {
    return invariantFailure("source range matching rates", [owner]);
  }
  const ordering = compareTime(source.in, source.out);
  if (!ordering.ok) {
    return invariantFailure("source range valid exact time", [owner]);
  }
  if (ordering.value !== -1) {
    return invariantFailure("source.in < source.out", [owner]);
  }
  return undefined;
}

function validateSourceRanges(project: GuyditorProject): Result<GuyditorProject> | undefined {
  for (const sequence of project.sequences) {
    for (const clip of sequence.clips) {
      const error = validateSourceRange(clip.id, clip.source);
      if (error !== undefined) return error;
    }
  }
  for (const layer of project.layers) {
    for (const item of layer.items ?? []) {
      if (item.source !== undefined && "in" in item.source) {
        const error = validateSourceRange(item.id, item.source);
        if (error !== undefined) return error;
      }
    }
  }
  return undefined;
}

function validateBoundaries(project: GuyditorProject): Result<GuyditorProject> | undefined {
  for (const region of project.avoidRegions ?? []) {
    if (region.frames !== undefined && region.frames.from > region.frames.to) {
      return invariantFailure("avoid region frame range", [region.id]);
    }
  }
  for (const sequence of project.sequences) {
    for (const [index, clip] of sequence.clips.entries()) {
      if (index === 0 && clip.overlapPrevious !== undefined) {
        return invariantFailure("first clip overlapPrevious", [clip.id]);
      }

      const previous = sequence.clips[index - 1];
      const hasIncomingTransition = previous?.transitionAfter !== undefined;
      if (hasIncomingTransition && clip.overlapPrevious !== undefined) {
        return invariantFailure("incoming transition and overlapPrevious", [
          previous.id,
          clip.id,
        ]);
      }
      if (
        clip.gapBefore !== undefined &&
        (hasIncomingTransition || clip.overlapPrevious !== undefined)
      ) {
        return invariantFailure("gapBefore boundary exclusivity", [
          ...(hasIncomingTransition && previous !== undefined ? [previous.id] : []),
          clip.id,
        ]);
      }
    }
  }
  return undefined;
}

function validateGeneratedAssets(project: GuyditorProject): Result<GuyditorProject> | undefined {
  const generatedWithoutProvenance = project.assets.find(
    (asset) => asset.kind === "generated" && asset.provenance === undefined,
  );
  return generatedWithoutProvenance === undefined
    ? undefined
    : invariantFailure("generated asset provenance", [
        generatedWithoutProvenance.id,
      ]);
}

function validateAnnotationSidecar(project: GuyditorProject): Result<GuyditorProject> | undefined {
  return project.sidecars.some(
    (sidecar) => sidecar.name === project.annotations.sidecar,
  )
    ? undefined
    : invariantFailure("annotations.sidecar reference", [
        project.annotations.sidecar,
      ]);
}

function validateAnchorSyntax(project: GuyditorProject): Result<GuyditorProject> | undefined {
  for (const reference of storedAnchors(project)) {
    const parsed = parseAnchor(reference.anchor);
    if (!parsed.ok) return failure(parsed.error);
  }
  return undefined;
}

function validateTemplateGraphics(project: GuyditorProject): Result<GuyditorProject> | undefined {
  for (const layer of project.layers) {
    for (const item of layer.items ?? []) {
      if (item.template === undefined || !/^tpl_[a-z2-7]{10}$/u.test(item.template)) continue;
      if (!/^gfx_[a-z2-7]{10}$/u.test(item.id)) {
        return invariantFailure("template graphic gfx_ identity", [layer.id, item.id]);
      }
      if (layer.kind !== "text" && layer.kind !== "animation") {
        return invariantFailure("template graphic text or animation layer", [layer.id, item.id]);
      }
      if (
        item.seed === undefined || !Number.isInteger(item.seed) ||
        item.seed < 0 || item.seed > 0xffff_ffff
      ) {
        return invariantFailure("template graphic stored uint32 seed", [item.id]);
      }
      if (project.templates?.[item.template] === undefined) {
        return invariantFailure("template graphic exact project pin", [item.id, item.template]);
      }
    }
  }
  return undefined;
}

export function validateProject(value: unknown): Result<GuyditorProject> {
  if (!validateShape(value)) return schemaFailure(validateShape.errors);

  const checks = [
    validateUniqueIds,
    validateReferences,
    validateDeliverables,
    validateComposition,
    validateSourceRanges,
    validateBoundaries,
    validateGeneratedAssets,
    validateAnnotationSidecar,
    validateAnchorSyntax,
    validateTemplateGraphics,
  ] as const;

  for (const check of checks) {
    const error = check(value);
    if (error !== undefined) return error;
  }

  return success(value);
}
