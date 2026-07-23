import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
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
  createGenerationReview,
  createProject,
} from "../index.js";
import type {
  Asset,
  GenerationProvenance,
  GenerationReviewAnnotation,
  IdPrefix,
  Proposal,
  Result,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const roots: string[] = [];
const NOW = new Date("2026-07-23T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

function ids(): (prefix: IdPrefix) => string {
  const ordinals = new Map<IdPrefix, number>();
  return (prefix) => {
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    return `${prefix}_${String.fromCharCode(97 + ordinal).repeat(10)}`;
  };
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function completedReview(): GenerationReviewAnnotation {
  const review = createGenerationReview({
    annotationId: "ann_aaaaaaaaaa",
    candidateId: "job_aaaaaaaaaa/0",
    createdAt: NOW.toISOString(),
  });
  return {
    ...review,
    state: "resolved",
    resolvedAt: "2026-07-23T10:05:00.000Z",
    checklist: {
      ...review.checklist,
      items: review.checklist.items.map((item) => ({
        ...item,
        state: "pass",
        note: "Checked by creator.",
      })),
    },
  };
}

async function proposal(
  engine: OperationEngine,
  params: Record<string, unknown>,
): Promise<Proposal> {
  return valueOf(engine.createProposal({
    operations: [{ op: "generation.accept", params }],
    instruction: { kind: "user-text", text: "Accept this B-roll candidate" },
    actor: { kind: "agent", id: "ses_aaaaaaaaaa", model: "test-agent" },
    sessionId: "ses_aaaaaaaaaa",
    reason: {
      text: "Freeze the creator-reviewed candidate.",
      sources: [{ kind: "annotation", ref: "ann_aaaaaaaaaa" }],
    },
    addresses: [],
  }));
}

describe("FR-605 generation freeze transaction", () => {
  it("rehashes, freezes read-only media, and persists provenance plus review atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-generation-store-"));
    roots.push(root);
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
    const candidateDirectory = join(root, ".guyditor/cache/generations/job_aaaaaaaaaa");
    const candidatePath = join(candidateDirectory, "candidate-0.mp4");
    const candidate = Buffer.from("deterministic-generation-candidate");
    await mkdir(candidateDirectory, { recursive: true });
    await writeFile(candidatePath, candidate);
    const hash = createHash("sha256").update(candidate).digest("hex");
    const rights = {
      origin: "generated" as const,
      licensor: "Guyditor deterministic stub",
      providerTermsUrl: "https://stub.guyditor.invalid/terms",
      restrictions: [],
      confirmedBy: "provider" as const,
    };
    const asset: Asset = {
      id: "ast_bbbbbbbbbb",
      kind: "generated",
      path: "media/generated/ast_bbbbbbbbbb.mp4",
      sha256: hash,
      bytes: candidate.byteLength,
      probe: { duration: { frames: 24, fps: "24/1" }, fps: "24/1" },
      provenance: { sidecar: "provenance-ast_bbbbbbbbbb" },
      rights,
    };
    const provenance: GenerationProvenance = {
      schema: "guyditor.provenance/v1",
      assetId: asset.id,
      generation: {
        adapterId: "adp_stubgenaaa",
        adapterVersion: "1.0.0",
        provider: "Guyditor deterministic stub",
        model: "ffmpeg-synth-v1",
        prompt: "Cobalt glass sculpture",
        settings: { width: 1280, height: 720, durationFrames: 24, fps: "24/1" },
        settingsSchemaHash: `sha256:${"d".repeat(64)}`,
        seed: 12,
        requestId: "01K0GENERATIONREQUEST",
        jobId: "job_aaaaaaaaaa",
        referenceAssetIds: [],
        createdAt: NOW.toISOString(),
        providerMetadata: { synthesizer: "lavfi" },
      },
      rights,
      reviewAnnotationId: "ann_aaaaaaaaaa",
      contentHash: `sha256:${hash}`,
    };
    const review = completedReview();
    const accepted = await proposal(engine, {
      cachedPath: candidatePath,
      asset,
      provenance,
      review,
      placement: {
        sequenceId: "seq_aaaaaaaaaa",
        layerId: "lyr_bbbbbbbbbb",
        itemId: "gfx_bbbbbbbbbb",
        atFrame: 24,
        durationFrames: 24,
      },
    });

    await valueOf(engine.acceptProposal(accepted.id, "creator"));

    const frozenPath = join(root, asset.path);
    await expect(readFile(frozenPath)).resolves.toEqual(candidate);
    expect((await stat(frozenPath)).mode & 0o222).toBe(0);
    expect(JSON.parse(await readFile(
      join(root, "sidecars/provenance/ast_bbbbbbbbbb.provenance.json"),
      "utf8",
    ))).toEqual(provenance);
    expect(JSON.parse(await readFile(
      join(root, "sidecars/generation-reviews/ann_aaaaaaaaaa.json"),
      "utf8",
    ))).toEqual(review);
    expect(store.currentProject.layers.at(-1)?.items?.[0]?.asset).toBe(asset.id);
  });

  it("aborts without project changes when candidate bytes drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-generation-drift-"));
    roots.push(root);
    const store = await valueOf(createProject(root, projectFixture(), { now: () => NOW }));
    const engine = new OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: store,
      idFactory: ids(),
      now: () => NOW,
    });
    const candidateDirectory = join(root, ".guyditor/cache/generations/job_aaaaaaaaaa");
    const candidatePath = join(candidateDirectory, "candidate-0.mp4");
    await mkdir(candidateDirectory, { recursive: true });
    await writeFile(candidatePath, "changed bytes");
    const fakeHash = "c".repeat(64);
    const rights = {
      origin: "generated" as const,
      providerTermsUrl: "https://stub.guyditor.invalid/terms",
      restrictions: [],
      confirmedBy: "provider" as const,
    };
    const asset: Asset = {
      id: "ast_bbbbbbbbbb",
      kind: "generated",
      path: "media/generated/ast_bbbbbbbbbb.mp4",
      sha256: fakeHash,
      probe: {},
      provenance: { sidecar: "provenance-ast_bbbbbbbbbb" },
      rights,
    };
    const provenance: GenerationProvenance = {
      schema: "guyditor.provenance/v1",
      assetId: asset.id,
      generation: {
        adapterId: "adp_stubgenaaa",
        adapterVersion: "1.0.0",
        provider: "stub",
        model: "ffmpeg-synth-v1",
        prompt: "drift test",
        settings: {},
        settingsSchemaHash: `sha256:${"d".repeat(64)}`,
        requestId: "01K0GENERATIONREQUEST",
        jobId: "job_aaaaaaaaaa",
        referenceAssetIds: [],
        createdAt: NOW.toISOString(),
        providerMetadata: {},
      },
      rights,
      reviewAnnotationId: "ann_aaaaaaaaaa",
      contentHash: `sha256:${fakeHash}`,
    };
    const accepted = await proposal(engine, {
      cachedPath: candidatePath,
      asset,
      provenance,
      review: completedReview(),
      placement: {
        sequenceId: "seq_aaaaaaaaaa",
        layerId: "lyr_bbbbbbbbbb",
        itemId: "gfx_bbbbbbbbbb",
        atFrame: 0,
        durationFrames: 24,
      },
    });

    await expect(engine.acceptProposal(accepted.id, "creator")).resolves.toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_COMMIT" },
    });
    expect(store.currentProject.assets.some(({ id }) => id === asset.id)).toBe(false);
    await expect(readFile(join(root, asset.path))).rejects.toThrow();
  });
});
