import { describe, expect, it } from "vitest";

import {
  assessBatchRisk,
  buildSemanticDiff,
  structuralSemanticEntries,
} from "./diff.js";
import type {
  AppliedOperation,
  SemanticDiff,
} from "./types.js";
import type { ClipApplication } from "./clip.js";
import { projectFixture } from "../project/test-fixtures.js";

function applied(
  op: string,
  params: Record<string, unknown>,
  affected: string[] = [],
): AppliedOperation {
  return {
    op,
    params,
    summary: `Apply ${op}`,
    inverse: [],
    captionImpact: "none",
    warnings: [],
    affected,
  };
}

function emptyApplication(model = projectFixture()): ClipApplication {
  return {
    model,
    inverse: [],
    affected: [],
    summary: "Apply operation",
    mutations: [],
  };
}

describe("SemanticDiff", () => {
  it("represents stable-ID clip reorders as ownership and order deltas", () => {
    const before = projectFixture();
    const after = structuredClone(before);
    after.sequences[0]!.clips.reverse();

    const entries = structuralSemanticEntries(before, after);

    expect(entries.filter(({ entityType }) => entityType === "clip")).toEqual([
      expect.objectContaining({
        entityId: "clp_aaaaaaaaaa",
        change: "modified",
        fields: expect.arrayContaining([{ field: "order", before: 0, after: 1 }]),
      }),
      expect.objectContaining({
        entityId: "clp_bbbbbbbbbb",
        change: "modified",
        fields: expect.arrayContaining([{ field: "order", before: 1, after: 0 }]),
      }),
    ]);
  });

  it("discovers stable-ID entity changes and per-field deltas beyond clip mutations", () => {
    const before = projectFixture();
    const after = structuredClone(before);
    after.deliverables[0]!.status = "in-review";
    after.sidecars[0]!.sha256 = "b".repeat(64);
    const operation = applied("annotation.resolve", { annotationId: "ann_aaaaaaaaaa" });

    const diff = buildSemanticDiff(
      before,
      after,
      [emptyApplication(after)],
      [operation],
    );

    expect(diff.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityId: "dlv_aaaaaaaaaa",
        entityType: "deliverable",
        change: "modified",
        fields: [{ field: "status", before: "draft", after: "in-review" }],
      }),
      expect.objectContaining({
        entityId: "annotations",
        entityType: "sidecar",
        change: "modified",
        fields: [{ field: "sha256", before: "a".repeat(64), after: "b".repeat(64) }],
      }),
    ]));
  });

  it("attributes structural fallback entries to each operation in applied order", () => {
    const before = projectFixture();
    const afterFirst = structuredClone(before);
    afterFirst.deliverables[0]!.status = "in-review";
    const afterSecond = structuredClone(afterFirst);
    afterSecond.sidecars[0]!.sha256 = "b".repeat(64);

    const diff = buildSemanticDiff(
      before,
      afterSecond,
      [emptyApplication(afterFirst), emptyApplication(afterSecond)],
      [
        applied("deliverable.review", { deliverableId: "dlv_aaaaaaaaaa" }),
        applied("sidecar.register", { name: "annotations" }),
      ],
    );

    expect(diff.entries.map(({ entityId, op }) => ({ entityId, op }))).toEqual([
      { entityId: "dlv_aaaaaaaaaa", op: "deliverable.review" },
      { entityId: "annotations", op: "sidecar.register" },
    ]);
  });

  it("reports word ranges, affected layers/deliverables, and orphan warnings", () => {
    const before = projectFixture();
    const after = structuredClone(before);
    after.sequences[0]!.clips[0]!.source.out.frames = 20;
    const operation = applied("transcript.range.remove", {
      wordRange: { fromWord: "w000010", toWord: "w000020" },
    }, ["clp_aaaaaaaaaa"]);
    const application: ClipApplication = {
      ...emptyApplication(after),
      affected: ["clp_aaaaaaaaaa"],
      mutations: [{
        entityId: "clp_aaaaaaaaaa",
        entityType: "clip",
        change: "modified",
        fields: [{
          field: "source.out",
          before: { frames: 24, fps: "24/1" },
          after: { frames: 20, fps: "24/1" },
        }],
      }],
    };

    const diff = buildSemanticDiff(before, after, [application], [operation], [{
      owner: "beat_aaaaaaaaaa",
      anchor: "clip:clp_aaaaaaaaaa@src=23f",
      anchorPath: "/anchor",
      reason: "clip-deleted",
    }]);

    expect(diff.stats).toMatchObject({
      affectedLayers: ["lyr_aaaaaaaaaa"],
      affectedWordRanges: [{ fromWord: "w000010", toWord: "w000020" }],
      affectedDeliverables: ["dlv_aaaaaaaaaa"],
    });
    expect(diff.orphanedAnchors).toEqual([expect.objectContaining({
      owner: "beat_aaaaaaaaaa",
      reason: "clip-deleted",
    })]);
  });
});

