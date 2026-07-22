import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  parseSubjectiveAssessment,
  serializeSubjectiveAssessment,
  validateSubjectiveAssessment,
} from "../../core/src/index.js";
import type {
  EvidenceRef,
  ProjectStore,
  SubjectiveAssessment,
} from "../../core/src/index.js";
import type { ResolvedSkill } from "./skills/index.js";

export interface AssessmentStoreOptions {
  projectRoot: string;
  project: ProjectStore;
  skills?: readonly ResolvedSkill[];
  evidenceResolver?: (evidence: EvidenceRef) => boolean;
}

/** Standalone assessment cache used before an assessment is attached to a proposal. */
export class AssessmentStore {
  readonly #projectRoot: string;
  readonly #project: ProjectStore;
  readonly #skills: readonly ResolvedSkill[];
  readonly #evidenceResolver: ((evidence: EvidenceRef) => boolean) | undefined;

  public constructor(options: AssessmentStoreOptions) {
    this.#projectRoot = options.projectRoot;
    this.#project = options.project;
    this.#skills = options.skills ?? [];
    this.#evidenceResolver = options.evidenceResolver;
  }

  public async submit(value: unknown): Promise<SubjectiveAssessment> {
    const assessment = validateSubjectiveAssessment(value, {
      evidenceResolver: (evidence) => this.#resolves(evidence),
    });
    this.#validateRubrics(assessment);
    const path = this.#path(assessment.assessmentId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, serializeSubjectiveAssessment(assessment), "utf8");
    await rename(temporary, path);
    return assessment;
  }

  public async get(assessmentId: string): Promise<SubjectiveAssessment | undefined> {
    if (!/^asm_[a-z2-7]{10}$/u.test(assessmentId)) return undefined;
    try {
      return parseSubjectiveAssessment(await readFile(this.#path(assessmentId), "utf8"), {
        evidenceResolver: (evidence) => this.#resolves(evidence),
      });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  #resolves(evidence: EvidenceRef): boolean {
    const model = this.#project.currentProject;
    if (evidence.assetId !== undefined &&
        !model.assets.some(({ id }) => id === evidence.assetId)) return false;
    if (evidence.deliverableId !== undefined &&
        !model.deliverables.some(({ id }) => id === evidence.deliverableId)) return false;
    return this.#evidenceResolver?.(evidence) ??
      (evidence.assetId !== undefined || evidence.deliverableId !== undefined);
  }

  #validateRubrics(assessment: SubjectiveAssessment): void {
    for (const criterion of assessment.criteria) {
      if (criterion.source !== "skill_rule") continue;
      const skill = this.#skills.find(({ manifest }) => manifest.id === criterion.skillId);
      const rule = skill?.manifest.rules.find(({ id }) => id === criterion.ruleId);
      if (rule === undefined) {
        throw new TypeError(`Assessment criterion ${criterion.id} references an unpinned skill rule.`);
      }
      if (rule.text !== criterion.text) {
        throw new TypeError(`Assessment criterion ${criterion.id} does not disclose the pinned rule text.`);
      }
    }
  }

  #path(assessmentId: string): string {
    return join(this.#projectRoot, ".guyditor", "cache", "assessments", `${assessmentId}.json`);
  }
}
