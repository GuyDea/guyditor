import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type { GuyditorProject, Layer } from "../project/index.js";
import type { IdFactory } from "./engine.js";
import type { ClipApplication, EntityMutation } from "./clip.js";
import type { OperationInput, SemanticFieldDelta } from "./types.js";

interface LayerRestoreReferences {
  captions: Array<{ captionId: string; sourceLayerIds: string[] }>;
  mattes: Array<{ layerId: string; matte: NonNullable<Layer["matte"]> }>;
}

function layerFailure(code: `E_${Uppercase<string>}`, message: string, affected: string[]) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function orderMutations(before: readonly Layer[], after: readonly Layer[]): EntityMutation[] {
  const beforeById = new Map(before.map((layer) => [layer.id, layer]));
  return after.flatMap((layer) => {
    const prior = beforeById.get(layer.id);
    return prior === undefined || prior.order === layer.order
      ? []
      : [{
          entityId: layer.id,
          entityType: "layer" as const,
          change: "modified" as const,
          fields: [{ field: "order", before: prior.order, after: layer.order }],
        }];
  });
}

function insertedOrder(layers: readonly Layer[], index: number): number {
  const below = layers[index - 1]?.order;
  const above = layers[index]?.order;
  if (below === undefined && above === undefined) return 0;
  if (below === undefined) return above! - 1;
  if (above === undefined) return below + 1;
  return below + (above - below) / 2;
}

function applyAdd(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  const kind = input.params["kind"] as Layer["kind"];
  const name = input.params["name"] as string;
  const index = input.params["index"] as number;
  if (index > project.layers.length) {
    return layerFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `Layer index ${String(index)} is outside the layer stack.`,
      [],
    );
  }
  const layerId = input.params["layerId"] as string | undefined ?? idFactory("lyr");
  if (project.layers.some(({ id }) => id === layerId)) {
    return layerFailure("E_OP_ID_CONFLICT", `Layer ${layerId} already exists.`, [layerId]);
  }
  const restore = input.params["restore"] as Layer | undefined;
  const layer: Layer = restore === undefined
    ? {
        id: layerId,
        kind,
        name,
        order: insertedOrder(project.layers, index),
        enabled: true,
        locked: false,
        items: [],
      }
    : structuredClone(restore);
  if (layer.id !== layerId || layer.kind !== kind || layer.name !== name) {
    return layerFailure(
      "E_OP_CAPTURE_MISMATCH",
      "Captured layer payload does not match layer.add addressing fields.",
      [layerId],
    );
  }
  const inserted = project.layers.slice();
  inserted.splice(index, 0, layer);
  const restoreReferences = input.params["restoreReferences"] as
    | LayerRestoreReferences
    | undefined;
  let layers = inserted;
  let captions = project.captions;
  const restoredMutations: EntityMutation[] = [];
  if (restoreReferences !== undefined) {
    layers = layers.map((candidate) => {
      const restored = restoreReferences.mattes.find(({ layerId: owner }) =>
        owner === candidate.id);
      if (restored === undefined) return candidate;
      restoredMutations.push({
        entityId: candidate.id,
        entityType: "layer",
        change: "modified",
        fields: [{ field: "matte", after: restored.matte }],
      });
      return { ...candidate, matte: structuredClone(restored.matte) };
    });
    captions = captions.map((caption) => {
      const restored = restoreReferences.captions.find(({ captionId }) =>
        captionId === caption.id);
      if (restored === undefined) return caption;
      restoredMutations.push({
        entityId: caption.id,
        entityType: "caption",
        change: "modified",
        fields: [{ field: "sourceLayerIds", after: restored.sourceLayerIds }],
      });
      return { ...caption, sourceLayerIds: [...restored.sourceLayerIds] };
    });
  }
  const added = layers[index]!;
  const mutations: EntityMutation[] = [
    {
      entityId: added.id,
      entityType: "layer",
      change: "added",
      fields: [{ field: "$entity", after: added }],
    },
    ...restoredMutations,
  ];
  return success({
    model: { ...project, layers, captions },
    inverse: [{ op: "layer.remove", params: { layerId: added.id } }],
    redo: {
      op: "layer.add",
      params: { ...input.params, layerId: added.id },
    },
    affected: mutations.map(({ entityId }) => entityId),
    summary: `Add ${kind} layer '${name}'`,
    mutations,
  });
}

function contentCount(project: GuyditorProject, layer: Layer): number {
  if (layer.items !== undefined) return layer.items.length;
  return project.sequences.find(({ id }) => id === layer.sequence)?.clips.length ?? 0;
}

