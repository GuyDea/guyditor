import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { projectFixture } from "../../core/src/project/test-fixtures.js";
import {
  buildRefreshOperation,
  discoverShortCandidates,
  resolveDerivationSources,
  writeCandidateCache,
} from "./deliverable-service.js";
import type { DeliverableTranscript } from "./deliverable-service.js";

function transcript(): DeliverableTranscript {
  return {
    assetId: "ast_aaaaaaaaaa",
    words: [
      { id: "w000001", text: "Why", punctAfter: "", state: "active", start: { samples: 0, rate: 48_000 }, end: { samples: 12_000, rate: 48_000 } },
      { id: "w000002", text: "does", punctAfter: "", state: "active", start: { samples: 12_000, rate: 48_000 }, end: { samples: 24_000, rate: 48_000 } },
      { id: "w000003", text: "this", punctAfter: "", state: "active", start: { samples: 24_000, rate: 48_000 }, end: { samples: 36_000, rate: 48_000 } },
      { id: "w000004", text: "work", punctAfter: "?", state: "active", start: { samples: 36_000, rate: 48_000 }, end: { samples: 48_000, rate: 48_000 } },
      { id: "w000005", text: "So", punctAfter: "", state: "active", start: { samples: 48_000, rate: 48_000 }, end: { samples: 60_000, rate: 48_000 } },
      { id: "w000006", text: "it", punctAfter: "", state: "active", start: { samples: 60_000, rate: 48_000 }, end: { samples: 72_000, rate: 48_000 } },
      { id: "w000007", text: "wins", punctAfter: ".", state: "active", start: { samples: 72_000, rate: 48_000 }, end: { samples: 96_000, rate: 48_000 } },
    ],
  };
}

describe("deliverable selection resolution", () => {
  it("normalizes transcript, clip, timeline, and beat selections to SourceRangeRef", () => {
    const project = projectFixture();
    project.beats = [
      { id: "beat_aaaaaaaaaa", name: "hook", anchor: "word:w000001" },
      { id: "beat_bbbbbbbbbb", name: "payoff", anchor: "word:w000005" },
    ];
    const source = transcript();
    const selections = [
      { words: { startWordId: "w000001", endWordId: "w000004" } },
      { clips: ["clp_aaaaaaaaaa"] },
      { timelineRange: { start: { frames: 0, fps: "24/1" }, end: { frames: 12, fps: "24/1" } } },
      { beats: ["beat_aaaaaaaaaa", "beat_bbbbbbbbbb"] },
    ] as const;

    for (const selection of selections) {
      const resolved = resolveDerivationSources(project, [source], selection);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.value).not.toHaveLength(0);
      expect(resolved.value[0]).toMatchObject({
        assetId: "ast_aaaaaaaaaa",
        longformClipId: "clp_aaaaaaaaaa",
      });
    }
  });
});

