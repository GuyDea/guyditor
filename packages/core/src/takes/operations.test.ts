import { describe, expect, it } from "vitest";

import { OperationEngine } from "../operations/index.js";
import { projectFixture } from "../project/test-fixtures.js";
import { takeComparisonSidecarRef } from "./comparison.js";
import type { TakeComparison } from "./types.js";

function comparison(): TakeComparison {
  const candidate = (takeId: string, start: number) => ({
    takeId,
    assetId: "ast_aaaaaaaaaa",
    sourceRange: {
      in: { frames: start, fps: "24/1" },
      out: { frames: start + 48, fps: "24/1" },
    },
    transcriptText: "Make the opening specific",
    scriptMatch: { score: 1, deviations: [] },
    delivery: {
      wordsPerMinute: 150,
      fillerCount: 0,
      pauseRatio: 0.1,
      energyVariance: 0.5,
      restartCount: 0,
    },
    technical: { audioClippingPct: 0, noiseFloorDb: -50 },
    preference: { score: 0.8, rubricId: "skl_aaaaaaaaaa", rubricVersion: "1.0.0" },
    markers: { qualityFlags: ["unrated"], notes: [] },
  });
  return {
    id: "tkc_aaaaaaaaaa",
    slot: { scriptSection: "opening" },
    candidates: [candidate("tak_aaaaaaaaaa", 0), candidate("tak_bbbbbbbbbb", 60)],
    recommendation: {
      takeId: "tak_aaaaaaaaaa",
      reasons: [{ criterion: "delivery", detail: "More stable delivery.", evidence: "tak_aaaaaaaaaa pauseRatio=0.1" }],
      confidence: "medium",
    },
    createdAt: "2026-07-22T12:00:00.000Z",
  };
}

function projectWithComparison() {
  const project = projectFixture();
  const value = comparison();
  project.sidecars.push(takeComparisonSidecarRef(value, {
    ast_aaaaaaaaaa: project.assets[0]!.sha256,
  }));
  return { project, value };
}

describe("take.select", () => {
  it("selects one take while retaining all rejected candidates and an invertible sidecar update", async () => {
    const { project, value: previousComparison } = projectWithComparison();
    const comparison = { ...previousComparison, selectedTakeId: "tak_aaaaaaaaaa" };
    const result = await new OperationEngine(project).execute([{
      op: "take.select",
      params: { comparison, previousComparison },
    }], { baseRevision: project.revision, origin: "ui", dryRun: true });

    expect(result).toMatchObject({
      ok: true,
      value: {
        riskClass: "normal",
        applied: [{
          op: "take.select",
          affected: ["tkc_aaaaaaaaaa", "tak_aaaaaaaaaa", "tak_bbbbbbbbbb"],
          inverse: [{ op: "take.select" }],
        }],
      },
    });
    expect(comparison.candidates).toHaveLength(2);
  });

  it("requires Reason even for a comparison-derived proposal", async () => {
    const { project, value: previousComparison } = projectWithComparison();
    const comparison = { ...previousComparison, selectedTakeId: "tak_aaaaaaaaaa" };
    const result = await new OperationEngine(project).createProposal({
      operations: [{ op: "take.select", params: { comparison, previousComparison } }],
      instruction: { kind: "skill-policy" },
      actor: { kind: "agent", id: "ses_aaaaaaaaaa", model: "stub" },
      reason: { text: "", sources: [{ kind: "media-evidence", ref: comparison.id }] },
      addresses: [],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "E_OP_REASON_REQUIRED" } });
  });
});
