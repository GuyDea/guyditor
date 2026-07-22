import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type {
  CaptionTrack,
  Clip,
  Deliverable,
  GuyditorProject,
  Layer,
  Sequence,
} from "../project/model.js";
import { formatRevision, parseRevision } from "../project/ids.js";
import type { ClipApplication, EntityMutation } from "../operations/clip.js";
import type { IdFactory } from "../operations/engine.js";
import type { OperationInput } from "../operations/types.js";
import type {
  DependencyEntry,
  PublishChapterList,
  PublishMetadataDocument,
  SourceRangeRef,
} from "./types.js";
import type { FramingOverride } from "./types.js";

interface DeriveCreatedIds {
  deliverableId: string;
  sequenceId: string;
  layerId: string;
  additionalLayerIds: string[];
  captionsTrackId: string;
  clipIds: string[];
}

function deliverableFailure(code: `E_${Uppercase<string>}`, message: string, affected: string[] = []) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function deliverableById(project: GuyditorProject, id: string): Result<Deliverable> {
  const deliverable = project.deliverables.find((candidate) => candidate.id === id);
  return deliverable === undefined
    ? deliverableFailure("E_OP_NOT_FOUND", `Deliverable ${id} does not exist.`, [id])
    : success(deliverable);
}

function sourceClip(source: SourceRangeRef, clipId: string): Clip {
  return {
    id: clipId,
    asset: source.assetId,
    source: {
      in: structuredClone(source.range.start),
      out: structuredClone(source.range.end),
    },
  };
}

function copiedCaptionTrack(
  project: GuyditorProject,
  primary: Deliverable,
  id: string,
  layerIds: ReadonlyMap<string, string>,
  fallbackLayerId: string,
): CaptionTrack {
  const source = project.captions.find(({ id: candidateId }) => candidateId === primary.captionsTrackId);
  return source === undefined
    ? {
        id,
        name: "Derivative captions",
        sourceLayerIds: [fallbackLayerId],
        preset: { presetId: project.presets.find(({ kind }) => kind === "caption")?.id ?? "pre_aaaaaaaaaa", version: project.presets.find(({ kind }) => kind === "caption")?.version ?? 1 },
        styleOverrides: {},
        breakOverrides: [],
        emphasisOverrides: [],
        timingOffsets: [],
        enabled: true,
      }
    : (() => {
        const mappedSourceLayerIds = source.sourceLayerIds.flatMap((sourceLayerId) => {
          const copiedLayerId = layerIds.get(sourceLayerId);
          return copiedLayerId === undefined ? [] : [copiedLayerId];
        });
        return {
          ...structuredClone(source),
          id,
          name: `${source.name} — derivative`,
          sourceLayerIds: mappedSourceLayerIds.length === 0
            ? [fallbackLayerId]
            : mappedSourceLayerIds,
        };
      })();
}

function createdIds(
  input: OperationInput,
  idFactory: IdFactory,
  sourceCount: number,
  layerCount: number,
): DeriveCreatedIds {
  const captured = input.params["created"] as Omit<DeriveCreatedIds, "additionalLayerIds"> & {
    additionalLayerIds?: string[];
  } | undefined;
  return captured === undefined ? {
    deliverableId: idFactory("dlv"),
    sequenceId: idFactory("seq"),
    layerId: idFactory("lyr"),
    additionalLayerIds: Array.from({ length: Math.max(0, layerCount - 1) }, () => idFactory("lyr")),
    captionsTrackId: idFactory("cts"),
    clipIds: Array.from({ length: sourceCount }, () => idFactory("clp")),
  } : {
    ...captured,
    additionalLayerIds: captured.additionalLayerIds ?? [],
  };
}

function added(entityId: string, entityType: EntityMutation["entityType"], after: unknown): EntityMutation {
  return { entityId, entityType, change: "added", fields: [{ field: "$entity", after }] };
}