function applyRemove(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const layerId = input.params["layerId"] as string;
  const index = project.layers.findIndex(({ id }) => id === layerId);
  const layer = project.layers[index];
  if (layer === undefined) {
    return layerFailure("E_OP_NOT_FOUND", `Layer ${layerId} does not exist.`, [layerId]);
  }
  const removed = structuredClone(layer);
  const restoreReferences: LayerRestoreReferences = {
    captions: project.captions
      .filter(({ sourceLayerIds }) => sourceLayerIds.includes(layerId))
      .map(({ id, sourceLayerIds }) => ({
        captionId: id,
        sourceLayerIds: [...sourceLayerIds],
      })),
    mattes: project.layers
      .filter(({ id, matte }) => id !== layerId && matte?.layerId === layerId)
      .map(({ id, matte }) => ({ layerId: id, matte: structuredClone(matte!) })),
  };
  const remaining = project.layers.slice();
  remaining.splice(index, 1);
  const layers = remaining.map((candidate) => {
    if (candidate.matte?.layerId !== layerId) return candidate;
    const replacement = { ...candidate };
    delete replacement.matte;
    return replacement;
  });
  const captions = project.captions.map((caption) =>
    caption.sourceLayerIds.includes(layerId)
      ? {
          ...caption,
          sourceLayerIds: caption.sourceLayerIds.filter((sourceId) => sourceId !== layerId),
        }
      : caption);
  const mutations: EntityMutation[] = [
    {
      entityId: layerId,
      entityType: "layer",
      change: "removed",
      fields: [{ field: "$entity", before: removed }],
    },
    ...restoreReferences.mattes.map(({ layerId: owner, matte }) => ({
      entityId: owner,
      entityType: "layer" as const,
      change: "modified" as const,
      fields: [{ field: "matte", before: matte }],
    })),
    ...restoreReferences.captions.map(({ captionId, sourceLayerIds }) => ({
      entityId: captionId,
      entityType: "caption" as const,
      change: "modified" as const,
      fields: [{
        field: "sourceLayerIds",
        before: sourceLayerIds,
        after: sourceLayerIds.filter((sourceId) => sourceId !== layerId),
      }],
    })),
  ];
  const count = contentCount(project, layer);
  return success({
    model: { ...project, layers, captions },
    inverse: [{
      op: "layer.add",
      params: {
        kind: removed.kind,
        name: removed.name,
        index,
        layerId: removed.id,
        restore: removed,
        ...(restoreReferences.captions.length === 0 && restoreReferences.mattes.length === 0
          ? {}
          : { restoreReferences }),
      },
    }],
    affected: mutations.map(({ entityId }) => entityId),
    summary: `Remove layer '${layer.name}' (${String(count)} clips)`,
    mutations,
  });
}

function applyReorder(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const layerId = input.params["layerId"] as string;
  const fromIndex = project.layers.findIndex(({ id }) => id === layerId);
  const layer = project.layers[fromIndex];
  if (layer === undefined) {
    return layerFailure("E_OP_NOT_FOUND", `Layer ${layerId} does not exist.`, [layerId]);
  }
  const toIndex = input.params["toIndex"] as number;
  if (toIndex >= project.layers.length) {
    return layerFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `Layer index ${String(toIndex)} is outside the layer stack.`,
      [layerId],
    );
  }
  const reordered = project.layers.slice();
  reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, layer);
  const orderValues = project.layers.map(({ order }) => order);
  const layers = reordered.map((candidate, index) =>
    candidate.order === orderValues[index]
      ? candidate
      : { ...candidate, order: orderValues[index]! });
  const mutations = orderMutations(project.layers, layers);
  return success({
    model: { ...project, layers },
    inverse: [{ op: "layer.reorder", params: { layerId, toIndex: fromIndex } }],
    affected: mutations.map(({ entityId }) => entityId),
    summary: `Move layer '${layer.name}' to position ${String(toIndex)}`,
    mutations,
  });
}

function applyState(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const layerId = input.params["layerId"] as string;
  const index = project.layers.findIndex(({ id }) => id === layerId);
  const layer = project.layers[index];
  if (layer === undefined) {
    return layerFailure("E_OP_NOT_FOUND", `Layer ${layerId} does not exist.`, [layerId]);
  }
  const action = input.op.slice("layer.".length) as "enable" | "disable" | "lock" | "unlock";
  const field = action === "enable" || action === "disable" ? "enabled" : "locked";
  const next = action === "enable" || action === "lock";
  const prior = layer[field];
  const replacement = { ...layer, [field]: next };
  const layers = project.layers.slice();
  layers[index] = replacement;
  const opposite = action === "enable" ? "disable"
    : action === "disable" ? "enable"
      : action === "lock" ? "unlock" : "lock";
  const fields: SemanticFieldDelta[] = [{ field, before: prior, after: next }];
  return success({
    model: { ...project, layers },
    inverse: [{ op: `layer.${opposite}`, params: { layerId } }],
    affected: [layerId],
    summary: `${action[0]!.toUpperCase()}${action.slice(1)} layer '${layer.name}'`,
    mutations: [{
      entityId: layerId,
      entityType: "layer",
      change: "modified",
      fields,
    }],
  });
}

export function applyLayerOperation(
  project: GuyditorProject,
  input: OperationInput,
  idFactory: IdFactory,
): Result<ClipApplication> {
  if (input.op === "layer.add") return applyAdd(project, input, idFactory);
  if (input.op === "layer.remove") return applyRemove(project, input);
  if (input.op === "layer.reorder") return applyReorder(project, input);
  return applyState(project, input);
}
