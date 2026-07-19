import { describe, expect, it } from "vitest";

import type {
  AudioChain,
  GuyditorProject,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { compileFiltergraph } from "./filtergraph.js";
import { compileRenderGraph } from "./graph.js";
import type {
  AudioChainNodeParams,
  RenderProfile,
  ToolchainManifest,
} from "./index.js";

const HASH = "a".repeat(64);
const PROFILE: RenderProfile = {
  id: "youtube",
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
    version: "test",
    canvasVersion: "test",
    fontHashes: {},
  },
  encoderThreads: 1,
  os: "linux",
};

const CHAIN: AudioChain = {
  nodes: [
    { type: "channelSelect", enabled: true, mapping: "left" },
    { type: "noiseReduction", enabled: true, strengthDb: 12 },
    { type: "gain", enabled: true, gainDb: 2 },
    { type: "eq", enabled: true, bands: [{ freqHz: 180, gainDb: -2, q: 0.8 }] },
    {
      type: "compression", enabled: true, thresholdDb: -18, ratio: 3,
      attackMs: 8, releaseMs: 140, makeupDb: 1,
    },
    { type: "limiting", enabled: true, ceilingDb: -1 },
  ],
};

function audioProject(): GuyditorProject {
  const project = projectFixture();
  project.assets[0]!.audio = [{
    index: 0,
    codec: "aac",
    sampleRate: 48_000,
    channels: 2,
    layout: "stereo",
  }];
  project.assets[0]!.probe.audio = { rate: 48_000, channels: 2 };
  project.sequences[0]!.audio = { targetLufs: -16, truePeakDb: -1.5 };
  project.sequences[0]!.clips[0]!.audio = {
    gainDb: -1,
    fadeIn: { frames: 3, fps: "24/1" },
    fadeOut: { frames: 3, fps: "24/1" },
    offset: { samples: 120, rate: 48_000 },
    chain: CHAIN,
  };
  project.sequences[0]!.clips[0]!.effects = [{
    id: "fx_aaaaaaaaaa",
    kind: "color",
    params: {
      exposure: 0.5,
      contrast: 1.1,
      temperatureK: 5_400,
      tint: 0.1,
      saturation: 0.9,
    },
  }];
  project.sequences.push({
    id: "seq_bbbbbbbbbb",
    name: "score",
    clips: [{
      id: "clp_cccccccccc",
      asset: "ast_aaaaaaaaaa",
      source: {
        in: { frames: 0, fps: "24/1" },
        out: { frames: 24, fps: "24/1" },
      },
      loop: { enabled: true, crossfade: { frames: 3, fps: "24/1" } },
      anchor: "timeline:0@24/1",
    }],
  });
  project.layers.push({
    id: "lyr_bbbbbbbbbb",
    kind: "music",
    name: "Score",
    order: 1,
    enabled: true,
    locked: false,
    audio: { chain: CHAIN },
    ducking: {
      enabled: true,
      mode: "auto",
      duckDb: -12,
      attackMs: 150,
      releaseMs: 400,
      holdMs: 250,
      minGapMs: 700,
      overrides: [],
    },
    sequence: "seq_bbbbbbbbbb",
  });
  project.layers.push({
    id: "lyr_cccccccccc",
    kind: "adjustment",
    name: "Warm finish",
    order: 2,
    enabled: true,
    locked: false,
    adjustment: {
      exposure: 0.1,
      contrast: 1.05,
      temperatureK: 5_800,
      tint: -0.05,
      saturation: 1.02,
    },
  });
  return project;
}

describe("audio post/color render graph", () => {
  it("rejects an unresolved manual ducking anchor instead of moving it to sample zero", () => {
    const project = audioProject();
    project.layers[1]!.ducking!.overrides = [{ at: "word:w000001", gainDb: -8 }];

    expect(() => compileRenderGraph({
      project,
      revision: project.revision,
      deliverableId: "dlv_aaaaaaaaaa",
      variant: "clean",
      quality: "high",
      profile: PROFILE,
      profileSha256: HASH,
      toolchain: TOOLCHAIN,
      anchorFrames: { "timeline:0@24/1": 0 },
    })).toThrow(/unresolved ducking override/u);
  });

  it("orders clip/layer/duck/master stages and lowers looping plus looks to FFmpeg", () => {
    const project = audioProject();
    const graph = compileRenderGraph({
      project,
      revision: project.revision,
      deliverableId: "dlv_aaaaaaaaaa",
      variant: "clean",
      quality: "high",
      profile: PROFILE,
      profileSha256: HASH,
      toolchain: TOOLCHAIN,
      anchorFrames: { "timeline:0@24/1": 0 },
      speechIntervals: [{
        start: { samples: 12_000, rate: 48_000 },
        end: { samples: 48_000, rate: 48_000 },
      }],
    });
    const chains = graph.nodes
      .filter(({ kind }) => kind === "audiochain")
      .map(({ params }) => params as AudioChainNodeParams);

    expect(chains).toHaveLength(3);
    expect(chains[0]!.inputSettings?.[0]!.stages.map(({ stage }) => stage)).toEqual([
      "gain", "fade", "fade", "channelmap", "denoise", "gain", "eq", "compress", "limit",
    ]);
    expect(chains[1]!.mode).toBe("anchored");
    expect(chains[1]!.inputSettings?.[0]).toMatchObject({
      loop: true,
      loopCrossfadeSamples: 6_000,
      loopDurationSamples: 96_000,
    });
    expect(chains[1]!.stages.map(({ stage }) => stage)).toEqual([
      "channelmap", "denoise", "gain", "eq", "compress", "limit", "duck",
    ]);
    expect(chains[2]!.mode).toBe("mix");
    expect(chains[2]!.stages.at(-1)).toMatchObject({
      stage: "loudnorm",
      params: { integratedLufs: -16, truePeakDbtp: -1.5, twoPass: true },
    });

    const compiled = compileFiltergraph(graph, "/tmp/audio-post.mp4");
    expect(compiled.filterComplex).toContain("volume=-1dB");
    expect(compiled.filterComplex).toContain("afade=");
    expect(compiled.filterComplex).toContain("channelmap=");
    expect(compiled.filterComplex).toContain("arnndn=");
    expect(compiled.filterComplex).toContain("equalizer=");
    expect(compiled.filterComplex).toContain("acompressor=");
    expect(compiled.filterComplex).toContain("alimiter=");
    expect(compiled.filterComplex).toContain("level=false");
    expect(compiled.filterComplex).toContain("acrossfade=");
    expect(compiled.filterComplex).toContain("volume='pow(10,(if(");
    expect(compiled.filterComplex).not.toContain("loudnorm=");
    expect(compiled.filterComplex).toContain("eq=contrast=1.1");
    expect(compiled.filterComplex).toContain("colorbalance=");
    expect(compiled.filterComplex).toContain("colortemperature=temperature=5400");
  });
});
