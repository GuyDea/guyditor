import type { RightsMetadata } from "../restyle/types.js";
import type {
  RightsCompliance,
  RightsPolicy,
} from "./types.js";

const DEFAULT_REQUIREMENTS: Partial<Record<
  RightsMetadata["origin"],
  Array<keyof RightsMetadata>
>> = {
  licensed: ["licenseName", "licensor"],
  stock: ["licenseName", "licensor"],
  generated: ["providerTermsUrl", "confirmedBy"],
  unknown: ["origin"],
};

function missing(value: RightsMetadata, field: keyof RightsMetadata): boolean {
  if (field === "origin") return value.origin === "unknown";
  const candidate = value[field];
  if (Array.isArray(candidate)) return candidate.length === 0;
  return candidate === undefined || candidate === "";
}

export function rightsCompliance(
  rights: RightsMetadata | undefined,
  policy: RightsPolicy,
): RightsCompliance {
  if (policy.requirementLevel === "off") {
    return { compliant: true, missingFields: [], severity: "none" };
  }
  const origin = rights?.origin ?? "unknown";
  const required = policy.requiredFields?.[origin] ?? DEFAULT_REQUIREMENTS[origin] ?? [];
  const missingFields = rights === undefined
    ? ["origin", ...required.filter((field) => field !== "origin")]
    : required.filter((field) => missing(rights, field)).map(String);
  return {
    compliant: missingFields.length === 0,
    missingFields,
    severity: missingFields.length === 0
      ? "none"
      : policy.requirementLevel === "block" ? "error" : "warning",
  };
}

