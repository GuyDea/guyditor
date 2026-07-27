import type {
  GuyditorProject,
  PlacedItem,
} from "../project/model.js";
import { parseAnchor } from "./parser.js";

interface InferredSequenceScopes {
  invalid: boolean;
  sequenceIds: Set<string>;
}

function inferAnchorSequence(
  project: GuyditorProject,
  anchor: string,
  inferred: InferredSequenceScopes,
): void {
  const parsed = parseAnchor(anchor);
  if (!parsed.ok) {
    inferred.invalid = true;
    return;
  }
  if (parsed.value.kind === "timeline" && "sequenceId" in parsed.value) {
    inferred.sequenceIds.add(parsed.value.sequenceId);
    return;
  }
  if (parsed.value.kind !== "clip") return;
  const clipId = parsed.value.clipId;
  const owner = project.sequences.find(({ clips }) =>
    clips.some(({ id }) => id === clipId));
  if (owner === undefined) {
    inferred.invalid = true;
  } else {
    inferred.sequenceIds.add(owner.id);
  }
}

/**
 * Returns whether a placed item belongs in a sequence-specific view or render.
 *
 * Explicit ownership is authoritative. Legacy items infer ownership from
 * sequence-qualified timeline and clip anchors; genuinely unscoped legacy
 * anchors remain global for backwards compatibility. Conflicting or
 * unresolvable qualified anchors apply nowhere.
 */
export function placedItemAppliesToSequence(
  project: GuyditorProject,
  item: PlacedItem,
  sequenceId: string,
): boolean {
  const inferred: InferredSequenceScopes = {
    invalid: false,
    sequenceIds: new Set(),
  };
  inferAnchorSequence(project, item.at, inferred);
  if (typeof item.duration === "object" && "until" in item.duration) {
    inferAnchorSequence(project, item.duration.until, inferred);
  }
  if (inferred.invalid || inferred.sequenceIds.size > 1) return false;

  if (item.sequenceId !== undefined) {
    const inferredSequence = inferred.sequenceIds.values().next().value as string | undefined;
    return inferredSequence !== undefined && inferredSequence !== item.sequenceId
      ? false
      : item.sequenceId === sequenceId;
  }
  const inferredSequence = inferred.sequenceIds.values().next().value as string | undefined;
  return inferredSequence === undefined || inferredSequence === sequenceId;
}
