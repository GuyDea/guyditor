import { failure, makeGuyditorError, success } from "../errors.js";
import type { Result } from "../errors.js";
import type { Asset, GuyditorProject, Layer, PlacedItem } from "../project/index.js";
import type { ClipApplication, EntityMutation } from "../operations/clip.js";
import type { OperationInput } from "../operations/types.js";
import {
  restylePlanSidecarRef,
  restyleProvenanceSidecarRef,
} from "./sidecar.js";
import type {
  RestyleGenerationProvenance,
  RestylePlan,
} from "./types.js";

function restyleFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
): ReturnType<typeof failure> {
  return failure(makeGuyditorError(code, message, { affected }));
}

function replaceSidecar(
  project: GuyditorProject,
  name: string,
  replacement: GuyditorProject["sidecars"][number],
): GuyditorProject["sidecars"] {
  return [...project.sidecars.filter((sidecar) => sidecar.name !== name), replacement];
}

function nextLayerOrder(layers: readonly Layer[]): number {
  return layers.reduce((maximum, layer) => Math.max(maximum, layer.order), -1) + 1;
}

function planCreate(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const plan = structuredClone(input.params["plan"] as RestylePlan);
  const deliverableIndex = project.deliverables.findIndex(({ id }) => id === deliverableId);
  const deliverable = project.deliverables[deliverableIndex];
  if (deliverable === undefined) {
    return restyleFailure(
      "E_OP_NOT_FOUND",
      `Deliverable ${deliverableId} does not exist.`,
      [deliverableId],
    );
  }
  if (plan.deliverableId !== deliverableId || plan.sequenceId !== deliverable.sequenceId) {
    return restyleFailure(
      "E_RESTYLE_PLAN_TARGET",
      `Restyle plan ${plan.id} does not target deliverable ${deliverableId}.`,
      [deliverableId, plan.id],
    );
  }
  const assetIds = new Set(project.assets.map(({ id }) => id));
  const missingAsset = plan.sourceAssets.find(({ assetId }) => !assetIds.has(assetId));
  if (missingAsset !== undefined) {
    return restyleFailure(
      "E_OP_NOT_FOUND",
      `Restyle source asset ${missingAsset.assetId} does not exist.`,
      [missingAsset.assetId],
    );
  }
  const reference = restylePlanSidecarRef(plan);
  const deliverables = project.deliverables.slice();
  deliverables[deliverableIndex] = {
    ...deliverable,
    restyle: {
      coverageMode: plan.coverage.mode,
      planSidecar: reference.name,
    },
  };
  const mutation: EntityMutation = {
    entityId: deliverableId,
    entityType: "deliverable",
    change: "modified",
    fields: [{
      field: "restyle",
      ...(deliverable.restyle === undefined ? {} : { before: deliverable.restyle }),
      after: deliverables[deliverableIndex]!.restyle,
    }],
  };
  return success({
    model: {
      ...project,
      deliverables,
      sidecars: replaceSidecar(project, reference.name, reference),
    },
    inverse: [],
    affected: [deliverableId, plan.id, reference.name],
    summary: `Create ${String(plan.chunks.length)}-chunk restyle plan for ${deliverable.name}`,
    mutations: [mutation],
  });
}

function segmentApprove(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const deliverableId = input.params["deliverableId"] as string;
  const plan = structuredClone(input.params["plan"] as RestylePlan);
  const chunkId = input.params["chunkId"] as string;
  const asset = structuredClone(input.params["asset"] as Asset);
  const provenance = structuredClone(
    input.params["provenance"] as RestyleGenerationProvenance,
  );
  const layerId = input.params["layerId"] as string;
  const itemId = input.params["itemId"] as string;
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  const chunk = plan.chunks.find(({ id }) => id === chunkId);
  if (deliverable === undefined || chunk === undefined) {
    return restyleFailure(
      "E_OP_NOT_FOUND",
      `Restyle approval target ${deliverableId}/${chunkId} does not exist.`,
      [deliverableId, chunkId],
    );
  }
  if (
    plan.deliverableId !== deliverableId || plan.sequenceId !== deliverable.sequenceId ||
    chunk.status !== "approved" || chunk.assetId !== asset.id
  ) {
    return restyleFailure(
      "E_RESTYLE_APPROVAL_INVALID",
      `Restyle chunk ${chunkId} is not prepared for asset ${asset.id}.`,
      [chunkId, asset.id],
    );
  }
  if (project.assets.some(({ id }) => id === asset.id)) {
    return restyleFailure("E_OP_ID_CONFLICT", `Asset ${asset.id} already exists.`, [asset.id]);
  }
  if (provenance.assetId !== asset.id || asset.provenance?.sidecar !== `provenance-${asset.id}`) {
    return restyleFailure(
      "E_RESTYLE_PROVENANCE_INVALID",
      `Restyle provenance does not match asset ${asset.id}.`,
      [asset.id],
    );
  }
  if (project.layers.some((layer) =>
    layer.id === layerId || layer.items?.some(({ id }) => id === itemId))) {
    return restyleFailure(
      "E_OP_ID_CONFLICT",
      `Restyle placement IDs ${layerId}/${itemId} are already in use.`,
      [layerId, itemId],
    );
  }
  const fps = project.settings.timeline.fps;
  const durationFrames = chunk.sourceRange.endFrame - chunk.sourceRange.startFrame;
  if (durationFrames <= 0) {
    return restyleFailure(
      "E_RESTYLE_RANGE_INVALID",
      `Restyle chunk ${chunkId} has an empty source range.`,
      [chunkId],
    );
  }
  const item: PlacedItem = {
    id: itemId,
    asset: asset.id,
    at: `timeline:${plan.sequenceId}@${String(chunk.sourceRange.startFrame)}`,
    duration: { frames: durationFrames, fps },
    source: {
      in: { frames: 0, fps },
      out: { frames: durationFrames, fps },
    },
    params: {
      restyle: {
        planId: plan.id,
        chunkId,
        sourceRange: structuredClone(chunk.sourceRange),
      },
    },
  };
  const layer: Layer = {
    id: layerId,
    kind: "video",
    name: `AI restyle · ${chunkId}`,
    order: nextLayerOrder(project.layers),
    enabled: true,
    locked: false,
    items: [item],
  };
  const provenanceReference = restyleProvenanceSidecarRef(provenance, plan);
  return success({
    model: {
      ...project,
      assets: [...project.assets, asset],
      layers: [...project.layers, layer],
      sidecars: [...project.sidecars, provenanceReference].filter((sidecar, index, sidecars) =>
        sidecars.findIndex(({ name }) => name === sidecar.name) === index),
    },
    inverse: [],
    affected: [deliverableId, chunkId, asset.id, layerId, itemId],
    summary: `Approve restyle chunk ${String(chunk.index + 1)} for ${deliverable.name}`,
    mutations: [
      {
        entityId: asset.id,
        entityType: "asset",
        change: "added",
        fields: [{ field: "$entity", after: asset }],
      },
      {
        entityId: layerId,
        entityType: "layer",
        change: "added",
        fields: [{ field: "$entity", after: layer }],
      },
    ],
  });
}

export function applyRestyleOperation(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  if (input.op === "restyle.plan.create") return planCreate(project, input);
  if (input.op === "restyle.segment.approve") return segmentApprove(project, input);
  return restyleFailure("E_OP_UNKNOWN", `Unknown restyle operation ${input.op}.`, [input.op]);
}
