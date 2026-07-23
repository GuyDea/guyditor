import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type {
  Asset,
  GuyditorProject,
  Layer,
  PlacedItem,
  SkillPin,
} from "../project/index.js";
import type { ClipApplication } from "../operations/clip.js";
import type { OperationInput } from "../operations/types.js";
import { generationReviewIsAcceptable } from "./review.js";
import {
  generationProvenanceSidecarRef,
  generationReviewSidecarRef,
} from "./sidecar.js";
import type {
  GenerationProvenance,
  GenerationReviewAnnotation,
} from "./types.js";

function generationFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[],
): Result<ClipApplication> {
  return failure(makeGuyditorError(code, message, { affected }));
}

function pinsMatch(
  expected: SkillPin,
  actual: GenerationReviewAnnotation["brandVisualSkill"],
): boolean {
  return actual !== undefined && actual.id === expected.id &&
    actual.version === expected.version && actual.contentHash === expected.contentHash;
}

function nextLayerOrder(project: GuyditorProject): number {
  return project.layers.reduce((maximum, layer) => Math.max(maximum, layer.order), -1) + 1;
}

export function applyGenerationOperation(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  if (input.op !== "generation.accept") {
    return generationFailure("E_OP_UNKNOWN", `Unknown generation operation ${input.op}.`, [input.op]);
  }
  const asset = structuredClone(input.params["asset"] as Asset);
  const provenance = structuredClone(input.params["provenance"] as GenerationProvenance);
  const review = structuredClone(input.params["review"] as GenerationReviewAnnotation);
  const placement = input.params["placement"] as {
    sequenceId: string;
    layerId: string;
    itemId: string;
    atFrame: number;
    durationFrames: number;
  };
  const reviewStatus = generationReviewIsAcceptable(review);
  if (!reviewStatus.acceptable) {
    return generationFailure(
      "E_GENERATION_REVIEW_INCOMPLETE",
      `Generation review ${review.annotationId} is incomplete.`,
      [review.annotationId, ...reviewStatus.incompleteItemIds],
    );
  }
  const brandVisual = project.skills.find(({ name }) => name === "brand_visual");
  if (brandVisual !== undefined && !pinsMatch(brandVisual, review.brandVisualSkill)) {
    return generationFailure(
      "E_GENERATION_BRAND_REVIEW_UNPINNED",
      `Generation review ${review.annotationId} must reference the active brand_visual skill.`,
      [review.annotationId, brandVisual.id],
    );
  }
  if (
    project.assets.some(({ id }) => id === asset.id) ||
    project.layers.some(({ id }) => id === placement.layerId) ||
    project.layers.some(({ items }) => items?.some(({ id }) => id === placement.itemId))
  ) {
    return generationFailure(
      "E_OP_ID_CONFLICT",
      "Generation acceptance requires new asset and placement IDs.",
      [asset.id, placement.layerId, placement.itemId],
    );
  }
  if (!project.sequences.some(({ id }) => id === placement.sequenceId)) {
    return generationFailure(
      "E_OP_NOT_FOUND",
      `Generation placement sequence ${placement.sequenceId} does not exist.`,
      [placement.sequenceId],
    );
  }
  if (
    asset.kind !== "generated" || provenance.assetId !== asset.id ||
    asset.provenance?.sidecar !== `provenance-${asset.id}` ||
    provenance.reviewAnnotationId !== review.annotationId ||
    !review.candidateId.startsWith(`${provenance.generation.jobId}/`) ||
    provenance.contentHash !== `sha256:${asset.sha256}` ||
    JSON.stringify(provenance.rights) !== JSON.stringify(asset.rights)
  ) {
    return generationFailure(
      "E_GENERATION_PROVENANCE_INVALID",
      `Generation provenance or review does not match asset ${asset.id}.`,
      [asset.id, review.annotationId],
    );
  }
  if (
    !Number.isSafeInteger(placement.atFrame) || placement.atFrame < 0 ||
    !Number.isSafeInteger(placement.durationFrames) || placement.durationFrames <= 0
  ) {
    return generationFailure(
      "E_GENERATION_PLACEMENT_INVALID",
      "Generation placement frames must be non-negative integers with positive duration.",
      [placement.itemId],
    );
  }
  const fps = project.settings.timeline.fps;
  const item: PlacedItem = {
    id: placement.itemId,
    asset: asset.id,
    at: `timeline:${placement.sequenceId}@${String(placement.atFrame)}`,
    duration: { frames: placement.durationFrames, fps },
    ...(asset.video === undefined
      ? {}
      : {
          source: {
            in: { frames: 0, fps },
            out: { frames: placement.durationFrames, fps },
          },
        }),
  };
  const layer: Layer = {
    id: placement.layerId,
    kind: asset.image === undefined ? "video" : "image",
    name: `B-roll · ${asset.id}`,
    order: nextLayerOrder(project),
    enabled: true,
    locked: false,
    items: [item],
  };
  const provenanceReference = generationProvenanceSidecarRef(provenance);
  const reviewReference = generationReviewSidecarRef(review);
  return success({
    model: {
      ...project,
      assets: [...project.assets, asset],
      layers: [...project.layers, layer],
      sidecars: [...project.sidecars, provenanceReference, reviewReference],
    },
    inverse: [],
    affected: [asset.id, placement.layerId, placement.itemId, review.annotationId],
    summary: `Accept generated B-roll ${asset.id}`,
    mutations: [
      {
        entityId: asset.id,
        entityType: "asset",
        change: "added",
        fields: [{ field: "$entity", after: asset }],
      },
      {
        entityId: placement.layerId,
        entityType: "layer",
        change: "added",
        fields: [{ field: "$entity", after: layer }],
      },
      {
        entityId: placement.itemId,
        entityType: "item",
        change: "added",
        fields: [{ field: "$entity", after: item }],
      },
    ],
  });
}