describe("proposal risk escalation", () => {
  function diffWith(entries: SemanticDiff["entries"], durationFrames = 0): SemanticDiff {
    return {
      base: "rev_00001",
      entries,
      orphanedAnchors: [],
      stats: {
        durationDelta: { frames: durationFrames, fps: "24/1" },
        clipsAdded: 0,
        clipsRemoved: entries.filter(({ entityType, change }) =>
          entityType === "clip" && change === "removed").length,
        clipsModified: entries.filter(({ entityType, change }) =>
          entityType === "clip" && change === "modified").length,
        affectedLayers: [],
        affectedWordRanges: [],
        affectedDeliverables: [],
      },
    };
  }

  const entry = (
    entityId: string,
    entityType: SemanticDiff["entries"][number]["entityType"],
    change: SemanticDiff["entries"][number]["change"],
    before?: unknown,
  ): SemanticDiff["entries"][number] => ({
    summary: "change",
    op: "test.change",
    anchors: [entityId],
    entityId,
    entityType,
    change,
    fields: before === undefined ? [] : [{ field: "$entity", before }],
  });

  it("escalates batches touching more than 20 clips", () => {
    const project = projectFixture();
    const entries = Array.from({ length: 21 }, (_, index) => entry(
      [
        "clp",
        `${"a".repeat(9)}${String.fromCharCode("a".charCodeAt(0) + index)}`,
      ].join("_"),
      "clip",
      "modified",
    ));
    expect(assessBatchRisk(
      project,
      [applied("clip.trim", {})],
      diffWith(entries),
      "ui",
    )).toBe("consequential");
  });

  it("escalates removal over 30 seconds and removal of a non-empty layer", () => {
    const project = projectFixture();
    expect(assessBatchRisk(
      project,
      [applied("clip.remove", {})],
      diffWith([entry("clp_aaaaaaaaaa", "clip", "removed")], -721),
      "ui",
    )).toBe("consequential");
    expect(assessBatchRisk(
      project,
      [applied("layer.remove", { layerId: "lyr_aaaaaaaaaa" })],
      diffWith([entry("lyr_aaaaaaaaaa", "layer", "removed", project.layers[0])]),
      "ui",
    )).toBe("consequential");
  });

  it("counts removed duration without additions cancelling it", () => {
    const before = projectFixture();
    before.sequences[0]!.clips = [before.sequences[0]!.clips[0]!];
    before.sequences[0]!.clips[0]!.source.out.frames = 960;
    const after = structuredClone(before);
    after.sequences[0]!.clips[0]!.id = "clp_cccccccccc";
    const diff = buildSemanticDiff(before, after, [], []);
    expect(diff.stats.durationDelta.frames).toBe(0);

    expect(assessBatchRisk(
      before,
      [applied("clip.replace", {})],
      diff,
      "ui",
      [],
      "normal",
      after,
    )).toBe("consequential");
  });

  it("does not treat lossless split identity changes as removed duration", () => {
    const before = projectFixture();
    before.sequences[0]!.clips = [before.sequences[0]!.clips[0]!];
    before.sequences[0]!.clips[0]!.source.out.frames = 960;
    const after = structuredClone(before);
    after.sequences[0]!.clips[0]!.source.out.frames = 120;
    const second = structuredClone(after.sequences[0]!.clips[0]!);
    second.id = "clp_cccccccccc";
    second.source = {
      in: { frames: 120, fps: "24/1" },
      out: { frames: 960, fps: "24/1" },
    };
    after.sequences[0]!.clips.push(second);
    const operation = applied("clip.split", { clipId: "clp_aaaaaaaaaa", at: 120 });
    const diff = buildSemanticDiff(before, after, [], [operation]);

    expect(assessBatchRisk(
      before,
      [operation],
      diff,
      "ui",
      [],
      "normal",
      after,
    )).toBe("normal");
  });

  it("escalates agent transitions unless the preset is creator-approved", () => {
    const project = projectFixture();
    const noChanges = diffWith([]);
    expect(assessBatchRisk(
      project,
      [applied("transition.set", { kind: "crossfade" })],
      noChanges,
      "agent",
      ["pre_aaaaaaaaaa"],
    )).toBe("consequential");
    expect(assessBatchRisk(
      project,
      [applied("transition.set", {
        kind: "preset",
        presetId: "pre_aaaaaaaaaa",
      })],
      noChanges,
      "agent",
      ["pre_aaaaaaaaaa"],
    )).toBe("normal");
  });
});
