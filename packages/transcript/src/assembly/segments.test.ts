import { describe, expect, it } from "vitest";
import type { MarkerRecord } from "../../../core/src/index.js";
import { scriptedTranscript } from "./__fixtures__/scripted-transcript.js";
import { groupSegments, orderAssets, scoreScriptMatch, segmentTranscript } from "./segments.js";
import type { ScriptBlock } from "./types.js";

const LINE = "line one words here";

function spoken(assetId: string, ms: number, note: string): MarkerRecord {
  return {
    id: `m-${ms}`, assetId, at: { frame: Math.round((ms * 30) / 1000), fps: "30/1" },
    type: "spoken", note, detected: true, source: "spoken",
  };
}

describe("segmentTranscript", () => {
  it("splits at long pauses and spoken markers", () => {
    const sidecar = scriptedTranscript("a1", [
      { atMs: 0, text: LINE }, { atMs: 2200, text: "again" }, { atMs: 3000, text: LINE },
    ]);
    const segments = segmentTranscript({
      assetId: "a1", ordinal: 1, sidecar, markers: [spoken("a1", 2200, "again")],
    });
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.id)).toEqual(["C1.01", "C1.02", "C1.03"]);
    expect(segments[0]?.pauseBeforeMs).toBeNull();
    expect(segments[1]?.markerPhrases).toContain("again");
    // Gap from the end of "again" (2500 ms) to the retake (3000 ms); the brief's 800 ms
    // measured from the marker start rather than the previous word end.
    expect(segments[2]?.pauseBeforeMs).toBeGreaterThan(400);
    expect(segments[2]?.pauseBeforeMs).toBeLessThan(600);
    expect(segments[0]?.text).toBe(LINE);
  });

  it.each([["15 ms after the word start", 2215], ["40 ms before the word", 2160]])(
    "tolerates an off-grid marker time (%s)", (_label, ms) => {
      const sidecar = scriptedTranscript("a1", [
        { atMs: 0, text: LINE }, { atMs: 2200, text: "again" }, { atMs: 3000, text: LINE },
      ]);
      const marker = { ...spoken("a1", 0, "again"), at: { frame: (ms * 30) / 1000, fps: "30/1" } };
      const segments = segmentTranscript({ assetId: "a1", ordinal: 1, sidecar, markers: [marker] });
      expect(segments).toHaveLength(3);
      expect(segments[1]?.markerPhrases).toContain("again");
    });

  it("flags low confidence", () => {
    const sidecar = scriptedTranscript("a1", [{ atMs: 0, text: LINE, confidence: 0.3 }]);
    const [segment] = segmentTranscript({ assetId: "a1", ordinal: 1, sidecar, markers: [] });
    expect(segment?.lowConfidence).toBe(true);
    expect(segment?.confidence).toBeCloseTo(0.3);
  });
});

describe("groupSegments", () => {
  it("groups repeated lines and keeps capture order", () => {
    const segs = [1, 2].flatMap((ordinal) => segmentTranscript({
      assetId: `a${ordinal}`, ordinal, markers: [],
      sidecar: scriptedTranscript(`a${ordinal}`, [{ atMs: 0, text: LINE }]),
    }));
    const { segments, groups } = groupSegments(segs, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("G1");
    expect(groups[0]?.memberIds).toEqual(["C1.01", "C2.01"]);
    expect(segments.every((s) => s.groupId === "G1")).toBe(true);
    expect(segs[0]?.groupId).toBeNull();
  });

  it("marks short unmatched segments as asides only with a script", () => {
    const sidecar = scriptedTranscript("a1", [
      { atMs: 0, text: "he stayed home today" }, { atMs: 5000, text: "again" },
    ]);
    const segs = segmentTranscript({ assetId: "a1", ordinal: 1, sidecar, markers: [] });
    const block: ScriptBlock = {
      id: "S001", section: "A", text: "He stayed home today.", sentences: ["He stayed home today."],
    };
    const withScript = groupSegments(segs, [block]);
    expect(withScript.segments[1]?.aside).toBe(true);
    expect(withScript.segments[0]?.aside).toBe(false);
    expect(withScript.segments[0]?.scriptMatch?.block).toBe("S001");
    expect(withScript.groups[0]?.scriptBlock).toBe("S001");
    expect(groupSegments(segs, []).segments[1]?.aside).toBe(false);
    const marked = segs.map((s, i) => (i === 1 ? { ...s, markerPhrases: ["again"] } : s));
    expect(groupSegments(marked, []).segments[1]?.aside).toBe(true);
  });
});

describe("scoreScriptMatch", () => {
  it("matches a one-sentence take against a three-sentence block", () => {
    const block: ScriptBlock = {
      id: "S002", section: "A",
      text: "It was late. The rain fell. He stayed home.",
      sentences: ["It was late.", "The rain fell.", "He stayed home."],
    };
    expect(scoreScriptMatch("he stayed home", block)).toBeGreaterThanOrEqual(0.8);
  });
});

describe("orderAssets", () => {
  it("orders clips by capture time with warnings", () => {
    const ordered = orderAssets([
      { assetId: "c", fileName: "C.mp4", capturedAt: "2026-01-01T10:05:00Z", captureSource: "container", durationMs: 1000 },
      { assetId: "b", fileName: "B.mp4", capturedAt: "2026-01-01T10:00:00Z", captureSource: "container", durationMs: 1000 },
      { assetId: "a", fileName: "A.mp4", capturedAt: "2026-01-01T10:00:00Z", captureSource: "container", durationMs: 1000 },
    ]);
    expect(ordered.map((a) => a.assetId)).toEqual(["a", "b", "c"]);
    expect(ordered.map((a) => a.ordinal)).toEqual([1, 2, 3]);
    expect(ordered.map((a) => a.durationMs)).toEqual([1000, 1000, 1000]);
    expect(ordered[0]?.orderWarning).toMatch(/same capture time/);
    expect(ordered[1]?.orderWarning).toMatch(/same capture time/);
    expect(ordered[2]?.orderWarning).toBeNull();
    const mtime = orderAssets([
      { assetId: "x", fileName: "X.mp4", capturedAt: "2026-01-01T10:00:00Z", captureSource: "file-mtime", durationMs: 2500 },
    ]);
    expect(mtime[0]?.orderWarning).toMatch(/modified time/);
    expect(mtime[0]?.durationMs).toBe(2500);
  });
});
