import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProject,
  OperationEngine,
} from "../../core/src/index.js";
import type { IdPrefix, Result } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { createRefreshProposal } from "./deliverable-service.js";
import type { DeliverableTranscript } from "./deliverable-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const resolved = await result;
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
}

function ids() {
  const ordinals = new Map<IdPrefix, number>();
  const alphabet = ["b", "c", "d", "e", "f", "g", "h", "j", "k", "m"];
  return (prefix: IdPrefix): string => {
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    const offset = prefix === "clp" ? 1 : 0;
    return `${prefix}_${alphabet[ordinal + offset]!.repeat(10)}`;
  };
}

function transcript(): DeliverableTranscript {
  return {
    assetId: "ast_aaaaaaaaaa",
    words: Array.from({ length: 8 }, (_, index) => ({
      id: `w${String(index + 1).padStart(6, "0")}`,
      text: `word${String(index + 1)}`,
      punctAfter: index === 7 ? "." : "",
      state: "active" as const,
      start: { samples: index * 6_000, rate: 48_000 },
      end: { samples: (index + 1) * 6_000, rate: 48_000 },
    })),
  };
}

describe("AC-008 — detect stale derivatives", () => {
  it("marks only an overlapping edit stale and keeps the approved export byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-ac008-"));
    roots.push(root);
    const model = projectFixture();
    model.sequences[0]!.clips[0]!.source.out.frames = 24;
    model.sequences[0]!.clips[1]!.source = {
      in: { frames: 24, fps: "24/1" },
      out: { frames: 48, fps: "24/1" },
    };
    const store = await valueOf(createProject(root, model));
    const idFactory = ids();
    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-test",
      committer: store,
      proposalStore: store,
      idFactory,
      now: () => new Date("2026-07-22T08:00:00Z"),
    });
    const derive = await valueOf(engine.createProposal({
      operations: [{
        op: "deliverable.derive",
        params: {
          kind: "short",
          name: "R",
          profile: "youtube-shorts@1.0.0",
          from: {
            timelineRange: {
              sequenceId: "seq_aaaaaaaaaa",
              start: { frames: 0, fps: "24/1" },
              end: { frames: 12, fps: "24/1" },
            },
          },
          resolvedSources: [{
            assetId: "ast_aaaaaaaaaa",
            range: { start: { frames: 0, fps: "24/1" }, end: { frames: 12, fps: "24/1" } },
            words: { startWordId: "w000001", endWordId: "w000008" },
            longformClipId: "clp_aaaaaaaaaa",
          }],
        },
      }],
      instruction: { kind: "user-text", text: "derive R" },
      actor: { kind: "human", id: "creator" },
      reason: { text: "Create the approved short fixture.", sources: [{ kind: "instruction", ref: "AC-008" }] },
      addresses: [],
    }));
    await valueOf(engine.acceptProposal(derive.id, "creator"));
    const short = store.currentProject.deliverables.find(({ kind }) => kind === "short")!;
    await valueOf(engine.execute([{
      op: "deliverable.status.set",
      params: { deliverableId: short.id, status: "in-review" },
    }], { baseRevision: store.currentProject.revision, origin: "ui", dryRun: false }));
    await valueOf(engine.execute([{
      op: "deliverable.approve",
      params: { deliverableId: short.id },
    }], { baseRevision: store.currentProject.revision, origin: "ui", dryRun: false }));

    const exported = join(root, "approved-short.mp4");
    await writeFile(exported, "approved bytes", "utf8");
    const approvedHash = createHash("sha256").update(await readFile(exported)).digest("hex");

    await valueOf(engine.execute([{
      op: "clip.trim",
      params: { clipId: "clp_aaaaaaaaaa", edge: "head", delta: { frames: 4, fps: "24/1" } },
    }], { baseRevision: store.currentProject.revision, origin: "ui", dryRun: false }));
    const stale = store.currentProject.deliverables.find(({ id }) => id === short.id)!;
    expect(stale).toMatchObject({
      status: "stale",
      staleReasons: [{
        affected: [{
          dependency: { source: { range: { start: { frames: 0 }, end: { frames: 12 } } } },
          change: expect.stringContaining("derivative clip"),
        }],
      }],
    });
    const reasonCount = stale.staleReasons!.length;

    await valueOf(engine.execute([{
      op: "clip.trim",
      params: { clipId: "clp_bbbbbbbbbb", edge: "head", delta: { frames: 4, fps: "24/1" } },
    }], { baseRevision: store.currentProject.revision, origin: "ui", dryRun: false }));
    expect(store.currentProject.deliverables.find(({ id }) => id === short.id)!.staleReasons)
      .toHaveLength(reasonCount);

    const currentTranscript = transcript();
    currentTranscript.words[0]!.state = "deleted";
    const refresh = await valueOf(createRefreshProposal({
      project: store.currentProject,
      transcripts: [currentTranscript],
      deliverableId: short.id,
      history: [],
      createProposal: (request) => engine.createProposal(request),
      attachPreview: async (proposal) => {
        const path = join(root, ".guyditor", "cache", `${proposal.id}.preview.json`);
        await writeFile(path, JSON.stringify({ proposalId: proposal.id }), "utf8");
        return "job_bbbbbbbbbb";
      },
      updateProposal: (proposal) => store.updateProposal(proposal),
    }));
    expect(refresh.previewJobId).toBe("job_bbbbbbbbbb");
    expect(refresh.diff?.entries.length).toBeGreaterThan(0);
    expect(refresh.operations[0]?.op).toBe("deliverable.refresh");
    expect(createHash("sha256").update(await readFile(exported)).digest("hex")).toBe(approvedHash);
  });
});
