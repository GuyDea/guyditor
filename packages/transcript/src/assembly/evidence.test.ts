import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MarkerRecord } from "../../../core/src/index.js";
import { scriptedTranscript } from "./__fixtures__/scripted-transcript.js";
import { formatClipTime, renderEvidencePackage, type EvidenceInput } from "./evidence.js";
import { parseScriptBlocks } from "./script.js";
import { groupSegments, orderAssets, segmentTranscript } from "./segments.js";

const LINE = "the quick brown fox jumps over the lazy dog";
const SCRIPT = [
  "## 1. Opening", "", "> The quick brown fox jumps over the lazy dog.", "",
  "> A completely different closing thought about gardens and rain.",
].join("\n");

function again(assetId: string, ms: number): MarkerRecord {
  return {
    id: `m-${ms}`, assetId, at: { frame: Math.round((ms * 30) / 1000), fps: "30/1" },
    type: "spoken", note: "again", detected: true, source: "spoken",
  };
}

function fixture(withScript = true): EvidenceInput {
  const scriptBlocks = withScript ? parseScriptBlocks(SCRIPT) : [];
  const assets = orderAssets([
    { assetId: "a1", fileName: "cam_0001.mov", capturedAt: "2026-10-20T14:32:07Z", captureSource: "container", durationMs: 401_000 },
    { assetId: "a2", fileName: "cam_0002.mov", capturedAt: "2026-10-20T14:40:00Z", captureSource: "file-mtime", durationMs: 65_000 },
  ]);
  const raw = [
    ...segmentTranscript({
      assetId: "a1", ordinal: 1, markers: [again("a1", 6000)],
      sidecar: scriptedTranscript("a1", [
        { atMs: 0, text: LINE, confidence: 0.94 },
        { atMs: 6000, text: "again" },
        { atMs: 9000, text: "garden rain closing thought" },
      ]),
    }),
    ...segmentTranscript({
      assetId: "a2", ordinal: 2, markers: [],
      sidecar: scriptedTranscript("a2", [{ atMs: 1000, text: LINE, confidence: 0.3 }], 48000, 100),
    }),
  ];
  const { segments, groups } = groupSegments(raw, scriptBlocks);
  return {
    projectName: "Demo", language: "en", assets, segments, groups, scriptBlocks,
    notes: ["Asset a2 was captured later."],
  };
}

describe("renderEvidencePackage", () => {
  it("renders the documented layout", () => {
    expect(renderEvidencePackage(fixture()).text).toMatchSnapshot();
  });

  it("omits the script section without a script", () => {
    const { text } = renderEvidencePackage(fixture(false));
    expect(text).not.toContain("## Script");
    expect(text).toContain("## Footage");
  });

  it("rejects packages over the token limit", () => {
    const input = { ...fixture(), notes: ["x".repeat(500_000)] };
    expect(() => renderEvidencePackage(input)).toThrow(/E_ASSEMBLY_EVIDENCE_TOO_LARGE/);
  });

  it("hash is sha256 of text", () => {
    const evidence = renderEvidencePackage(fixture());
    expect(evidence.sha256).toBe(createHash("sha256").update(evidence.text).digest("hex"));
    expect(evidence.tokenEstimate).toBe(Math.ceil(evidence.text.length / 4));
  });
});

describe("formatClipTime", () => {
  it("formats mm:ss.mmm", () => {
    expect(formatClipTime({ samples: 134.32 * 48000, rate: 48000 })).toBe("02:14.320");
  });
});
