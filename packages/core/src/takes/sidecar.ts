import { Ajv2020 } from "ajv/dist/2020.js";

import schema from "../../schema/sidecars/guyditor-take-markers-v1.schema.json" with { type: "json" };
import type { TakeMarkerSidecar } from "./types.js";

const validate = new Ajv2020({ allErrors: true, strict: true }).compile<TakeMarkerSidecar>(schema);

function invalid(detail: string): never {
  throw new TypeError(`Invalid guyditor.take-markers/v1 sidecar: ${detail}.`);
}

export function validateTakeMarkerSidecar(value: unknown): TakeMarkerSidecar {
  if (!validate(value)) {
    invalid(validate.errors?.map((error) =>
      `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ") ?? "schema error");
  }
  const sidecar = value as TakeMarkerSidecar;
  const markerIds = new Set<string>();
  for (const marker of sidecar.markers) {
    if (marker.assetId !== sidecar.assetId) invalid(`${marker.id} belongs to another asset`);
    if (markerIds.has(marker.id)) invalid(`duplicate marker ID ${marker.id}`);
    markerIds.add(marker.id);
    if ("start" in marker.at && marker.at.start >= marker.at.end) {
      invalid(`${marker.id} range must start before it ends`);
    }
  }
  const takeIds = new Set<string>();
  for (const take of sidecar.takes) {
    if (take.assetId !== sidecar.assetId) invalid(`${take.id} belongs to another asset`);
    if (takeIds.has(take.id)) invalid(`duplicate take ID ${take.id}`);
    takeIds.add(take.id);
    if (take.range.start >= take.range.end) invalid(`${take.id} range must start before it ends`);
    if (!take.sourceMarkerIds.every((id) => markerIds.has(id))) {
      invalid(`${take.id} references an absent marker`);
    }
  }
  return structuredClone(sidecar);
}

export function parseTakeMarkerSidecar(text: string): TakeMarkerSidecar {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return invalid("expected valid JSON");
  }
  return validateTakeMarkerSidecar(value);
}

export function serializeTakeMarkerSidecar(sidecar: TakeMarkerSidecar): string {
  return `${JSON.stringify(validateTakeMarkerSidecar(sidecar), null, 2)}\n`;
}
