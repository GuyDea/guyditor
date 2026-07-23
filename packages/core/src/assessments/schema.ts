import type {
  AssessedMoment,
  AssessmentValidationOptions,
  CriterionRef,
  EvidenceRef,
  Inference,
  Observation,
  SubjectiveAssessment,
} from "./types.js";

const ASSESSMENT_ID = /^asm_[a-z2-7]{10}$/u;
const ASSET_ID = /^ast_[a-z2-7]{10}$/u;
const ANNOTATION_ID = /^ann_[a-z2-7]{10}$/u;
const DELIVERABLE_ID = /^dlv_[a-z2-7]{10}$/u;
const SKILL_ID = /^skl_[a-z2-7]{10}$/u;
const WORD_ID = /^w[0-9]{6}$/u;
const RATIONAL = /^(?:0|[1-9][0-9]*)\/[1-9][0-9]*$/u;

function invalid(detail: string): never {
  throw new TypeError(`Invalid SubjectiveAssessment: ${detail}.`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  permitted: readonly string[],
  path: string,
): void {
  const unsupported = Object.keys(value).filter((key) => !permitted.includes(key));
  if (unsupported.length > 0) {
    invalid(`${path} has unsupported field ${unsupported.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid(`${path} must be non-empty`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    invalid(`${path} must contain non-empty strings`);
  }
  return [...value] as string[];
}

function evidenceRef(value: unknown, path: string): EvidenceRef {
  const source = record(value, path);
  exactKeys(source, ["assetId", "sourceRange", "wordRange", "annotationId", "deliverableId"], path);
  if (Object.keys(source).length === 0) invalid(`${path} must point to inspectable evidence`);
  const assetId = source["assetId"];
  if (assetId !== undefined && (typeof assetId !== "string" || !ASSET_ID.test(assetId))) {
    invalid(`${path}.assetId is malformed`);
  }
  const annotationId = source["annotationId"];
  if (annotationId !== undefined &&
      (typeof annotationId !== "string" || !ANNOTATION_ID.test(annotationId))) {
    invalid(`${path}.annotationId is malformed`);
  }
  const deliverableId = source["deliverableId"];
  if (deliverableId !== undefined &&
      (typeof deliverableId !== "string" || !DELIVERABLE_ID.test(deliverableId))) {
    invalid(`${path}.deliverableId is malformed`);
  }
  const sourceRangeValue = source["sourceRange"];
  let sourceRange: EvidenceRef["sourceRange"];
  if (sourceRangeValue !== undefined) {
    const range = record(sourceRangeValue, `${path}.sourceRange`);
    exactKeys(range, ["start", "durFrames"], `${path}.sourceRange`);
    const start = record(range["start"], `${path}.sourceRange.start`);
    exactKeys(start, ["frames", "fps"], `${path}.sourceRange.start`);
    if (!Number.isSafeInteger(start["frames"]) || Number(start["frames"]) < 0 ||
        typeof start["fps"] !== "string" || !RATIONAL.test(start["fps"])) {
      invalid(`${path}.sourceRange.start must use non-negative frames and rational fps`);
    }
    if (!Number.isSafeInteger(range["durFrames"]) || Number(range["durFrames"]) <= 0) {
      invalid(`${path}.sourceRange.durFrames must be a positive integer`);
    }
    sourceRange = {
      start: { frames: Number(start["frames"]), fps: start["fps"] },
      durFrames: Number(range["durFrames"]),
    };
  }
  const wordRangeValue = source["wordRange"];
  let wordRange: EvidenceRef["wordRange"];
  if (wordRangeValue !== undefined) {
    const range = record(wordRangeValue, `${path}.wordRange`);
    exactKeys(range, ["from", "to"], `${path}.wordRange`);
    if (typeof range["from"] !== "string" || !WORD_ID.test(range["from"]) ||
        typeof range["to"] !== "string" || !WORD_ID.test(range["to"])) {
      invalid(`${path}.wordRange must use word IDs`);
    }
    wordRange = { from: range["from"], to: range["to"] };
  }
  return {
    ...(assetId === undefined ? {} : { assetId }),
    ...(sourceRange === undefined ? {} : { sourceRange }),
    ...(wordRange === undefined ? {} : { wordRange }),
    ...(annotationId === undefined ? {} : { annotationId }),
    ...(deliverableId === undefined ? {} : { deliverableId }),
  };
}

function criterion(value: unknown, path: string): CriterionRef {
  const source = record(value, path);
  exactKeys(source, ["id", "source", "skillId", "ruleId", "text"], path);
  const id = nonEmptyString(source["id"], `${path}.id`);
  const kind = source["source"];
  if (kind !== "skill_rule" && kind !== "inline") invalid(`${path}.source is invalid`);
  const skillId = source["skillId"];
  const ruleId = source["ruleId"];
  if (kind === "skill_rule") {
    if (typeof skillId !== "string" || !SKILL_ID.test(skillId) ||
        typeof ruleId !== "string" || ruleId === "") {
      invalid(`${path} skill_rule must disclose skillId and ruleId`);
    }
  } else if (skillId !== undefined || ruleId !== undefined) {
    invalid(`${path} inline criterion cannot claim a skill rule`);
  }
  return {
    id,
    source: kind,
    ...(skillId === undefined ? {} : { skillId: skillId as string }),
    ...(ruleId === undefined ? {} : { ruleId: ruleId as string }),
    text: nonEmptyString(source["text"], `${path}.text`),
  };
}

function observation(
  value: unknown,
  path: string,
  options: AssessmentValidationOptions,
): Observation {
  const source = record(value, path);
  exactKeys(source, ["id", "text", "evidence"], path);
  if (!Array.isArray(source["evidence"]) || source["evidence"].length === 0) {
    invalid(`${path}.evidence must contain at least one EvidenceRef`);
  }
  const evidence = source["evidence"].map((entry, index) =>
    evidenceRef(entry, `${path}.evidence[${String(index)}]`));
  if (options.evidenceResolver !== undefined) {
    const unresolved = evidence.find((entry) => !options.evidenceResolver!(entry));
    if (unresolved !== undefined) invalid(`${path}.evidence contains an unresolved pointer`);
  }
  return {
    id: nonEmptyString(source["id"], `${path}.id`),
    text: nonEmptyString(source["text"], `${path}.text`),
    evidence,
  };
}

function inference(value: unknown, path: string): Inference {
  const source = record(value, path);
  exactKeys(source, ["text", "basedOn", "confidence"], path);
  const basedOn = stringArray(source["basedOn"], `${path}.basedOn`);
  if (basedOn.length === 0) invalid(`${path}.basedOn must cite an observation`);
  const confidence = source["confidence"];
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    invalid(`${path}.confidence is invalid`);
  }
  return {
    text: nonEmptyString(source["text"], `${path}.text`),
    basedOn,
    confidence,
  };
}

function moment(
  value: unknown,
  path: string,
  criteria: ReadonlySet<string>,
  options: AssessmentValidationOptions,
): AssessedMoment {
  const source = record(value, path);
  exactKeys(source, ["ref", "observations", "inferences", "scores"], path);
  if (!Array.isArray(source["observations"]) || !Array.isArray(source["inferences"])) {
    invalid(`${path} must separate observations and inferences`);
  }
  const observations = source["observations"].map((entry, index) =>
    observation(entry, `${path}.observations[${String(index)}]`, options));
  const observationIds = new Set(observations.map(({ id }) => id));
  if (observationIds.size !== observations.length) invalid(`${path} has duplicate observation IDs`);
  const inferences = source["inferences"].map((entry, index) =>
    inference(entry, `${path}.inferences[${String(index)}]`));
  for (const item of inferences) {
    if (item.basedOn.some((id) => !observationIds.has(id))) {
      invalid(`${path} inference must cite an existing observation`);
    }
  }
  const scoresValue = source["scores"];
  let scores: AssessedMoment["scores"];
  if (scoresValue !== undefined) {
    if (!Array.isArray(scoresValue)) invalid(`${path}.scores must be an array`);
    scores = scoresValue.map((entry, index) => {
      const score = record(entry, `${path}.scores[${String(index)}]`);
      exactKeys(score, ["criterionId", "value", "scale"], `${path}.scores[${String(index)}]`);
      const criterionId = nonEmptyString(score["criterionId"], `${path}.scores[${String(index)}].criterionId`);
      if (!criteria.has(criterionId)) invalid(`${path}.scores references an undisclosed criterion`);
      if (!Number.isInteger(score["value"]) || Number(score["value"]) < 1 || Number(score["value"]) > 5 ||
          score["scale"] !== "1-5") {
        invalid(`${path}.scores must use integer values on the 1-5 scale`);
      }
      return { criterionId, value: Number(score["value"]), scale: "1-5" as const };
    });
  }
  return {
    ref: evidenceRef(source["ref"], `${path}.ref`),
    observations,
    inferences,
    ...(scores === undefined ? {} : { scores }),
  };
}

export function validateSubjectiveAssessment(
  value: unknown,
  options: AssessmentValidationOptions = {},
): SubjectiveAssessment {
  const source = record(value, "assessment");
  exactKeys(source, [
    "assessmentId", "framing", "question", "criteria", "subjects", "comparison", "limitations",
  ], "assessment");
  if (typeof source["assessmentId"] !== "string" || !ASSESSMENT_ID.test(source["assessmentId"])) {
    invalid("assessmentId is malformed");
  }
  if (source["framing"] !== "recommendation") invalid("framing must be recommendation");
  if (!Array.isArray(source["criteria"]) || source["criteria"].length === 0) {
    invalid("criteria must be non-empty");
  }
  const criteria = source["criteria"].map((entry, index) =>
    criterion(entry, `assessment.criteria[${String(index)}]`));
  const criterionIds = new Set(criteria.map(({ id }) => id));
  if (criterionIds.size !== criteria.length) invalid("criteria IDs must be unique");
  if (!Array.isArray(source["subjects"]) || source["subjects"].length === 0) {
    invalid("subjects must be non-empty");
  }
  const subjects = source["subjects"].map((entry, index) =>
    moment(entry, `assessment.subjects[${String(index)}]`, criterionIds, options));
  const comparisonValue = source["comparison"];
  let comparison: SubjectiveAssessment["comparison"];
  if (comparisonValue !== undefined) {
    const item = record(comparisonValue, "assessment.comparison");
    exactKeys(item, ["rankedRefs", "rationale"], "assessment.comparison");
    const rankedRefs = stringArray(item["rankedRefs"], "assessment.comparison.rankedRefs");
    if (rankedRefs.length === 0) invalid("assessment.comparison.rankedRefs must be non-empty");
    comparison = {
      rankedRefs,
      rationale: nonEmptyString(item["rationale"], "assessment.comparison.rationale"),
    };
  }
  return structuredClone({
    assessmentId: source["assessmentId"],
    framing: "recommendation",
    question: nonEmptyString(source["question"], "assessment.question"),
    criteria,
    subjects,
    ...(comparison === undefined ? {} : { comparison }),
    limitations: nonEmptyString(source["limitations"], "assessment.limitations"),
  });
}

export function parseSubjectiveAssessment(
  text: string,
  options: AssessmentValidationOptions = {},
): SubjectiveAssessment {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return invalid("expected valid JSON");
  }
  return validateSubjectiveAssessment(value, options);
}

export function serializeSubjectiveAssessment(value: unknown): string {
  return `${JSON.stringify(validateSubjectiveAssessment(value), null, 2)}\n`;
}
