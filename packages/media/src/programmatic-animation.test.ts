import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  materializeProgrammaticAnimationArtifact,
  synthesizePromptClip,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("programmatic-animation artifact ingest", () => {
  it("builds a generated asset and exact hashed template provenance", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "guyditor-programmatic-"));
    temporaryDirectories.push(projectRoot);
    const outputPath = join(
      projectRoot,
      "media/programmatic/ast_bbbbbbbbbb.mp4",
    );
    await synthesizePromptClip({
      outputPath,
      prompt: "programmatic artifact fixture",
      seed: 7,
      width: 64,
      height: 36,
      durationFrames: 3,
      fps: "30/1",
    });
    const artifact = await materializeProgrammaticAnimationArtifact({
      projectRoot,
      outputPath,
      assetId: "ast_bbbbbbbbbb",
      template: {
        id: "tpl_d2e3f4g5h6",
        version: "1.0.0",
        contentHash: "a".repeat(64),
      },
      params: { title: "No Camera Needed" },
      seed: 20260723,
      renderer: {
        template: "overlay/v1@1",
        primitives: "primitives/v1@1",
        canvas: "1.0.2",
        toolchainHash: `sha256:${"d".repeat(64)}`,
        fontHashes: {
          "Inconsolata Guyditor": "1561e616c414a1b82d6e6dfbd18e5726fd65028913ade191e5fa38b6ec375a1a",
        },
      },
      expected: {
        frames: 3,
        fps: "30/1",
        width: 64,
        height: 36,
      },
      ingestedAt: "2026-07-23T10:00:00.000Z",
    });

    expect(artifact.asset).toMatchObject({
      id: "ast_bbbbbbbbbb",
      kind: "generated",
      path: "media/programmatic/ast_bbbbbbbbbb.mp4",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      probe: {
        duration: { frames: 3, fps: "30/1" },
        width: 64,
        height: 36,
        fps: "30/1",
      },
      rights: { origin: "programmatic", confirmedBy: "creator" },
      provenance: { sidecar: "programmatic-ast_bbbbbbbbbb" },
    });
    expect(artifact.provenance).toMatchObject({
      assetId: artifact.asset.id,
      params: { title: "No Camera Needed" },
      seed: 20260723,
      contentHash: `sha256:${artifact.asset.sha256}`,
    });
    expect(artifact.sidecar).toMatchObject({
      name: "programmatic-ast_bbbbbbbbbb",
      schema: "guyditor.programmatic-provenance/v1",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(artifact.serialized).toContain(`"contentHash": "sha256:${artifact.asset.sha256}"`);
  });

  it("rejects encoded media that differs from the requested profile geometry", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "guyditor-programmatic-"));
    temporaryDirectories.push(projectRoot);
    const outputPath = join(projectRoot, "wrong.mp4");
    await synthesizePromptClip({
      outputPath,
      prompt: "wrong geometry",
      width: 64,
      height: 36,
      durationFrames: 2,
      fps: "30/1",
    });
    await expect(materializeProgrammaticAnimationArtifact({
      projectRoot,
      outputPath,
      assetId: "ast_bbbbbbbbbb",
      template: {
        id: "tpl_d2e3f4g5h6",
        version: "1.0.0",
        contentHash: "a".repeat(64),
      },
      params: {},
      seed: 1,
      renderer: {
        template: "overlay/v1@1",
        primitives: "primitives/v1@1",
        canvas: "1.0.2",
        toolchainHash: `sha256:${"d".repeat(64)}`,
        fontHashes: {},
      },
      expected: { frames: 2, fps: "30/1", width: 128, height: 72 },
      ingestedAt: "2026-07-23T10:00:00.000Z",
    })).rejects.toMatchObject({ code: "E_PROGRAMMATIC_ARTIFACT_INVALID" });
  });
});
