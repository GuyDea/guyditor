import { describe, expect, it, vi } from "vitest";

import { ASSEMBLY_REPLY_SCHEMA, createAssemblySession } from "../../../transcript/src/index.js";
import type { AssemblySession, ReplyContext } from "../../../transcript/src/index.js";
import { messageText, textMessage } from "../../../agent/src/index.js";
import type { LlmAdapter, LlmCompletion, LlmContentPart, LlmRequest } from "../../../agent/src/index.js";

import { runAssemblyTurn, TurnError } from "./assembly-turn.js";
import type { TurnDeps } from "./assembly-turn.js";

const ASSET = "ast_aaaaaaaaaa";
const context: ReplyContext = {
  words: new Map([
    ["w000001", { assetId: ASSET, state: "active", order: 1 }],
    ["w000002", { assetId: ASSET, state: "active", order: 2 }],
  ]),
  scriptBlocks: [],
  assetIds: [ASSET],
};
const PLAN = {
  status: "plan", summary: "s", tightening: null, flags: [],
  cuts: [{ scriptBlock: null, scriptSentences: null, assetId: ASSET, fromWord: "w000001", toWord: "w000002", reason: "r" }],
};
const QUESTIONS = { status: "questions", summary: "s", questions: [{ id: "Q1", about: null, text: "which?", options: null }] };
const BAD = { status: "plan", summary: "s", tightening: null, flags: [], cuts: [{ ...PLAN.cuts[0], fromWord: "w999999" }] };

function session(tightening: "ask" | "gentle" = "gentle"): AssemblySession {
  return {
    ...createAssemblySession({
      id: "asb_aaaaaaaaaa", now: "2026-01-01T00:00:00.000Z",
      settings: { provider: "anthropic", model: "m", effort: "medium", tightening, transport: "api" },
      assetIds: [ASSET],
    }),
    status: "conversing",
    evidence: { text: "EVIDENCE", sha256: "x", tokenEstimate: 1, assets: [], segments: [], groups: [], scriptBlocks: [], notes: [] },
  };
}

function scripted(...replies: unknown[]) {
  const requests: LlmRequest[] = [];
  const complete = vi.fn((request: LlmRequest): Promise<LlmCompletion> => {
    requests.push(structuredClone(request));
    const reply = replies.shift();
    if (reply instanceof Error) return Promise.reject(reply);
    if (isCompletion(reply)) return Promise.resolve(reply);
    return Promise.resolve({ reply, usage: { inputTokens: 10, outputTokens: 5 } });
  });
  const adapter = { provider: "anthropic", complete, listModels: () => Promise.resolve([]) } as unknown as LlmAdapter;
  const deps: TurnDeps = { adapter, system: "SYS", schema: ASSEMBLY_REPLY_SCHEMA, context, maxTurns: 12 };
  return { deps, requests };
}

/** A scripted entry that is already a whole completion, e.g. one carrying `reportedUsd`. */
function isCompletion(value: unknown): value is LlmCompletion {
  return typeof value === "object" && value !== null && "reply" in value && "usage" in value;
}

