import { failure, makeGuyditorError, success } from "../errors.js";
import type { Result } from "../errors.js";
import type { Asset, GuyditorProject, Layer, PlacedItem } from "../project/index.js";
import type { ClipApplication, EntityMutation } from "../operations/clip.js";
import type { OperationInput } from "../operations/types.js";
import {
  resolveTemplateDescriptor,
  validateTemplateParams,
} from "../operations/graphic.js";
import type { TemplateProvider } from "../templates/index.js";
import {
  restylePlanSidecarRef,
  restyleProvenanceSidecarRef,
} from "./sidecar.js";
import type {
  RestyleGenerationProvenance,
  RestylePlan,
  RestyleSeamTreatment,
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

async function planCreate(
  project: GuyditorProject,
  input: OperationInput,
  templateProvider: TemplateProvider | undefined,
): Promise<Result<ClipApplication>> {
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
  let templates = { ...(project.templates ?? {}) };
  for (const treatment of plan.seams.flatMap((seam) =>
    seam.treatment.kind === "interstitial" ? [seam.treatment] : [])) {
    if (templateProvider === undefined) {
      return restyleFailure(
        "E_TEMPLATE_PROVIDER_UNAVAILABLE",
        `Restyle seam template ${treatment.templateId} requires an installed template provider.`,
        [treatment.templateId],
      );
    }
    const descriptor = await resolveTemplateDescriptor(
      { ...project, templates },
      treatment.templateId,
      templateProvider,
    );
    if (!descriptor.ok) return descriptor;
    const validated = validateTemplateParams(descriptor.value, treatment.params);
    if (!validated.ok) return validated;
    templates = {
      ...templates,
      [treatment.templateId]: templates[treatment.templateId] ?? {
        version: descriptor.value.version,
        contentHash: descriptor.value.contentHash,
      },
    };
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
  const seamMutations: EntityMutation[] = plan.seams.map((seam) => ({
    entityId: seam.id,
    entityType: "restyle-seam",
    change: "added",
    fields: [
      { field: "frame", after: seam.frame },
      { field: "boundary", after: seam.boundary },
      ...(seam.beforeChunkId === undefined
        ? []
        : [{ field: "beforeChunkId", after: seam.beforeChunkId }]),
      ...(seam.afterChunkId === undefined
        ? []
        : [{ field: "afterChunkId", after: seam.afterChunkId }]),
      { field: "treatment", after: structuredClone(seam.treatment) },
      { field: "status", after: seam.status },
    ],
  }));
  return success({
    model: {
      ...project,
      deliverables,
      ...(Object.keys(templates).length === 0 ? {} : { templates }),
      sidecars: replaceSidecar(project, reference.name, reference),
    },
    inverse: [],
    affected: [deliverableId, plan.id, reference.name],
    summary: `Create ${String(plan.chunks.length)}-chunk restyle plan for ${deliverable.name}`,
    mutations: [mutation, ...seamMutations],
  });
}

async function seamTreatmentSet(
  project: GuyditorProject,
  input: OperationInput,
  templateProvider: TemplateProvider | undefined,
): Promise<Result<ClipApplication>> {
  const deliverableId = input.params["deliverableId"] as string;
  const plan = structuredClone(input.params["plan"] as RestylePlan);
  const seamId = input.params["seamId"] as string;
  const treatment = structuredClone(input.params["treatment"] as RestyleSeamTreatment);
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  const seam = plan.seams.find(({ id }) => id === seamId);
  if (deliverable === undefined || seam === undefined) {
    return restyleFailure(
      "E_OP_NOT_FOUND",
      `Restyle seam target ${deliverableId}/${seamId} does not exist.`,
      [deliverableId, seamId],
    );
  }
  if (
    plan.deliverableId !== deliverableId || plan.sequenceId !== deliverable.sequenceId ||
    deliverable.restyle?.planSidecar !== `restyle-${plan.id}`
  ) {
    return restyleFailure(
      "E_RESTYLE_PLAN_TARGET",
      `Restyle seam ${seamId} does not belong to the accepted plan for ${deliverableId}.`,
      [deliverableId, seamId, plan.id],
    );
  }
  const beforeTreatment = structuredClone(seam.treatment);
  const beforeStatus = seam.status;
  seam.treatment = treatment;
  seam.status = beforeStatus === "applied" ? "review" : "planned";
  if (seam.status === "review") seam.review = { reason: "treatment-changed" };
  else delete seam.review;
  delete seam.application;
  let templates = { ...(project.templates ?? {}) };
  if (treatment.kind === "interstitial") {
    const fps = /^(\d+)\/([1-9]\d*)$/u.exec(project.settings.timeline.fps);
    if (fps === null) {
      return restyleFailure(
        "E_RESTYLE_SEAM_DURATION",
        `Restyle seam ${seamId} cannot validate timeline fps ${project.settings.timeline.fps}.`,
        [seamId],
      );
    }
    const frames = BigInt(treatment.durationFrames);
    const numerator = BigInt(fps[1]!);
    const denominator = BigInt(fps[2]!);
    if (frames * denominator * 2n < numerator || frames * denominator > numerator * 2n) {
      return restyleFailure(
        "E_RESTYLE_SEAM_DURATION",
        `Restyle seam ${seamId} duration must be between 0.5 and 2 seconds.`,
        [seamId],
      );
    }
    if (templateProvider === undefined) {
      return restyleFailure(
        "E_TEMPLATE_PROVIDER_UNAVAILABLE",
        `Restyle seam template ${treatment.templateId} requires an installed template provider.`,
        [treatment.templateId],
      );
    }
    const descriptor = await resolveTemplateDescriptor(
      { ...project, templates },
      treatment.templateId,
      templateProvider,
    );
    if (!descriptor.ok) return descriptor;
    const validated = validateTemplateParams(descriptor.value, treatment.params);
    if (!validated.ok) return validated;
    templates = {
      ...templates,
      [treatment.templateId]: templates[treatment.templateId] ?? {
        version: descriptor.value.version,
        contentHash: descriptor.value.contentHash,
      },
    };
  }
  const reference = restylePlanSidecarRef(plan);
  return success({
    model: {
      ...project,
      ...(Object.keys(templates).length === 0 ? {} : { templates }),
      sidecars: replaceSidecar(project, reference.name, reference),
    },
    inverse: [],
    redo: {
      op: "seam.treatment.set",
      params: { deliverableId, plan, seamId, treatment },
    },
    affected: [deliverableId, plan.id, seamId, reference.name],
    summary: `Set ${seamId} treatment to ${treatment.kind}`,
    mutations: [{
      entityId: seamId,
      entityType: "restyle-seam",
      change: "modified",
      fields: [
        { field: "treatment", before: beforeTreatment, after: structuredClone(treatment) },
        { field: "status", before: beforeStatus, after: seam.status },
        ...(seam.review === undefined
          ? []
          : [{ field: "review", after: structuredClone(seam.review) }]),
      ],
    }],
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
  const seamPlacements = structuredClone(
    (input.params["seamPlacements"] ?? []) as Array<{
      seamId: string;
      layerId: string;
      itemId: string;
      seed: number;
    }>,
  );
  const chunkPunchIn = structuredClone(input.params["chunkPunchIn"] as {
    seamId: string;
    effectId: string;
    level: number;
  } | undefined);
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
  const ownedSeamIds = new Set(plan.seams
    .filter(({ application }) => application?.chunkId === chunkId)
    .map(({ id }) => id));
  const replacedLayers = project.layers.filter((candidate) =>
    (candidate.items ?? []).some((candidateItem) => {
      const restyle = candidateItem.params?.["restyle"];
      if (typeof restyle === "object" && restyle !== null && !Array.isArray(restyle)) {
        const metadata = restyle as Record<string, unknown>;
        if (metadata["planId"] === plan.id && metadata["chunkId"] === chunkId) return true;
      }
      const restyleSeam = candidateItem.layout?.["restyleSeam"];
      if (typeof restyleSeam === "object" && restyleSeam !== null && !Array.isArray(restyleSeam)) {
        const metadata = restyleSeam as Record<string, unknown>;
        return metadata["planId"] === plan.id &&
          typeof metadata["seamId"] === "string" && ownedSeamIds.has(metadata["seamId"]);
      }
      return false;
    }));
  const replacedLayerIds = new Set(replacedLayers.map(({ id }) => id));
  const retainedLayers = project.layers.filter(({ id }) => !replacedLayerIds.has(id));
  const placementLayerIds = new Set([layerId, ...seamPlacements.map((placement) => placement.layerId)]);
  const placementItemIds = new Set([itemId, ...seamPlacements.map((placement) => placement.itemId)]);
  if (
    placementLayerIds.size !== seamPlacements.length + 1 ||
    placementItemIds.size !== seamPlacements.length + 1 ||
    retainedLayers.some((layer) =>
      placementLayerIds.has(layer.id) ||
      layer.items?.some(({ id }) => placementItemIds.has(id)))
  ) {
    return restyleFailure(
      "E_OP_ID_CONFLICT",
      "Restyle chunk and seam placement IDs must be unique and unused.",
      [...placementLayerIds, ...placementItemIds],
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
    ...(chunkPunchIn === undefined
      ? {}
      : {
          effects: [{
            id: chunkPunchIn.effectId,
            kind: "transform",
            params: { scale: chunkPunchIn.level },
          }],
        }),
  };
  if (chunkPunchIn !== undefined) {
    const punchSeam = plan.seams.find(({ id }) => id === chunkPunchIn.seamId);
    if (
      punchSeam === undefined || punchSeam.treatment.kind !== "punch-in" ||
      punchSeam.boundary !== "internal" || punchSeam.afterChunkId !== chunkId ||
      punchSeam.status !== "applied" || punchSeam.application?.chunkId !== chunkId ||
      !Number.isFinite(chunkPunchIn.level) || chunkPunchIn.level <= 1
    ) {
      return restyleFailure(
        "E_RESTYLE_APPROVAL_INVALID",
        `Restyle internal punch-in ${chunkPunchIn.seamId} is not prepared for ${chunkId}.`,
        [chunkId, chunkPunchIn.seamId],
      );
    }
  }
  const layer: Layer = {
    id: layerId,
    kind: "video",
    name: `AI restyle · ${chunkId}`,
    order: nextLayerOrder(retainedLayers),
    enabled: true,
    locked: false,
    items: [item],
  };
  const seamLayers: Layer[] = [];
  for (const placement of seamPlacements) {
    const seam = plan.seams.find(({ id }) => id === placement.seamId);
    if (
      seam === undefined || seam.treatment.kind !== "interstitial" ||
      seam.status !== "applied" || seam.application?.chunkId !== chunkId ||
      seam.application.itemId !== placement.itemId ||
      (seam.beforeChunkId ?? seam.afterChunkId) !== chunkId
    ) {
      return restyleFailure(
        "E_RESTYLE_APPROVAL_INVALID",
        `Restyle seam ${placement.seamId} is not prepared for chunk ${chunkId}.`,
        [chunkId, placement.seamId],
      );
    }
    if (project.templates?.[seam.treatment.templateId] === undefined) {
      return restyleFailure(
        "E_TEMPLATE_MISSING_VERSION",
        `Restyle seam ${seam.id} template ${seam.treatment.templateId} is not pinned.`,
        [seam.id, seam.treatment.templateId],
      );
    }
    if (!Number.isSafeInteger(placement.seed) || placement.seed < 0 || placement.seed > 0xffff_ffff) {
      return restyleFailure(
        "E_GRAPHIC_SEED_INVALID",
        `Restyle seam ${seam.id} seed must be a uint32.`,
        [seam.id],
      );
    }
    const treatment = seam.treatment;
    seamLayers.push({
      id: placement.layerId,
      kind: "animation",
      name: `Restyle seam · ${seam.id}`,
      order: nextLayerOrder([...retainedLayers, layer, ...seamLayers]),
      enabled: true,
      locked: false,
      items: [{
        id: placement.itemId,
        template: treatment.templateId,
        at: `timeline:${plan.sequenceId}@${String(seam.frame)}`,
        duration: { frames: treatment.durationFrames, fps },
        params: structuredClone(treatment.params),
        seed: placement.seed,
        layout: {
          restyleSeam: {
            planId: plan.id,
            seamId: seam.id,
            sourceFrame: seam.frame,
            durationFrames: treatment.durationFrames,
            resumeExact: true,
          },
        },
      }],
    });
  }
  const provenanceReference = restyleProvenanceSidecarRef(provenance, plan);
  return success({
    model: {
      ...project,
      assets: [...project.assets, asset],
      layers: [...retainedLayers, layer, ...seamLayers],
      sidecars: [...project.sidecars, provenanceReference].filter((sidecar, index, sidecars) =>
        sidecars.findIndex(({ name }) => name === sidecar.name) === index),
    },
    inverse: [],
    affected: [
      deliverableId,
      chunkId,
      asset.id,
      layerId,
      itemId,
      ...replacedLayers.flatMap((replacedLayer) => [
        replacedLayer.id,
        ...(replacedLayer.items ?? []).map(({ id }) => id),
      ]),
      ...seamLayers.flatMap((seamLayer) => [seamLayer.id, ...(seamLayer.items ?? []).map(({ id }) => id)]),
    ],
    summary: `Approve restyle chunk ${String(chunk.index + 1)} for ${deliverable.name}`,
    mutations: [
      ...replacedLayers.flatMap((replacedLayer): EntityMutation[] => [
        ...(replacedLayer.items ?? []).map((replacedItem) => ({
          entityId: replacedItem.id,
          entityType: "item" as const,
          change: "removed" as const,
          fields: [{ field: "$entity", before: replacedItem }],
        })),
        {
          entityId: replacedLayer.id,
          entityType: "layer" as const,
          change: "removed" as const,
          fields: [{ field: "$entity", before: replacedLayer }],
        },
      ]),
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
      ...(chunkPunchIn === undefined ? [] : [{
        entityId: chunkPunchIn.effectId,
        entityType: "effect" as const,
        change: "added" as const,
        fields: [{ field: "$entity", after: item.effects![0] }],
      }]),
      ...seamLayers.flatMap((seamLayer): EntityMutation[] => [
        {
          entityId: seamLayer.id,
          entityType: "layer",
          change: "added",
          fields: [{ field: "$entity", after: seamLayer }],
        },
        ...(seamLayer.items ?? []).map((seamItem) => ({
          entityId: seamItem.id,
          entityType: "item" as const,
          change: "added" as const,
          fields: [{ field: "$entity", after: seamItem }],
        })),
      ]),
    ],
  });
}

export async function applyRestyleOperation(
  project: GuyditorProject,
  input: OperationInput,
  templateProvider?: TemplateProvider,
): Promise<Result<ClipApplication>> {
  if (input.op === "restyle.plan.create") return planCreate(project, input, templateProvider);
  if (input.op === "restyle.segment.approve") return segmentApprove(project, input);
  if (input.op === "seam.treatment.set") {
    return seamTreatmentSet(project, input, templateProvider);
  }
  return restyleFailure("E_OP_UNKNOWN", `Unknown restyle operation ${input.op}.`, [input.op]);
}
