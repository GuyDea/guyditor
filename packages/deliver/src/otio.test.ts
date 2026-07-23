import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { Annotation, FrameTime } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import {
  buildOtioExport,
  writeOtioExport,
  type OtioExportOptions,
} from "./otio.js";

const OPTIONS: OtioExportOptions = {
  deliverableId: "dlv_aaaaaaaaaa",
  revision: "rev_00001",
  mediaPaths: "relative",
  includeBeatsAsMarkers: true,
  includeAnnotationsAsMarkers: true,
};

const ANNOTATION: Annotation = {
  id: "ann_aaaaaaaaaa",
  shape: "note",
  body: "Tighten this entrance",
  geometry: null,
  anchor: {
    kind: "timeline",
    sequenceId: "seq_aaaaaaaaaa",
    frame: { frames: 37, fps: "24/1" },
  },
  extent: { frames: 2, fps: "24/1" },
  canvasRef: {
    sequenceId: "seq_aaaaaaaaaa",
    deliverableId: "dlv_aaaaaaaaaa",
    aspect: "16:9",
  },
  state: "resolved",
  blocking: false,
  author: { kind: "human", id: "creator" },
  createdAt: "2026-07-23T10:00:00.000Z",
  history: [],
};

function resolved(frames: number, fps = "24/1"): FrameTime {
  return { frames, fps };
}

