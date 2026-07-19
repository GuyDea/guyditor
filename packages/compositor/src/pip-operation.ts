import type { OperationInput, PlacementConstraints } from "../../core/src/index.js";

/** Shared UI/agent semantic operation builder required by FR-901. */
export function pipPlaceOperation(
  layerId: string,
  placement: PlacementConstraints,
): OperationInput {
  return { op: "pip.place", params: { layerId, placement: structuredClone(placement) } };
}
