export const SKILL_CATEGORIES = Object.freeze([
  "pacing",
  "pauses_fillers",
  "framing_cuts",
  "subtitle_style",
  "motion_transitions",
  "brand_voice",
  "brand_visual",
  "hooks_retention",
  "research_accuracy",
] as const);

export type SkillCategory = typeof SKILL_CATEGORIES[number];
export type SkillRuleStrength = "must" | "prefer" | "avoid";

export interface SkillRule {
  id: string;
  category: SkillCategory;
  strength: SkillRuleStrength;
  text: string;
}

export interface SkillExample {
  id: string;
  description: string;
  media?: { path: string; sha256: string };
  provenance?: { projectId: string; revision: string };
}

export interface SkillExamples {
  approved: SkillExample[];
  rejected: SkillExample[];
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  title: string;
  categories: SkillCategory[];
  summary: string;
  rules: SkillRule[];
  examples: SkillExamples;
  contentHash: string;
}

export interface SkillManifestSource extends Omit<SkillManifest, "contentHash"> {
  format: "guyditor-skill/v1";
  body: "SKILL.md";
}

export interface PresetReference {
  id: string;
  version: number;
}

export interface ResolvedSkill {
  manifest: SkillManifest;
  body: string;
  presetReferences: PresetReference[];
  exampleContents?: {
    approved: ResolvedSkillExample[];
    rejected: ResolvedSkillExample[];
  };
}

export interface ResolvedSkillExample {
  example: SkillExample;
  payload?: unknown;
}

export type SkillScope = "global" | "project" | "all";

export interface SkillVersionDiff {
  skillId: string;
  fromVersion: string;
  toVersion: string;
  metadata: {
    title: { before: string; after: string };
    summary: { before: string; after: string };
    categories: { before: SkillCategory[]; after: SkillCategory[] };
  };
  rules: {
    added: SkillRule[];
    removed: SkillRule[];
    changed: Array<{ id: string; before: SkillRule; after: SkillRule }>;
  };
  examples: {
    approved: { added: string[]; removed: string[]; unchanged: string[] };
    rejected: { added: string[]; removed: string[]; unchanged: string[] };
  };
  body: { before: string; after: string };
}

export interface CreateSkillDraftInput {
  base: { skillId: string; version: string };
  version: string;
}

export interface UpdateSkillDraftInput {
  skillId: string;
  version: string;
  title?: string;
  summary?: string;
  categories?: SkillCategory[];
  rules?: SkillRule[];
  examples?: SkillExamples;
  body?: string;
}
