import { touchedDerivativeIds } from "../../../core/src/index.js";
import type {
  DivergenceClass,
  GuyditorProject,
  OperationInput,
} from "../../../core/src/index.js";

export interface JumpCutProposalOperationGroup {
  operations: OperationInput[];
  operationIndexes: number[];
  divergence?: DivergenceClass;
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
