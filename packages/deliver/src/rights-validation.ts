import {
  rightsCompliance,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  RightsPolicy,
} from "../../core/src/index.js";

export interface DeliverableRightsCheck {
  id: string;
  code: "E_RIGHTS_MISSING";
  status: "warn" | "fail";
  assetId: string;
  missingFields: string[];
  message: string;
}

export interface DeliverableRightsValidation {
  outcome: "pass" | "warnings" | "blocked";
  checks: DeliverableRightsCheck[];
  attributionText: string[];
}

function usedAssetIds(project: GuyditorProject, deliverableId: string): Set<string> {
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
  const sequence = project.sequences.find(({ id }) => id === deliverable.sequenceId);
  const used = new Set(sequence?.clips.map(({ asset }) => asset) ?? []);
  for (const layer of project.layers) {
    if (!layer.enabled) continue;
    if (layer.sequence === deliverable.sequenceId) {
      const layerSequence = project.sequences.find(({ id }) => id === layer.sequence);
      for (const clip of layerSequence?.clips ?? []) used.add(clip.asset);
    }
    for (const item of layer.items ?? []) {
      if (item.asset !== undefined && item.at.startsWith(`timeline:${deliverable.sequenceId}@`)) {
        used.add(item.asset);
      }
    }
  }
  return used;
}

export function validateDeliverableRights(
  project: GuyditorProject,
  deliverableId: string,
  policy: RightsPolicy,
): DeliverableRightsValidation {
  const used = usedAssetIds(project, deliverableId);
  const checks: DeliverableRightsCheck[] = [];
  const attributionText: string[] = [];
  for (const asset of project.assets.filter(({ id }) => used.has(id))) {
    const compliance = rightsCompliance(asset.rights, policy);
    if (!compliance.compliant) {
      checks.push({
        id: `rights-${asset.id}`,
        code: "E_RIGHTS_MISSING",
        status: compliance.severity === "error" ? "fail" : "warn",
        assetId: asset.id,
        missingFields: compliance.missingFields,
        message: `Asset ${asset.id} is missing rights fields: ${compliance.missingFields.join(", ")}.`,
      });
    }
    if (
      asset.rights?.restrictions.includes("attribution-required") === true &&
      asset.rights.attributionText !== undefined &&
      !attributionText.includes(asset.rights.attributionText)
    ) attributionText.push(asset.rights.attributionText);
  }
  return {
    outcome: checks.some(({ status }) => status === "fail")
      ? "blocked"
      : checks.length > 0 ? "warnings" : "pass",
    checks,
    attributionText,
  };
}

