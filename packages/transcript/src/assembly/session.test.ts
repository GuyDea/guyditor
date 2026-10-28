import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { isId } from "../../../core/src/index.js";
import type { AssemblySession } from "./index.js";
import {
  assemblySidecarRef,
  createAssemblySession,
  parseAssemblySession,
  serializeAssemblySession,
} from "./index.js";

function fresh() {
  return createAssemblySession({
    id: "asb_aaaaaaaaaa",
    now: "2026-10-27T10:00:00.000Z",
    settings: { provider: "stub", model: "stub-1", effort: "medium", tightening: "ask", transport: "api" },
    assetIds: ["ast_aaaaaaaaaa", "ast_bbbbbbbbbb"],
  });
}

function populated(): AssemblySession {
  const session = fresh();
  const flag = { cutIndex: 0, kind: "stitch" as const, note: "join is audible" };
  const plan = {
    status: "plan" as const,
    summary: "Two cuts.",
    tightening: "gentle" as const,
    cuts: [
      { scriptBlock: "S001", scriptSentences: [0, 1] as [number, number], assetId: "ast_aaaaaaaaaa", fromWord: "w000001", toWord: "w000010", reason: "best take" },
      { scriptBlock: null, scriptSentences: null, assetId: "ast_bbbbbbbbbb", fromWord: "w000002", toWord: "w000008", reason: "aside kept" },
    ],
    flags: [flag],
  };
  return {
    ...session,
    inputs: {
      ...session.inputs,
      files: [
        {
          label: "F1", name: "script.md", path: "sidecars/context/asb_aaaaaaaaaa/F1-script.md", sha256: "2".repeat(64),
          bytes: 120, mime: "text/markdown", kind: "text", sent: true, unsentReason: null, pages: null, role: "script",
        },
        {
          label: "F2", name: "dot.png", path: "sidecars/context/asb_aaaaaaaaaa/F2-dot.png", sha256: "3".repeat(64),
          bytes: 68, mime: "image/png", kind: "image", sent: true, unsentReason: null, pages: null, role: "context",
        },
      ],
      script: { mode: "label", label: "F1" },
      nextFileLabel: 3,
    },
    status: "proposed",
    updatedAt: "2026-10-27T10:05:00.000Z",
    auditSessionId: "ses_aaaaaaaaaa",
    externalAcknowledged: true,
    evidence: {
      text: "evidence text",
      sha256: "1".repeat(64),
      tokenEstimate: 1234,
      assets: [
        { assetId: "ast_aaaaaaaaaa", ordinal: 1, fileName: "a.mp4", capturedAt: "2026-10-27T09:00:00.000Z", captureSource: "container", durationMs: 60000, orderWarning: null },
        { assetId: "ast_bbbbbbbbbb", ordinal: 2, fileName: "b.mp4", capturedAt: "2026-10-27T09:10:00.000Z", captureSource: "file-mtime", durationMs: 30000, orderWarning: "clock skew" },
      ],
      segments: [
        { id: "C1.01", assetId: "ast_aaaaaaaaaa", fromWord: "w000001", toWord: "w000010", start: { samples: 0, rate: 48000 }, end: { samples: 96000, rate: 48000 }, text: "hello there", pauseBeforeMs: null, confidence: 0.9, lowConfidence: false, groupId: "G1", scriptMatch: { block: "S001", score: 0.8 }, aside: false, markerPhrases: [] },
        { id: "C2.01", assetId: "ast_bbbbbbbbbb", fromWord: "w000002", toWord: "w000008", start: { samples: 100, rate: 48000 }, end: { samples: 48000, rate: 48000 }, text: "um, off script", pauseBeforeMs: 400, confidence: null, lowConfidence: true, groupId: null, scriptMatch: null, aside: true, markerPhrases: ["take two"] },
      ],
      groups: [{ id: "G1", memberIds: ["C1.01"], scriptBlock: "S001" }],
      scriptBlocks: [
        { id: "S001", section: "Intro", text: "Hello there. Welcome.", sentences: ["Hello there.", "Welcome."] },
        { id: "S002", section: "Body", text: "Main point.", sentences: ["Main point."] },
      ],
      notes: ["one asset has low confidence"],
    },
    messages: [
      { role: "user", content: "assemble it", reply: null, usage: null, at: "2026-10-27T10:01:00.000Z" },
      {
        role: "assistant", content: "questions", at: "2026-10-27T10:02:00.000Z",
        usage: { inputTokens: 100, outputTokens: 20, usd: 0.01, estimated: true },
        reply: {
          status: "questions", summary: "Need input",
          questions: [
            { id: "Q1", about: { assetId: "ast_aaaaaaaaaa", fromWord: "w000001", toWord: "w000010" }, text: "Which take?", options: ["first", "second"] },
            { id: "Q2", about: null, text: "Anything else?", options: null },
          ],
        },
      },
      { role: "assistant", content: "plan", reply: plan, usage: null, at: "2026-10-27T10:03:00.000Z" },
      { role: "validation", content: "all word ids resolve", reply: null, usage: null, at: "2026-10-27T10:04:00.000Z" },
    ],
    plan,
    compiled: [{
      index: 0, assetId: "ast_aaaaaaaaaa", reason: "best take", flags: [flag],
      in: { frames: 0, fps: "30/1" }, out: { frames: 60, fps: "30/1" },
      timelineStart: { frames: 0, fps: "30/1" }, extent: { frames: 60, fps: "30/1" },
    }],
    proposalId: "prp_aaaaaaaaaa",
    tighteningJobId: "job_aaaaaaaaaa",
  };
}

