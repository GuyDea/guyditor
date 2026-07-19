import { describe, expect, it } from "vitest";

import { OperationEngine } from "./engine.js";
import { projectFixture } from "../project/test-fixtures.js";

describe("jump-cut concealment operations", () => {
  it("sets an exact static punch-in with a reversible semantic operation", async () => {
    const project = projectFixture();
    const engine = new OperationEngine(project);
    const result = await engine.execute([{
      op: "clip.punchin.set",
      params: {
        clipId: "clp_bbbbbbbbbb",
        level: 1.12,
        anchor: { x: 0.48, y: 0.42 },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.applied[0]).toMatchObject({
      op: "clip.punchin.set",
      inverse: [{
        op: "clip.punchin.set",
        params: { clipId: "clp_bbbbbbbbbb", level: null, anchor: null },
      }],
      affected: ["clp_bbbbbbbbbb"],
    });
    expect(result.value.diff.entries[0]).toMatchObject({
      entityId: "clp_bbbbbbbbbb",
      entityType: "clip",
      change: "modified",
      fields: [{ field: "punchIn", after: { level: 1.12, anchor: { x: 0.48, y: 0.42 } } }],
    });
  });

  it("switches only to a synchronized alternate while preserving source time", async () => {
    const project = projectFixture();
    project.assets.push({
      ...structuredClone(project.assets[0]!),
      id: "ast_bbbbbbbbbb",
      path: "media/b.mov",
      sha256: "b".repeat(64),
      sync: {
        referenceAssetId: "ast_aaaaaaaaaa",
        method: "manual",
        offset: { samples: 0, rate: 48_000 },
        evidence: {},
        decidedBy: "creator",
        decidedAt: "2026-07-19T10:00:00Z",
      },
    });
    const engine = new OperationEngine(project);
    const switched = await engine.execute([{
      op: "clip.source.switch",
      params: {
        clipId: "clp_bbbbbbbbbb",
        assetId: "ast_bbbbbbbbbb",
        synchronizedTo: "ast_aaaaaaaaaa",
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: true });
    expect(switched).toMatchObject({
      ok: true,
      value: {
        applied: [{
          inverse: [{
            op: "clip.source.switch",
            params: {
              clipId: "clp_bbbbbbbbbb",
              assetId: "ast_aaaaaaaaaa",
              synchronizedTo: "ast_bbbbbbbbbb",
            },
          }],
        }],
      },
    });

    delete project.assets[1]!.sync;
    const rejected = await new OperationEngine(project).execute([{
      op: "clip.source.switch",
      params: {
        clipId: "clp_bbbbbbbbbb",
        assetId: "ast_bbbbbbbbbb",
        synchronizedTo: "ast_aaaaaaaaaa",
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: true });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "E_OP_SOURCE_NOT_SYNCHRONIZED", acceptedStateChanged: false },
    });
  });
});
