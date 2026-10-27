import { describe, expect, it } from "vitest";
import {
  ASSEMBLY_REPLY_SCHEMA, groupSegments, orderAssets, parseScriptBlocks, renderEvidencePackage,
  segmentTranscript, type AssemblyPlan, type AssemblyReply,
} from "../../../transcript/src/index.js";
import { scriptedTranscript } from "../../../transcript/src/assembly/__fixtures__/scripted-transcript.js";
import { createLlmAdapter, type LlmRequest } from "./types.js";

const LINE = "the quick brown fox jumps over the lazy dog";
const SCRIPT = [
  "## 1. Opening", "", "> The quick brown fox jumps over the lazy dog.", "",
  "> A completely different closing thought about gardens and rain.",
].join("\n");

function evidence(withAside: boolean): string {
  const scriptBlocks = parseScriptBlocks(SCRIPT);
  const assets = orderAssets([
    { assetId: "ast_aaaaaaaaaa", fileName: "cam_0001.mov", capturedAt: "2026-10-20T14:32:07Z", captureSource: "container", durationMs: 401_000 },
    { assetId: "ast_bbbbbbbbbb", fileName: "cam_0002.mov", capturedAt: "2026-10-20T14:40:00Z", captureSource: "container", durationMs: 65_000 },
  ]);
  const raw = [
    ...segmentTranscript({
      assetId: "ast_aaaaaaaaaa", ordinal: 1, markers: [],
      sidecar: scriptedTranscript("ast_aaaaaaaaaa", [
        { atMs: 0, text: LINE },
        ...(withAside ? [{ atMs: 6000, text: "garden rain closing thought" }] : []),
      ]),
    }),
    ...segmentTranscript({
      assetId: "ast_bbbbbbbbbb", ordinal: 2, markers: [],
      sidecar: scriptedTranscript("ast_bbbbbbbbbb", [{ atMs: 1000, text: LINE }], 48000, 100),
    }),
  ];
  const { segments, groups } = groupSegments(raw, scriptBlocks);
  return renderEvidencePackage({
    projectName: "Demo", language: "en", assets, segments, groups, scriptBlocks, notes: [],
  }).text;
}

function request(text: string, assistantTurns = 0): LlmRequest {
  const messages: LlmRequest["messages"] = [{ role: "user", content: text }];
  for (let i = 0; i < assistantTurns; i += 1) {
    messages.push({ role: "assistant", content: "{}" }, { role: "user", content: "Instruction, drop it" });
  }
  return {
    model: "stub-model", effort: "low", system: "sys", messages,
    responseSchema: ASSEMBLY_REPLY_SCHEMA, maxOutputTokens: 1000,
  };
}

const stub = createLlmAdapter("stub", { apiKey: "" });

describe("StubLlmAdapter", () => {
  it("asks about an aside on the first turn", async () => {
    const text = evidence(true);
    expect(text).toContain("ASIDE?");
    const { reply, usage } = await stub.complete(request(text));
    const typed = reply as AssemblyReply;
    expect(typed.status).toBe("questions");
    if (typed.status !== "questions") return;
    expect(typed.questions).toHaveLength(1);
    expect(typed.questions[0]!.id).toBe("Q1");
    expect(typed.questions[0]!.about?.assetId).toBe("ast_aaaaaaaaaa");
    expect(typed.questions[0]!.options).toEqual(["Instruction, drop it", "It is a line, keep it"]);
    expect(usage.outputTokens).toBe(200);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  it("plans latest-wins after the answer", async () => {
    const { reply } = await stub.complete(request(evidence(true), 1));
    const plan = reply as AssemblyPlan;
    expect(plan.status).toBe("plan");
    expect(plan.tightening).toBeNull();
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]).toMatchObject({
      scriptBlock: "S001", assetId: "ast_bbbbbbbbbb", fromWord: "w000100", toWord: "w000108",
      reason: "Latest of 2 attempts (G1)",
    });
    expect(plan.flags).toEqual([expect.objectContaining({ cutIndex: 0, kind: "other" })]);
  });

  it("plans immediately without asides", async () => {
    const { reply } = await stub.complete(request(evidence(false)));
    expect((reply as AssemblyReply).status).toBe("plan");
  });

  it("is deterministic and lists one model", async () => {
    const a = await stub.complete(request(evidence(false)));
    const b = await stub.complete(request(evidence(false)));
    expect(a).toEqual(b);
    expect(await stub.listModels()).toEqual(["stub-model"]);
  });

  it("createLlmAdapter: stub provider", () => {
    expect(stub.provider).toBe("stub");
  });
});
