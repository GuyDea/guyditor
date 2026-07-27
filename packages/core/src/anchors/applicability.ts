import type {
  GuyditorProject,
  PlacedItem,
} from "../project/model.js";
import { parseAnchor } from "./parser.js";

interface InferredSequenceScopes {
  unresolved: boolean;
  sequenceIds: Set<string>;
}

function inferAnchorSequence(
  project: GuyditorProject,
  anchor: string,
  inferred: InferredSequenceScopes,
): void {
  const parsed = parseAnchor(anchor);
  if (!parsed.ok) {
    inferred.unresolved = true;
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
    inferred.unresolved = true;
  } else {
    inferred.sequenceIds.add(owner.id);
  }
}

export interface PlacedItemOwnershipConsistency {
  consistent: boolean;
  explicitSequenceId?: string;
  inferredSequenceIds: string[];
  unresolvedQualifiedAnchors: boolean;
}

/**
 * Reports the sequence ownership evidence carried by a placed item.
 *
 * Word, beat, annotation, and rate-qualified timeline anchors deliberately
 * carry no sequence ownership: they can become orphaned without corrupting
 * the item's explicit owner. Sequence-qualified timeline anchors and
 * resolvable clip anchors must agree with one another and with sequenceId.
 */
export function placedItemOwnershipConsistency(
  project: GuyditorProject,
  item: PlacedItem,
): PlacedItemOwnershipConsistency {
  const inferred: InferredSequenceScopes = {
    unresolved: false,
    sequenceIds: new Set(),
  };
  inferAnchorSequence(project, item.at, inferred);
  if (typeof item.duration === "object" && "until" in item.duration) {
    inferAnchorSequence(project, item.duration.until, inferred);
  }
  const inferredSequenceIds = [...inferred.sequenceIds].sort();
  const consistent = inferredSequenceIds.length <= 1 &&
    (
      item.sequenceId === undefined ||
      inferredSequenceIds.length === 0 ||
      inferredSequenceIds[0] === item.sequenceId
    );
  return {
    consistent,
    ...(item.sequenceId === undefined ? {} : { explicitSequenceId: item.sequenceId }),
    inferredSequenceIds,
    unresolvedQualifiedAnchors: inferred.unresolved,
  };
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
  const ownership = placedItemOwnershipConsistency(project, item);
  if (!ownership.consistent || ownership.unresolvedQualifiedAnchors) return false;

  if (item.sequenceId !== undefined) {
    return item.sequenceId === sequenceId;
  }
  const inferredSequence = ownership.inferredSequenceIds[0];
  return inferredSequence === undefined || inferredSequence === sequenceId;
}
