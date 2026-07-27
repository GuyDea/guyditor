import { describe, expect, it } from "vitest";

import {
  JobQueue,
  ProjectStore,
} from "../../core/src/index.js";
import type { GuyditorProject } from "../../core/src/index.js";
import {
  compileRenderGraph,
  VIRTUAL_GAP_ASSET,
  validateRenderGraph,
} from "./graph.js";
import { RenderService } from "./service.js";
import type {
  RenderGraph,
  RenderProfile,
  ToolchainManifest,
  TrimNodeParams,
} from "./index.js";
import type { FramingSidecar } from "../../deliver/src/index.js";

const HASH = "a".repeat(64);

const PROFILE: RenderProfile = {
  id: "youtube-longform",
  version: "1.0.0",
  video: { codec: "libx264", crf: 18, pixelFormat: "yuv420p" },
  audio: { codec: "aac", bitrate: "192k" },
  container: "mp4",
};

const SHORT_PROFILE: RenderProfile = {
  id: "youtube-shorts",
  version: "1.0.0",
  kind: "short",
  video: {
    codec: "libx264",
    crf: 18,
    pixelFormat: "yuv420p",
    resolution: { width: 1080, height: 1920 },
    fps: "30/1",
    aspect: "9:16",
  },
  audio: { codec: "aac", bitrate: "256k" },
  container: "mp4",
};

const TOOLCHAIN: ToolchainManifest = {
  ffmpeg: { version: "ffmpeg test", buildSha256: HASH },
  ffprobe: { version: "ffprobe test", buildSha256: HASH },
  renderPackage: "0.0.0",
  overlayRenderer: {
    version: "not-used-m0",
    canvasVersion: "not-used-m0",
    fontHashes: {},
  },
  encoderThreads: 1,
  os: "linux",
};

