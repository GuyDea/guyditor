import { describe, expect, it } from "vitest";

import { OperationEngine } from "./index.js";
import type { Asset, OperationInput } from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

function ingestedAsset(id: string, hashCharacter: string): Asset {
  return {
    id,
    kind: "audio",
    path: `media/${id}.wav`,
    sha256: hashCharacter.repeat(64),
    bytes: 48_000,
    container: "wav",
    probe: {
      duration: { samples: 24_000, rate: 48_000 },
      audio: { rate: 48_000, channels: 1 },
    },
    audio: [{
      index: 0,
      codec: "pcm_s16le",
      sampleRate: 48_000,
      channels: 1,
      layout: "mono",
    }],
    integrity: "ok",
    ingest: {
      at: "2026-07-18T10:00:00.000Z",
      ffprobeVersion: "ffprobe version test",
      via: "manual",
    },
  };
}

function systemContext(baseRevision: string) {
  return {
    baseRevision,
    dryRun: false,
    origin: "system" as const,
  };
}

describe("asset operation catalog", () => {
  it("ingests a full batch in one normal-risk operation with an asset.remove inverse", async () => {
    const engine = new OperationEngine(projectFixture(), {
      idFactory: (prefix) => `${prefix}_cccccccccc`,
      now: () => new Date("2026-07-18T10:00:00.000Z"),
    });
    const assets = [
      ingestedAsset("ast_bbbbbbbbbb", "b"),
      ingestedAsset("ast_cccccccccc", "c"),
    ];

    const result = await engine.execute([{
      op: "asset.ingest",
      params: { assets },
    }], systemContext("rev_00001"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        riskClass: "normal",
        applied: [{
          op: "asset.ingest",
          summary: "Ingest 2 assets",
          affected: ["ast_bbbbbbbbbb", "ast_cccccccccc"],
          inverse: [{
            op: "asset.remove",
            params: { assetIds: ["ast_bbbbbbbbbb", "ast_cccccccccc"] },
          }],
        }],
      },
    });
    expect(engine.currentProject.revision).toBe("rev_00002");
    expect(engine.currentProject.assets.slice(-2)).toEqual(assets);
  });

  it("upserts duplicate asset records so known paths are journaled without a second asset", async () => {
    const project = projectFixture();
    const existing = structuredClone(project.assets[0]!);
    existing.knownPaths = ["/captures/a.mov"];
    const engine = new OperationEngine(project);

    const result = await engine.execute([{
      op: "asset.ingest",
      params: { assets: [existing] },
    }], systemContext("rev_00001"));

    expect(result.ok).toBe(true);
    expect(engine.currentProject.assets).toHaveLength(1);
    expect(engine.currentProject.assets[0]?.knownPaths).toEqual(["/captures/a.mov"]);
  });

  it("rejects two asset IDs with the same hash in one ingest batch", async () => {
    const engine = new OperationEngine(projectFixture());

    const result = await engine.execute([{
      op: "asset.ingest",
      params: {
        assets: [
          ingestedAsset("ast_bbbbbbbbbb", "b"),
          ingestedAsset("ast_cccccccccc", "b"),
        ],
      },
    }], systemContext("rev_00001"));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_OP_ASSET_CONFLICT",
        affected: expect.arrayContaining(["ast_bbbbbbbbbb", "ast_cccccccccc"]),
      },
    });
  });

  it("removes unreferenced assets and refuses assets used by clips or placed items", async () => {
    const project = projectFixture();
    project.assets.push(ingestedAsset("ast_bbbbbbbbbb", "b"));
    const engine = new OperationEngine(project);

    const removed = await engine.execute([{
      op: "asset.remove",
      params: { assetIds: ["ast_bbbbbbbbbb"] },
    }], systemContext("rev_00001"));
    expect(removed).toMatchObject({
      ok: true,
      value: {
        applied: [{
          op: "asset.remove",
          inverse: [{
            op: "asset.ingest",
            params: { assets: [expect.objectContaining({ id: "ast_bbbbbbbbbb" })] },
          }],
        }],
      },
    });
    expect(engine.currentProject.assets.map(({ id }) => id))
      .toEqual(["ast_aaaaaaaaaa"]);

    const inUseEngine = new OperationEngine(projectFixture());
    const requested: OperationInput = {
      op: "asset.remove",
      params: { assetIds: ["ast_aaaaaaaaaa"] },
    };
    await expect(inUseEngine.execute(
      [requested],
      systemContext("rev_00001"),
    )).resolves.toMatchObject({
      ok: false,
      error: {
        code: "E_OP_ASSET_IN_USE",
        affected: expect.arrayContaining(["ast_aaaaaaaaaa"]),
      },
    });
  });

  it("changes rights only through the journaled asset.rights.set operation", async () => {
    const project = projectFixture();
    const engine = new OperationEngine(project);
    const rights = {
      origin: "licensed" as const,
      licenseName: "Envato Standard",
      licensor: "Example contributor",
      purchaseRef: "invoice-1001",
      restrictions: ["single-project"],
      confirmedBy: "creator" as const,
      confirmedAt: "2026-07-23T10:00:00.000Z",
    };

    const result = await engine.execute([{
      op: "asset.rights.set",
      params: { assetId: "ast_aaaaaaaaaa", rights },
    }], systemContext(project.revision));

    expect(result).toMatchObject({
      ok: true,
      value: {
        riskClass: "normal",
        applied: [{
          op: "asset.rights.set",
          inverse: [{
            op: "asset.rights.set",
            params: { assetId: "ast_aaaaaaaaaa", rights: null },
          }],
        }],
      },
    });
    expect(engine.currentProject.assets[0]?.rights).toEqual(rights);
  });
});