function applyDerive(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  const kind = input.params["kind"];
  if (kind !== "short") {
    return deliverableFailure(
      "E_DELIVERABLE_KIND",
      "deliverable.derive may only create short deliverables; project.create owns the one long-form deliverable.",
    );
  }
  const sources = input.params["resolvedSources"] as SourceRangeRef[] | undefined;
  if (sources === undefined || sources.length === 0) {
    return deliverableFailure(
      "E_DERIVATION_RESOLUTION_REQUIRED",
      "deliverable.derive requires explicit resolved source anchors from DeliverableService.",
    );
  }
  const primary = project.deliverables.find(({ id }) => id === project.settings.primaryDeliverable);
  if (primary === undefined || primary.kind !== "longform") {
    return deliverableFailure(
      "E_DELIVERABLE_KIND",
      "The primary deliverable must be the project's long-form deliverable.",
      [project.settings.primaryDeliverable],
    );
  }
  const sourceLayers = project.layers.filter(({ sequence }) => sequence === primary.sequenceId);
  const copiedLayerCount = Math.max(1, sourceLayers.length);
  const created = createdIds(input, idFactory, sources.length, copiedLayerCount);
  if (created.clipIds.length !== sources.length) {
    return deliverableFailure("E_OP_CAPTURE_MISMATCH", "Captured derivative clip IDs do not match resolved sources.");
  }
  const layerIds = [created.layerId, ...created.additionalLayerIds];
  if (layerIds.length !== copiedLayerCount) {
    return deliverableFailure("E_OP_CAPTURE_MISMATCH", "Captured derivative layer IDs do not match the long-form layer stack.");
  }
  const allIds = new Set([
    ...project.deliverables.map(({ id }) => id),
    ...project.sequences.map(({ id }) => id),
    ...project.layers.map(({ id }) => id),
    ...project.captions.map(({ id }) => id),
    ...project.sequences.flatMap(({ clips }) => clips.map(({ id }) => id)),
  ]);
  const requestedIds = [
    created.deliverableId,
    created.sequenceId,
    ...layerIds,
    created.captionsTrackId,
    ...created.clipIds,
  ];
  const conflict = requestedIds.find((id, index) => allIds.has(id) || requestedIds.indexOf(id) !== index);
  if (conflict !== undefined) {
    return deliverableFailure("E_OP_ID_CONFLICT", `Derivative ID ${conflict} already exists.`, [conflict]);
  }
  const clips = sources.map((source, index) => sourceClip(source, created.clipIds[index]!));
  const sequence: Sequence = { id: created.sequenceId, name: String(input.params["name"]), clips };
  const sourceLayerIds = new Map(sourceLayers.map((layer, index) => [layer.id, layerIds[index]!] as const));
  const firstOrder = project.layers.reduce((maximum, candidate) => Math.max(maximum, candidate.order), -1) + 1;
  const sourceFirstOrder = sourceLayers.reduce(
    (minimum, candidate) => Math.min(minimum, candidate.order),
    Number.POSITIVE_INFINITY,
  );
  const layers: Layer[] = sourceLayers.length === 0
    ? [{
        id: created.layerId,
        kind: "video",
        name: `${String(input.params["name"])} video`,
        order: firstOrder,
        enabled: true,
        locked: false,
        sequence: sequence.id,
      }]
    : sourceLayers.map((sourceLayer, index) => {
        const copied: Layer = {
          ...structuredClone(sourceLayer),
          id: layerIds[index]!,
          name: `${sourceLayer.name} — derivative`,
          order: firstOrder + sourceLayer.order - sourceFirstOrder,
          sequence: sequence.id,
        };
        if (copied.matte !== undefined) {
          copied.matte = {
            ...copied.matte,
            layerId: sourceLayerIds.get(copied.matte.layerId) ?? copied.matte.layerId,
          };
        }
        return copied;
      });
  const caption = copiedCaptionTrack(
    project,
    primary,
    created.captionsTrackId,
    sourceLayerIds,
    layers[0]!.id,
  );
  const dependencies: DependencyEntry[] = sources.map((source, index) => ({
    derivativeClipId: clips[index]!.id,
    source: structuredClone(source),
  }));
  const deliverable: Deliverable = {
    id: created.deliverableId,
    kind: "short",
    name: String(input.params["name"]),
    profile: String(input.params["profile"]),
    ...(input.params["profileOverrides"] === undefined
      ? {}
      : { profileOverrides: structuredClone(input.params["profileOverrides"] as Record<string, unknown>) }),
    sequenceId: sequence.id,
    captionsTrackId: caption.id,
    status: "draft",
    dependencies,
  };
  const model = {
    ...project,
    sequences: [...project.sequences, sequence],
    layers: [...project.layers, ...layers],
    captions: [...project.captions, caption],
    deliverables: [...project.deliverables, deliverable],
  };
  return success({
    model,
    inverse: [{ op: "deliverable.remove", params: { deliverableId: deliverable.id } }],
    redo: { op: input.op, params: { ...input.params, created } },
    affected: [deliverable.id, sequence.id, ...layers.map(({ id }) => id), caption.id, ...clips.map(({ id }) => id)],
    summary: `Derive short '${deliverable.name}' from ${String(sources.length)} source range${sources.length === 1 ? "" : "s"}`,
    mutations: [
      added(deliverable.id, "deliverable", deliverable),
      added(sequence.id, "sequence", sequence),
      ...layers.map((layer) => added(layer.id, "layer", layer)),
      added(caption.id, "caption", caption),
      ...clips.map((clip) => added(clip.id, "clip", clip)),
    ],
  });
}

