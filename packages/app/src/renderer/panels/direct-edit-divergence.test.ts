import { describe, expect, it } from "vitest";

import type {
  DivergenceClass,
  GuyditorProject,
} from "../../../../core/src/index.js";
import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import { directEditDivergence } from "./direct-edit-divergence.js";

const LONG_SEQUENCE_ID = "seq_aaaaaaaaaa";
const LONG_CLIP_ID = "clp_aaaaaaaaaa";
const LONG_LAYER_ID = "lyr_aaaaaaaaaa";
const LONG_CAPTION_ID = "cts_aaaaaaaaaa";
const SHORT_SEQUENCE_ID = "seq_bbbbbbbbbb";
const SHORT_CLIP_ID = "clp_cccccccccc";
const SHORT_VIDEO_LAYER_ID = "lyr_bbbbbbbbbb";
const SHORT_AUDIO_LAYER_ID = "lyr_cccccccccc";
const SHORT_CAPTION_ID = "cts_bbbbbbbbbb";
const SHORT_DELIVERABLE_ID = "dlv_bbbbbbbbbb";
const SHARED_LAYER_ID = "lyr_dddddddddd";
const LONG_SHARED_ITEM_ID = "gfx_aaaaaaaaaa";
const SHORT_SHARED_ITEM_ID = "gfx_bbbbbbbbbb";

interface Operation {
  op: string;
  params: Record<string, unknown>;
}

function projectWithShortAndSharedTargets(): GuyditorProject {
  const project = projectFixture();
  project.sequences.push({
    id: SHORT_SEQUENCE_ID,
    name: "short",
    clips: [{
      id: SHORT_CLIP_ID,
      asset: "ast_aaaaaaaaaa",
      source: {
        in: { frames: 48, fps: "24/1" },
        out: { frames: 72, fps: "24/1" },
      },
    }],
  });
  project.layers.push({
    id: SHORT_VIDEO_LAYER_ID,
    kind: "video",
    name: "short video",
    order: 0,
    enabled: true,
    locked: false,
    sequence: SHORT_SEQUENCE_ID,
  }, {
    id: SHORT_AUDIO_LAYER_ID,
    kind: "music",
    name: "short music",
    order: 1,
    enabled: true,
    locked: false,
    sequence: SHORT_SEQUENCE_ID,
  }, {
    id: SHARED_LAYER_ID,
    kind: "animation",
    name: "shared graphics",
    order: 2,
    enabled: true,
    locked: false,
    items: [{
      id: LONG_SHARED_ITEM_ID,
      sequenceId: LONG_SEQUENCE_ID,
      at: "word:w000001",
      duration: { frames: 24, fps: "24/1" },
    }, {
      id: SHORT_SHARED_ITEM_ID,
      sequenceId: SHORT_SEQUENCE_ID,
      at: "word:w000001",
      duration: { frames: 24, fps: "24/1" },
    }],
  });
  project.captions.push({
    ...structuredClone(project.captions[0]!),
    id: SHORT_CAPTION_ID,
    name: "short captions",
    sourceLayerIds: [SHORT_VIDEO_LAYER_ID],
  });
  project.deliverables.push({
    id: SHORT_DELIVERABLE_ID,
    kind: "short",
    name: "short",
    profile: "youtube-shorts@1.0.0",
    sequenceId: SHORT_SEQUENCE_ID,
    captionsTrackId: SHORT_CAPTION_ID,
    status: "draft",
  });
  return project;
}

function operation(
  op: string,
  params: Record<string, unknown>,
): Operation {
  return { op, params };
}

