import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  OperationEngine,
  markAcceptedDeliverableStaleness,
  markRestylePlanStaleness,
  sourceRangesOverlap,
} from "../index.js";
import type { DependencyEntry, IdPrefix } from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

describe("FR-807 dependency staleness", () => {
  it("matches mathematical half-open overlap for random exact frame pairs", () => {
    fc.assert(fc.property(
      fc.tuple(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 1, max: 500 })),
      fc.tuple(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 1, max: 500 })),
      ([leftStart, leftLength], [rightStart, rightLength]) => {
        const leftEnd = leftStart + leftLength;
        const rightEnd = rightStart + rightLength;
        expect(sourceRangesOverlap(
          {
            start: { frames: leftStart, fps: "30000/1001" },
            end: { frames: leftEnd, fps: "30000/1001" },
          },
          {
            start: { frames: rightStart, fps: "30000/1001" },
            end: { frames: rightEnd, fps: "30000/1001" },
          },
        )).toBe(leftStart < rightEnd && rightStart < leftEnd);
      },
    ));
    expect(sourceRangesOverlap(
      { start: { frames: 0, fps: "24/1" }, end: { frames: 12, fps: "24/1" } },
      { start: { frames: 12, fps: "24/1" }, end: { frames: 20, fps: "24/1" } },
    )).toBe(false);
  });

  it("marks only an approved short overlapping an accepted long-form trim", async () => {
    const project = projectFixture();
    const dependency: DependencyEntry = {
      derivativeClipId: "clp_cccccccccc",
      source: {
        assetId: "ast_aaaaaaaaaa",
        range: {
          start: { frames: 16, fps: "24/1" },
          end: { frames: 22, fps: "24/1" },
        },
        words: { startWordId: "w000016", endWordId: "w000022" },
        longformClipId: "clp_aaaaaaaaaa",
      },
    };
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "short",
      clips: [{
        id: dependency.derivativeClipId,
        asset: dependency.source.assetId,
        source: { in: dependency.source.range.start, out: dependency.source.range.end },
      }],
    });
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "video",
      name: "short",
      order: 1,
      enabled: true,
      locked: false,
      sequence: "seq_bbbbbbbbbb",
    });
    project.deliverables.push({
      id: "dlv_bbbbbbbbbb",
      kind: "short",
      name: "Approved short",
      profile: "youtube-shorts@1.0.0",
      sequenceId: "seq_bbbbbbbbbb",
      status: "approved",
      approvedRevision: project.revision,
      dependencies: [dependency],
      publishFiles: [{ path: "exports/short.mp4", sha256: "b".repeat(64) }],
    });
    const ids = (prefix: IdPrefix) => prefix === "txn" ? "txn_bbbbbbbbbb" : `${prefix}_bbbbbbbbbb`;
    const engine = new OperationEngine(project, {
      idFactory: ids,
      now: () => new Date("2026-07-22T08:00:00Z"),
    });

    const accepted = await engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 4, fps: "24/1" },
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: false });

    expect(accepted.ok).toBe(true);
    expect(engine.currentProject.deliverables[1]).toMatchObject({
      status: "stale",
      approvedRevision: "rev_00001",
      publishFiles: [{ path: "exports/short.mp4", sha256: "b".repeat(64) }],
      staleReasons: [{
        transactionId: "txn_bbbbbbbbbb",
        revision: "rev_00002",
        detectedAt: "2026-07-22T08:00:00.000Z",
        affected: [{
          dependency,
          change: expect.stringContaining("clip.trim"),
        }],
      }],
    });
    expect(engine.currentProject.sequences[1]).toEqual(project.sequences[1]);
  });

  it("expands accepted beat and long-form layer IDs to dependency ranges", () => {
    const project = projectFixture();
    project.beats = [{ id: "beat_aaaaaaaaaa", name: "hook", anchor: "word:w000016" }];
    project.deliverables.push({
      id: "dlv_bbbbbbbbbb",
      kind: "short",
      name: "review short",
      profile: "youtube-shorts@1.0.0",
      sequenceId: "seq_bbbbbbbbbb",
      status: "in-review",
      dependencies: [{
        derivativeClipId: "clp_cccccccccc",
        source: {
          assetId: "ast_aaaaaaaaaa",
          range: { start: { frames: 0, fps: "24/1" }, end: { frames: 24, fps: "24/1" } },
          words: { startWordId: "w000010", endWordId: "w000020" },
          longformClipId: "clp_aaaaaaaaaa",
        },
      }],
    });
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "short",
      clips: [{ id: "clp_cccccccccc", asset: "ast_aaaaaaaaaa", source: { in: { frames: 0, fps: "24/1" }, out: { frames: 24, fps: "24/1" } } }],
    });
    project.layers.push({ id: "lyr_bbbbbbbbbb", kind: "video", name: "short", order: 1, enabled: true, locked: false, sequence: "seq_bbbbbbbbbb" });
    const changed = markAcceptedDeliverableStaleness({
      before: project,
      after: structuredClone(project),
      applied: [{
        op: "beat.rename",
        params: { beatId: "beat_aaaaaaaaaa" },
        summary: "Rename hook beat",
        inverse: [],
        captionImpact: "none",
        warnings: [],
        affected: ["beat_aaaaaaaaaa", "lyr_aaaaaaaaaa"],
      }],
      transactionId: "txn_bbbbbbbbbb",
      revision: "rev_00002",
      detectedAt: "2026-07-22T08:00:00Z",
    });
    expect(changed.deliverables[1]).toMatchObject({
      status: "stale",
      staleReasons: [{ affected: [{ change: expect.stringContaining("Rename hook beat") }] }],
    });
  });

  it("uses the same accepted-range engine for restyle chunks and adjacent seams", () => {
    const result = markRestylePlanStaleness({
      chunks: [{
        id: "restyle-chunk-staleness-001",
        index: 0,
        sourceRange: { startFrame: 10, endFrame: 20 },
        semanticAnchors: { start: "frame:10", end: "frame:20", boundaryKind: "range-edge" },
        durationSeconds: 10 / 24,
        estimatedCostUsd: 0.01,
        status: "approved",
      }],
      seams: [{
        id: "restyle-seam-staleness-001",
        frame: 20,
        boundary: "restyled-to-untouched",
        beforeChunkId: "restyle-chunk-staleness-001",
        treatment: { kind: "punch-in" },
        status: "applied",
        application: { chunkId: "restyle-chunk-staleness-001", atFrame: 20 },
      }],
    }, [{ start: 19, end: 21 }], {
      transactionId: "txn_bbbbbbbbbb",
      detectedAt: "2026-07-22T08:00:00Z",
    });

    expect(result.changed).toBe(true);
    expect(result.plan.chunks[0]).toMatchObject({
      status: "stale",
      stale: { reason: "source-range-overlap", transactionId: "txn_bbbbbbbbbb" },
    });
    expect(result.plan.seams[0]).toMatchObject({
      status: "review",
      review: { reason: "adjacent-chunk-stale", transactionId: "txn_bbbbbbbbbb" },
    });
    expect(result.plan.seams[0]).not.toHaveProperty("application");
  });
});