function replaceDeliverable(
  project: GuyditorProject,
  replacement: Deliverable,
): GuyditorProject {
  return {
    ...project,
    deliverables: project.deliverables.map((deliverable) =>
      deliverable.id === replacement.id ? replacement : deliverable),
  };
}

function statusChange(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const found = deliverableById(project, deliverableId);
  if (!found.ok) return found;
  const status = input.params["status"];
  if (found.value.status !== "draft" || status !== "in-review") {
    return deliverableFailure(
      "E_DELIVERABLE_STATUS",
      `Deliverable ${deliverableId} cannot transition ${found.value.status} → ${String(status)}.`,
      [deliverableId],
    );
  }
  const replacement: Deliverable = { ...found.value, status: "in-review" };
  return success({
    model: replaceDeliverable(project, replacement),
    inverse: [],
    affected: [deliverableId],
    summary: `Move ${found.value.name} to in-review`,
    mutations: [{
      entityId: deliverableId,
      entityType: "deliverable",
      change: "modified",
      fields: [{ field: "status", before: found.value.status, after: replacement.status }],
    }],
  });
}

function approve(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const found = deliverableById(project, deliverableId);
  if (!found.ok) return found;
  if (found.value.status !== "in-review") {
    return deliverableFailure(
      "E_DELIVERABLE_STATUS",
      `Deliverable ${deliverableId} must be in-review before approval.`,
      [deliverableId],
    );
  }
  const replacement: Deliverable = {
    ...found.value,
    status: "approved",
    approvedRevision: formatRevision(parseRevision(project.revision) + 1),
  };
  return success({
    model: replaceDeliverable(project, replacement),
    inverse: [],
    affected: [deliverableId],
    summary: `Approve ${found.value.name} at ${replacement.approvedRevision}`,
    mutations: [{
      entityId: deliverableId,
      entityType: "deliverable",
      change: "modified",
      fields: [
        { field: "status", before: found.value.status, after: replacement.status },
        { field: "approvedRevision", before: found.value.approvedRevision, after: replacement.approvedRevision },
      ],
    }],
  });
}

function refresh(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const found = deliverableById(project, deliverableId);
  if (!found.ok) return found;
  if (found.value.kind !== "short" || found.value.status !== "stale") {
    return deliverableFailure(
      "E_DELIVERABLE_STATUS",
      `Deliverable ${deliverableId} must be a stale short before refresh.`,
      [deliverableId],
    );
  }
  const sequenceIndex = project.sequences.findIndex(({ id }) => id === found.value.sequenceId);
  const sequence = project.sequences[sequenceIndex];
  if (sequence === undefined) {
    return deliverableFailure("E_OP_NOT_FOUND", `Sequence ${found.value.sequenceId} does not exist.`, [found.value.sequenceId]);
  }
  const clips = structuredClone(input.params["clips"] as Clip[]);
  const dependencies = structuredClone(input.params["dependencies"] as DependencyEntry[]);
  const sequences = project.sequences.slice();
  sequences[sequenceIndex] = { ...sequence, clips };
  const replacement: Deliverable = {
    ...found.value,
    status: "in-review",
    dependencies,
  };
  delete replacement.staleReasons;
  return success({
    model: { ...replaceDeliverable(project, replacement), sequences },
    inverse: [],
    affected: [deliverableId, sequence.id, ...clips.map(({ id }) => id)],
    summary: `Refresh ${found.value.name} for review`,
    mutations: [{
      entityId: deliverableId,
      entityType: "deliverable",
      change: "modified",
      fields: [
        { field: "status", before: found.value.status, after: replacement.status },
        { field: "dependencies", before: found.value.dependencies, after: dependencies },
        { field: "staleReasons", before: found.value.staleReasons },
      ],
    }],
  });
}

