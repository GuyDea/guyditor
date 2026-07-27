import type { RestylePlan } from "../../../../core/src/index.js";
import { deliverableContextKey } from "./async-context.js";

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

export function createRestyleContext(
  projectPath: string,
  deliverableId: string,
  sequenceId: string,
): RestyleContext {
  return {
    key: deliverableContextKey(projectPath, deliverableId),
    projectPath,
    deliverableId,
    sequenceId,
  };
}

export function restylePlanMatchesContext(
  plan: RestylePlan,
  context: RestyleContext,
): boolean {
  return plan.deliverableId === context.deliverableId &&
    plan.sequenceId === context.sequenceId;
}

export function keyRestylePlan(
  context: RestyleContext,
  plan: RestylePlan | null,
): KeyedRestylePlan {
  return {
    contextKey: context.key,
    plan: plan !== null && restylePlanMatchesContext(plan, context)
      ? plan
      : null,
  };
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
