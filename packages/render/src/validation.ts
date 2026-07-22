import { validateMetadata } from "../../deliver/src/index.js";
import type { PlatformProfile, PublishMetadata } from "../../deliver/src/index.js";
import type { ExportValidationCheckResult } from "./service.js";

interface NormalizedRect { x: number; y: number; w: number; h: number }

function intersects(left: NormalizedRect, right: NormalizedRect): boolean {
  return left.x < right.x + right.w && right.x < left.x + left.w &&
    left.y < right.y + right.h && right.y < left.y + left.h;
}

export function validateOverlayLayout(input: {
  deliverableId: string;
  profile: Pick<PlatformProfile, "safeAreas">;
  captionOverflowWordIds: readonly string[];
  boxes: readonly {
    ownerId: string;
    kind: "caption" | "graphic";
    rect: NormalizedRect;
  }[];
}): ExportValidationCheckResult {
  const intersections = input.boxes.flatMap((box) => input.profile.safeAreas.platformUi
    .filter((zone) => intersects(box.rect, zone.rect))
    .map((zone) => ({ box, zone })));
  const strict = intersections.filter(({ zone }) => zone.strict === true);
  const soft = intersections.filter(({ zone }) => zone.strict !== true);
  const affected = [...new Set([
    ...input.captionOverflowWordIds,
    ...intersections.map(({ box }) => box.ownerId),
  ])];
  const status = strict.length > 0
    ? "fail"
    : input.captionOverflowWordIds.length > 0 || soft.length > 0 ? "warn" : "pass";
  const details = [
    ...(input.captionOverflowWordIds.length === 0
      ? []
      : [`${String(input.captionOverflowWordIds.length)} overflowing caption word(s)`]),
    ...strict.map(({ zone }) => `strict ${zone.name} exclusion`),
    ...soft.map(({ zone }) => `${zone.name} exclusion`),
  ];
  return {
    id: "VAL-401",
    status,
    message: status === "pass"
      ? "Captions and graphics fit the profile safe areas."
      : `Caption/safe-area validation found ${details.join(", ")}.`,
    affected: affected.length === 0 ? [input.deliverableId] : affected,
  };
}

export function validatePublishMetadataCheck(input: {
  deliverableId: string;
  metadata: PublishMetadata;
  profile: Pick<PlatformProfile, "metadata">;
}): ExportValidationCheckResult {
  const errors = validateMetadata(input.metadata, input.profile);
  return {
    id: "VAL-METADATA",
    status: errors.length === 0 ? "pass" : "fail",
    message: errors.length === 0
      ? "Publish metadata is within the pinned profile limits."
      : errors.map(({ suggestion }) => suggestion).join("; "),
    affected: errors.length === 0
      ? [input.deliverableId]
      : [...new Set(errors.flatMap(({ affected }) => affected))],
  };
}