function remove(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const found = deliverableById(project, deliverableId);
  if (!found.ok) return found;
  if (found.value.kind === "longform") {
    return deliverableFailure("E_DELIVERABLE_KIND", "The project's long-form deliverable cannot be removed.", [deliverableId]);
  }
  const clips = project.sequences.find(({ id }) => id === found.value.sequenceId)?.clips ?? [];
  const layerIds = new Set(project.layers.filter(({ sequence }) => sequence === found.value.sequenceId).map(({ id }) => id));
  return success({
    model: {
      ...project,
      deliverables: project.deliverables.filter(({ id }) => id !== deliverableId),
      sequences: project.sequences.filter(({ id }) => id !== found.value.sequenceId),
      layers: project.layers.filter(({ id }) => !layerIds.has(id)),
      captions: project.captions.filter(({ id }) => id !== found.value.captionsTrackId),
    },
    inverse: [],
    affected: [deliverableId, found.value.sequenceId, ...layerIds, ...clips.map(({ id }) => id)],
    summary: `Remove short ${found.value.name}`,
    mutations: [{
      entityId: deliverableId,
      entityType: "deliverable",
      change: "removed",
      fields: [{ field: "$entity", before: found.value }],
    }],
  });
}

function framingOverride(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const found = deliverableById(project, deliverableId);
  if (!found.ok) return found;
  if (found.value.kind !== "short") {
    return deliverableFailure(
      "E_DELIVERABLE_KIND",
      `Deliverable ${deliverableId} is not a short-form derivative.`,
      [deliverableId],
    );
  }
  const before = structuredClone(found.value.framingOverrides ?? []);
  const restore = input.params["restoreOverrides"] as FramingOverride[] | undefined;
  let framingOverrides: FramingOverride[];
  let summary: string;
  if (restore !== undefined) {
    framingOverrides = structuredClone(restore);
    summary = `Restore framing overrides for ${found.value.name}`;
  } else {
    const override = structuredClone(input.params["override"] as FramingOverride);
    const index = before.findIndex(({ decisionId }) => decisionId === override.decisionId);
    framingOverrides = before.slice();
    if (index === -1) framingOverrides.push(override);
    else framingOverrides[index] = override;
    summary = `Override framing decision ${override.decisionId} for ${found.value.name}`;
  }
  const replacement: Deliverable = { ...found.value, framingOverrides };
  return success({
    model: replaceDeliverable(project, replacement),
    inverse: [{
      op: "deliverable.framing.override",
      params: { deliverableId, restoreOverrides: before },
    }],
    redo: {
      op: "deliverable.framing.override",
      params: structuredClone(input.params),
    },
    affected: [deliverableId, ...framingOverrides.map(({ decisionId }) => decisionId)],
    summary,
    mutations: [{
      entityId: deliverableId,
      entityType: "deliverable",
      change: "modified",
      fields: [{ field: "framingOverrides", before, after: framingOverrides }],
    }],
  });
}

function setMetadata(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const found = deliverableById(project, deliverableId);
  if (!found.ok) return found;
  const metadata = structuredClone(input.params["metadata"] as PublishMetadataDocument);
  if (metadata.deliverableId !== deliverableId || metadata.profile !== found.value.profile) {
    return deliverableFailure(
      "E_PUBLISH_METADATA_MISMATCH",
      `Metadata must identify ${deliverableId} and its pinned profile ${found.value.profile}.`,
      [deliverableId],
    );
  }
  const before = found.value.publish?.metadata;
  const replacement: Deliverable = {
    ...found.value,
    publish: { ...found.value.publish, metadata },
  };
  return success({
    model: replaceDeliverable(project, replacement),
    inverse: [],
    redo: { op: input.op, params: structuredClone(input.params) },
    affected: [deliverableId],
    summary: `Edit publish metadata for ${found.value.name}`,
    mutations: [{
      entityId: deliverableId,
      entityType: "deliverable",
      change: "modified",
      fields: [{ field: "publish.metadata", before, after: metadata }],
    }],
  });
}

function setChapters(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const found = deliverableById(project, deliverableId);
  if (!found.ok) return found;
  if (found.value.kind !== "longform") {
    return deliverableFailure(
      "E_DELIVERABLE_KIND",
      "Chapter generation is available only for long-form deliverables.",
      [deliverableId],
    );
  }
  const chapters = structuredClone(input.params["chapters"] as PublishChapterList);
  if (chapters.deliverableId !== deliverableId) {
    return deliverableFailure(
      "E_PUBLISH_CHAPTER_MISMATCH",
      `Chapter list must identify ${deliverableId}.`,
      [deliverableId],
    );
  }
  const before = found.value.publish?.chapters;
  const replacement: Deliverable = {
    ...found.value,
    publish: { ...found.value.publish, chapters },
  };
  return success({
    model: replaceDeliverable(project, replacement),
    inverse: [],
    redo: { op: input.op, params: structuredClone(input.params) },
    affected: [deliverableId, ...chapters.chapters.map(({ beatId }) => beatId)],
    summary: `Generate publish chapters for ${found.value.name}`,
    mutations: [{
      entityId: deliverableId,
      entityType: "deliverable",
      change: "modified",
      fields: [{ field: "publish.chapters", before, after: chapters }],
    }],
  });
}

