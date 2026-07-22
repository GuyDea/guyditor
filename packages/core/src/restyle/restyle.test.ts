import { describe, expect, it } from "vitest";

import {
  OperationEngine,
  applyRestyleOperation,
  parseRestylePlan,
  restylePlanSidecarRef,
  serializeRestylePlan,
} from "../index.js";
import type {
  Asset,
  IdPrefix,
  RestyleGenerationProvenance,
  RestylePlan,
  Result,
  TemplateProvider,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const HASH = "b".repeat(64);

function generatedAsset(id: string, hash = HASH): Asset {
  return {
    id,
    kind: "generated",
    path: `media/generated/${id}.mp4`,
    sha256: hash,
    probe: {
      duration: { frames: 48, fps: "24/1" },
      width: 1920,
      height: 1080,
      fps: "24/1",
    },
    provenance: { sidecar: `provenance-${id}` },
    rights: { origin: "generated", restrictions: [] },
  };
}

function generatedProvenance(id: string, hash = HASH): RestyleGenerationProvenance {
  return {
    schema: "guyditor.provenance/v1",
    assetId: id,
    generation: {
      adapterId: "adp_klingaaaaa",
      adapterVersion: "1.0.0",
      provider: "Kling AI",
      model: "kling-video-o1",
      prompt: "Watercolor documentary",
      settings: {},
      requestId: `restyle-request-${id}`,
      jobId: "job_aaaaaaaaaa",
      referenceAssetIds: ["ast_aaaaaaaaaa"],
      sourceRange: { sequenceId: "seq_aaaaaaaaaa", startFrame: 0, endFrame: 48 },
      createdAt: "2026-07-19T10:00:01.000Z",
      providerMetadata: {},
    },
    rights: { origin: "generated", restrictions: [] },
    contentHash: `sha256:${hash}`,
  };
}

function plan(): RestylePlan {
  return {
    schema: "guyditor.restyle/v1",
    id: "restyle-plan-001",
    deliverableId: "dlv_aaaaaaaaaa",
    sequenceId: "seq_aaaaaaaaaa",
    sourceAssets: [{ assetId: "ast_aaaaaaaaaa", sha256: "a".repeat(64) }],
    adapterId: "adp_klingaaaaa",
    model: "kling-video-o1",
    createdAt: "2026-07-19T10:00:00.000Z",
    coverage: { mode: "full", ranges: [{ startFrame: 0, endFrame: 48 }] },
    constraints: {
      maxSegmentSeconds: 10,
      maxResolution: { width: 1920, height: 1080 },
      fpsSupport: ["24/1"],
      costPerSecond: 0.14,
      concurrency: 2,
    },
    settings: {
      prompt: "Watercolor documentary",
      providerSettings: {},
    },
    chunks: [{
      id: "restyle-chunk-001",
      index: 0,
      sourceRange: { startFrame: 0, endFrame: 48 },
      semanticAnchors: {
        start: "timeline:seq_aaaaaaaaaa@0",
        end: "word:w000001#end",
        boundaryKind: "word-gap",
      },
      durationSeconds: 2,
      estimatedCostUsd: 0.28,
      status: "planned",
    }],
    seams: [],
    estimatedCost: { currency: "USD", amount: 0.28 },
  };
}

function ids(prefix: IdPrefix): string {
  const values: Partial<Record<IdPrefix, string>> = {
    txn: "txn_bbbbbbbbbb",
  };
  return values[prefix] ?? `${prefix}_bbbbbbbbbb`;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

describe("FR-607/608 restyle core contract", () => {
  it("round-trips the versioned plan and builds a content-addressed sidecar reference", () => {
    const source = plan();
    const serialized = serializeRestylePlan(source);

    expect(parseRestylePlan(serialized)).toEqual({ ok: true, value: source });
    expect(restylePlanSidecarRef(source)).toMatchObject({
      name: "restyle-restyle-plan-001",
      path: "sidecars/restyle/restyle-plan-001.json",
      schema: "guyditor.restyle/v1",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      inputs: [{ asset: "ast_aaaaaaaaaa", sha256: "a".repeat(64) }],
    });
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("requires proposal acceptance even for direct UI plan creation", async () => {
    const project = projectFixture();
    const engine = new OperationEngine(project, { idFactory: ids });

    const result = await engine.execute([{
      op: "restyle.plan.create",
      params: { deliverableId: "dlv_aaaaaaaaaa", plan: plan() },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_PROPOSAL_REQUIRED", acceptedStateChanged: false },
    });
  });

  it("dry-runs plan creation as consequential and records coverage on the deliverable", async () => {
    const project = projectFixture();
    const engine = new OperationEngine(project, { idFactory: ids });
    const proposed = plan();
    proposed.seams = [{
      id: "restyle-seam-001",
      frame: 48,
      boundary: "restyled-to-untouched",
      beforeChunkId: "restyle-chunk-001",
      treatment: { kind: "punch-in" },
      status: "planned",
    }];

    const result = await valueOf(engine.execute([{
      op: "restyle.plan.create",
      params: { deliverableId: "dlv_aaaaaaaaaa", plan: proposed },
    }], {
      baseRevision: project.revision,
      origin: "system",
      dryRun: true,
    }));

    expect(result.riskClass).toBe("consequential");
    const application = await applyRestyleOperation(project, {
      op: "restyle.plan.create",
      params: { deliverableId: "dlv_aaaaaaaaaa", plan: proposed },
    });
    expect(application.ok).toBe(true);
    if (!application.ok) throw new Error(application.error.message);
    expect(application.value.model.deliverables[0]!.restyle).toEqual({
      coverageMode: "full",
      planSidecar: "restyle-restyle-plan-001",
    });
    expect(application.value.model.sidecars.at(-1)).toEqual(restylePlanSidecarRef(proposed));
    expect(result.diff.entries).toContainEqual(expect.objectContaining({
      entityId: "restyle-seam-001",
      entityType: "restyle-seam",
      change: "added",
      fields: expect.arrayContaining([expect.objectContaining({
        field: "treatment",
        after: { kind: "punch-in" },
      })]),
    }));
  });

  it("pins and validates every interstitial template when the plan is proposed", async () => {
    const project = projectFixture();
    const source = plan();
    source.seams = [{
      id: "restyle-seam-001",
      frame: 24,
      boundary: "internal",
      beforeChunkId: "restyle-chunk-001",
      afterChunkId: "restyle-chunk-002",
      treatment: {
        kind: "interstitial",
        templateId: "tpl_d2e3f4g5h6",
        params: { title: "Episode" },
        durationFrames: 24,
        resumeExact: true,
      },
      status: "planned",
    }];
    const provider: TemplateProvider = {
      latest: () => ({
        ok: true,
        value: {
          schema: "guyditor/template/v1",
          id: "tpl_d2e3f4g5h6",
          name: "Full-frame infographic",
          kind: "diagram",
          version: "1.0.0",
          engine: "overlay/v1",
          duration: { mode: "fixed", default: { frames: 24, fps: "24/1" } },
          params: {
            type: "object",
            additionalProperties: false,
            required: ["title"],
            properties: { title: { type: "string", minLength: 1 } },
          },
          contentHash: "c".repeat(64),
        },
      }),
      get: () => { throw new Error("unexpected pinned lookup"); },
    };

    const application = await applyRestyleOperation(project, {
      op: "restyle.plan.create",
      params: { deliverableId: source.deliverableId, plan: source },
    }, provider);

    expect(application).toMatchObject({
      ok: true,
      value: {
        model: {
          templates: {
            tpl_d2e3f4g5h6: { version: "1.0.0", contentHash: "c".repeat(64) },
          },
        },
      },
    });

    const originalTreatment = source.seams[0]!.treatment;
    if (originalTreatment.kind !== "interstitial") throw new Error("expected interstitial");
    source.seams[0]!.treatment = { ...originalTreatment, params: {} };
    const invalid = await applyRestyleOperation(project, {
      op: "restyle.plan.create",
      params: { deliverableId: source.deliverableId, plan: source },
    }, provider);
    expect(invalid).toMatchObject({ ok: false, error: { code: "E_TEMPLATE_PARAMS_INVALID" } });
  });

  it("review-gates a per-seam treatment override and exposes its semantic delta", async () => {
    const project = projectFixture();
    const source = plan();
    source.seams = [{
      id: "restyle-seam-001",
      frame: 48,
      boundary: "restyled-to-untouched",
      beforeChunkId: "restyle-chunk-001",
      treatment: { kind: "punch-in" },
      status: "applied",
      application: { chunkId: "restyle-chunk-001", atFrame: 48 },
    }];
    project.deliverables[0]!.restyle = {
      coverageMode: "full",
      planSidecar: "restyle-restyle-plan-001",
    };
    project.sidecars.push(restylePlanSidecarRef(source));
    const engine = new OperationEngine(project, { idFactory: ids });

    const direct = await engine.execute([{
      op: "seam.treatment.set",
      params: {
        deliverableId: "dlv_aaaaaaaaaa",
        plan: source,
        seamId: "restyle-seam-001",
        treatment: { kind: "none" },
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: false });
    expect(direct).toMatchObject({
      ok: false,
      error: { code: "E_OP_PROPOSAL_REQUIRED", acceptedStateChanged: false },
    });

    const dryRun = await valueOf(engine.execute([{
      op: "seam.treatment.set",
      params: {
        deliverableId: "dlv_aaaaaaaaaa",
        plan: source,
        seamId: "restyle-seam-001",
        treatment: { kind: "none" },
      },
    }], { baseRevision: project.revision, origin: "system", dryRun: true }));
    expect(dryRun.diff.entries).toContainEqual(expect.objectContaining({
      entityId: "restyle-seam-001",
      entityType: "restyle-seam",
      change: "modified",
      fields: expect.arrayContaining([
        { field: "treatment", before: { kind: "punch-in" }, after: { kind: "none" } },
        { field: "status", before: "applied", after: "review" },
      ]),
    }));
  });

  it("places an accepted generated asset over the exact source range on a top video layer", async () => {
    const project = projectFixture();
    project.deliverables[0]!.restyle = {
      coverageMode: "full",
      planSidecar: "restyle-restyle-plan-001",
    };
    project.sidecars.push(restylePlanSidecarRef(plan()));
    const approvedPlan = plan();
    approvedPlan.chunks[0]!.status = "approved";
    approvedPlan.chunks[0]!.assetId = "ast_bbbbbbbbbb";
    const engine = new OperationEngine(project, { idFactory: ids });

    const result = await valueOf(engine.execute([{
      op: "restyle.segment.approve",
      params: {
        deliverableId: "dlv_aaaaaaaaaa",
        plan: approvedPlan,
        chunkId: "restyle-chunk-001",
        cachedPath: "/tmp/restyle-candidate.mp4",
        layerId: "lyr_bbbbbbbbbb",
        itemId: "gfx_bbbbbbbbbb",
        asset: {
          id: "ast_bbbbbbbbbb",
          kind: "generated",
          path: "media/generated/ast_bbbbbbbbbb.mp4",
          sha256: HASH,
          probe: {
            duration: { frames: 48, fps: "24/1" },
            width: 1920,
            height: 1080,
            fps: "24/1",
          },
          provenance: { sidecar: "provenance-ast_bbbbbbbbbb" },
          rights: {
            origin: "generated",
            licensor: "Kling AI",
            providerTermsUrl: "https://klingai.com/terms-of-service",
            restrictions: [],
            confirmedBy: "provider",
          },
        },
        provenance: {
          schema: "guyditor.provenance/v1",
          assetId: "ast_bbbbbbbbbb",
          generation: {
            adapterId: "adp_klingaaaaa",
            adapterVersion: "1.0.0",
            provider: "Kling AI",
            model: "kling-video-o1",
            prompt: "Watercolor documentary",
            settings: {},
            seed: 7,
            requestId: "restyle-request-001",
            jobId: "job_aaaaaaaaaa",
            referenceAssetIds: ["ast_aaaaaaaaaa"],
            sourceRange: { sequenceId: "seq_aaaaaaaaaa", startFrame: 0, endFrame: 48 },
            createdAt: "2026-07-19T10:00:01.000Z",
            providerMetadata: { taskId: "stub-restyle-request-001" },
          },
          rights: {
            origin: "generated",
            licensor: "Kling AI",
            providerTermsUrl: "https://klingai.com/terms-of-service",
            restrictions: [],
            confirmedBy: "provider",
          },
          contentHash: `sha256:${HASH}`,
        },
      },
    }], {
      baseRevision: project.revision,
      origin: "system",
      proposalId: "prp_aaaaaaaaaa",
      dryRun: true,
    }));

    expect(result.riskClass).toBe("consequential");
    expect(result.applied[0]).toMatchObject({
      affected: [
        "dlv_aaaaaaaaaa",
        "restyle-chunk-001",
        "ast_bbbbbbbbbb",
        "lyr_bbbbbbbbbb",
        "gfx_bbbbbbbbbb",
      ],
    });
  });

  it("places an applied interstitial seam as a pinned full-frame template instance", async () => {
    const project = projectFixture();
    project.templates = {
      tpl_d2e3f4g5h6: { version: "1.0.0", contentHash: "c".repeat(64) },
    };
    project.deliverables[0]!.restyle = {
      coverageMode: "full",
      planSidecar: "restyle-restyle-plan-001",
    };
    const approvedPlan = plan();
    approvedPlan.chunks[0]!.status = "approved";
    approvedPlan.chunks[0]!.assetId = "ast_bbbbbbbbbb";
    approvedPlan.seams = [{
      id: "restyle-seam-001",
      frame: 48,
      boundary: "restyled-to-untouched",
      beforeChunkId: "restyle-chunk-001",
      treatment: {
        kind: "interstitial",
        templateId: "tpl_d2e3f4g5h6",
        params: {
          title: "Episode title",
          body: "A precise source-resume beat",
          accent: "#77E7C4",
          logoSlot: "brand",
        },
        durationFrames: 24,
        resumeExact: true,
      },
      status: "applied",
      application: {
        chunkId: "restyle-chunk-001",
        atFrame: 48,
        itemId: "gfx_cccccccccc",
      },
    }];

    const application = await applyRestyleOperation(project, {
      op: "restyle.segment.approve",
      params: {
        deliverableId: "dlv_aaaaaaaaaa",
        plan: approvedPlan,
        chunkId: "restyle-chunk-001",
        layerId: "lyr_bbbbbbbbbb",
        itemId: "gfx_bbbbbbbbbb",
        asset: {
          id: "ast_bbbbbbbbbb",
          kind: "generated",
          path: "media/generated/ast_bbbbbbbbbb.mp4",
          sha256: HASH,
          probe: {
            duration: { frames: 48, fps: "24/1" },
            width: 1920,
            height: 1080,
            fps: "24/1",
          },
          provenance: { sidecar: "provenance-ast_bbbbbbbbbb" },
        },
        provenance: {
          schema: "guyditor.provenance/v1",
          assetId: "ast_bbbbbbbbbb",
          generation: {
            adapterId: "adp_klingaaaaa",
            adapterVersion: "1.0.0",
            provider: "Kling AI",
            model: "kling-video-o1",
            prompt: "Watercolor documentary",
            settings: {},
            requestId: "restyle-request-001",
            jobId: "job_aaaaaaaaaa",
            referenceAssetIds: ["ast_aaaaaaaaaa"],
            sourceRange: { sequenceId: "seq_aaaaaaaaaa", startFrame: 0, endFrame: 48 },
            createdAt: "2026-07-19T10:00:01.000Z",
            providerMetadata: {},
          },
          rights: { origin: "generated", restrictions: [] },
          contentHash: `sha256:${HASH}`,
        },
        seamPlacements: [{
          seamId: "restyle-seam-001",
          layerId: "lyr_cccccccccc",
          itemId: "gfx_cccccccccc",
          seed: 609,
        }],
      },
    });

    expect(application.ok).toBe(true);
    if (!application.ok) throw new Error(application.error.message);
    expect(application.value.model.layers.at(-1)).toEqual({
      id: "lyr_cccccccccc",
      kind: "animation",
      name: "Restyle seam · restyle-seam-001",
      order: 2,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_cccccccccc",
        template: "tpl_d2e3f4g5h6",
        at: "timeline:seq_aaaaaaaaaa@48",
        duration: { frames: 24, fps: "24/1" },
        params: approvedPlan.seams[0]!.treatment.kind === "interstitial"
          ? approvedPlan.seams[0]!.treatment.params
          : {},
        seed: 609,
        layout: {
          restyleSeam: {
            planId: "restyle-plan-001",
            seamId: "restyle-seam-001",
            sourceFrame: 48,
            durationFrames: 24,
            resumeExact: true,
          },
        },
      }],
    });
  });

  it("re-evaluates a stale chunk approval by replacing its prior chunk and seam placements", async () => {
    const project = projectFixture();
    project.templates = {
      tpl_d2e3f4g5h6: { version: "1.0.0", contentHash: "c".repeat(64) },
    };
    project.deliverables[0]!.restyle = {
      coverageMode: "full",
      planSidecar: "restyle-restyle-plan-001",
    };
    const approvedPlan = plan();
    approvedPlan.chunks[0]!.status = "approved";
    approvedPlan.chunks[0]!.assetId = "ast_bbbbbbbbbb";
    approvedPlan.seams = [{
      id: "restyle-seam-001",
      frame: 48,
      boundary: "restyled-to-untouched",
      beforeChunkId: "restyle-chunk-001",
      treatment: {
        kind: "interstitial",
        templateId: "tpl_d2e3f4g5h6",
        params: { title: "First placement" },
        durationFrames: 24,
        resumeExact: true,
      },
      status: "applied",
      application: {
        chunkId: "restyle-chunk-001",
        atFrame: 48,
        itemId: "gfx_cccccccccc",
      },
    }];
    const first = await applyRestyleOperation(project, {
      op: "restyle.segment.approve",
      params: {
        deliverableId: approvedPlan.deliverableId,
        plan: approvedPlan,
        chunkId: "restyle-chunk-001",
        layerId: "lyr_bbbbbbbbbb",
        itemId: "gfx_bbbbbbbbbb",
        asset: generatedAsset("ast_bbbbbbbbbb"),
        provenance: generatedProvenance("ast_bbbbbbbbbb"),
        seamPlacements: [{
          seamId: "restyle-seam-001",
          layerId: "lyr_cccccccccc",
          itemId: "gfx_cccccccccc",
          seed: 609,
        }],
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;

    const reapprovedPlan = structuredClone(approvedPlan);
    reapprovedPlan.chunks[0]!.assetId = "ast_dddddddddd";
    reapprovedPlan.seams[0]!.application = {
      chunkId: "restyle-chunk-001",
      atFrame: 48,
      itemId: "gfx_eeeeeeeeee",
    };
    const second = await applyRestyleOperation(first.value.model, {
      op: "restyle.segment.approve",
      params: {
        deliverableId: reapprovedPlan.deliverableId,
        plan: reapprovedPlan,
        chunkId: "restyle-chunk-001",
        layerId: "lyr_dddddddddd",
        itemId: "gfx_dddddddddd",
        asset: generatedAsset("ast_dddddddddd", "d".repeat(64)),
        provenance: generatedProvenance("ast_dddddddddd", "d".repeat(64)),
        seamPlacements: [{
          seamId: "restyle-seam-001",
          layerId: "lyr_eeeeeeeeee",
          itemId: "gfx_eeeeeeeeee",
          seed: 610,
        }],
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;
    const restyleItems = second.value.model.layers.flatMap(({ items }) => items ?? [])
      .filter((item) => {
        const metadata = item.params?.["restyle"];
        return typeof metadata === "object" && metadata !== null &&
          (metadata as Record<string, unknown>)["chunkId"] === "restyle-chunk-001";
      });
    const seamItems = second.value.model.layers.flatMap(({ items }) => items ?? [])
      .filter((item) => {
        const metadata = item.layout?.["restyleSeam"];
        return typeof metadata === "object" && metadata !== null &&
          (metadata as Record<string, unknown>)["seamId"] === "restyle-seam-001";
      });
    expect(restyleItems.map(({ id }) => id)).toEqual(["gfx_dddddddddd"]);
    expect(seamItems.map(({ id }) => id)).toEqual(["gfx_eeeeeeeeee"]);
  });
});
