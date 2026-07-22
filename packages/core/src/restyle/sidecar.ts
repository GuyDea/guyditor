import { createHash } from "node:crypto";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

import restyleSchema from "../../schema/sidecars/guyditor-restyle-v1.schema.json" with { type: "json" };
import { failure, makeGuyditorError, success } from "../errors.js";
import type { Result } from "../errors.js";
import type { SidecarRef } from "../project/index.js";
import type {
  RestyleGenerationProvenance,
  RestylePlan,
} from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validatePlan = ajv.compile<RestylePlan>(restyleSchema);

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortedJson(child)]),
  );
}

function schemaErrors(errors: readonly ErrorObject[] | null | undefined): string {
  return errors?.map((error) =>
    `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? error.keyword}`,
  ).join("; ") ?? "unknown schema error";
}

export function serializeRestylePlan(plan: RestylePlan): string {
  return `${JSON.stringify(sortedJson(plan), null, 2)}\n`;
}

export function parseRestylePlan(source: string): Result<RestylePlan> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    return failure(makeGuyditorError(
      "E_RESTYLE_SIDECAR_INVALID",
      `Restyle sidecar is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    ));
  }
  if (!validatePlan(parsed)) {
    return failure(makeGuyditorError(
      "E_RESTYLE_SIDECAR_INVALID",
      `Restyle sidecar failed schema validation: ${schemaErrors(validatePlan.errors)}.`,
    ));
  }
  return success(structuredClone(parsed));
}

export function restylePlanSidecarName(planId: string): string {
  return `restyle-${planId}`;
}

export function restylePlanSidecarRef(plan: RestylePlan): SidecarRef {
  const source = serializeRestylePlan(plan);
  return {
    name: restylePlanSidecarName(plan.id),
    path: `sidecars/restyle/${plan.id}.json`,
    schema: "guyditor.restyle/v1",
    sha256: createHash("sha256").update(source).digest("hex"),
    generatedBy: { tool: "@guyditor/deliver", version: "1" },
    inputs: plan.sourceAssets.map(({ assetId, sha256 }) => ({ asset: assetId, sha256 })),
  };
}

export function serializeRestyleProvenance(
  provenance: RestyleGenerationProvenance,
): string {
  return `${JSON.stringify(sortedJson(provenance), null, 2)}\n`;
}

export function restyleProvenanceSidecarRef(
  provenance: RestyleGenerationProvenance,
  plan: RestylePlan,
): SidecarRef {
  const source = serializeRestyleProvenance(provenance);
  return {
    name: `provenance-${provenance.assetId}`,
    path: `sidecars/provenance/${provenance.assetId}.provenance.json`,
    schema: "guyditor.provenance/v1",
    sha256: createHash("sha256").update(source).digest("hex"),
    generatedBy: {
      tool: provenance.generation.adapterId,
      version: provenance.generation.adapterVersion,
      job: provenance.generation.jobId,
    },
    inputs: plan.sourceAssets.map(({ assetId, sha256 }) => ({ asset: assetId, sha256 })),
  };
}