function approvePublish(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const found = deliverableById(project, deliverableId);
  if (!found.ok) return found;
  const targets = input.params["targets"] as Array<"metadata" | "chapters">;
  const approvedRevision = formatRevision(parseRevision(project.revision) + 1);
  const publish = structuredClone(found.value.publish ?? {});
  for (const target of targets) {
    if (target === "metadata" && publish.metadata === undefined ||
        target === "chapters" && publish.chapters === undefined) {
      return deliverableFailure(
        "E_PUBLISH_ARTIFACT_MISSING",
        `${target} must be generated before approval.`,
        [deliverableId],
      );
    }
    if (target === "metadata") {
      publish.metadata!.status = "approved";
      publish.metadata!.approvedRevision = approvedRevision;
    } else {
      publish.chapters!.status = "approved";
      publish.chapters!.approvedRevision = approvedRevision;
      delete publish.chapters!.stale;
    }
  }
  const replacement: Deliverable = { ...found.value, publish };
  return success({
    model: replaceDeliverable(project, replacement),
    inverse: [],
    affected: [deliverableId],
    summary: `Approve ${targets.join(" and ")} for ${found.value.name}`,
    mutations: [{
      entityId: deliverableId,
      entityType: "deliverable",
      change: "modified",
      fields: [{ field: "publish", before: found.value.publish, after: publish }],
    }],
  });
}

function selectThumbnail(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const found = deliverableById(project, deliverableId);
  if (!found.ok) return found;
  const composition = input.params["composition"] as string | null;
  const previous = found.value.publish?.selectedThumbnail ?? null;
  const publish = structuredClone(found.value.publish ?? {});
  if (composition === null) delete publish.selectedThumbnail;
  else publish.selectedThumbnail = composition;
  const replacement: Deliverable = { ...found.value, publish };
  return success({
    model: replaceDeliverable(project, replacement),
    inverse: [{
      op: "deliverable.thumbnail.select",
      params: { deliverableId, composition: previous },
    }],
    redo: { op: input.op, params: structuredClone(input.params) },
    affected: [deliverableId],
    summary: composition === null
      ? `Clear selected thumbnail for ${found.value.name}`
      : `Select thumbnail ${composition} for ${found.value.name}`,
    mutations: [{
      entityId: deliverableId,
      entityType: "deliverable",
      change: "modified",
      fields: [{ field: "publish.selectedThumbnail", before: previous, after: composition }],
    }],
  });
}

function setPublishFiles(project: GuyditorProject, input: OperationInput): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const found = deliverableById(project, deliverableId);
  if (!found.ok) return found;
  const files = structuredClone(input.params["files"] as Array<{ path: string; sha256: string }>)
    .sort((left, right) => left.path.localeCompare(right.path));
  const before = structuredClone(found.value.publishFiles ?? []);
  const replacement: Deliverable = { ...found.value, publishFiles: files };
  return success({
    model: replaceDeliverable(project, replacement),
    inverse: [{ op: "deliverable.publish.files.set", params: { deliverableId, files: before } }],
    redo: { op: input.op, params: structuredClone(input.params) },
    affected: [deliverableId, ...files.map(({ path }) => path)],
    summary: `Register ${String(files.length)} publish files for ${found.value.name}`,
    mutations: [{
      entityId: deliverableId,
      entityType: "deliverable",
      change: "modified",
      fields: [{ field: "publishFiles", before, after: files }],
    }],
  });
}

export function applyDeliverableOperation(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  switch (input.op) {
    case "deliverable.derive": return applyDerive(project, input, idFactory);
    case "deliverable.status.set": return statusChange(project, input);
    case "deliverable.approve": return approve(project, input);
    case "deliverable.refresh": return refresh(project, input);
    case "deliverable.framing.override": return framingOverride(project, input);
    case "deliverable.metadata.set": return setMetadata(project, input);
    case "deliverable.chapters.set": return setChapters(project, input);
    case "deliverable.publish.approve": return approvePublish(project, input);
    case "deliverable.thumbnail.select": return selectThumbnail(project, input);
    case "deliverable.publish.files.set": return setPublishFiles(project, input);
    case "deliverable.remove": return remove(project, input);
    default:
      return deliverableFailure("E_OP_UNKNOWN", `Unknown deliverable operation ${input.op}.`);
  }
}
