import { createHash } from "node:crypto";

import type { SidecarRef } from "../project/index.js";
import type {
  GenerationProvenance,
  GenerationReviewAnnotation,
} from "./types.js";

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortedJson(child)]),
  );
}

function serialize(value: unknown): string {
  return `${JSON.stringify(sortedJson(value), null, 2)}\n`;
}

export function serializeGenerationProvenance(provenance: GenerationProvenance): string {
  return serialize(provenance);
}

export function serializeGenerationReview(review: GenerationReviewAnnotation): string {
  return serialize(review);
}

export function generationProvenanceSidecarRef(
  provenance: GenerationProvenance,
): SidecarRef {
  const source = serializeGenerationProvenance(provenance);
  return {
    name: `provenance-${provenance.assetId}`,
    path: `sidecars/provenance/${provenance.assetId}.provenance.json`,
    schema: "guyditor.provenance/v1",
    sha256: createHash("sha256").update(source).digest("hex"),
    generatedBy: {
      tool: provenance.generation.adapterId,
      version: provenance.generation.adapterVersion,
      job: provenance.generation.jobId,
    },
    inputs: [],
  };
}

export function generationReviewSidecarRef(
  review: GenerationReviewAnnotation,
): SidecarRef {
  const source = serializeGenerationReview(review);
  return {
    name: `generation-review-${review.annotationId}`,
    path: `sidecars/generation-reviews/${review.annotationId}.json`,
    schema: "guyditor.genreview/v1",
    sha256: createHash("sha256").update(source).digest("hex"),
    generatedBy: { tool: "@guyditor/core", version: "1" },
    inputs: [],
  };
}

