import { describe, expect, it } from "vitest";

import {
  parseSubjectiveAssessment,
  serializeSubjectiveAssessment,
  validateSubjectiveAssessment,
} from "../index.js";
import type { SubjectiveAssessment } from "../index.js";

function assessment(): SubjectiveAssessment {
  return {
    assessmentId: "asm_aaaaaaaaaa",
    framing: "recommendation",
    question: "Which opening is clearest without losing energy?",
    criteria: [{
      id: "hook-clarity",
      source: "skill_rule",
      skillId: "skl_aaaaaaaaaa",
      ruleId: "rule_hook_12s",
      text: "State the promise in the opening twelve seconds.",
    }],
    subjects: [{
      ref: {
        assetId: "ast_aaaaaaaaaa",
        sourceRange: { start: { frames: 12, fps: "24/1" }, durFrames: 48 },
        wordRange: { from: "w000042", to: "w000049" },
      },
      observations: [{
        id: "obs-opening-promise",
        text: "The first sentence names the promised outcome.",
        evidence: [{ wordRange: { from: "w000042", to: "w000049" } }],
      }],
      inferences: [{
        text: "The opening is likely to feel clear to a first-time viewer.",
        basedOn: ["obs-opening-promise"],
        confidence: "medium",
      }],
      scores: [{ criterionId: "hook-clarity", value: 4, scale: "1-5" }],
    }],
    comparison: {
      rankedRefs: ["ast_aaaaaaaaaa"],
      rationale: "The promise is explicit and arrives before the setup detail.",
    },
    limitations: "Clarity and retention are heuristic recommendations, not measured outcomes.",
  };
}

describe("FR-702 subjective assessment schema", () => {
  it("round-trips the verbatim recommendation schema", () => {
    const source = assessment();

    expect(parseSubjectiveAssessment(serializeSubjectiveAssessment(source))).toEqual(source);
    expect(validateSubjectiveAssessment(source)).toEqual(source);
  });

  it("requires every inference to cite an observation in the same assessed moment", () => {
    const source = assessment();
    source.subjects[0]!.inferences[0]!.basedOn = ["obs-does-not-exist"];

    expect(() => validateSubjectiveAssessment(source)).toThrow(/existing observation/i);
  });

  it("keeps observations and inferences structurally separate", () => {
    const noEvidence = assessment();
    noEvidence.subjects[0]!.observations[0]!.evidence = [];
    expect(() => validateSubjectiveAssessment(noEvidence)).toThrow(/evidence/i);

    const inferredObservation: unknown = {
      ...assessment(),
      subjects: [{
        ...assessment().subjects[0],
        observations: [{
          ...assessment().subjects[0]!.observations[0],
          confidence: "high",
        }],
      }],
    };
    expect(() => validateSubjectiveAssessment(inferredObservation)).toThrow(/unsupported field/i);
  });

  it("requires disclosed criteria, valid recommendation scores, and limitations", () => {
    const noCriteria = assessment();
    noCriteria.criteria = [];
    expect(() => validateSubjectiveAssessment(noCriteria)).toThrow(/criteria/i);

    const undisclosedScore = assessment();
    undisclosedScore.subjects[0]!.scores![0]!.criterionId = "hidden-criterion";
    expect(() => validateSubjectiveAssessment(undisclosedScore)).toThrow(/criterion/i);

    const noLimitations = { ...assessment(), limitations: "" };
    expect(() => validateSubjectiveAssessment(noLimitations)).toThrow(/limitations/i);
  });
});
