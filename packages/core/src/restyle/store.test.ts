import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationEngine,
  createProject,
  parseRestylePlan,
} from "../index.js";
import type {
  Asset,
  IdPrefix,
  Proposal,
  RestyleGenerationProvenance,
  RestylePlan,
  Result,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const roots: string[] = [];
const NOW = new Date("2026-07-19T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-restyle-store-"));
  roots.push(root);
  return root;
}

function ids(): (prefix: IdPrefix) => string {
  const ordinals = new Map<IdPrefix, number>();
  return (prefix) => {
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    const character = String.fromCharCode("a".charCodeAt(0) + ordinal);
    return `${prefix}_${character.repeat(10)}`;
  };
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function planned(): RestylePlan {
  return {
    schema: "guyditor.restyle/v1",
    id: "restyle-plan-store-001",
    deliverableId: "dlv_aaaaaaaaaa",
    sequenceId: "seq_aaaaaaaaaa",
    sourceAssets: [{ assetId: "ast_aaaaaaaaaa", sha256: "a".repeat(64) }],
    adapterId: "adp_klingaaaaa",
    model: "kling-video-o1",
    createdAt: NOW.toISOString(),
    coverage: { mode: "ranges", ranges: [{ startFrame: 0, endFrame: 20 }] },
    constraints: {
      maxSegmentSeconds: 10,
      maxResolution: { width: 1920, height: 1080 },
      fpsSupport: ["24/1"],
      costPerSecond: 0.14,
      concurrency: 1,
    },
    settings: { prompt: "Watercolor documentary", seed: 7, providerSettings: {} },
    chunks: [{
      id: "restyle-chunk-store-001",
      index: 0,
      sourceRange: { startFrame: 0, endFrame: 20 },
      semanticAnchors: {
        start: "timeline:seq_aaaaaaaaaa@0",
        end: "timeline:seq_aaaaaaaaaa@20",
        boundaryKind: "range-edge",
      },
      durationSeconds: 0.833333,
      estimatedCostUsd: 0.116667,
      status: "planned",
    }],
    seams: [{
      id: "restyle-seam-store-001",
      frame: 20,
      boundary: "restyled-to-untouched",
      beforeChunkId: "restyle-chunk-store-001",
      treatment: { kind: "punch-in" },
      status: "applied",
      application: { chunkId: "restyle-chunk-store-001", atFrame: 20 },
    }],
    estimatedCost: { currency: "USD", amount: 0.116667 },
  };
}

async function propose(
  engine: OperationEngine,
  operations: Array<{ op: string; params: Record<string, unknown> }>,
): Promise<Proposal> {
  return valueOf(engine.createProposal({
    operations,
    instruction: { kind: "user-text", text: "Restyle this deliverable" },
    actor: { kind: "agent", id: "ses_aaaaaaaaaa", model: "test-agent" },
    sessionId: "ses_aaaaaaaaaa",
    reason: {
      text: "Apply the creator-reviewed segmented restyle plan.",
      sources: [{ kind: "instruction", ref: "Restyle this deliverable" }],
    },
    addresses: [],
  }));
}

describe("restyle acceptance materialization", () => {
  it("writes the accepted plan, freezes a generated asset and provenance, then marks overlap stale", async () => {
    const root = await temporaryRoot();
    const store = await valueOf(createProject(root, projectFixture(), {
      idFactory: () => "txn_aaaaaaaaaa",
      now: () => NOW,
    }));
    const engine = new OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: store,
      idFactory: ids(),
      now: () => NOW,
    });
    const sourcePlan = planned();
    const planProposal = await propose(engine, [{
      op: "restyle.plan.create",
      params: { deliverableId: sourcePlan.deliverableId, plan: sourcePlan },
    }]);
    await valueOf(engine.acceptProposal(planProposal.id, "creator"));

    const sidecarPath = join(root, "sidecars/restyle/restyle-plan-store-001.json");
    const persistedPlan = parseRestylePlan(await readFile(sidecarPath, "utf8"));
    expect(persistedPlan).toEqual({ ok: true, value: sourcePlan });
    expect(store.currentProject.deliverables[0]!.restyle).toEqual({
      coverageMode: "ranges",
      planSidecar: "restyle-restyle-plan-store-001",
    });

    const candidate = Buffer.from("deterministic-restyle-video-candidate");
    const candidatePath = join(root, ".guyditor/cache/generations/job_aaaaaaaaaa/0.mp4");
    await mkdir(join(root, ".guyditor/cache/generations/job_aaaaaaaaaa"), {
      recursive: true,
    });
    await writeFile(candidatePath, candidate);
    const contentHash = createHash("sha256").update(candidate).digest("hex");
    const asset: Asset = {
      id: "ast_bbbbbbbbbb",
      kind: "generated",
      path: "media/generated/ast_bbbbbbbbbb.mp4",
      sha256: contentHash,
      bytes: candidate.byteLength,
      container: "mp4",
      probe: {
        duration: { frames: 20, fps: "24/1" },
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
    };
    const approvedPlan = structuredClone(sourcePlan);
    approvedPlan.chunks[0]!.status = "approved";
    approvedPlan.chunks[0]!.assetId = asset.id;
    approvedPlan.chunks[0]!.jobId = "job_aaaaaaaaaa";
    approvedPlan.chunks[0]!.providerJobId = "stub-restyle-store-001";
    const provenance: RestyleGenerationProvenance = {
      schema: "guyditor.provenance/v1",
      assetId: asset.id,
      generation: {
        adapterId: "adp_klingaaaaa",
        adapterVersion: "1.0.0",
        provider: "Kling AI",
        model: "kling-video-o1",
        prompt: sourcePlan.settings.prompt,
        settings: {},
        seed: 7,
        requestId: "restyle-request-store-001",
        jobId: "job_aaaaaaaaaa",
        referenceAssetIds: ["ast_aaaaaaaaaa"],
        sourceRange: { sequenceId: "seq_aaaaaaaaaa", startFrame: 0, endFrame: 20 },
        createdAt: "2026-07-19T10:00:01.000Z",
        providerMetadata: { taskId: "stub-restyle-store-001" },
      },
      rights: asset.rights!,
      contentHash: `sha256:${contentHash}`,
    };
    const approval = await propose(engine, [{
      op: "restyle.segment.approve",
      params: {
        deliverableId: sourcePlan.deliverableId,
        plan: approvedPlan,
        chunkId: approvedPlan.chunks[0]!.id,
        cachedPath: candidatePath,
        layerId: "lyr_bbbbbbbbbb",
        itemId: "gfx_bbbbbbbbbb",
        asset,
        provenance,
      },
    }]);
    await valueOf(engine.acceptProposal(approval.id, "creator"));

    const frozenPath = join(root, asset.path);
    await expect(readFile(frozenPath)).resolves.toEqual(candidate);
    expect((await stat(frozenPath)).mode & 0o222).toBe(0);
    const provenanceText = await readFile(
      join(root, `sidecars/provenance/${asset.id}.provenance.json`),
      "utf8",
    );
    expect(JSON.parse(provenanceText) as RestyleGenerationProvenance).toEqual(provenance);
    expect(store.currentProject.assets.at(-1)).toEqual(asset);
    const approvedPlanHash = store.currentProject.sidecars.find(({ name }) =>
      name === "restyle-restyle-plan-store-001")!.sha256;

    const nonOverlappingTrim = await engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_bbbbbbbbbb",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
      },
    }], {
      baseRevision: store.currentProject.revision,
      origin: "ui",
      dryRun: false,
    });
    expect(nonOverlappingTrim.ok).toBe(true);
    const stillFresh = parseRestylePlan(await readFile(sidecarPath, "utf8"));
    expect(stillFresh.ok).toBe(true);
    if (!stillFresh.ok) throw new Error(stillFresh.error.message);
    expect(stillFresh.value.chunks[0]!.status).toBe("approved");
    expect(store.currentProject.sidecars.find(({ name }) =>
      name === "restyle-restyle-plan-store-001")?.sha256).toBe(approvedPlanHash);

    const trim = await engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
      },
    }], {
      baseRevision: store.currentProject.revision,
      origin: "ui",
      dryRun: false,
    });
    expect(trim.ok).toBe(true);

    const stale = parseRestylePlan(await readFile(sidecarPath, "utf8"));
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error(stale.error.message);
    expect(stale.value.chunks[0]).toMatchObject({
      status: "stale",
      stale: {
        reason: "source-range-overlap",
        transactionId: expect.stringMatching(/^txn_/),
        markedAt: NOW.toISOString(),
      },
    });
    expect(stale.value.seams[0]).toMatchObject({
      status: "review",
      review: {
        reason: "adjacent-chunk-stale",
        transactionId: expect.stringMatching(/^txn_/),
        markedAt: NOW.toISOString(),
      },
    });
    expect(store.currentProject.sidecars.find(({ name }) =>
      name === "restyle-restyle-plan-store-001")?.sha256).not.toBe(approvedPlanHash);
  });
});
