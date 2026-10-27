import { describe, expect, it } from "vitest";
import type { FrameTime } from "../../../core/src/index.js";
import type { TranscriptWord } from "../types.js";
import { compileAssemblyPlan, reviewMarkerAnnotations, type CompileContext } from "./compile.js";
import type { AssemblyPlan, CandidateSegment } from "./types.js";

const ASSET = "ast_aaaaaaaaaa";
const SEQ = "seq_aaaaaaaaaa";
const LAYER = "lyr_aaaaaaaaaa";
const RATE = 48000;

const at = (seconds: number) => ({ samples: Math.round(seconds * RATE), rate: RATE });

function word(start: number, end: number): TranscriptWord & { assetId: string } {
  return {
    assetId: ASSET, text: "w", punctBefore: "", punctAfter: "", start: at(start), end: at(end),
    confidence: null, alignment: "aligned", state: "active", origin: "asr",
  } as unknown as TranscriptWord & { assetId: string };
}

function segment(id: string, fromWord: string, toWord: string, start: number, end: number): CandidateSegment {
  return {
    id, assetId: ASSET, fromWord, toWord, start: at(start), end: at(end), text: "", pauseBeforeMs: null,
    confidence: null, lowConfidence: false, groupId: null, scriptMatch: null, aside: false, markerPhrases: [],
  };
}

const frames = (n: number): FrameTime => ({ frames: n, fps: "24/1" });

function ctx(over: Partial<CompileContext> = {}): CompileContext {
  return {
    sequenceId: SEQ, layerId: LAYER, fps: "24/1", existingClips: [],
    words: new Map([["w000001", word(1, 2.5)], ["w000002", word(5, 6)]]),
    segments: [segment("C1.01", "w000001", "w000001", 1, 2.5), segment("C1.02", "w000002", "w000002", 5, 6)],
    assetDurations: new Map([[ASSET, frames(24 * 60)]]),
    ...over,
  };
}

function plan(cuts: [string, string][], flags: AssemblyPlan["flags"] = []): AssemblyPlan {
  return {
    status: "plan", summary: "s", tightening: null, flags,
    cuts: cuts.map(([fromWord, toWord]) => ({
      scriptBlock: null, scriptSentences: null, assetId: ASSET, fromWord, toWord, reason: "because",
    })),
  };
}

describe("compileAssemblyPlan", () => {
  it("pads and snaps a cut to frames", () => {
    const r = compileAssemblyPlan(plan([["w000001", "w000001"]]), ctx({ segments: [segment("C1.01", "w000001", "w000001", 1, 2.5)] }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.cuts[0]?.in.frames).toBe(21);
    expect(r.value.cuts[0]?.out.frames).toBe(65);
    expect(r.value.operations[0]).toEqual({
      op: "clip.insert",
      params: {
        sequenceId: SEQ, index: 0, layerId: LAYER, evidence: "because",
        source: { assetId: ASSET, in: frames(21), out: frames(65) },
      },
    });
  });

  it("clamps padding at segment neighbours", () => {
    const words = new Map([["w000000", word(0.5, 0.95)], ["w000001", word(1, 2.5)], ["w000002", word(2.6, 3)]]);
    const segments = [
      segment("C1.01", "w000000", "w000000", 0.5, 0.95), segment("C1.02", "w000001", "w000001", 1, 2.5), segment("C1.03", "w000002", "w000002", 2.6, 3),
    ];
    const r = compileAssemblyPlan(plan([["w000001", "w000001"]]), ctx({ words, segments }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.cuts[0]?.in.frames).toBe(23); // 0.95 s * 24 = 22.8
    expect(r.value.cuts[0]?.out.frames).toBe(62); // 2.6 s * 24 = 62.4
  });

  it("clamps padding at the neighbouring active words inside one segment", () => {
    // Frame-aligned neighbours: w000000 ends at frame 23, w000003 starts at frame 71.
    const words = new Map([
      ["w000000", word(0.5, 23 / 24)], ["w000001", word(1, 2.5)], ["w000002", word(2.55, 2.9)],
      ["w000003", word(71 / 24, 3.5)],
      // A deleted word between the cut and its neighbour does not count.
      ["w000004", { ...word(0.96, 0.99), state: "deleted" as const }],
    ]);
    const segments = [segment("C1.01", "w000000", "w000003", 0.5, 3.5)];
    const r = compileAssemblyPlan(plan([["w000001", "w000002"]]), ctx({ words, segments }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    // Unclamped: 1 s - 120 ms = frame 21, 2.9 s + 200 ms = frame 74.
    expect(r.value.cuts[0]?.in.frames).toBe(23);
    expect(r.value.cuts[0]?.out.frames).toBe(71);
  });

  it("appends after existing clips", () => {
    const clip = { in: frames(0), out: frames(48) };
    const r = compileAssemblyPlan(plan([["w000001", "w000001"], ["w000002", "w000002"]]), ctx({ existingClips: [clip, clip] }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.cuts[0]?.index).toBe(2);
    expect(r.value.cuts[0]?.timelineStart.frames).toBe(96);
    expect(r.value.cuts[1]?.index).toBe(3);
    expect(r.value.cuts[1]?.timelineStart.frames).toBe(96 + 44);
    expect(r.value.cuts[0]?.extent.frames).toBe(44);
  });

  it("rejects a cut beyond asset duration", () => {
    const r = compileAssemblyPlan(plan([["w000002", "w000002"]]), ctx({ assetDurations: new Map([[ASSET, frames(24 * 5)]]) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("E_ASSEMBLY_CUT_OUT_OF_RANGE");
  });
});

describe("reviewMarkerAnnotations", () => {
  it("one annotation per flagged cut", () => {
    const r = compileAssemblyPlan(
      plan([["w000001", "w000001"], ["w000002", "w000002"]], [{ cutIndex: 1, kind: "stitch", note: "check join" }]),
      ctx(),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const anns = reviewMarkerAnnotations(r.value.cuts, {
      sequenceId: SEQ, deliverableId: "dlv_aaaaaaaaaa", aspect: "16:9", authorId: "assembly",
      now: "2026-10-27T00:00:00Z", idFactory: () => "ann_aaaaaaaaaa",
    });
    expect(anns).toHaveLength(1);
    expect(anns[0]?.anchor).toEqual({ kind: "timeline", sequenceId: SEQ, frame: r.value.cuts[1]?.timelineStart });
    expect(anns[0]?.body).toBe("stitch: check join");
    expect(anns[0]?.author).toEqual({ kind: "agent", id: "assembly" });
  });
});
