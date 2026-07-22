import type { RightsMetadata } from "../restyle/types.js";

export type BrollSourceClassId =
  | "local-footage"
  | "licensed-asset"
  | "still-image"
  | "screen-capture"
  | "programmatic-animation"
  | "external-generation"
  | "local-generation";

export interface BrollSourceDescriptor {
  id: BrollSourceClassId;
  label: string;
  entryPath: "ingest" | "capture" | "template" | "generate";
  origin: RightsMetadata["origin"];
  createsAsset: boolean;
  availability: "available" | "declared-unavailable";
  rightsDefault: "creator-owned" | "capture-required" | "provider-terms";
}

export interface GenerationReviewChecklistItem {
  id: string;
  label: string;
  required: boolean;
  state: "pending" | "pass" | "fail" | "not_applicable";
  note?: string;
  agentObservation?: string;
}

export interface GenerationReviewChecklist {
  schema: "guyditor/genreview/v1";
  items: GenerationReviewChecklistItem[];
}

export interface GenerationReviewAnnotation {
  annotationId: string;
  type: "generation-review";
  candidateId: string;
  state: "open" | "resolved" | "rejected";
  checklist: GenerationReviewChecklist;
  guidance: string;
  createdAt: string;
  resolvedAt?: string;
  brandVisualSkill?: {
    id: string;
    version: string;
    contentHash: string;
  };
}

export interface RightsPolicy {
  requirementLevel: "off" | "warn" | "block";
  requiredFields?: Partial<Record<
    RightsMetadata["origin"],
    Array<keyof RightsMetadata>
  >>;
}

export interface RightsCompliance {
  compliant: boolean;
  missingFields: string[];
  severity: "none" | "warning" | "error";
}

export interface GenerationProvenance {
  schema: "guyditor.provenance/v1";
  assetId: string;
  generation: {
    adapterId: string;
    adapterVersion: string;
    provider: string;
    endpoint?: string;
    model: string;
    prompt: string;
    negativePrompt?: string | null;
    settings: Record<string, unknown>;
    settingsSchemaHash: string;
    seed?: number;
    requestId: string;
    jobId: string;
    referenceAssetIds: string[];
    createdAt: string;
    providerMetadata: Record<string, unknown>;
  };
  rights: RightsMetadata;
  reviewAnnotationId: string;
  contentHash: string;
}

