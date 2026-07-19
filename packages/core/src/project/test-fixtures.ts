import type { GuyditorProject } from "./model.js";

const HASH = "a".repeat(64);

export function projectFixture(): GuyditorProject {
  return {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: {
      id: "prj_aaaaaaaaaa",
      name: "Fixture",
      created: "2026-07-18T10:00:00Z",
    },
    settings: {
      timeline: { fps: "24/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: 1 },
    assets: [
      {
        id: "ast_aaaaaaaaaa",
        kind: "video",
        path: "media/a.mov",
        sha256: HASH,
        probe: {
          duration: { frames: 240, fps: "24/1" },
          fps: "24/1",
        },
      },
    ],
    beats: [],
    sequences: [
      {
        id: "seq_aaaaaaaaaa",
        name: "main",
        clips: [
          {
            id: "clp_aaaaaaaaaa",
            asset: "ast_aaaaaaaaaa",
            source: {
              in: { frames: 0, fps: "24/1" },
              out: { frames: 24, fps: "24/1" },
            },
          },
          {
            id: "clp_bbbbbbbbbb",
            asset: "ast_aaaaaaaaaa",
            source: {
              in: { frames: 24, fps: "24/1" },
              out: { frames: 48, fps: "24/1" },
            },
          },
        ],
      },
    ],
    layers: [
      {
        id: "lyr_aaaaaaaaaa",
        kind: "video",
        name: "main",
        order: 0,
        enabled: true,
        locked: false,
        sequence: "seq_aaaaaaaaaa",
      },
    ],
    captions: [
      {
        id: "cts_aaaaaaaaaa",
        name: "captions",
        sourceLayerIds: ["lyr_aaaaaaaaaa"],
        preset: { presetId: "pre_aaaaaaaaaa", version: 1 },
        styleOverrides: {},
        breakOverrides: [],
        emphasisOverrides: [],
        timingOffsets: [],
        enabled: true,
      },
    ],
    annotations: {
      sidecar: "annotations",
      summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 },
    },
    deliverables: [
      {
        id: "dlv_aaaaaaaaaa",
        kind: "longform",
        name: "master",
        profile: "youtube@1.0.0",
        sequenceId: "seq_aaaaaaaaaa",
        captionsTrackId: "cts_aaaaaaaaaa",
        status: "draft",
      },
    ],
    presets: [
      {
        id: "pre_aaaaaaaaaa",
        name: "captions",
        kind: "caption",
        version: 1,
        path: "presets/pre_aaaaaaaaaa@1.yaml",
        sha256: HASH,
      },
    ],
    skills: [
      {
        id: "skl_aaaaaaaaaa",
        name: "editing",
        version: "1.0.0",
        path: "skills/editing/1.0.0/",
        contentHash: HASH,
      },
    ],
    sidecars: [
      {
        name: "annotations",
        path: "sidecars/annotations.yaml",
        schema: "guyditor.annotations/v1",
        sha256: HASH,
        inputs: [{ asset: "ast_aaaaaaaaaa", sha256: HASH }],
      },
    ],
  };
}