describe("direct edit divergence", () => {
  it("classifies timeline edits only when their clip target belongs to a short", () => {
    const project = projectWithShortAndSharedTargets();
    const cases: Array<{
      expected: DivergenceClass;
      operation: Operation;
    }> = [
      {
        expected: "cuts",
        operation: operation("clip.trim", { clipId: SHORT_CLIP_ID }),
      },
      {
        expected: "cuts",
        operation: operation("clip.split", { clipId: SHORT_CLIP_ID }),
      },
      {
        expected: "cuts",
        operation: operation("clip.join", {
          clipIds: [SHORT_CLIP_ID, SHORT_CLIP_ID],
        }),
      },
      {
        expected: "cuts",
        operation: operation("clip.remove", { clipId: SHORT_CLIP_ID }),
      },
      {
        expected: "order",
        operation: operation("clip.move", { clipId: SHORT_CLIP_ID }),
      },
      {
        expected: "pacing",
        operation: operation("clip.gap.set", { clipId: SHORT_CLIP_ID }),
      },
    ];

    for (const testCase of cases) {
      expect(directEditDivergence(project, [testCase.operation]))
        .toBe(testCase.expected);
      expect(directEditDivergence(project, [{
        ...testCase.operation,
        params: {
          ...testCase.operation.params,
          clipId: LONG_CLIP_ID,
          ...(testCase.operation.op === "clip.join"
            ? { clipIds: [LONG_CLIP_ID, LONG_CLIP_ID] }
            : {}),
        },
      }])).toBeUndefined();
    }
  });

  it("classifies caption and transcript cuts from their actual short targets", () => {
    const project = projectWithShortAndSharedTargets();
    const captionOperations = [
      "caption.track.set",
      "caption.style.set",
      "caption.break.set",
      "caption.break.clear",
      "caption.word.emphasis.set",
      "caption.cue.retime",
      "caption.preset.upgrade",
    ];

    for (const op of captionOperations) {
      expect(directEditDivergence(project, [
        operation(op, { captionId: SHORT_CAPTION_ID }),
      ])).toBe("captions");
      expect(directEditDivergence(project, [
        operation(op, { captionId: LONG_CAPTION_ID }),
      ])).toBeUndefined();
    }

    expect(directEditDivergence(project, [
      operation("transcript.range.remove", { sequenceId: SHORT_SEQUENCE_ID }),
    ])).toBe("cuts");
    expect(directEditDivergence(project, [
      operation("transcript.range.remove", { sequenceId: LONG_SEQUENCE_ID }),
    ])).toBeUndefined();
    expect(directEditDivergence(project, [
      operation("transcript.range.createClip", {
        targetLayerId: SHORT_VIDEO_LAYER_ID,
      }),
    ])).toBe("cuts");
    expect(directEditDivergence(project, [
      operation("transcript.range.createClip", {
        targetLayerId: LONG_LAYER_ID,
      }),
    ])).toBeUndefined();
  });

  it("uses layer role and shared applicability for layer edits", () => {
    const project = projectWithShortAndSharedTargets();

    expect(directEditDivergence(project, [
      operation("layer.disable", { layerId: LONG_LAYER_ID }),
    ])).toBeUndefined();
    expect(directEditDivergence(project, [
      operation("layer.disable", { layerId: SHORT_VIDEO_LAYER_ID }),
    ])).toBe("graphics");
    expect(directEditDivergence(project, [
      operation("layer.disable", { layerId: SHORT_AUDIO_LAYER_ID }),
    ])).toBe("audio");
    expect(directEditDivergence(project, [
      operation("layer.disable", { layerId: SHARED_LAYER_ID }),
    ])).toBe("graphics");
    expect(directEditDivergence(project, [
      operation("layer.lock", { layerId: SHORT_VIDEO_LAYER_ID }),
    ])).toBeUndefined();
  });

  it("classifies audio, framing, and visual inspector edits", () => {
    const project = projectWithShortAndSharedTargets();
    const cases: Array<{
      expected: DivergenceClass;
      operation: Operation;
    }> = [
      {
        expected: "audio",
        operation: operation("layer.ducking.set", {
          layerId: SHORT_AUDIO_LAYER_ID,
        }),
      },
      {
        expected: "audio",
        operation: operation("layer.ducking.override", {
          layerId: SHORT_AUDIO_LAYER_ID,
        }),
      },
      {
        expected: "framing",
        operation: operation("pip.place", {
          layerId: SHORT_VIDEO_LAYER_ID,
        }),
      },
      {
        expected: "framing",
        operation: operation("composition.arrange", {
          sequenceId: SHORT_SEQUENCE_ID,
        }),
      },
      {
        expected: "framing",
        operation: operation("deliverable.framing.override", {
          deliverableId: SHORT_DELIVERABLE_ID,
        }),
      },
      {
        expected: "graphics",
        operation: operation("pip.style.set", {
          layerId: SHORT_VIDEO_LAYER_ID,
        }),
      },
      {
        expected: "graphics",
        operation: operation("pip.preset.apply", {
          layerId: SHORT_VIDEO_LAYER_ID,
        }),
      },
      {
        expected: "graphics",
        operation: operation("clip.key.set", { clipId: SHORT_CLIP_ID }),
      },
    ];

    for (const testCase of cases) {
      expect(directEditDivergence(project, [testCase.operation]))
        .toBe(testCase.expected);
    }
  });

  it("keeps short review and analysis operations unclassified", () => {
    const project = projectWithShortAndSharedTargets();
    const operations = [
      operation("transcript.word.correct", { wordId: "w000001" }),
      operation("region.mark", { sequenceId: SHORT_SEQUENCE_ID }),
      operation("pip.avoid.solve", { layerId: SHORT_VIDEO_LAYER_ID }),
      operation("key.qc.run", { clipId: SHORT_CLIP_ID }),
      operation("key.matte.generate", { clipId: SHORT_CLIP_ID }),
      operation("annotation.create", { sequenceId: SHORT_SEQUENCE_ID }),
      operation("annotation.resolve", { annotationId: "ann_aaaaaaaaaa" }),
      operation("annotation.reject", { annotationId: "ann_aaaaaaaaaa" }),
      operation("annotation.reopen", { annotationId: "ann_aaaaaaaaaa" }),
    ];

    for (const candidate of operations) {
      expect(directEditDivergence(project, [candidate])).toBeUndefined();
    }
  });

  it("rejects a direct batch that mixes divergence classes", () => {
    const project = projectWithShortAndSharedTargets();

    expect(() => directEditDivergence(project, [
      operation("clip.trim", { clipId: SHORT_CLIP_ID }),
      operation("layer.ducking.set", { layerId: SHORT_AUDIO_LAYER_ID }),
    ])).toThrow("Direct edit batch mixes divergence classes: audio, cuts.");
  });
});
