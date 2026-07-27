import type {
  RestylePlan,
  RestyleSeam,
} from "../../../../core/src/index.js";

export interface RestyleContext {
  key: string;
  projectPath: string;
  deliverableId: string;
  sequenceId: string;
}

export interface KeyedRestylePlan {
  contextKey: string;
  plan: RestylePlan | null;
}

export interface RestyleConfirmationIdentity {
  contextKey: string;
  sequenceId: string;
  planId: string;
}

export function createRestyleContext(
  projectPath: string,
  deliverableId: string,
  sequenceId: string,
): RestyleContext {
  return {
    key: JSON.stringify([projectPath, deliverableId, sequenceId]),
    projectPath,
    deliverableId,
    sequenceId,
  };
}

export function restyleMutationRequestKey(
  context: RestyleContext,
  resourceIdentity: string,
): string {
  return JSON.stringify([context.key, resourceIdentity]);
}

export function restyleConfirmationMatchesContext(
  confirmation: RestyleConfirmationIdentity,
  context: RestyleContext | null,
  planId: string | undefined,
): boolean {
  return context !== null &&
    confirmation.contextKey === context.key &&
    confirmation.sequenceId === context.sequenceId &&
    confirmation.planId === planId;
}

export function restylePlanMatchesContext(
  plan: RestylePlan,
  context: RestyleContext,
): boolean {
  return plan.deliverableId === context.deliverableId &&
    plan.sequenceId === context.sequenceId;
}

export function restylePlanContractError(
  plan: RestylePlan,
  context: RestyleContext,
): string | null {
  return restylePlanMatchesContext(plan, context)
    ? null
    : `Restyle plan contract violation: ${plan.id} belongs to deliverable ${plan.deliverableId} / sequence ${plan.sequenceId}, not the active ${context.deliverableId} / ${context.sequenceId}.`;
}

export function keyRestylePlan(
  context: RestyleContext,
  plan: RestylePlan | null,
): KeyedRestylePlan {
  if (plan !== null) {
    const contractError = restylePlanContractError(plan, context);
    if (contractError !== null) throw new Error(contractError);
  }
  return {
    contextKey: context.key,
    plan,
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

export function restyleSeamEditorKey(
  context: RestyleContext,
  plan: Pick<RestylePlan, "id">,
  seam: Pick<RestyleSeam, "id" | "frame" | "boundary" | "status" | "treatment">,
  catalog: readonly {
    id: string;
    version: string;
    contentHash: string;
  }[],
): string {
  const catalogIdentity = [...catalog]
    .map(({ id, version, contentHash }) => ({ id, version, contentHash }))
    .sort((left, right) =>
      left.id.localeCompare(right.id) ||
      left.version.localeCompare(right.version) ||
      left.contentHash.localeCompare(right.contentHash));
  return JSON.stringify(canonicalJsonValue({
    contextKey: context.key,
    planId: plan.id,
    seam: {
      id: seam.id,
      frame: seam.frame,
      boundary: seam.boundary,
      status: seam.status,
    },
    treatment: seam.treatment,
    catalog: catalogIdentity,
  }));
}

export function restylePlanForContext(
  state: KeyedRestylePlan | null,
  context: RestyleContext | null,
): RestylePlan | null {
  if (
    state === null ||
    context === null ||
    state.contextKey !== context.key ||
    state.plan === null ||
    !restylePlanMatchesContext(state.plan, context)
  ) {
    return null;
  }
  return state.plan;
}
