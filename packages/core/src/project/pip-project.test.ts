import { describe, expect, it } from "vitest";

import { OperationEngine } from "../operations/engine.js";
import { storedAnchors } from "../anchors/index.js";
import { canonicalizeYaml } from "./canonical.js";
import type {
  AvoidRegion,
  PipConfig,
} from "./model.js";
import { projectFixture } from "./test-fixtures.js";
import { validateProject } from "./validate.js";

const pip: PipConfig = {
  style: {
    mask: { shape: "rounded", cornerRadius: 0.08, featherPx: 1 },
    border: { widthPx: 4, color: "#FFFFFF", opacity: 0.9 },
    shadow: { dx: 0, dy: 8, blurPx: 24, color: "#000000", opacity: 0.35 },
    background: { color: "#14202B", blurSigma: 8, padPx: 12 },
    deviceFrame: { templateId: "tpl_aaaaaaaaaa", params: { bezel: "dark" } },
  },
  placement: {
    base: { anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9" },
  },
  keyframes: [{
    id: "kfr_aaaaaaaaaa",
    at: "word:w000123",
    placement: { anchor: "bottom_left", width: "24%", margin: "4%" },
    style: { border: { widthPx: 2, color: "#FFFFFF", opacity: 1 } },
    transition: {
      preset: "pre_pipsmoothm",
      durationFrames: 18,
      params: { direction: "left" },
    },
  }],
  avoid: {
    enabled: true,
    sources: ["caption", "marked", "safe_area"],
    softOverlapMax: 0.15,
    holdFrames: 60,
    fallbackAnchors: ["bottom_right", "bottom_left", "top_left", "top_right"],
    moveTransition: { preset: "pre_pipsmoothm", durationFrames: 18 },
  },
};

const marked: AvoidRegion = {
  id: "avr_aaaaaaaaaa",
  source: "marked",
  hardness: "hard",
  rect: { x: 0.38, y: 0.42, w: 0.24, h: 0.18 },
  frames: { from: 30, to: 90 },
  fromAnnotation: "ann_aaaaaaaaaa",
};

function pinDeviceFrame(project: ReturnType<typeof projectFixture>): void {
  project.templates = {
    "tpl_aaaaaaaaaa": { version: "1.0.0", contentHash: "1".repeat(64) },
  };
}

describe("canonical PiP project model", () => {
  it("round-trips sparse constraints, semantic anchors, styles, and avoid regions", () => {
    const project = projectFixture();
    pinDeviceFrame(project);
    project.layers[0]!.pip = structuredClone(pip);
    project.avoidRegions = [structuredClone(marked)];
    project.presets.push({
      id: "pre_pipsmoothm",
      name: "pip-smooth-move",
      kind: "motion",
      version: 1,
      path: "builtin:pip-smooth-move@1",
      sha256: "1".repeat(64),
    });

    const valid = validateProject(project);
    expect(valid.ok).toBe(true);
    const yaml = canonicalizeYaml(project);
    expect(yaml).toContain("at: word:w000123");
    expect(yaml).toContain("preset: pre_pipsmoothm");
    expect(yaml).toContain("width: 24%");
    expect(yaml).not.toMatch(/atOutputFrame|coordinates|rects:/u);
  });

  it("rejects PiP on non-visual layer kinds", () => {
    const project = projectFixture();
    pinDeviceFrame(project);
    project.presets.push({
      id: "pre_pipsmoothm", name: "pip-smooth-move", kind: "motion", version: 1,
      path: "builtin:pip-smooth-move@1", sha256: "1".repeat(64),
    });
    project.layers[0]!.kind = "audio";
    project.layers[0]!.pip = structuredClone(pip);
    expect(validateProject(project)).toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_INVARIANT", affected: ["lyr_aaaaaaaaaa"] },
    });
  });

  it("rejects malformed constraint values and unpinned motion presets", () => {
    const malformed = projectFixture();
    pinDeviceFrame(malformed);
    malformed.layers[0]!.pip = structuredClone(pip);
    malformed.layers[0]!.pip!.placement.base.width = "twenty four";
    expect(validateProject(malformed).ok).toBe(false);

    const unpinned = projectFixture();
    pinDeviceFrame(unpinned);
    unpinned.layers[0]!.pip = structuredClone(pip);
    expect(validateProject(unpinned)).toMatchObject({
      ok: false,
      error: {
        code: "E_PROJECT_INVARIANT",
        affected: ["kfr_aaaaaaaaaa", "pre_pipsmoothm"],
      },
    });
  });

  it("registers the exact Part 6 PiP and region operation names", async () => {
    const names = [
      "pip.style.set",
      "pip.place",
      "pip.keyframe.add",
      "pip.keyframe.remove",
      "pip.preset.apply",
      "pip.avoid.solve",
      "region.mark",
    ];
    for (const op of names) {
      const project = projectFixture();
      const engine = new OperationEngine(project);
      const result = await engine.execute([{ op, params: {} }], {
        baseRevision: project.revision,
        origin: "ui",
        dryRun: true,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "E_OP_SCHEMA" },
      });
    }
  });

  it("registers PiP keyframe anchors and keyframe IDs with core bookkeeping", () => {
    const project = projectFixture();
    pinDeviceFrame(project);
    project.presets.push({
      id: "pre_pipsmoothm", name: "pip-smooth-move", kind: "motion", version: 1,
      path: "builtin:pip-smooth-move@1", sha256: "1".repeat(64),
    });
    project.layers[0]!.pip = structuredClone(pip);
    expect(storedAnchors(project)).toContainEqual(expect.objectContaining({
      owner: "kfr_aaaaaaaaaa",
      anchor: "word:w000123",
      anchorPath: "/at",
      modelPath: "/layers/lyr_aaaaaaaaaa/pip/keyframes/kfr_aaaaaaaaaa/at",
    }));

    project.layers[0]!.pip!.keyframes.push({
      ...structuredClone(pip.keyframes[0]!),
    });
    expect(validateProject(project)).toMatchObject({
      ok: false, error: { code: "E_PROJECT_INVARIANT", affected: ["kfr_aaaaaaaaaa"] },
    });
  });
});