describe("candidate discovery", () => {
  it("uses disclosed deterministic hook/coherence/payoff scoring", () => {
    const project = projectFixture();
    project.sequences[0]!.clips[0]!.source.out.frames = 48;
    project.sequences[0]!.clips.splice(1);
    project.beats = [
      { id: "beat_aaaaaaaaaa", name: "hook", anchor: "word:w000001" },
      { id: "beat_bbbbbbbbbb", name: "payoff", anchor: "word:w000005" },
    ];
    const first = discoverShortCandidates({
      project,
      transcripts: [transcript()],
      profile: "youtube-shorts@1.0.0",
      duration: { minSeconds: 1, maxSeconds: 180 },
      maxCandidates: 8,
    });
    const second = discoverShortCandidates({
      project,
      transcripts: [transcript()],
      profile: "youtube-shorts@1.0.0",
      duration: { minSeconds: 1, maxSeconds: 180 },
      maxCandidates: 8,
    });

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      words: { startWordId: "w000001", endWordId: "w000007" },
      beats: ["beat_aaaaaaaaaa", "beat_bbbbbbbbbb"],
      evidence: {
        hookLine: "Why does this work? So it wins.",
        criteria: expect.arrayContaining(["question", "conclusion-marker", "payoff-beat-final-third"]),
      },
    });
    expect(first[0]!.scores.overall).toBeCloseTo(
      0.4 * first[0]!.scores.hook + 0.35 * first[0]!.scores.coherence + 0.25 * first[0]!.scores.payoff,
      6,
    );
  });

  it("writes revision-keyed disposable candidate records outside project state", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-candidates-"));
    try {
      const project = projectFixture();
      const written = await writeCandidateCache(root, project.revision, discoverShortCandidates({
        project,
        transcripts: [transcript()],
        profile: "youtube-shorts@1.0.0",
        duration: { minSeconds: 1, maxSeconds: 180 },
      }));
      expect(written).toBe(join(root, ".guyditor", "cache", "candidates", "rev_00001.json"));
      expect(JSON.parse(await readFile(written, "utf8"))).toMatchObject({
        revision: "rev_00001",
        candidates: expect.any(Array),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("refresh planning", () => {
  it("remaps dependency words while preserving local derivative clips", () => {
    const project = projectFixture();
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "short",
      clips: [
        {
          id: "clp_cccccccccc",
          asset: "ast_aaaaaaaaaa",
          source: { in: { frames: 0, fps: "24/1" }, out: { frames: 24, fps: "24/1" } },
        },
        {
          id: "clp_dddddddddd",
          asset: "ast_aaaaaaaaaa",
          origin: "local",
          source: { in: { frames: 0, fps: "24/1" }, out: { frames: 4, fps: "24/1" } },
        },
      ],
    });
    project.layers.push({ id: "lyr_bbbbbbbbbb", kind: "video", name: "short", order: 1, enabled: true, locked: false, sequence: "seq_bbbbbbbbbb" });
    project.deliverables.push({
      id: "dlv_bbbbbbbbbb",
      kind: "short",
      name: "short",
      profile: "youtube-shorts@1.0.0",
      sequenceId: "seq_bbbbbbbbbb",
      status: "stale",
      dependencies: [{
        derivativeClipId: "clp_cccccccccc",
        source: {
          assetId: "ast_aaaaaaaaaa",
          range: { start: { frames: 0, fps: "24/1" }, end: { frames: 24, fps: "24/1" } },
          words: { startWordId: "w000001", endWordId: "w000004" },
          longformClipId: "clp_aaaaaaaaaa",
        },
      }],
      staleReasons: [{ transactionId: "txn_aaaaaaaaaa", revision: "rev_00002", affected: [], detectedAt: "2026-07-22T00:00:00Z" }],
    });
    const source = transcript();
    source.words[1]!.state = "deleted";
    const refreshed = buildRefreshOperation({ project, transcripts: [source], deliverableId: "dlv_bbbbbbbbbb", history: [] });

    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.value.params["clips"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "clp_dddddddddd", origin: "local" }),
    ]));
    expect(refreshed.value.params["dependencies"]).toEqual([expect.objectContaining({
      derivativeClipId: "clp_cccccccccc",
      source: expect.objectContaining({
        words: { startWordId: "w000001", endWordId: "w000004" },
        range: { start: { frames: 0, fps: "24/1" }, end: { frames: 24, fps: "24/1" } },
      }),
    })]);

    for (const word of source.words.slice(0, 4)) word.state = "deleted";
    const fullyDeleted = buildRefreshOperation({
      project,
      transcripts: [source],
      deliverableId: "dlv_bbbbbbbbbb",
      history: [],
    });
    expect(fullyDeleted.ok).toBe(true);
    if (!fullyDeleted.ok) return;
    expect(fullyDeleted.value.params["orphaned"]).toEqual([{
      transactionId: "txn_aaaaaaaaaa",
      explanation: expect.stringContaining("clp_cccccccccc"),
    }]);
  });
});
