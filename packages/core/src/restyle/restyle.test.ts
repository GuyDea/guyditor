import { describe, expect, it } from "vitest";

import {
  OperationEngine,
  applyRestyleOperation,
  parseRestylePlan,
  restylePlanSidecarRef,
  serializeRestylePlan,
} from "../index.js";
import type {
  IdPrefix,
  RestylePlan,
  Result,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const HASH = "b".repeat(64);

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

    const result = await valueOf(engine.execute([{
      op: "restyle.plan.create",
      params: { deliverableId: "dlv_aaaaaaaaaa", plan: plan() },
    }], {
      baseRevision: project.revision,
      origin: "system",
      dryRun: true,
    }));

    expect(result.riskClass).toBe("consequential");
    const application = applyRestyleOperation(project, {
      op: "restyle.plan.create",
      params: { deliverableId: "dlv_aaaaaaaaaa", plan: plan() },
    });
    expect(application.ok).toBe(true);
    if (!application.ok) throw new Error(application.error.message);
    expect(application.value.model.deliverables[0]!.restyle).toEqual({
      coverageMode: "full",
      planSidecar: "restyle-restyle-plan-001",
    });
    expect(application.value.model.sidecars.at(-1)).toEqual(restylePlanSidecarRef(plan()));
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
});