describe("assembly session sidecar", () => {
  it("round-trips a fresh session", () => {
    const session = fresh();
    const parsed = parseAssemblySession(serializeAssemblySession(session));
    expect(parsed).toEqual(session);
    expect(parsed.status).toBe("created");
    expect(parsed.messages.length).toBe(0);
    expect(parsed.externalAcknowledged).toBe(false);
    expect(parsed.inputs).toEqual({
      assetIds: ["ast_aaaaaaaaaa", "ast_bbbbbbbbbb"], files: [], script: { mode: "auto" }, nextFileLabel: 1,
    });
    expect(parsed.settings.transport).toBe("api");
  });

  it("rejects the pre-v2 inputs shape", () => {
    const old = JSON.parse(serializeAssemblySession(fresh())) as { inputs: Record<string, unknown> };
    old.inputs = { assetIds: ["ast_aaaaaaaaaa"], script: null };
    expect(() => parseAssemblySession(JSON.stringify(old))).toThrow(/E_ASSEMBLY_SIDECAR_INVALID/);
  });

  it("rejects a sidecar with the wrong schema id", () => {
    expect(() => parseAssemblySession('{"schema":"guyditor.transcript/v1"}')).toThrow(/E_ASSEMBLY_SIDECAR_INVALID/);
  });

  it("sidecar ref points at sidecars/assembly", () => {
    const session = fresh();
    const text = serializeAssemblySession(session);
    const ref = assemblySidecarRef(session, text);
    expect(ref.path).toBe("sidecars/assembly/asb_aaaaaaaaaa.json");
    expect(ref.sha256).toBe(createHash("sha256").update(text).digest("hex"));
  });

  it("asb is a known id prefix", () => {
    expect(isId("asb", "asb_aaaaaaaaaa")).toBe(true);
  });

  it("round-trips a populated session", () => {
    const session = populated();
    const text = serializeAssemblySession(session);
    expect(parseAssemblySession(text)).toEqual(session);
    const broken = parseAssemblySession(text) as unknown as { evidence: { segments: Record<string, unknown>[] } };
    delete broken.evidence.segments[0]!.fromWord;
    expect(() => serializeAssemblySession(broken as unknown as AssemblySession)).toThrow(/E_ASSEMBLY_SIDECAR_INVALID/);
  });
});