describe("runAssemblyTurn", () => {
  it("first turn carries the evidence", async () => {
    const { deps, requests } = scripted(QUESTIONS);
    const result = await runAssemblyTurn(session(), "go", deps);
    expect(requests[0]!.messages).toEqual([textMessage("user", "EVIDENCE\n\ngo")]);
    expect(requests[0]!.maxOutputTokens).toBe(16_000);
    expect(result.session.status).toBe("conversing");
    expect(result.session.messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
    expect(result.session.messages[0]!.content).toBe("go");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("prefixes the tightening hint once, sends the full history later and plans", async () => {
    const { deps, requests } = scripted(QUESTIONS, PLAN);
    const first = await runAssemblyTurn(session("ask"), "go", deps);
    expect(messageText(requests[0]!.messages[0]!)).toContain("Tightening preference: ask me before planning. go");
    const second = await runAssemblyTurn(first.session, "keep it", deps);
    expect(requests[1]!.messages.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
    expect(messageText(requests[1]!.messages[2]!)).toBe("keep it");
    expect(second.session.status).toBe("planned");
    expect(second.session.plan?.cuts).toHaveLength(1);
  });

  it("keeps the tightening hint on the first message for every later turn", async () => {
    const { deps, requests } = scripted(QUESTIONS, PLAN);
    const first = await runAssemblyTurn(session("ask"), "go", deps);
    await runAssemblyTurn(first.session, "keep it", deps);
    expect(messageText(requests[1]!.messages[0]!)).toBe("EVIDENCE\n\nTightening preference: ask me before planning. go");
  });

  it("sends the tightening hint on the retry after a provider failure", async () => {
    const { deps, requests } = scripted(new Error("429"), PLAN);
    const failure = await runAssemblyTurn(session("ask"), "go", deps).catch((error: unknown) => error) as TurnError;
    await runAssemblyTurn(failure.session, "go", deps);
    expect(messageText(requests[1]!.messages[0]!)).toBe("EVIDENCE\n\nTightening preference: ask me before planning. go");
  });

  it("retries once on an invalid reply then succeeds", async () => {
    const { deps, requests } = scripted(BAD, PLAN);
    const result = await runAssemblyTurn(session(), "go", deps);
    expect(result.session.status).toBe("planned");
    expect(result.session.messages.filter(({ role }) => role === "validation")).toHaveLength(1);
    expect(requests[1]!.messages.map(({ role }) => role)).toEqual(["user", "assistant", "validation"]);
    expect(messageText(requests[1]!.messages[2]!)).toContain("w999999");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it("fails after the second invalid reply", async () => {
    const { deps, requests } = scripted(BAD, BAD);
    const failure = await runAssemblyTurn(session(), "go", deps).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TurnError);
    expect((failure as TurnError).message).toMatch(/^E_ASSEMBLY_REPLY_INVALID: /);
    expect((failure as TurnError).session.messages.map(({ role }) => role)).toEqual(["user", "assistant", "validation", "assistant", "validation"]);
    expect(requests).toHaveLength(2);
  });

  it("reports a provider failure with the user message kept", async () => {
    const { deps } = scripted(new Error("429"));
    const failure = await runAssemblyTurn(session(), "go", deps).catch((error: unknown) => error) as TurnError;
    expect(failure.kind).toBe("provider");
    expect(failure.session.messages.map(({ role }) => role)).toEqual(["user"]);
  });

  it("stops at the turn limit before calling the adapter", async () => {
    const { deps, requests } = scripted(QUESTIONS, QUESTIONS);
    const limited = { ...deps, maxTurns: 1 };
    const first = await runAssemblyTurn(session(), "go", limited);
    await expect(runAssemblyTurn(first.session, "again", limited)).rejects.toThrow("E_ASSEMBLY_TURN_LIMIT");
    expect(requests).toHaveLength(1);
  });

  it("requires evidence", async () => {
    const { deps } = scripted(PLAN);
    await expect(runAssemblyTurn({ ...session(), evidence: null }, "go", deps)).rejects.toThrow("E_ASSEMBLY_STATE");
  });

  it("attachments ride on the first user message on every turn", async () => {
    const image: LlmContentPart = { type: "image", mime: "image/png", data: new Uint8Array([1, 2, 3]), label: "F1", name: "dot.png" };
    const { deps, requests } = scripted(QUESTIONS, QUESTIONS);
    const withAttachments = { ...deps, attachments: [image] };
    const first = await runAssemblyTurn(session(), "go", withAttachments);
    await runAssemblyTurn(first.session, "keep it", withAttachments);
    for (const request of requests) {
      expect(request.messages[0]!.content).toEqual([{ type: "text", text: expect.stringContaining("go") as string }, image]);
    }
    expect(requests[1]!.messages[2]!.content).toEqual([{ type: "text", text: "keep it" }]);
  });

  it("sums reported cost across the validation retry", async () => {
    const { deps } = scripted(
      { reply: BAD, usage: { inputTokens: 0, outputTokens: 0 }, reportedUsd: 0.1 },
      { reply: PLAN, usage: { inputTokens: 0, outputTokens: 0 }, reportedUsd: 0.2 },
    );
    const result = await runAssemblyTurn(session(), "go", deps);
    expect(result.usage.reportedUsd).toBeCloseTo(0.3, 9);
  });
});
