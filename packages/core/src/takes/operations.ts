import { failure, makeGuyditorError, success } from "../errors.js";
import type { GuyditorProject } from "../project/index.js";
import type { ClipApplication } from "../operations/clip.js";
import type { OperationInput } from "../operations/types.js";
import {
  serializeTakeComparison,
  takeComparisonSidecarRef,
  validateTakeComparison,
} from "./comparison.js";
import type { TakeComparison } from "./types.js";

function withoutSelection(comparison: TakeComparison): string {
  return serializeTakeComparison({
    id: comparison.id,
    slot: comparison.slot,
    candidates: comparison.candidates,
    ...(comparison.recommendation === undefined ? {} : { recommendation: comparison.recommendation }),
    createdAt: comparison.createdAt,
  });
}

export function applyTakeOperation(
  project: GuyditorProject,
  input: OperationInput,
): ReturnType<typeof success<ClipApplication>> | ReturnType<typeof failure> {
  let comparison: TakeComparison;
  let previous: TakeComparison;
  try {
    comparison = validateTakeComparison(input.params["comparison"]);
    previous = validateTakeComparison(input.params["previousComparison"]);
  } catch (error: unknown) {
    return failure(makeGuyditorError(
      "E_TAKE_COMPARISON_SCHEMA",
      error instanceof Error ? error.message : "Invalid take comparison.",
    ));
  }
  if (comparison.id !== previous.id || withoutSelection(comparison) !== withoutSelection(previous)) {
    return failure(makeGuyditorError(
      "E_TAKE_COMPARISON_CHANGED",
      "take.select may only change selectedTakeId; candidates and recommendation must remain retained.",
      { affected: [comparison.id] },
    ));
  }
  if (comparison.selectedTakeId === undefined) {
    return failure(makeGuyditorError(
      "E_TAKE_SELECTION_REQUIRED",
      "take.select requires selectedTakeId.",
      { affected: [comparison.id] },
    ));
  }
  const hashes = Object.fromEntries(project.assets.map(({ id, sha256 }) => [id, sha256]));
  const previousReference = takeComparisonSidecarRef(previous, hashes);
  const current = project.sidecars.find(({ name }) => name === previousReference.name);
  if (current === undefined || current.path !== previousReference.path ||
      current.sha256 !== previousReference.sha256) {
    return failure(makeGuyditorError(
      "E_TAKE_COMPARISON_NOT_FOUND",
      `Take comparison ${comparison.id} is not registered at its expected version.`,
      { affected: [comparison.id] },
    ));
  }
  const nextReference = takeComparisonSidecarRef(comparison, hashes);
  return success({
    model: {
      ...project,
      sidecars: project.sidecars.map((sidecar) =>
        sidecar.name === nextReference.name ? nextReference : sidecar),
    },
    inverse: [{
      op: "take.select",
      params: { comparison: previous, previousComparison: comparison },
    }],
    affected: [comparison.id, comparison.selectedTakeId, ...comparison.candidates
      .filter(({ takeId }) => takeId !== comparison.selectedTakeId)
      .map(({ takeId }) => takeId)],
    summary: `Select ${comparison.selectedTakeId} from comparison ${comparison.id}`,
    mutations: [{
      entityId: nextReference.name,
      entityType: "sidecar",
      change: "modified",
      fields: [{
        field: "selectedTakeId",
        before: previous.selectedTakeId,
        after: comparison.selectedTakeId,
      }],
    }],
  });
}
