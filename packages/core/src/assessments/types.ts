export interface SubjectiveAssessment {
  assessmentId: string;
  framing: "recommendation";
  question: string;
  criteria: CriterionRef[];
  subjects: AssessedMoment[];
  comparison?: { rankedRefs: string[]; rationale: string };
  limitations: string;
}

export interface CriterionRef {
  id: string;
  source: "skill_rule" | "inline";
  skillId?: string;
  ruleId?: string;
  text: string;
}

export interface AssessedMoment {
  ref: EvidenceRef;
  observations: Observation[];
  inferences: Inference[];
  scores?: Array<{ criterionId: string; value: number; scale: "1-5" }>;
}

export interface Observation {
  id: string;
  text: string;
  evidence: EvidenceRef[];
}

export interface Inference {
  text: string;
  basedOn: string[];
  confidence: "low" | "medium" | "high";
}

export interface EvidenceRef {
  assetId?: string;
  sourceRange?: {
    start: { frames: number; fps: string };
    durFrames: number;
  };
  wordRange?: { from: string; to: string };
  annotationId?: string;
  deliverableId?: string;
}

export interface AssessmentValidationOptions {
  evidenceResolver?: (evidence: EvidenceRef) => boolean;
}
