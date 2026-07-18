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

// TODO(part 3/4/5/6/7/9/11): replace the true schemas for fields owned by
// later parts (automation, sync, chain, transform, pip, adjustment, ducking,
// breakOverrides, avoidRegions, watchFolders, dependencies, staleReasons)
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
  ];

  for (const sequence of project.sequences) {
    for (const clip of sequence.clips) {
      ids.push(clip.id);
      if (clip.transitionAfter !== undefined) ids.push(clip.transitionAfter.id);
      ids.push(...effectsFromItem(clip).map((effect) => effect.id));
    }
  }

  for (const layer of project.layers) {
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
  const templateIds = new Set(Object.keys(project.templates ?? {}));
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
    }
  }

  for (const layer of project.layers) {
    if (layer.sequence !== undefined && !sequenceIds.has(layer.sequence)) {
      return missingReference("layer sequence reference", layer.id, layer.sequence);
    }
    if (layer.matte !== undefined && !layerIds.has(layer.matte.layerId)) {
      return missingReference("matte layer reference", layer.id, layer.matte.layerId);
    }
    for (const item of layer.items ?? []) {
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
      if (item.source !== undefined) {
        const error = validateSourceRange(item.id, item.source);
        if (error !== undefined) return error;
      }
    }
  }
  return undefined;
}

function validateBoundaries(project: GuyditorProject): Result<GuyditorProject> | undefined {
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

export function validateProject(value: unknown): Result<GuyditorProject> {
  if (!validateShape(value)) return schemaFailure(validateShape.errors);

  const checks = [
    validateUniqueIds,
    validateReferences,
    validateSourceRanges,
    validateBoundaries,
    validateGeneratedAssets,
    validateAnnotationSidecar,
  ] as const;

  for (const check of checks) {
    const error = check(value);
    if (error !== undefined) return error;
  }

  return success(value);
}
