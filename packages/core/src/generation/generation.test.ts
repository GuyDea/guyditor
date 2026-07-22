import { describe, expect, it } from "vitest";

import {
  BROLL_SOURCE_TAXONOMY,
  createGenerationReview,
  generationReviewIsAcceptable,
  rightsCompliance,
} from "../index.js";
import type {
  GenerationReviewAnnotation,
  RightsMetadata,
  RightsPolicy,
} from "../index.js";

const NOW = "2026-07-23T10:00:00.000Z";

function complete(review: GenerationReviewAnnotation): GenerationReviewAnnotation {
  return {
    ...review,
    state: "resolved",
    resolvedAt: NOW,
    checklist: {
      ...review.checklist,
      items: review.checklist.items.map((item) => ({
        ...item,
        state: "pass",
        note: `Creator checked ${item.label.toLowerCase()}.`,
      })),
    },
  };
}

describe("FR-603 B-roll source taxonomy", () => {
  it("exposes all seven first-class source paths and declares local generation unavailable", () => {
    expect(BROLL_SOURCE_TAXONOMY.map(({ id }) => id)).toEqual([
      "local-footage",
      "licensed-asset",
      "still-image",
      "screen-capture",
      "programmatic-animation",
      "external-generation",
      "local-generation",
    ]);
    expect(BROLL_SOURCE_TAXONOMY).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "programmatic-animation",
        entryPath: "template",
        origin: "programmatic",
        createsAsset: false,
      }),
      expect.objectContaining({
        id: "local-generation",
        entryPath: "generate",
        availability: "declared-unavailable",
      }),
    ]));
  });
});

describe("FR-606 generation review", () => {
  it("creates the required human checklist and keeps visual observations advisory", () => {
    const review = createGenerationReview({
      annotationId: "ann_aaaaaaaaaa",
      candidateId: "job_aaaaaaaaaa/0",
      createdAt: NOW,
      brandVisualSkill: {
        id: "skl_bbbbbbbbbb",
        version: "2.1.0",
        contentHash: "b".repeat(64),
      },
    });

    expect(review.type).toBe("generation-review");
    expect(review.checklist.items.map(({ id }) => id)).toEqual([
      "factual-relevance",
      "research-accuracy",
      "brand-fit",
      "visual-artifacts",
      "text-artifacts",
      "unintended-implications",
      "rights-confirmed",
    ]);
    expect(review.checklist.items.every(({ state }) => state === "pending")).toBe(true);
    expect(review.guidance).toMatch(/plausibility is not factual verification/i);
    expect(review.brandVisualSkill).toEqual(expect.objectContaining({ version: "2.1.0" }));
    expect(generationReviewIsAcceptable(review)).toEqual({
      acceptable: false,
      incompleteItemIds: review.checklist.items.map(({ id }) => id),
    });
  });

  it("accepts only resolved reviews whose required judgments have notes and no failures", () => {
    const review = complete(createGenerationReview({
      annotationId: "ann_aaaaaaaaaa",
      candidateId: "job_aaaaaaaaaa/0",
      createdAt: NOW,
    }));
    expect(generationReviewIsAcceptable(review)).toEqual({
      acceptable: true,
      incompleteItemIds: [],
    });

    review.checklist.items[1] = {
      ...review.checklist.items[1]!,
      state: "fail",
      note: "The skyline does not match the researched location.",
    };
    expect(generationReviewIsAcceptable(review)).toEqual({
      acceptable: false,
      incompleteItemIds: ["research-accuracy"],
    });
  });
});

describe("NFR-004 rights policy", () => {
  const licensed: RightsMetadata = {
    origin: "licensed",
    restrictions: [],
  };
  const generated: RightsMetadata = {
    origin: "generated",
    restrictions: [],
    providerTermsUrl: "https://provider.invalid/terms",
    confirmedBy: "provider",
  };

  it.each([
    ["off", "none"],
    ["warn", "warning"],
    ["block", "error"],
  ] as const)("maps a missing licensed rights record at %s level to %s", (level, severity) => {
    const policy: RightsPolicy = { requirementLevel: level };
    expect(rightsCompliance(licensed, policy)).toEqual({
      compliant: level === "off",
      missingFields: level === "off" ? [] : ["licenseName", "licensor"],
      severity,
    });
  });

  it("accepts provider-confirmed generated rights and flags unknown origin", () => {
    expect(rightsCompliance(generated, { requirementLevel: "block" })).toEqual({
      compliant: true,
      missingFields: [],
      severity: "none",
    });
    expect(rightsCompliance({ origin: "unknown", restrictions: [] }, {
      requirementLevel: "warn",
    })).toEqual({
      compliant: false,
      missingFields: ["origin"],
      severity: "warning",
    });
  });
});