function project(): GuyditorProject {
  return {
    format: "guyditor/v1",
    revision: "rev_00002",
    project: {
      id: "prj_aaaaaaaaaa",
      name: "Render graph",
      created: "2026-07-18T10:00:00Z",
    },
    settings: {
      timeline: { fps: "30/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: 1 },
    assets: [
      {
        id: "ast_aaaaaaaaaa",
        kind: "video",
        path: "/tmp/bars.mp4",
        sha256: HASH,
        probe: {
          duration: { frames: 300, fps: "30/1" },
          fps: "30/1",
          audio: { rate: 48_000, channels: 1 },
        },
        audio: [{
          index: 1,
          codec: "aac",
          sampleRate: 48_000,
          channels: 1,
          layout: "mono",
        }],
      },
      {
        id: "ast_bbbbbbbbbb",
        kind: "video",
        path: "/tmp/screencast.mp4",
        sha256: HASH,
        probe: { duration: { frames: 450, fps: "30/1" }, fps: "30/1" },
      },
    ],
    beats: [],
    sequences: [{
      id: "seq_aaaaaaaaaa",
      name: "main",
      clips: [
        {
          id: "clp_aaaaaaaaaa",
          asset: "ast_aaaaaaaaaa",
          source: {
            in: { frames: 0, fps: "30/1" },
            out: { frames: 120, fps: "30/1" },
          },
        },
        {
          id: "clp_bbbbbbbbbb",
          asset: "ast_bbbbbbbbbb",
          source: {
            in: { frames: 225, fps: "30/1" },
            out: { frames: 345, fps: "30/1" },
          },
          effects: [{
            id: "fx_aaaaaaaaaa",
            kind: "speed",
            params: { rate: "2/1" },
          }],
          gapBefore: { frames: 30, fps: "30/1" },
        },
      ],
    }],
    layers: [{
      id: "lyr_aaaaaaaaaa",
      kind: "video",
      name: "main",
      order: 0,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    }],
    captions: [],
    annotations: {
      sidecar: "annotations",
      summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 },
    },
    deliverables: [{
      id: "dlv_aaaaaaaaaa",
      kind: "longform",
      name: "master",
      profile: "youtube-longform@1.0.0",
      sequenceId: "seq_aaaaaaaaaa",
      status: "draft",
    }],
    presets: [],
    skills: [],
    sidecars: [{
      name: "annotations",
      path: "sidecars/annotations.json",
      schema: "guyditor.annotations/v1",
      sha256: HASH,
      inputs: [],
    }],
  };
}

function compile(
  model = project(),
  quality: "proxy" | "high" = "high",
  variant: "burnin" | "clean" = "clean",
  captionOverlays: Array<{ overlayAssetPath: string; overlaySha256: string; atOutputFrame: number; durationFrames: number }> = [],
  graphicOverlays: Array<{ overlayAssetPath: string; overlaySha256: string; atOutputFrame: number; durationFrames: number }> = [],
) {
  return compileRenderGraph({
    project: model,
    revision: model.revision,
    deliverableId: "dlv_aaaaaaaaaa",
    variant,
    quality,
    profile: PROFILE,
    profileSha256: HASH,
    toolchain: TOOLCHAIN,
    overlays: captionOverlays,
    graphicOverlays,
  });
}

describe("compileRenderGraph", () => {
  it("lowers shot crops into the vertical profile canvas", () => {
    const model = project();
    model.deliverables[0] = {
      ...model.deliverables[0]!,
      kind: "short",
      profile: "youtube-shorts@1.0.0",
    };
    const framing: FramingSidecar = {
      format: "guyditor.framing/v1",
      deliverableId: "dlv_aaaaaaaaaa",
      profile: "youtube-shorts@1.0.0",
      sourceRevision: model.revision,
      aspect: "9:16",
      requiredTrackAssets: [],
      decisions: [{
        decisionId: "fd_0001",
        shot: {
          clipId: "clp_aaaaaaaaaa",
          source: {
            start: { frames: 0, fps: "30/1" },
            end: { frames: 120, fps: "30/1" },
          },
        },
        mode: "crop",
        crop: { keyframes: [
          { at: { frames: 0, fps: "30/1" }, rect: { x: 0.2, y: 0, w: 0.31640625, h: 1 } },
          { at: { frames: 60, fps: "30/1" }, rect: { x: 0.3, y: 0, w: 0.31640625, h: 1 } },
        ] },
        subjects: ["face-1"],
        confidence: 0.9,
        warnings: [],
      }],
    };

    const graph = compileRenderGraph({
      project: model, revision: model.revision, deliverableId: "dlv_aaaaaaaaaa",
      variant: "clean", quality: "high", profile: SHORT_PROFILE, profileSha256: HASH,
      toolchain: TOOLCHAIN, framing,
    });

    expect(graph.outputSize).toEqual({ w: 1080, h: 1920 });
    const framed = graph.nodes.find(({ kind, params }) =>
      kind === "transform" && "framingDecisionId" in params);
    expect(framed?.params).toMatchObject({
      layerId: "lyr_aaaaaaaaaa",
      framingDecisionId: "fd_0001",
      keyframes: [
        { atOutputFrame: 0, crop: [0.2, 0.341796875, 0.31640625, 0.31640625] },
        { atOutputFrame: 60, crop: [0.3, 0.341796875, 0.31640625, 0.31640625] },
      ],
    });
  });

  it("accepts a derived framing sidecar after a manual override advances the revision", () => {
    const model = project();
    const derivedRevision = model.revision;
    model.revision = "rev_00003";
    model.deliverables[0] = {
      ...model.deliverables[0]!,
      kind: "short",
      profile: "youtube-shorts@1.0.0",
      framingOverrides: [{
        id: "fov_aaaaaaaaaa",
        decisionId: "fd_0001",
        crop: {
          keyframes: [{
            at: { frames: 0, fps: "30/1" },
            rect: { x: 0.4, y: 0, w: 0.31640625, h: 1 },
          }],
        },
      }],
    };
    const framing: FramingSidecar = {
      format: "guyditor.framing/v1",
      deliverableId: "dlv_aaaaaaaaaa",
      profile: "youtube-shorts@1.0.0",
      sourceRevision: derivedRevision,
      aspect: "9:16",
      requiredTrackAssets: [],
      decisions: [{
        decisionId: "fd_0001",
        shot: {
          clipId: "clp_aaaaaaaaaa",
          source: {
            start: { frames: 0, fps: "30/1" },
            end: { frames: 120, fps: "30/1" },
          },
        },
        mode: "crop",
        crop: { keyframes: [{
          at: { frames: 0, fps: "30/1" },
          rect: { x: 0.2, y: 0, w: 0.31640625, h: 1 },
        }] },
        subjects: ["face-1"],
        confidence: 0.9,
        warnings: [],
      }],
    };

    const graph = compileRenderGraph({
      project: model, revision: model.revision, deliverableId: "dlv_aaaaaaaaaa",
      variant: "clean", quality: "high", profile: SHORT_PROFILE, profileSha256: HASH,
      toolchain: TOOLCHAIN, framing,
    });
    const framed = graph.nodes.find(({ kind, params }) =>
      kind === "transform" && "framingDecisionId" in params);

    expect(framed?.params).toMatchObject({
      keyframes: [{
        atOutputFrame: 0,
        crop: [0.4, 0.341796875, 0.31640625, 0.31640625],
      }],
    });
  });

  it("recomposes multi-layer vertical projects with layer-level transforms", () => {
    const model = project();
    model.deliverables[0] = {
      ...model.deliverables[0]!,
      kind: "short",
      profile: "youtube-shorts@1.0.0",
    };
    model.layers.push({
      ...structuredClone(model.layers[0]!),
      id: "lyr_bbbbbbbbbb",
      name: "presenter",
      order: 1,
    });
    const framing: FramingSidecar = {
      format: "guyditor.framing/v1",
      deliverableId: "dlv_aaaaaaaaaa",
      profile: "youtube-shorts@1.0.0",
      sourceRevision: model.revision,
      aspect: "9:16",
      requiredTrackAssets: [],
      decisions: [{
        decisionId: "fd_0001",
        shot: {
          clipId: "clp_aaaaaaaaaa",
          source: {
            start: { frames: 0, fps: "30/1" },
            end: { frames: 120, fps: "30/1" },
          },
        },
        mode: "recompose",
        layout: "youtube-shorts:portrait",
        subjects: ["face-1"],
        confidence: 0.9,
        warnings: [],
      }],
    };

    const graph = compileRenderGraph({
      project: model, revision: model.revision, deliverableId: "dlv_aaaaaaaaaa",
      variant: "clean", quality: "high", profile: SHORT_PROFILE, profileSha256: HASH,
      toolchain: TOOLCHAIN, framing,
    });
    const framingTransforms = graph.nodes.filter(({ kind, params }) =>
      kind === "transform" && "framingDecisionId" in params);

    expect(framingTransforms).toHaveLength(2);
    expect(framingTransforms.map(({ params }) =>
      "layerId" in params ? params.layerId : undefined)).toEqual([
      "lyr_aaaaaaaaaa", "lyr_bbbbbbbbbb",
    ]);
    expect(framingTransforms.every(({ params }) =>
      "keyframes" in params && params.keyframes.every(({ crop }) => crop === undefined))).toBe(true);
  });

  it("lowers a static punch-in level to a normalized crop and restoring scale", () => {
    const model = project();
    model.sequences[0]!.clips[0]!.punchIn = {
      level: 1.25,
      anchor: { x: 0.4, y: 0.6 },
    };

    const graph = compile(model);
    const transform = graph.nodes.find(({ kind }) => kind === "transform");
    expect(transform).toMatchObject({
      kind: "transform",
      params: {
        interpolation: "linear",
        keyframes: [{
          atOutputFrame: 0,
          crop: [0, 0.2, 0.8, 0.8],
          scale: 1.25,
          pos: [0.5, 0.5],
          anchor: [0.5, 0.5],
        }],
      },
    });
  });

  it("derives semantic PiP keyframes into transform samples without storing coordinates", () => {
    const model = project();
    model.presets.push({
      id: "pre_pipsmoothm", name: "pip-smooth-move", kind: "motion", version: 1,
      path: "builtin:pip-smooth-move@1", sha256: "6".repeat(64),
    });
    model.layers[0]!.pip = {
      style: {
        mask: { shape: "rounded", cornerRadius: 0.08 },
        border: { widthPx: 4, color: "#FFFFFF", opacity: 0.9 },
        shadow: { dx: 0, dy: 8, blurPx: 24, color: "#000000", opacity: 0.35 },
      },
      placement: { base: { anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9" } },
      keyframes: [{
        id: "kfr_aaaaaaaaaa", at: "word:w000123",
        placement: { anchor: "bottom_left", width: "24%", margin: "4%", aspect: "16:9" },
        transition: { preset: "pre_pipsmoothm", durationFrames: 18 },
      }],
    };
    const rendered = compileRenderGraph({
      project: model, revision: model.revision, deliverableId: "dlv_aaaaaaaaaa",
      variant: "clean", quality: "high", profile: PROFILE, profileSha256: HASH,
      toolchain: TOOLCHAIN, anchorFrames: { "word:w000123": 90 },
    });
    const transform = rendered.nodes.find(({ kind }) => kind === "transform" &&
      "keyframes" in rendered.nodes.find(({ kind }) => kind === "transform")!.params);
    if (transform === undefined || !("keyframes" in transform.params)) {
      throw new Error("missing PiP transform");
    }
    expect(transform.params.keyframes.map(({ atOutputFrame }) => atOutputFrame)).toEqual([
      0, 72, 75, 78, 81, 84, 87, 90,
    ]);
    const firstScale = transform.params.keyframes[0]!.scale;
    expect(Array.isArray(firstScale) ? firstScale[0] : firstScale).toBeCloseTo(0.24);
    expect(transform.params.keyframes.at(-1)!.pos?.[0]).toBeCloseTo(0.16);
    expect(rendered.nodes.some(({ kind }) => kind === "pip")).toBe(true);
  });

  it("emits only the M0 node subset with ordered gap slots and exact speed", () => {
    const graph = compile();
    const kinds = new Set(graph.nodes.map((node) => node.kind));

    expect(kinds).toEqual(new Set([
      "source",
      "trim",
      "composite",
      "audiochain",
      "encode",
    ]));
    const composite = graph.nodes.find((node) => node.kind === "composite");
    const audiochain = graph.nodes.find((node) => node.kind === "audiochain");
    expect(composite?.inputs).toHaveLength(3);
    expect(audiochain?.inputs).toHaveLength(3);
    expect(graph.nodes.filter((node) => node.kind === "encode")).toHaveLength(1);

    const speedTrim = graph.nodes.find((node) =>
      node.kind === "trim" &&
      (node.params as TrimNodeParams).speed?.num === 2
    );
    expect(speedTrim?.params).toMatchObject({ speed: { num: 2, den: 1 } });
  });

  it("rejects proxy quality with the owning Part 3 in the error", () => {
    expect(() => compile(project(), "proxy")).toThrow(
      expect.objectContaining({
        code: "E_RENDER_UNSUPPORTED",
        message: expect.stringMatching(/proxy.*Part 3/i),
      }),
    );
  });

  it("compiles transitions and multiple video layers into layer timelines", () => {
    const withTransition = project();
    withTransition.sequences[0]!.clips[0]!.transitionAfter = {
      id: "trn_aaaaaaaaaa",
      preset: "hard-cut",
      duration: { frames: 5, fps: "30/1" },
    };
    delete withTransition.sequences[0]!.clips[1]!.gapBefore;
    expect(() => compile(withTransition)).not.toThrow();

    const withLayers = project();
    withLayers.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "video",
      name: "second",
      order: 1,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    });
    const graph = compile(withLayers);
    expect(graph.nodes.filter(({ kind }) => kind === "composite").length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    {
      feature: "overlap",
      part: "Part 5",
      change: (model: GuyditorProject) => {
        model.sequences[0]!.clips[1]!.overlapPrevious = { frames: 5, fps: "30/1" };
        delete model.sequences[0]!.clips[1]!.gapBefore;
      },
    },
    {
      feature: "freeze",
      part: "Part 6",
      change: (model: GuyditorProject) => {
        model.sequences[0]!.clips[0]!.effects = [{
          id: "fx_bbbbbbbbbb",
          kind: "freeze",
          params: { hold: { frames: 5, fps: "30/1" } },
        }];
      },
    },
  ])("rejects $feature with $part ownership", ({ feature, part, change }) => {
    const model = project();
    change(model);
    expect(() => compile(model)).toThrow(expect.objectContaining({
      code: "E_RENDER_UNSUPPORTED",
      message: expect.stringMatching(new RegExp(`${feature}.*${part}`, "iu")),
    }));
  });

  it("orders video and still layers with static transforms and a chroma key", () => {
    const model = project();
    model.assets.push({
      id: "ast_cccccccccc",
      kind: "image",
      path: "/tmp/foreground.png",
      sha256: HASH,
      probe: { width: 1920, height: 1080 },
      image: { width: 1920, height: 1080, hasAlpha: true },
    });
    model.sequences[0]!.clips[0]!.effects = [
      {
        id: "fx_bbbbbbbbbb",
        kind: "key",
        params: {
          schema: "guyditor/key@1",
          mode: "chroma",
          chroma: {
            keyColor: "#1FBF3A",
            tolerance: 0.35,
            softness: 0.12,
            preBlur: 1.5,
            edge: { erodePx: 1, featherPx: 2 },
            spill: { mode: "despill", strength: 0.6 },
          },
          masks: [],
        },
      },
      {
        id: "fx_cccccccccc",
        kind: "transform",
        params: {
          crop: { l: 0.05, t: 0.05, r: 0.05, b: 0.05 },
          scale: 0.8,
          position: { x: 0.5, y: 0.5 },
          rotationDeg: 2,
          opacity: 0.9,
        },
      },
    ];
    model.layers[0]!.name = "background";
    model.layers.push(
      {
        id: "lyr_bbbbbbbbbb",
        kind: "video",
        name: "presenter",
        order: 10,
        enabled: true,
        locked: false,
        sequence: "seq_aaaaaaaaaa",
        opacity: 0.8,
        blend: "screen",
        transform: {
          anchor: { x: 0.5, y: 0.5 },
          position: { x: 0.5, y: 0.5 },
          scale: { x: 0.75, y: 0.75 },
          rotationDeg: 0,
        },
      },
      {
        id: "lyr_cccccccccc",
        kind: "image",
        name: "foreground",
        order: 20,
        enabled: true,
        locked: false,
        items: [{
          id: "clp_cccccccccc",
          asset: "ast_cccccccccc",
          at: "timeline:seq_aaaaaaaaaa@0",
          duration: { frames: 150, fps: "30/1" },
        }],
      },
    );

    const graph = compile(model);
    expect(graph.nodes.some(({ kind }) => kind === "key")).toBe(true);
    expect(graph.nodes.filter(({ kind }) => kind === "transform")).toHaveLength(3);
    const composites = graph.nodes.filter(({ kind }) => kind === "composite");
    expect(composites.at(-1)?.params).toMatchObject({
      mode: "stack",
      inputSettings: [
        { layerId: "lyr_aaaaaaaaaa", blend: "normal", opacity: 1 },
        { layerId: "lyr_bbbbbbbbbb", blend: "screen", opacity: 0.8 },
        { layerId: "lyr_cccccccccc", blend: "normal", opacity: 1 },
      ],
    });
    expect(graph.nodes.some(({ kind, params }) =>
      kind === "source" && "still" in params && params.still === true)).toBe(true);
  });

  it("emits image2 caption overlays only for the burnin variant", () => {
    const model = project();
    model.deliverables[0]!.captionsTrackId = "cts_aaaaaaaaaa";
    model.captions.push({
      id: "cts_aaaaaaaaaa",
      name: "captions",
      sourceLayerIds: ["lyr_aaaaaaaaaa"],
      preset: { presetId: "pre_aaaaaaaaaa", version: 1 },
      styleOverrides: {},
      breakOverrides: [],
      emphasisOverrides: [],
      timingOffsets: [],
      enabled: true,
    });
    model.presets.push({ id: "pre_aaaaaaaaaa", name: "captions", kind: "caption", version: 1, path: "presets/pre_aaaaaaaaaa@1.yaml", sha256: HASH });
    const overlay = { overlayAssetPath: "/tmp/captions/%08d.png", overlaySha256: HASH, atOutputFrame: 12, durationFrames: 45 };

    expect(compile(model, "high", "clean", [overlay]).nodes.some(({ kind }) => kind === "overlay")).toBe(false);
    const burnin = compile(model, "high", "burnin", [overlay]);
    expect(burnin.nodes.find(({ kind }) => kind === "overlay")).toMatchObject({ params: overlay });
    expect(burnin.nodes.at(-1)?.inputs[0]).toBe(burnin.nodes.find(({ kind }) => kind === "overlay")?.id);
  });

  it("emits deliberate graphics overlays in clean and burnin variants", () => {
    const graphic = {
      overlayAssetPath: "/tmp/graphics/%08d.png",
      overlaySha256: HASH,
      atOutputFrame: 30,
      durationFrames: 90,
    };

    expect(compile(project(), "high", "clean", [], [graphic]).nodes
      .find(({ kind }) => kind === "overlay")?.params).toEqual(graphic);
    expect(compile(project(), "high", "burnin", [], [graphic]).nodes
      .find(({ kind }) => kind === "overlay")?.params).toEqual(graphic);
  });

  it("renders a frozen restyle asset only over its source range while retaining source audio", () => {
    const model = project();
    model.assets.push({
      id: "ast_cccccccccc",
      kind: "generated",
      path: "/tmp/restyled.mp4",
      sha256: "c".repeat(64),
      probe: { duration: { frames: 30, fps: "30/1" }, fps: "30/1" },
      provenance: { sidecar: "provenance-ast_cccccccccc" },
      rights: { origin: "generated", restrictions: [], confirmedBy: "provider" },
    });
    model.layers.push({
      id: "lyr_cccccccccc",
      kind: "video",
      name: "AI restyle · 1",
      order: 10,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_cccccccccc",
        asset: "ast_cccccccccc",
        at: "timeline:seq_aaaaaaaaaa@30",
        duration: { frames: 30, fps: "30/1" },
        source: {
          in: { frames: 0, fps: "30/1" },
          out: { frames: 30, fps: "30/1" },
        },
        params: {
          restyle: {
            planId: "restyle-plan-render",
            chunkId: "restyle-chunk-001",
            sourceRange: { startFrame: 30, endFrame: 60 },
          },
        },
      }],
    });

    const graph = compile(model, "high", "burnin");
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      kind: "source",
      params: expect.objectContaining({ assetId: "ast_cccccccccc", stream: "video" }),
    }));
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      kind: "source",
      params: expect.objectContaining({ assetId: "ast_aaaaaaaaaa", stream: "audio" }),
    }));
    const anchored = graph.nodes.find(({ kind, params }) =>
      kind === "composite" && "mode" in params && params.mode === "timeline.anchored");
    expect(anchored?.params).toMatchObject({
      inputSettings: [{ atOutputFrame: 30, durationFrames: 30 }],
    });

    model.layers.at(-1)!.items![0]!.duration = { frames: 29, fps: "30/1" };
    expect(() => compile(model)).toThrow(expect.objectContaining({
      code: "E_RENDER_GRAPH_INVALID",
      message: expect.stringMatching(/restyle.*source range/iu),
    }));
  });

  it("inserts an exact-resume interstitial and shifts source-anchored restyle footage", () => {
    const model = project();
    model.assets.push({
      id: "ast_cccccccccc",
      kind: "generated",
      path: "/tmp/restyled.mp4",
      sha256: "c".repeat(64),
      probe: { duration: { frames: 30, fps: "30/1" }, fps: "30/1" },
      provenance: { sidecar: "provenance-ast_cccccccccc" },
      rights: { origin: "generated", restrictions: [] },
    });
    model.layers.push(
      {
        id: "lyr_bbbbbbbbbb",
        kind: "video",
        name: "AI restyle · 2",
        order: 10,
        enabled: true,
        locked: false,
        items: [{
          id: "gfx_bbbbbbbbbb",
          asset: "ast_cccccccccc",
          at: "timeline:seq_aaaaaaaaaa@30",
          duration: { frames: 30, fps: "30/1" },
          source: {
            in: { frames: 0, fps: "30/1" },
            out: { frames: 30, fps: "30/1" },
          },
          params: {
            restyle: {
              planId: "restyle-plan-render",
              chunkId: "restyle-chunk-002",
              sourceRange: { startFrame: 30, endFrame: 60 },
            },
          },
        }],
      },
      {
        id: "lyr_cccccccccc",
        kind: "animation",
        name: "Restyle seam · 1",
        order: 20,
        enabled: true,
        locked: false,
        items: [{
          id: "gfx_cccccccccc",
          template: "tpl_d2e3f4g5h6",
          at: "timeline:seq_aaaaaaaaaa@30",
          duration: { frames: 30, fps: "30/1" },
          params: { title: "Exact resume" },
          seed: 609,
          layout: {
            restyleSeam: {
              planId: "restyle-plan-render",
              seamId: "restyle-seam-001",
              sourceFrame: 30,
              durationFrames: 30,
              resumeExact: true,
            },
          },
        }],
      },
    );

    const rendered = compile(model);
    expect(rendered.nodes.filter(({ kind }) => kind === "timeline-insert")).toHaveLength(2);
    expect(rendered.nodes).toContainEqual(expect.objectContaining({
      kind: "timeline-insert",
      params: {
        stream: "video",
        sourceDuration: 210,
        outputDuration: 240,
        insertions: [{ at: 30, duration: 30 }],
      },
    }));
    expect(rendered.nodes).toContainEqual(expect.objectContaining({
      kind: "timeline-insert",
      params: {
        stream: "audio",
        sourceDuration: 336_000,
        outputDuration: 384_000,
        insertions: [{ at: 48_000, duration: 48_000 }],
      },
    }));
    const anchored = rendered.nodes.find(({ kind, params }) =>
      kind === "composite" && "mode" in params && params.mode === "timeline.anchored");
    expect(anchored?.params).toMatchObject({
      durationFrames: 240,
      inputSettings: [{ atOutputFrame: 60, durationFrames: 30 }],
    });
    const stack = rendered.nodes.find(({ kind, params }) =>
      kind === "composite" && "mode" in params && params.mode === "stack");
    expect(stack?.params).toMatchObject({ durationFrames: 240 });
  });

  it("uses a deterministic black visual slot for an audio-only speech clip", () => {
    const model = project();
    model.assets = [{
      id: "ast_aaaaaaaaaa",
      kind: "audio",
      path: "/tmp/speech.wav",
      sha256: HASH,
      probe: {
        duration: { samples: 192_000, rate: 48_000 },
        audio: { rate: 48_000, channels: 1 },
      },
      audio: [{
        index: 0,
        codec: "pcm_s16le",
        sampleRate: 48_000,
        channels: 1,
        layout: "mono",
      }],
    }];
    model.sequences[0]!.clips = [{
      id: "clp_aaaaaaaaaa",
      asset: "ast_aaaaaaaaaa",
      source: {
        in: { frames: 0, fps: "30/1" },
        out: { frames: 120, fps: "30/1" },
      },
    }];

    const graph = compile(model);
    const sources = graph.nodes.filter(({ kind }) => kind === "source");
    expect(sources).toContainEqual(expect.objectContaining({
      params: expect.objectContaining({ assetId: VIRTUAL_GAP_ASSET, stream: "video" }),
    }));
    expect(sources).toContainEqual(expect.objectContaining({
      params: expect.objectContaining({ assetId: "ast_aaaaaaaaaa", stream: "audio" }),
    }));
  });

  it("accepts template-backed graphics layers and rejects non-template placed items", () => {
    const model = project();
    model.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "text",
      name: "overlay",
      order: 1,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_aaaaaaaaaa",
        template: "tpl_a2c3d4e5f6",
        at: "timeline:30@30/1",
        duration: { frames: 90, fps: "30/1" },
        params: { title: "A graphic" },
        seed: 1,
      }],
    });

    expect(() => compile(model)).not.toThrow();
    model.layers[1]!.items![0] = {
      id: "gfx_aaaaaaaaaa",
      asset: "ast_aaaaaaaaaa",
      at: "timeline:30@30/1",
      duration: { frames: 90, fps: "30/1" },
    };
    expect(() => compile(model)).toThrow(expect.objectContaining({
      code: "E_RENDER_UNSUPPORTED",
      message: expect.stringMatching(/overlay.*Part 7/iu),
    }));
  });

  it("compiles only owner-applicable asset and template items from shared global layers", () => {
    const model = project();
    model.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "sibling",
      clips: [],
    });
    model.assets.push({
      id: "ast_cccccccccc",
      kind: "image",
      path: "/tmp/owner.png",
      sha256: "c".repeat(64),
      probe: { width: 640, height: 360 },
      image: { width: 640, height: 360, hasAlpha: true },
    }, {
      id: "ast_dddddddddd",
      kind: "image",
      path: "/tmp/sibling.png",
      sha256: "d".repeat(64),
      probe: { width: 640, height: 360 },
      image: { width: 640, height: 360, hasAlpha: true },
    });
    model.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "image",
      name: "Shared frozen overlays",
      order: 1,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_aaaaaaaaaa",
        sequenceId: "seq_aaaaaaaaaa",
        asset: "ast_cccccccccc",
        at: "timeline:seq_aaaaaaaaaa@0",
        duration: { frames: 12, fps: "30/1" },
      }, {
        id: "gfx_bbbbbbbbbb",
        sequenceId: "seq_bbbbbbbbbb",
        asset: "ast_dddddddddd",
        at: "timeline:seq_bbbbbbbbbb@0",
        duration: { frames: 12, fps: "30/1" },
      }],
    }, {
      id: "lyr_cccccccccc",
      kind: "animation",
      name: "Shared template overlays",
      order: 2,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_cccccccccc",
        sequenceId: "seq_aaaaaaaaaa",
        template: "tpl_a2c3d4e5f6",
        at: "timeline:seq_aaaaaaaaaa@0",
        duration: { frames: 12, fps: "30/1" },
        seed: 1,
      }, {
        id: "gfx_dddddddddd",
        sequenceId: "seq_bbbbbbbbbb",
        asset: "ast_dddddddddd",
        at: "timeline:seq_bbbbbbbbbb@0",
        duration: { frames: 12, fps: "30/1" },
      }],
    });

    const graph = compile(model);
    const sourceAssetIds = graph.nodes
      .flatMap(({ kind, params }) =>
        kind === "source" && "assetId" in params ? [params.assetId] : []);
    expect(sourceAssetIds).toContain("ast_cccccccccc");
    expect(sourceAssetIds).not.toContain("ast_dddddddddd");
  });

  it("rejects proposal revisions before enqueueing with Part 5 ownership", async () => {
    const queue = JobQueue.open(":memory:").queue;
    try {
      const model = project();
      const service = new RenderService({
        projectRoot: "/tmp",
        store: new ProjectStore("/tmp", model),
        jobQueue: queue,
      });
      await expect(service.renderExport({
        revision: "prp_aaaaaaaaaa",
        deliverableId: "dlv_aaaaaaaaaa",
        variants: ["clean"],
        outputDir: "/tmp",
      })).rejects.toMatchObject({
        code: "E_RENDER_UNSUPPORTED",
        message: expect.stringMatching(/proposal.*Part 5/iu),
      });
      expect(queue.list()).toHaveLength(0);
    } finally {
      queue.close();
    }
  });
});

describe("validateRenderGraph", () => {
  it("rejects missing inputs, cycles, and multiple encode roots", () => {
    const valid = compile();
    const missing: RenderGraph = structuredClone(valid);
    missing.nodes.at(-1)!.inputs.push("rn_aaaaaaaaaa");
    expect(() => validateRenderGraph(missing)).toThrow(
      expect.objectContaining({ code: "E_RENDER_GRAPH_INVALID" }),
    );

    const cyclic: RenderGraph = structuredClone(valid);
    const source = cyclic.nodes.find((node) => node.kind === "source")!;
    const trim = cyclic.nodes.find((node) => node.inputs.includes(source.id))!;
    source.inputs.push(trim.id);
    expect(() => validateRenderGraph(cyclic)).toThrow(
      expect.objectContaining({ code: "E_RENDER_GRAPH_INVALID" }),
    );

    const multiple: RenderGraph = structuredClone(valid);
    multiple.nodes.push(structuredClone(multiple.nodes.at(-1)!));
    multiple.nodes.at(-1)!.id = "rn_aaaaaaaaaa";
    expect(() => validateRenderGraph(multiple)).toThrow(
      expect.objectContaining({ code: "E_RENDER_GRAPH_INVALID" }),
    );
  });
});
