import { touchedDerivativeIds } from "../../../core/src/index.js";
import type {
  ContinuityWarning,
  DivergenceClass,
  GuyditorProject,
  JumpCutOperationReason,
  OperationInput,
} from "../../../core/src/index.js";

export interface JumpCutProposalOperationGroup {
  operations: OperationInput[];
  operationIndexes: number[];
  divergence?: DivergenceClass;
}

export function jumpCutProposalEvidence(
  group: JumpCutProposalOperationGroup,
  reasons: readonly JumpCutOperationReason[],
  warnings: readonly ContinuityWarning[],
): {
  sources: Array<{ kind: "media-evidence"; ref: string }>;
  warnings: ContinuityWarning[];
} {
  const operationIndexes = new Set(group.operationIndexes);
  const selected = reasons.filter(({ operationIndex }) => operationIndexes.has(operationIndex));
  const boundaries = new Set(selected.map(({ boundary }) =>
    `${boundary.beforeClip}\u0000${boundary.afterClip}`));
  return {
    sources: selected.map(({ evidence }) => ({ kind: "media-evidence", ref: evidence })),
    warnings: warnings.filter(({ boundary }) =>
      boundary.beforeClip !== undefined &&
      boundary.afterClip !== undefined &&
      boundaries.has(`${boundary.beforeClip}\u0000${boundary.afterClip}`)),
  };
}

export function groupJumpCutProposalOperations(
  project: GuyditorProject,
  operations: readonly OperationInput[],
): JumpCutProposalOperationGroup[] {
  const groups: JumpCutProposalOperationGroup[] = [];
  operations.forEach((operation, operationIndex) => {
    const touchesShort = touchedDerivativeIds(project, project, [operation]).length > 0;
    const divergence = !touchesShort
      ? undefined
      : operation.op === "clip.punchin.set"
        ? "framing" as const
        : operation.op === "clip.source.switch" || operation.op === "transition.set"
          ? "cuts" as const
          : undefined;
    if (touchesShort && divergence === undefined) {
      throw new Error(`Jump-cut operation ${operation.op} has no divergence classification.`);
    }
    let group = groups.find((candidate) => candidate.divergence === divergence);
    if (group === undefined) {
      group = {
        operations: [],
        operationIndexes: [],
        ...(divergence === undefined ? {} : { divergence }),
      };
      groups.push(group);
    }
    group.operations.push(operation);
    group.operationIndexes.push(operationIndex);
  });
  return groups;
}
