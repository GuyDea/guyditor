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

const HASH = "a".repeat(64);

const PROFILE: RenderProfile = {
  id: "youtube-longform",
  version: "1.0.0",
  video: { codec: "libx264", crf: 18, pixelFormat: "yuv420p" },
  audio: { codec: "aac", bitrate: "192k" },
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

  it("rejects transitions and multiple video layers with owning parts", () => {
    const withTransition = project();
    withTransition.sequences[0]!.clips[0]!.transitionAfter = {
      id: "trn_aaaaaaaaaa",
      preset: "hard-cut",
      duration: { frames: 5, fps: "30/1" },
    };
    expect(() => compile(withTransition)).toThrow(
      expect.objectContaining({
        code: "E_RENDER_UNSUPPORTED",
        message: expect.stringMatching(/transition.*Part 5/i),
      }),
    );

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
    expect(() => compile(withLayers)).toThrow(
      expect.objectContaining({
        code: "E_RENDER_UNSUPPORTED",
        message: expect.stringMatching(/multiple video layers.*Part 6/i),
      }),
    );
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
      feature: "items",
      part: "Part 6",
      change: (model: GuyditorProject) => {
        model.layers[0]!.items = [];
      },
    },
    {
      feature: "key",
      part: "Part 6",
      change: (model: GuyditorProject) => {
        model.sequences[0]!.clips[0]!.effects = [{
          id: "fx_bbbbbbbbbb",
          kind: "key",
          params: {},
        }];
      },
    },
    {
      feature: "transform",
      part: "Part 6",
      change: (model: GuyditorProject) => {
        model.layers[0]!.transform = {};
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
      sequence: "seq_aaaaaaaaaa",
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
