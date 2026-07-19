import { describe, expect, it } from "vitest";

import { compileFiltergraph } from "./filtergraph.js";
import { compileRenderGraph } from "./graph.js";
import type {
  RenderGraph,
  RenderProfile,
  ToolchainManifest,
} from "./index.js";
import type { GuyditorProject } from "../../core/src/index.js";

const HASH = "b".repeat(64);
const PROFILE: RenderProfile = {
  id: "youtube-longform",
  version: "1.0.0",
  video: { codec: "libx264", crf: 18, pixelFormat: "yuv420p" },
  audio: { codec: "aac", bitrate: "192k" },
  container: "mp4",
};
const TOOLCHAIN: ToolchainManifest = {
  ffmpeg: { version: "ffmpeg", buildSha256: HASH },
  ffprobe: { version: "ffprobe", buildSha256: HASH },
  renderPackage: "0.0.0",
  overlayRenderer: { version: "n/a", canvasVersion: "n/a", fontHashes: {} },
  encoderThreads: 1,
  os: "linux",
};

function graph(sourcePath = "/tmp/source.mp4", speedRate?: string, withOverlay = false): RenderGraph {
  const project: GuyditorProject = {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: {
      id: "prj_aaaaaaaaaa",
      name: "Filtergraph",
      created: "2026-07-18T10:00:00Z",
    },
    settings: {
      timeline: { fps: "30/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: 1 },
    assets: [{
      id: "ast_aaaaaaaaaa",
      kind: "video",
      path: sourcePath,
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
    }],
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
            out: { frames: 60, fps: "30/1" },
          },
        },
        {
          id: "clp_bbbbbbbbbb",
          asset: "ast_aaaaaaaaaa",
          source: {
            in: { frames: 90, fps: "30/1" },
            out: { frames: 150, fps: "30/1" },
          },
          gapBefore: { frames: 30, fps: "30/1" },
          ...(speedRate === undefined
            ? {}
            : { effects: [{ id: "fx_aaaaaaaaaa", kind: "speed", params: { rate: speedRate } }] }
          ),
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

  return compileRenderGraph({
    project,
    revision: project.revision,
    deliverableId: "dlv_aaaaaaaaaa",
    variant: withOverlay ? "burnin" : "clean",
    quality: "high",
    profile: PROFILE,
    profileSha256: HASH,
    toolchain: TOOLCHAIN,
    overlays: withOverlay ? [{
      overlayAssetPath: "/tmp/caption-frames/%08d.png",
      overlaySha256: HASH,
      atOutputFrame: 12,
      durationFrames: 45,
    }] : [],
  });
}

describe("compileFiltergraph", () => {
  it("lowers trims, a black-and-silent gap, concat, and profile encoding once", () => {
    const command = compileFiltergraph(graph(), "/tmp/output.mp4");
    const args = command.args;

    expect(args).toContain("-nostdin");
    expect(args).toContain("-ss");
    expect(args).toContain("-to");
    expect(args).toContain("-filter_complex");
    expect(command.filterComplex).toMatch(/trim=.*setpts=/u);
    expect(command.filterComplex).toMatch(/atrim=.*asetpts=/u);
    expect(command.filterComplex).toContain("color=c=black");
    expect(command.filterComplex).toContain("anullsrc=");
    expect(command.filterComplex).toContain("concat=n=3:v=1:a=0");
    expect(command.filterComplex).toContain("concat=n=3:v=0:a=1");
    expect(args).toEqual(expect.arrayContaining([
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-progress",
      "pipe:1",
      "/tmp/output.mp4",
    ]));
  });

  it("rejects network sources and outputs as unsupported Part 12 inputs", () => {
    expect(() => compileFiltergraph(graph("https://example.com/a.mp4"), "/tmp/out.mp4"))
      .toThrow(expect.objectContaining({
        code: "E_RENDER_UNSUPPORTED",
        message: expect.stringMatching(/non-file input.*Part 12/i),
      }));
    expect(() => compileFiltergraph(graph(), "http://example.com/out.mp4"))
      .toThrow(expect.objectContaining({
        code: "E_RENDER_UNSUPPORTED",
        message: expect.stringMatching(/non-file output.*Part 12/i),
      }));
  });

  it("lowers exact speed rationals to video setpts and audio atempo", () => {
    const command = compileFiltergraph(graph("/tmp/source.mp4", "3/2"), "/tmp/out.mp4");

    expect(command.filterComplex).toContain("setpts=(PTS-STARTPTS)*2/3");
    expect(command.filterComplex).toContain("atempo=1.5");
    expect(command.expectedDurationFrames).toBe(130);
  });

  it("supports the M0 compileFiltergraph(graph) surface with a local derived output", () => {
    const command = compileFiltergraph(graph());
    const deliverableId = "dlv_aaaaaaaaaa";

    expect(command.args.at(-1)).toBe(`${deliverableId}-clean.mp4`);
  });

  it("adds an exact-fps image2 input and frame-enabled alpha overlay", () => {
    const command = compileFiltergraph(graph("/tmp/source.mp4", undefined, true), "/tmp/burnin.mp4");
    expect(command.args).toEqual(expect.arrayContaining([
      "-framerate",
      "30/1",
      "-start_number",
      "0",
      "-i",
      "/tmp/caption-frames/%08d.png",
    ]));
    expect(command.filterComplex).toContain("overlay=enable='between(n,12,56)'");
    expect(command.filterComplex).toContain("format=rgba");
  });
});
