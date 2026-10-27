import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MarkerRecord } from "../../../core/src/index.js";
import { scriptedTranscript } from "./__fixtures__/scripted-transcript.js";
import { contextFileNotes, formatClipTime, renderEvidencePackage, type EvidenceInput } from "./evidence.js";
import { parseScriptBlocks } from "./script.js";
import { groupSegments, orderAssets, segmentTranscript } from "./segments.js";
import type { ContextFile } from "./types.js";

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

const OUTLINE = "Open on the kettle, then pour and taste.";

function contextFile(label: string, name: string, kind: ContextFile["kind"], bytes: number, sent = true): ContextFile {
  return {
    label, name, path: `sidecars/context/asb_aaaaaaaaaa/${label}-${name}`, sha256: "0".repeat(64), bytes,
    mime: "x", kind, sent, unsentReason: sent ? null : "unsupported type", pages: kind === "pdf" ? 3 : null,
    role: "context",
  };
}

const CONTEXT_FILES = [
  contextFile("F1", "outline.md", "text", 41),
  contextFile("F2", "storyboard.png", "image", 1_153_434),
  contextFile("F3", "budget.xlsx", "other", 40_960, false),
];

function fixture(withScript = true, files: ContextFile[] = CONTEXT_FILES): EvidenceInput {
  const scriptBlocks = withScript ? parseScriptBlocks(SCRIPT) : [];
  const assets = orderAssets([
    { assetId: "ast_aaaaaaaaaa", fileName: "cam_0001.mov", capturedAt: "2026-10-20T14:32:07Z", captureSource: "container", durationMs: 401_000 },
    { assetId: "ast_bbbbbbbbbb", fileName: "cam_0002.mov", capturedAt: "2026-10-20T14:40:00Z", captureSource: "file-mtime", durationMs: 65_000 },
  ]);
  const raw = [
    ...segmentTranscript({
      assetId: "ast_aaaaaaaaaa", ordinal: 1, markers: [again("ast_aaaaaaaaaa", 6000)],
      sidecar: scriptedTranscript("ast_aaaaaaaaaa", [
        { atMs: 0, text: LINE, confidence: 0.94 },
        { atMs: 6000, text: "again" },
        { atMs: 9000, text: "garden rain closing thought" },
      ]),
    }),
    ...segmentTranscript({
      assetId: "ast_bbbbbbbbbb", ordinal: 2, markers: [],
      sidecar: scriptedTranscript("ast_bbbbbbbbbb", [{ atMs: 1000, text: LINE, confidence: 0.3 }], 48000, 100),
    }),
  ];
  const { segments, groups } = groupSegments(raw, scriptBlocks);
  return {
    projectName: "Demo", language: "en", assets, segments, groups, scriptBlocks,
    contextFiles: contextFileNotes(files, "api", () => OUTLINE),
    notes: ["Asset ast_bbbbbbbbbb was captured later."],
  };
}

describe("renderEvidencePackage", () => {
  it("renders the documented layout", () => {
    expect(renderEvidencePackage(fixture()).text).toMatchSnapshot();
  });

  it("cites asset and word ids", () => {
    const { text } = renderEvidencePackage(fixture());
    expect(text).toContain("asset ast_aaaaaaaaaa");
    expect(text).toContain("asset ast_bbbbbbbbbb");
    expect(text).toMatch(/words w\d{6}–w\d{6}/u);
  });

  it("omits the script section without a script", () => {
    const { text } = renderEvidencePackage(fixture(false));
    expect(text).not.toContain("## Script");
    expect(text).toContain("## Footage");
  });

  it("lists context files after the script and before the footage", () => {
    const { text } = renderEvidencePackage(fixture());
    const script = text.indexOf("## Script");
    const files = text.indexOf("## Context files");
    const footage = text.indexOf("## Footage");
    expect(script).toBeGreaterThanOrEqual(0);
    expect(files).toBeGreaterThan(script);
    expect(footage).toBeGreaterThan(files);
    const bare = renderEvidencePackage(fixture(false)).text;
    expect(bare.indexOf("## Context files")).toBeLessThan(bare.indexOf("## Footage"));
  });

  it("inlines text, sizes binaries and says why a file is not sent", () => {
    const { text } = renderEvidencePackage(fixture());
    expect(text).toContain(`### F1  outline.md   text   8 words   role: context\n${OUTLINE}\n`);
    expect(text).toContain("### F2  storyboard.png   image   1.1 MB   (attached as an image input)");
    expect(text).toContain("### F3  budget.xlsx   other   40 KB   (not sent — unsupported type)");
  });

  it("omits the section without files", () => {
    const { text } = renderEvidencePackage(fixture(true, []));
    expect(text).not.toContain("## Context files");
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

describe("contextFileNotes", () => {
  it("leaves the script to the script blocks and counts words with a thousands separator", () => {
    const script = { ...contextFile("F1", "script.md", "text", 9000), role: "script" as const };
    const long = contextFile("F2", "notes.md", "text", 9000);
    const read = (f: ContextFile): string => (f.label === "F2" ? "word ".repeat(1240) : "one two");
    const [scriptNote, longNote] = contextFileNotes([script, long], "api", read);
    expect(scriptNote).toMatchObject({ role: "script", text: null, note: "rendered as the script blocks above" });
    expect(longNote).toMatchObject({ role: "context", words: 1240, note: null });
    const { text } = renderEvidencePackage({ ...fixture(false, []), contextFiles: [scriptNote!, longNote!] });
    expect(text).toContain("### F1  script.md   text   2 words   role: script\n");
    expect(text).toContain("### F2  notes.md   text   1,240 words   role: context\n");
  });

  it("describes a pdf by transport", () => {
    const pdf = [contextFile("F4", "brief.pdf", "pdf", 2048)];
    expect(contextFileNotes(pdf, "api", () => "")[0]?.note).toBe("attached as a document input");
    expect(contextFileNotes(pdf, "cli", () => "")[0]?.note).toBe("attached by path for CLI providers: F4-brief.pdf");
  });
});

describe("formatClipTime", () => {
  it("formats mm:ss.mmm", () => {
    expect(formatClipTime({ samples: 134.32 * 48000, rate: 48000 })).toBe("02:14.320");
  });
});
