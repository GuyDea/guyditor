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

function graph(
  sourcePath = "/tmp/source.mp4",
  speedRate?: string,
  withOverlay = false,
  configure?: (project: GuyditorProject) => void,
): RenderGraph {
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

  configure?.(project);

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
  it("lowers piecewise-linear transform keyframes to FFmpeg frame expressions", () => {
    const rendered = graph();
    const sourceComposite = rendered.nodes.find(({ kind }) => kind === "composite");
    if (sourceComposite === undefined) throw new Error("missing visual composite");
    const transform = {
      id: "rn_aaaaaaaaaa",
      kind: "transform" as const,
      inputs: [sourceComposite.id],
      params: {
        keyframes: [
          { atOutputFrame: 0, scale: [0.24, 0.24] as [number, number], pos: [0.84, 0.84] as [number, number], anchor: [0.5, 0.5] as [number, number], opacity: 1 },
          { atOutputFrame: 30, scale: [0.32, 0.32] as [number, number], pos: [0.2, 0.8] as [number, number], anchor: [0.5, 0.5] as [number, number], opacity: 0.8 },
          { atOutputFrame: 60, scale: [1, 1] as [number, number], pos: [0.5, 0.5] as [number, number], anchor: [0.5, 0.5] as [number, number], opacity: 1 },
        ],
        interpolation: "linear" as const,
      },
    };
    const top = rendered.nodes.find(({ kind, params }) =>
      kind === "composite" && "mode" in params && params.mode === "stack");
    if (top === undefined) throw new Error("missing stack composite");
    top.inputs = top.inputs.map((id) => id === sourceComposite.id ? transform.id : id);
    rendered.nodes.splice(rendered.nodes.indexOf(top), 0, transform);

    const command = compileFiltergraph(rendered, "/tmp/keyframed.mp4");
    expect(command.filterComplex).toContain("eval=frame");
    expect(command.filterComplex).toContain("if(lt(n,30)");
    expect(command.filterComplex).toContain("if(lt(n,60)");
    expect(command.filterComplex).not.toContain("keyframed transform");
  });

  it("uses deterministic raster mask/underlay/chrome sequences for final PiP assembly", () => {
    const rendered = graph("/tmp/source.mp4", undefined, false, (project) => {
      project.layers[0]!.pip = {
        style: { mask: { shape: "rounded", cornerRadius: 0.08 } },
        placement: { base: { anchor: "bottom_right", width: "24%", margin: "4%" } },
        keyframes: [],
      };
    });
    const pipNode = rendered.nodes.find(({ kind }) => kind === "pip");
    if (pipNode === undefined || !("styleKeyframes" in pipNode.params)) throw new Error("missing PiP node");
    pipNode.params.rasterAssets = {
      maskPath: "/tmp/pip/mask/%08d.png",
      underlayPath: "/tmp/pip/underlay/%08d.png",
      chromePath: "/tmp/pip/chrome/%08d.png",
      sha256: HASH,
      durationFrames: 150,
    };
    const command = compileFiltergraph(rendered, "/tmp/pip.mp4");
    expect(command.args).toEqual(expect.arrayContaining([
      "/tmp/pip/mask/%08d.png",
      "/tmp/pip/underlay/%08d.png",
      "/tmp/pip/chrome/%08d.png",
    ]));
    expect(command.filterComplex).toContain("blend=all_mode=multiply");
    expect(command.filterComplex).toContain("alphamerge");
    expect(command.filterComplex).not.toContain("geq=");
  });

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

  it("lowers exact-resume seam insertions to frame/sample splits without consuming source", () => {
    const rendered = graph("/tmp/source.mp4", undefined, false, (project) => {
      project.layers.push({
        id: "lyr_bbbbbbbbbb",
        kind: "animation",
        name: "Restyle seam",
        order: 10,
        enabled: true,
        locked: false,
        items: [{
          id: "gfx_aaaaaaaaaa",
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
      });
    });

    const command = compileFiltergraph(rendered, "/tmp/restyle-seam.mp4");
    expect(command.expectedDurationFrames).toBe(180);
    expect(command.filterComplex).toContain("split=2");
    expect(command.filterComplex).toContain("trim=start_frame=0:end_frame=30");
    expect(command.filterComplex).toContain("trim=start_frame=30:end_frame=150");
    expect(command.filterComplex).toContain("color=c=0x00000000");
    expect(command.filterComplex).toContain("asplit=2");
    expect(command.filterComplex).toContain("atrim=start_sample=0:end_sample=48000");
    expect(command.filterComplex).toContain("atrim=start_sample=48000:end_sample=240000");
    expect(command.filterComplex).toContain("concat=n=3:v=1:a=0");
    expect(command.filterComplex).toContain("concat=n=3:v=0:a=1");
  });

  it("preserves alpha across every frame of an anchored video item", () => {
    const rendered = graph("/tmp/source.mp4", undefined, false, (project) => {
      project.layers.push({
        id: "lyr_bbbbbbbbbb",
        kind: "video",
        name: "Anchored generated range",
        order: 10,
        enabled: true,
        locked: false,
        items: [{
          id: "gfx_bbbbbbbbbb",
          asset: "ast_aaaaaaaaaa",
          at: "timeline:seq_aaaaaaaaaa@30",
          duration: { frames: 30, fps: "30/1" },
          source: {
            in: { frames: 0, fps: "30/1" },
            out: { frames: 30, fps: "30/1" },
          },
        }],
      });
    });

    const command = compileFiltergraph(rendered, "/tmp/anchored.mp4");
    expect(command.filterComplex).toContain(
      "tpad=start=30:stop=90:color=black@0,trim=start_frame=0:end_frame=150",
    );
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

  it("lowers stills, static transforms, chroma stages, and ordered blend/overlay chains", () => {
    const command = compileFiltergraph(graph(
      "/tmp/source.mp4",
      undefined,
      false,
      (project) => {
        project.assets.push({
          id: "ast_bbbbbbbbbb",
          kind: "image",
          path: "/tmp/foreground.png",
          sha256: HASH,
          probe: { width: 1920, height: 1080 },
          image: { width: 1920, height: 1080, hasAlpha: true },
        });
        project.sequences[0]!.clips[0]!.effects = [
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
              crop: { l: 0.05, t: 0.1, r: 0.05, b: 0.1 },
              scale: 0.8,
              position: { x: 0.5, y: 0.5 },
              rotationDeg: 2,
              opacity: 0.9,
            },
          },
        ];
        project.layers.push(
          {
            id: "lyr_bbbbbbbbbb",
            kind: "video",
            name: "presenter",
            order: 10,
            enabled: true,
            locked: false,
            sequence: "seq_aaaaaaaaaa",
            blend: "screen",
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
              asset: "ast_bbbbbbbbbb",
              at: "timeline:seq_aaaaaaaaaa@0",
              duration: { frames: 150, fps: "30/1" },
            }],
          },
        );
      },
    ), "/tmp/composite.mp4");

    expect(command.args).toEqual(expect.arrayContaining([
      "-loop",
      "1",
      "-framerate",
      "30/1",
      "-i",
      "/tmp/foreground.png",
    ]));
    expect(command.filterComplex).toContain("split=2");
    expect(command.filterComplex).toContain("gblur=sigma=1.5:planes=0x6");
    expect(command.filterComplex).toContain(
      "chromakey=color=0x1FBF3A:similarity=0.1465:blend=0.048",
    );
    expect(command.filterComplex).toContain("alphaextract");
    expect(command.filterComplex).toContain("erosion");
    expect(command.filterComplex).toContain("gblur=sigma=1");
    expect(command.filterComplex).toContain("alphamerge");
    expect(command.filterComplex).toContain("despill=type=green:mix=0.6:expand=0.3");
    expect(command.filterComplex).toContain("crop=");
    expect(command.filterComplex).toContain("rotate=");
    expect(command.filterComplex).toContain("colorchannelmixer=aa=0.9");
    expect(command.filterComplex).toContain("blend=all_mode=screen");
    expect(command.filterComplex).toMatch(/overlay=.*\[vout\]/u);
  });
});
