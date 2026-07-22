import { describe, expect, it } from "vitest";

import type { GuyditorProject } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import type { SubjectTrackAnalysis } from "../../media/src/index.js";
import { loadPlatformProfile } from "./profile.js";
import {
  deriveFramingSidecar,
  parseFramingSidecar,
  serializeFramingSidecar,
} from "./framing.js";

const builtinsRoot = new URL("../../../profiles/", import.meta.url);

function shortProject(layerCount = 1): GuyditorProject {
  const project = projectFixture();
  project.assets[0]!.video = {
    codec: "h264", width: 1920, height: 1080, fps: "24/1",
    pixFmt: "yuv420p", hasAlpha: false, rotation: 0,
  };
  project.sequences.push({
    id: "seq_bbbbbbbbbb",
    name: "Short",
    clips: [{
      id: "clp_cccccccccc",
      asset: "ast_aaaaaaaaaa",
      source: { in: { frames: 0, fps: "24/1" }, out: { frames: 120, fps: "24/1" } },
    }],
  });
  project.layers.push(...Array.from({ length: layerCount }, (_, index) => ({
    id: index === 0 ? "lyr_bbbbbbbbbb" : "lyr_cccccccccc",
    kind: "video" as const,
    name: index === 0 ? "Presenter" : "Screen",
    order: index + 1,
    enabled: true,
    locked: false,
    sequence: "seq_bbbbbbbbbb",
    ...(index === 0 ? {
      pip: {
        style: { mask: { shape: "rounded" as const } },
        placement: {
          base: { anchor: "bottom_right" as const, width: "24%", margin: "4%" },
          overrides: { "9:16": { anchor: "top" as const, width: "46%", margin_y: "6%" } },
        },
        keyframes: [],
      },
    } : {}),
  })) as GuyditorProject["layers"]);
  project.deliverables.push({
    id: "dlv_bbbbbbbbbb",
    kind: "short",
    name: "Short",
    profile: "youtube-shorts@1.0.0",
    sequenceId: "seq_bbbbbbbbbb",
    status: "draft",
    dependencies: [{
      derivativeClipId: "clp_cccccccccc",
      source: {
        assetId: "ast_aaaaaaaaaa",
        range: { start: { frames: 0, fps: "24/1" }, end: { frames: 120, fps: "24/1" } },
      },
    }],
  });
  return project;
}

function tracking(): SubjectTrackAnalysis {
  return {
    format: "guyditor.analysis/v1",
    kind: "subject.track",
    assetId: "ast_aaaaaaaaaa",
    sourceHash: "a".repeat(64),
    params: { sampleEvery: 3 },
    toolVersions: { mediapipe: "0.10.35" },
    createdAt: "2026-07-22T10:00:00.000Z",
    data: {
      frameCount: 120, width: 1920, height: 1080, fps: 24, sampleEvery: 3,
      samples: Array.from({ length: 40 }, (_, index) => ({
        frame: index * 3,
        boxes: [{
          kind: "face" as const,
          trackId: "trk_face0001",
          x: 0.15 + index * 0.005,
          y: 0.2,
          w: 0.12,
          h: 0.22,
          conf: 0.9,
        }],
      })),
    },
  };
}

describe("guyditor.framing/v1", () => {
  it("splits at scene boundaries and emits byte-deterministic per-shot crop decisions", async () => {
    const profile = (await loadPlatformProfile("youtube-shorts@1.0.0", { builtinsRoot })).profile;
    const request = {
      project: shortProject(),
      deliverableId: "dlv_bbbbbbbbbb",
      profile,
      tracking: { ast_aaaaaaaaaa: tracking() },
      sceneBoundaries: { ast_aaaaaaaaaa: [60] },
    };
    const first = deriveFramingSidecar(request);
    const second = deriveFramingSidecar(request);
    expect(second).toEqual(first);
    expect(serializeFramingSidecar(second)).toBe(serializeFramingSidecar(first));
    expect(parseFramingSidecar(serializeFramingSidecar(first))).toEqual(first);
    expect(first.decisions).toHaveLength(2);
    expect(first.decisions).toEqual([
      expect.objectContaining({ decisionId: "fd_0001", mode: "crop", subjects: ["trk_face0001"] }),
      expect.objectContaining({ decisionId: "fd_0002", mode: "crop", subjects: ["trk_face0001"] }),
    ]);
    expect(first.decisions.every((decision) => (decision.crop?.keyframes.length ?? 0) >= 1)).toBe(true);
  });

  it("chooses responsive layer recomposition for independently movable layers", async () => {
    const profile = (await loadPlatformProfile("tiktok@1.0.0", { builtinsRoot })).profile;
    const sidecar = deriveFramingSidecar({
      project: shortProject(2), deliverableId: "dlv_bbbbbbbbbb", profile,
      tracking: { ast_aaaaaaaaaa: tracking() }, sceneBoundaries: {},
    });
    expect(sidecar.decisions).toEqual([
      expect.objectContaining({
        mode: "recompose",
        layout: "tiktok:9:16",
      }),
    ]);
    expect(sidecar.requiredTrackAssets).toEqual([]);
  });

  it("retains an overridden unchanged decision across re-derivation", async () => {
    const profile = (await loadPlatformProfile("youtube-shorts@1.0.0", { builtinsRoot })).profile;
    const project = shortProject();
    const first = deriveFramingSidecar({
      project, deliverableId: "dlv_bbbbbbbbbb", profile,
      tracking: { ast_aaaaaaaaaa: tracking() }, sceneBoundaries: {},
    });
    project.deliverables.at(-1)!.framingOverrides = [{
      id: "fov_aaaaaaaaaa",
      decisionId: "fd_0001",
      crop: { keyframes: [{
        at: { frames: 0, fps: "24/1" },
        rect: { x: 0.3, y: 0, w: 0.31640625, h: 1 },
      }] },
    }];
    const rerun = deriveFramingSidecar({
      project, deliverableId: "dlv_bbbbbbbbbb", profile,
      tracking: { ast_aaaaaaaaaa: tracking() }, sceneBoundaries: {}, previous: first,
    });
    expect(rerun.decisions[0]).toEqual({
      ...first.decisions[0],
      overriddenBy: "fov_aaaaaaaaaa",
    });
  });
});
