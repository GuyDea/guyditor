import type {
  GenerationReviewAnnotation,
  GenerationReviewChecklistItem,
} from "./types.js";

const DEFAULT_ITEMS: ReadonlyArray<Pick<
  GenerationReviewChecklistItem,
  "id" | "label" | "required"
>> = [
  { id: "factual-relevance", label: "Factual relevance", required: true },
  { id: "research-accuracy", label: "Research accuracy", required: true },
  { id: "brand-fit", label: "Brand fit", required: true },
  { id: "visual-artifacts", label: "Visual artifacts", required: true },
  { id: "text-artifacts", label: "No unintended rendered text", required: true },
  { id: "unintended-implications", label: "Unintended implications", required: true },
  { id: "rights-confirmed", label: "Rights confirmed", required: true },
];

export interface CreateGenerationReviewInput {
  annotationId: string;
  candidateId: string;
  createdAt: string;
  brandVisualSkill?: GenerationReviewAnnotation["brandVisualSkill"];
}

export function createGenerationReview(
  input: CreateGenerationReviewInput,
): GenerationReviewAnnotation {
  return {
    annotationId: input.annotationId,
    type: "generation-review",
    candidateId: input.candidateId,
    state: "open",
    checklist: {
      schema: "guyditor/genreview/v1",
      items: DEFAULT_ITEMS.map((item) => ({ ...item, state: "pending" })),
    },
    guidance: "Visual plausibility is not factual verification; a creator must record every judgment.",
    createdAt: input.createdAt,
    ...(input.brandVisualSkill === undefined
      ? {}
      : { brandVisualSkill: structuredClone(input.brandVisualSkill) }),
  };
}

export function generationReviewIsAcceptable(
  review: GenerationReviewAnnotation,
): { acceptable: boolean; incompleteItemIds: string[] } {
  const incompleteItemIds = review.checklist.items
    .filter((item) => item.required && (
      review.state !== "resolved" ||
      item.state === "pending" ||
      item.state === "fail" ||
      item.note?.trim() === "" ||
      item.note === undefined
    ))
    .map(({ id }) => id);
  return {
    acceptable: review.state === "resolved" && incompleteItemIds.length === 0,
    incompleteItemIds,
  };
}

