import { describe, expect, it } from "vitest";
import { ASSEMBLY_REPLY_SCHEMA, validateAssemblyReply, type ReplyContext } from "./reply.js";

function context(): ReplyContext {
  const words = new Map<string, { assetId: string; state: "active" | "deleted"; order: number }>([
    ["a1", { assetId: "A", state: "active", order: 1 }],
    ["a2", { assetId: "A", state: "active", order: 2 }],
    ["a3", { assetId: "A", state: "active", order: 3 }],
    ["a4", { assetId: "A", state: "active", order: 4 }],
    ["a5", { assetId: "A", state: "active", order: 5 }],
    ["ad", { assetId: "A", state: "deleted", order: 6 }],
    ["b1", { assetId: "B", state: "active", order: 1 }],
    ["b2", { assetId: "B", state: "active", order: 2 }],
  ]);
  return {
    words,
    scriptBlocks: [{ id: "S1", section: "Intro", text: "Hello.", sentences: ["Hello."] }],
    assetIds: ["A", "B"],
  };
}

function cut(fromWord: string, toWord: string, extra: Record<string, unknown> = {}) {
  return {
    scriptBlock: "S1", scriptSentences: [0, 0], assetId: "A", fromWord, toWord, reason: "best take", ...extra,
  };
}

function plan(cuts: unknown[], flags: unknown[] = []) {
  return { status: "plan", summary: "s", tightening: null, cuts, flags };
}

function problem(value: unknown): string {
  const result = validateAssemblyReply(value, context());
  if (result.ok) throw new Error("expected failure");
  expect(result.error.code).toBe("E_ASSEMBLY_REPLY_INVALID");
  expect(result.error.retry).toBe("none");
  return result.error.message;
}

describe("validateAssemblyReply", () => {
  it("accepts a valid plan", () => {
    const reply = plan([cut("a1", "a2"), cut("a4", "a5"), cut("b1", "b2", { assetId: "B", scriptBlock: null, scriptSentences: null })],
      [{ cutIndex: 0, kind: "stitch", note: "n" }]);
    const result = validateAssemblyReply(reply, context());
    expect(result).toEqual({ ok: true, value: reply });
  });

  it("accepts a valid question list", () => {
    const reply = {
      status: "questions", summary: "s",
      questions: [
        { id: "Q1", about: null, text: "Which?", options: null },
        { id: "Q2", about: { assetId: "A", fromWord: "a1", toWord: "a2" }, text: "Keep?", options: ["yes", "no"] },
      ],
    };
    expect(validateAssemblyReply(reply, context()).ok).toBe(true);
  });

  it("rejects a deleted word", () => {
    expect(problem(plan([cut("a1", "ad")]))).toContain("ad");
  });

  it("rejects reversed word order", () => {
    expect(problem(plan([cut("a3", "a1")]))).toMatch(/order/);
  });

  it("rejects a cut spanning two assets", () => {
    expect(problem(plan([cut("a1", "b2")]))).toContain("b2");
  });

  it("rejects overlapping cuts", () => {
    expect(problem(plan([cut("a1", "a3"), cut("a3", "a5")]))).toMatch(/overlap/);
  });

  it("rejects an unknown script block", () => {
    expect(problem(plan([cut("a1", "a2", { scriptBlock: "S9" })]))).toContain("S9");
  });

  it("rejects an out-of-range flag, empty cuts, empty questions and schema violations", () => {
    expect(problem(plan([cut("a1", "a2")], [{ cutIndex: 1, kind: "other", note: "n" }]))).toMatch(/cutIndex/);
    expect(problem(plan([]))).toMatch(/cuts/);
    expect(problem({ status: "questions", summary: "s", questions: [] })).toMatch(/questions/);
    expect(problem({ status: "plan", summary: "s", extra: 1 })).toMatch(/;/);
  });
});

describe("ASSEMBLY_REPLY_SCHEMA", () => {
  it("schema is strict-compatible", () => {
    let objects = 0;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const props = record.properties;
      if (record.type === "object" || (props !== undefined && typeof props === "object")) {
        objects += 1;
        expect(record.additionalProperties).toBe(false);
        expect([...(record.required as string[])].sort()).toEqual(Object.keys(props as object).sort());
      }
      Object.values(record).forEach(walk);
    };
    walk(ASSEMBLY_REPLY_SCHEMA);
    expect(objects).toBeGreaterThan(3);
  });
});
