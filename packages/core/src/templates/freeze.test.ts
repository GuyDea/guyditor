import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  applyTemplateFreezeOperation,
  deriveTimeline,
  OperationEngine,
  serializeProgrammaticAnimationProvenance,
  success,
} from "../index.js";
import type {
  Asset,
  ProgrammaticAnimationProvenance,
  SidecarRef,
  TemplateDescriptor,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const CONTENT_HASH = "a".repeat(64);
const ASSET_HASH = "b".repeat(64);
const TEMPLATE_ID = "tpl_d2e3f4g5h6";

function descriptor(): TemplateDescriptor {
  return {
    schema: "guyditor/template/v1",
    id: TEMPLATE_ID,
    name: "Full-frame infographic",
    kind: "diagram",
    version: "1.0.0",
    engine: "overlay/v1",
    duration: { mode: "fixed", default: { frames: 150, fps: "30/1" } },
    params: { type: "object" },
    contentHash: CONTENT_HASH,
  };
}

function asset(): Asset {
  return {
    id: "ast_bbbbbbbbbb",
    kind: "generated",
    path: "media/programmatic/ast_bbbbbbbbbb.mp4",
    sha256: ASSET_HASH,
    bytes: 1234,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    probe: {
      duration: { frames: 150, fps: "30/1" },
      width: 640,
      height: 360,
      fps: "30/1",
    },
    video: {
      codec: "h264",
      width: 640,
      height: 360,
      fps: "30/1",
      pixFmt: "yuv420p",
      hasAlpha: false,
      rotation: 0,
    },
    ingest: {
      at: "2026-07-23T10:00:00.000Z",
      ffprobeVersion: "fixture",
      via: "generated",
    },
    provenance: { sidecar: "programmatic-ast_bbbbbbbbbb" },
    rights: {
      origin: "programmatic",
      restrictions: [],
      confirmedBy: "creator",
    },
  };
}

function provenance(): ProgrammaticAnimationProvenance {
  return {
    schema: "guyditor.programmatic-provenance/v1",
    assetId: "ast_bbbbbbbbbb",
    template: {
      id: TEMPLATE_ID,
      version: "1.0.0",
      contentHash: CONTENT_HASH,
    },
    params: {
      title: "No Camera Needed",
      body: "Start with deterministic graphics.",
      accent: "#77E7C4",
      logoSlot: "none",
    },
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
    output: {
      frames: 150,
      fps: "30/1",
      width: 640,
      height: 360,
    },
    rights: asset().rights!,
    contentHash: `sha256:${ASSET_HASH}`,
  };
}

function sidecar(): SidecarRef {
  const serialized = serializeProgrammaticAnimationProvenance(provenance());
  return {
    name: "programmatic-ast_bbbbbbbbbb",
    path: "sidecars/programmatic/ast_bbbbbbbbbb.json",
    schema: "guyditor.programmatic-provenance/v1",
    sha256: createHash("sha256").update(serialized).digest("hex"),
    generatedBy: {
      tool: TEMPLATE_ID,
      version: "1.0.0",
    },
    inputs: [],
  };
}

function operation(placeAsClip: boolean) {
  return {
    op: "template.freeze",
    params: {
      asset: asset(),
      provenance: provenance(),
      sidecar: sidecar(),
      ...(placeAsClip
        ? {
            placement: {
              sequenceId: "seq_aaaaaaaaaa",
              layerId: "lyr_aaaaaaaaaa",
              clipId: "clp_bbbbbbbbbb",
              index: 0,
            },
          }
        : {}),
    },
  };
}

function emptyProject() {
  const project = projectFixture();
  project.assets = [];
  project.settings.timeline.fps = "30/1";
  project.sequences = project.sequences.map((sequence) => ({ ...sequence, clips: [] }));
  project.sidecars = project.sidecars.map((sidecar) => ({ ...sidecar, inputs: [] }));
  return project;
}

describe("template.freeze semantic operation", () => {
  it("registers a frozen programmatic asset without requiring placement", async () => {
    const result = await applyTemplateFreezeOperation(
      emptyProject(),
      operation(false),
      {
        latest: () => success(descriptor()),
        get: () => success(descriptor()),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model.assets).toEqual([asset()]);
    expect(result.value.model.sidecars.at(-1)).toEqual(sidecar());
    expect(result.value.model.sequences[0]?.clips).toEqual([]);
  });

  it("places the first real clip and establishes exact empty-sequence duration", async () => {
    const project = emptyProject();
    const engine = new OperationEngine(project, {
      templateProvider: {
        latest: () => success(descriptor()),
        get: () => success(descriptor()),
      },
    });
    const frozen = await engine.execute([operation(true)], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });
    if (!frozen.ok) {
      throw new Error(`${frozen.error.code}: ${frozen.error.message}`);
    }
    expect(frozen.ok).toBe(true);
    expect(frozen.value.riskClass).toBe("normal");
    expect(engine.currentProject.sequences[0]?.clips).toEqual([{
      id: "clp_bbbbbbbbbb",
      asset: "ast_bbbbbbbbbb",
      origin: "local",
      source: {
        in: { frames: 0, fps: "30/1" },
        out: { frames: 150, fps: "30/1" },
      },
    }]);
    const timeline = deriveTimeline(engine.currentProject, "seq_aaaaaaaaaa");
    expect(timeline).toMatchObject({
      ok: true,
      value: {
        duration: "5/1",
        clips: [{
          clipId: "clp_bbbbbbbbbb",
          start: { frames: 0, fps: "30/1" },
          duration: { frames: 150, fps: "30/1" },
        }],
      },
    });
  });

  it("fails closed when provenance does not pin the frozen bytes", async () => {
    const invalid = operation(false);
    (invalid.params.provenance as ProgrammaticAnimationProvenance).contentHash =
      `sha256:${"e".repeat(64)}`;
    await expect(applyTemplateFreezeOperation(
      emptyProject(),
      invalid,
      {
        latest: () => success(descriptor()),
        get: () => success(descriptor()),
      },
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "E_TEMPLATE_FREEZE_PROVENANCE_INVALID" },
    });
  });

  it("blocks an unreviewed authored template before a frozen asset can enter accepted state", async () => {
    await expect(applyTemplateFreezeOperation(
      emptyProject(),
      operation(false),
      {
        latest: () => success({ ...descriptor(), reviewState: "draft" }),
        get: () => success({ ...descriptor(), reviewState: "draft" }),
      },
    )).resolves.toMatchObject({
      ok: false,
      error: {
        code: "E_TEMPLATE_UNREVIEWED",
        acceptedStateChanged: false,
      },
    });
  });
});