describe("FR-1102 OpenTimelineIO export", () => {
  it("maps the round-trip-safe subset and declares every canonical-only construct", async () => {
    const project = projectFixture();
    project.assets[0]!.path = "media/a.mov";
    project.assets[0]!.probe.fps = "30000/1001";
    project.assets[0]!.probe.duration = { frames: 300, fps: "30000/1001" };
    project.assets[0]!.provenance = { sidecar: "annotations" };
    project.sequences[0]!.clips = [
      {
        id: "clp_aaaaaaaaaa",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 10, fps: "30000/1001" },
          out: { frames: 40, fps: "30000/1001" },
        },
        effects: [{ id: "fx_aaaaaaaaaa", kind: "speed", params: { rate: "2/1" } }],
      },
      {
        id: "clp_bbbbbbbbbb",
        asset: "ast_aaaaaaaaaa",
        gapBefore: { frames: 6, fps: "24/1" },
        source: {
          in: { frames: 40, fps: "30000/1001" },
          out: { frames: 70, fps: "30000/1001" },
        },
        effects: [{
          id: "fx_bbbbbbbbbb",
          kind: "freeze",
          params: { hold: { frames: 12, fps: "24/1" } },
        }],
        transitionAfter: {
          id: "trn_aaaaaaaaaa",
          preset: "crossfade",
          duration: { frames: 9, fps: "24/1" },
        },
      },
      {
        id: "clp_cccccccccc",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 70, fps: "30000/1001" },
          out: { frames: 100, fps: "30000/1001" },
        },
        effects: [{
          id: "fx_cccccccccc",
          kind: "key",
          params: { schema: "guyditor/key@1", mode: "chroma", masks: [] },
        }],
      },
    ];
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "audio",
      name: "Program audio",
      order: 1,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    });
    project.layers[0]!.pip = {
      placement: { base: { anchor: "bottom_right", width: "24%" } },
      style: { mask: { shape: "none" } },
      keyframes: [],
    };
    project.beats.push({
      id: "beat_aaaaaaaaaa",
      name: "Hook",
      anchor: "timeline:seq_aaaaaaaaaa@12",
    });

    const plan = await buildOtioExport(project, OPTIONS, {
      annotations: [ANNOTATION],
      outputPath: "/project/exports/master.otio",
      projectRoot: "/project",
      resolveAnnotation: async () => resolved(37),
      resolveAnchor: async () => resolved(12),
    });

    expect(plan.path).toBe("/project/exports/master.otio");
    expect(plan.timeline).toMatchObject({
      OTIO_SCHEMA: "Timeline.1",
      name: "master",
      global_start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
      metadata: {
        guyditor: {
          canonical: false,
          format: "guyditor/v1",
          revision: "rev_00001",
        },
      },
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        children: [
          { OTIO_SCHEMA: "Track.1", name: "main", kind: "Video" },
          { OTIO_SCHEMA: "Track.1", name: "Program audio", kind: "Audio" },
        ],
      },
    });

    const video = plan.timeline.tracks.children[0]!;
    expect(video.children.map(({ OTIO_SCHEMA }) => OTIO_SCHEMA)).toEqual([
      "Clip.2",
      "Gap.1",
      "Clip.2",
      "Transition.1",
      "Clip.2",
    ]);
    const first = video.children[0]!;
    expect(first).toMatchObject({
      OTIO_SCHEMA: "Clip.2",
      name: "clp_aaaaaaaaaa",
      source_range: {
        start_time: { value: 10, rate: 30000 / 1001 },
        duration: { value: 30, rate: 30000 / 1001 },
      },
      effects: [{ OTIO_SCHEMA: "LinearTimeWarp.1", time_scalar: 2 }],
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: "ExternalReference.1",
          target_url: "../media/a.mov",
        },
      },
      active_media_reference_key: "DEFAULT_MEDIA",
    });
    expect(video.children[2]!.effects).toContainEqual(expect.objectContaining({
      OTIO_SCHEMA: "FreezeFrame.1",
    }));
    expect(video.children[3]).toMatchObject({
      OTIO_SCHEMA: "Transition.1",
      transition_type: "SMPTE_Dissolve",
      in_offset: { value: 4, rate: 24 },
      out_offset: { value: 5, rate: 24 },
    });
    expect(plan.timeline.tracks.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        OTIO_SCHEMA: "Marker.2",
        name: "Hook",
        color: "GREEN",
        marked_range: expect.objectContaining({ start_time: expect.objectContaining({ value: 12 }) }),
      }),
      expect.objectContaining({
        OTIO_SCHEMA: "Marker.2",
        name: "Tighten this entrance",
        color: "RED",
        metadata: { guyditor: expect.objectContaining({ annotationId: "ann_aaaaaaaaaa" }) },
      }),
    ]));

    expect(plan.losses.map(({ construct }) => construct)).toEqual(expect.arrayContaining([
      "review-annotations",
      "agent-provenance",
      "responsive-layouts",
      "semantic-anchors",
      "effects",
      "captions",
    ]));
    expect(plan.timeline.metadata.guyditor.losses).toEqual(plan.losses);
    expect(plan.timeline.metadata.guyditor.canonicalFragments).toMatchObject({
      deliverable: { id: "dlv_aaaaaaaaaa" },
      captions: [{ id: "cts_aaaaaaaaaa" }],
      annotations: [{ id: "ann_aaaaaaaaaa", state: "resolved" }],
    });
  });

  it("writes deterministic .otio JSON with an absolute media URL and SHA-256", async () => {
    const project = projectFixture();
    project.assets[0]!.path = "media/a.mov";
    const root = await mkdtemp(join(tmpdir(), "guyditor-otio-"));
    const outputPath = join(root, "master.otio");
    try {
      const result = await writeOtioExport(project, {
        ...OPTIONS,
        mediaPaths: "absolute",
        includeAnnotationsAsMarkers: false,
      }, {
        annotations: [ANNOTATION],
        outputPath,
        projectRoot: root,
        resolveAnchor: async () => resolved(0),
      });

      expect(result.path.endsWith(".otio")).toBe(true);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
      const parsed = JSON.parse(await readFile(outputPath, "utf8")) as {
        OTIO_SCHEMA: string;
        tracks: { children: Array<{ children: Array<{ media_references?: { DEFAULT_MEDIA: { target_url: string } } }> }> };
      };
      expect(parsed.OTIO_SCHEMA).toBe("Timeline.1");
      expect(parsed.tracks.children[0]!.children[0]!.media_references?.DEFAULT_MEDIA.target_url)
        .toMatch(/^file:\/\/\//u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
