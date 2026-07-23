import { describe, expect, it } from "vitest";

import {
  applyGenerationOperation,
  createGenerationReview,
  generationProvenanceSidecarRef,
  generationReviewSidecarRef,
  serializeGenerationProvenance,
  OperationEngine,
} from "../index.js";
import type {
  Asset,
  GenerationProvenance,
  GenerationReviewAnnotation,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const HASH = "c".repeat(64);

function asset(): Asset {
  return {
    id: "ast_bbbbbbbbbb",
    kind: "generated",
    path: "media/generated/ast_bbbbbbbbbb.mp4",
    sha256: HASH,
    probe: {
      duration: { frames: 48, fps: "24/1" },
      width: 1280,
      height: 720,
      fps: "24/1",
    },
    video: {
      codec: "h264",
      width: 1280,
      height: 720,
      fps: "24/1",
      pixFmt: "yuv420p",
      hasAlpha: false,
      rotation: 0,
    },
    provenance: { sidecar: "provenance-ast_bbbbbbbbbb" },
    rights: {
      origin: "generated",
      providerTermsUrl: "https://stub.guyditor.invalid/terms",
      confirmedBy: "provider",
      restrictions: [],
    },
  };
}

function provenance(): GenerationProvenance {
  return {
    schema: "guyditor.provenance/v1",
    assetId: "ast_bbbbbbbbbb",
    generation: {
      adapterId: "adp_stubgenaaa",
      adapterVersion: "1.0.0",
      provider: "Guyditor deterministic stub",
      model: "ffmpeg-synth-v1",
      prompt: "Slow orbit around a cobalt glass sculpture",
      negativePrompt: null,
      settings: { width: 1280, height: 720, durationFrames: 48, fps: "24/1" },
      settingsSchemaHash: `sha256:${"d".repeat(64)}`,
      seed: 42,
      requestId: "01K0GENERATIONREQUEST",
      jobId: "job_aaaaaaaaaa",
      referenceAssetIds: [],
      createdAt: "2026-07-23T10:00:00.000Z",
      providerMetadata: { synthesizer: "lavfi" },
    },
    rights: asset().rights!,
    reviewAnnotationId: "ann_aaaaaaaaaa",
    contentHash: `sha256:${HASH}`,
  };
}

function review(complete: boolean): GenerationReviewAnnotation {
  const created = createGenerationReview({
    annotationId: "ann_aaaaaaaaaa",
    candidateId: "job_aaaaaaaaaa/0",
    createdAt: "2026-07-23T10:00:00.000Z",
  });
  if (!complete) return created;
  return {
    ...created,
    state: "resolved",
    resolvedAt: "2026-07-23T10:05:00.000Z",
    checklist: {
      ...created.checklist,
      items: created.checklist.items.map((item) => ({
        ...item,
        state: "pass",
        note: "Checked by creator.",
      })),
    },
  };
}

function operation(candidateReview: GenerationReviewAnnotation) {
  return {
    op: "generation.accept",
    params: {
      cachedPath: "generations/job_aaaaaaaaaa/candidate-0.mp4",
      asset: asset(),
      provenance: provenance(),
      review: candidateReview,
      placement: {
        sequenceId: "seq_aaaaaaaaaa",
        layerId: "lyr_bbbbbbbbbb",
        itemId: "gfx_bbbbbbbbbb",
        atFrame: 24,
        durationFrames: 48,
      },
    },
  };
}

describe("FR-605 generation acceptance", () => {
  it("catalogs acceptance as consequential and requires proposal acceptance", async () => {
    const project = projectFixture();
    const engine = new OperationEngine(project);

    await expect(engine.execute([operation(review(true))], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "E_OP_PROPOSAL_REQUIRED" },
    });
    const dryRun = await engine.execute([operation(review(true))], {
      baseRevision: project.revision,
      origin: "system",
      dryRun: true,
    });
    if (!dryRun.ok) throw new Error(JSON.stringify(dryRun.error));
    expect(dryRun).toMatchObject({
      ok: true,
      value: { riskClass: "consequential" },
    });
  });

  it("blocks acceptance until every human review judgment is complete", () => {
    const result = applyGenerationOperation(projectFixture(), operation(review(false)));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_GENERATION_REVIEW_INCOMPLETE",
        affected: expect.arrayContaining(["ann_aaaaaaaaaa", "factual-relevance"]),
      },
    });
  });

  it("registers only the frozen asset and asset-based placement after review", () => {
    const result = applyGenerationOperation(projectFixture(), operation(review(true)));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.model.assets.at(-1)).toEqual(asset());
    expect(result.value.model.layers.at(-1)).toMatchObject({
      id: "lyr_bbbbbbbbbb",
      kind: "video",
      items: [{
        id: "gfx_bbbbbbbbbb",
        asset: "ast_bbbbbbbbbb",
        at: "timeline:seq_aaaaaaaaaa@24",
      }],
    });
    expect(result.value.model.layers.at(-1)?.items?.[0]).not.toHaveProperty("adapterId");
    expect(result.value.model.sidecars.slice(-2)).toEqual([
      generationProvenanceSidecarRef(provenance()),
      generationReviewSidecarRef(review(true)),
    ]);
  });

  it("pins the active brand_visual skill in the review gate", () => {
    const project = projectFixture();
    project.skills.push({
      id: "skl_bbbbbbbbbb",
      name: "brand_visual",
      version: "2.0.0",
      path: "skills/brand_visual/2.0.0/",
      contentHash: "b".repeat(64),
    });
    const candidateReview = review(true);

    expect(applyGenerationOperation(project, operation(candidateReview))).toMatchObject({
      ok: false,
      error: { code: "E_GENERATION_BRAND_REVIEW_UNPINNED" },
    });

    candidateReview.brandVisualSkill = {
      id: "skl_bbbbbbbbbb",
      version: "2.0.0",
      contentHash: "b".repeat(64),
    };
    expect(applyGenerationOperation(project, operation(candidateReview)).ok).toBe(true);
  });

  it("serializes adapter-versioned provenance deterministically", () => {
    const serialized = serializeGenerationProvenance(provenance());
    expect(serialized).toContain('"adapterVersion": "1.0.0"');
    expect(generationProvenanceSidecarRef(provenance())).toMatchObject({
      name: "provenance-ast_bbbbbbbbbb",
      path: "sidecars/provenance/ast_bbbbbbbbbb.provenance.json",
      schema: "guyditor.provenance/v1",
      generatedBy: { tool: "adp_stubgenaaa", version: "1.0.0", job: "job_aaaaaaaaaa" },
    });
  });
});
