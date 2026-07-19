import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import {
  findStoredAnchor,
  updateStoredAnchor,
} from "../anchors/owners.js";
import type { StoredAnchorPath } from "../anchors/owners.js";
import { parseAnchor } from "../anchors/parser.js";
import type { AnchorLastResolved } from "../anchors/types.js";
import type { GuyditorProject } from "../project/model.js";
import type { ClipApplication } from "./clip.js";
import type { OperationInput } from "./types.js";

function operationFailure(message: string, affected: readonly string[]) {
  return failure(makeGuyditorError("E_OP_NOT_FOUND", message, { affected }));
}

export function applyAnchorOperation(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const owner = input.params["owner"] as string;
  const anchorPath = input.params["anchorPath"] as StoredAnchorPath;
  const newAnchor = input.params["newAnchor"] as string;
  const lastResolved = input.params["lastResolved"] as AnchorLastResolved | undefined;
  const parsed = parseAnchor(newAnchor);
  if (!parsed.ok) return parsed;
  const previous = findStoredAnchor(project, owner, anchorPath);
  if (previous === undefined) {
    return operationFailure(
      `Anchor owner ${owner} has no stored anchor at ${anchorPath}.`,
      [owner],
    );
  }
  const model = updateStoredAnchor(project, owner, anchorPath, newAnchor, lastResolved);
  if (model === undefined) {
    return operationFailure(
      `Anchor owner ${owner} cannot be updated at ${anchorPath}.`,
      [owner],
    );
  }
  const itemLayer = model.layers.find((layer) => layer.items?.some(({ id }) => id === owner));
  if (itemLayer !== undefined) delete itemLayer.sequence;
  const inverseParams: Record<string, unknown> = {
    owner,
    anchorPath,
    newAnchor: previous.anchor,
    ...(previous.metadata?.lastResolved === undefined
      ? {}
      : { lastResolved: previous.metadata.lastResolved }),
  };
  return success({
    model,
    inverse: [{ op: "anchor.rebind", params: inverseParams }],
    affected: [owner],
    summary: `Rebind anchor on ${owner} to ${newAnchor}`,
    mutations: [],
  });
}
