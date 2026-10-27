import { describe, expect, it, vi } from "vitest";
import { ASSEMBLY_REPLY_SCHEMA } from "../../../transcript/src/index.js";
import { OpenAiLlmAdapter, toOpenAiStrictSchema } from "./openai.js";
import { LlmAdapterError, type LlmRequest } from "./types.js";

const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

function req(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "gpt-5.5", effort: "medium", system: "SYS", maxOutputTokens: 1000,
    messages: [{ role: "user", content: "hi" }], responseSchema: SCHEMA, ...over,
  };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ok = (text: string): Response => reply({
  output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 5, output_tokens: 6 },
});

function anyKey(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => anyKey(n, key));
  if (node && typeof node === "object") {
    return Object.entries(node).some(([k, v]) => k === key || anyKey(v, key));
  }
  return false;
}

function count(node: unknown, key: string): number {
  if (Array.isArray(node)) return node.reduce<number>((n, v) => n + count(v, key), 0);
  if (node && typeof node === "object") {
    return Object.entries(node).reduce((n, [k, v]) => n + (k === key ? 1 : 0) + count(v, key), 0);
  }
  return 0;
}

describe("OpenAiLlmAdapter", () => {
  it("sends reasoning effort and strict json schema", async () => {
    const fetchFn = vi.fn(async () => ok("{}"));
    const signal = new AbortController().signal;
    await new OpenAiLlmAdapter({ apiKey: "sk-test", fetch: fetchFn as unknown as typeof fetch }).complete(req({ effort: "max", signal }));
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(signal);
    expect(init.headers).toEqual({ authorization: "Bearer sk-test", "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-5.5", instructions: "SYS", input: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" }, max_output_tokens: 1000,
      text: { format: { type: "json_schema", name: "assembly_reply", schema: SCHEMA, strict: true } },
    });
  });

  it("maps effort low and medium straight through", async () => {
    const fetchFn = vi.fn(async () => ok("{}"));
    const adapter = new OpenAiLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch });
    await adapter.complete(req({ effort: "low" }));
    await adapter.complete(req({ effort: "medium" }));
    const efforts = fetchFn.mock.calls.map((c) => JSON.parse(((c as unknown as [string, RequestInit])[1].body) as string).reasoning.effort);
    expect(efforts).toEqual(["low", "medium"]);
  });

  it("parses output_text json", async () => {
    const fetchFn = vi.fn(async () => reply({
      output: [{ type: "message", content: [{ type: "output_text", text: '{"a":' }, { type: "refusal", text: "x" }, { type: "output_text", text: '"x"}' }] }],
      usage: { input_tokens: 5, output_tokens: 6 },
    }));
    const out = await new OpenAiLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).complete(req());
    expect(out).toEqual({ reply: { a: "x" }, usage: { inputTokens: 5, outputTokens: 6 } });
  });

  it("fails readably on 500 and non-JSON", async () => {
    const e500 = await new OpenAiLlmAdapter({ apiKey: "k", fetch: (async () => reply({ error: { message: "boom" } }, 500)) as unknown as typeof fetch })
      .complete(req()).catch((e: unknown) => e);
    expect(e500).toBeInstanceOf(LlmAdapterError);
    expect(e500).toMatchObject({ status: 500, retryable: true });
    expect((e500 as Error).message).toContain("500");
    expect((e500 as Error).message).toContain("boom");
    const bad = await new OpenAiLlmAdapter({ apiKey: "k", fetch: (async () => ok("not json")) as unknown as typeof fetch })
      .complete(req()).catch((e: unknown) => e);
    expect((bad as Error).message).toMatch(/non-JSON/);
    expect(bad).toMatchObject({ status: null, retryable: true });
  });

  it("lists models sorted", async () => {
    const fetchFn = vi.fn(async () => reply({ data: [{ id: "b" }, { id: "a" }] }));
    expect(await new OpenAiLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).listModels()).toEqual(["a", "b"]);
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.openai.com/v1/models");
  });
});

describe("toOpenAiStrictSchema", () => {
  it("removes oneOf and unsupported keywords, keeps strictness, does not mutate", () => {
    const before = JSON.stringify(ASSEMBLY_REPLY_SCHEMA);
    expect(anyKey(ASSEMBLY_REPLY_SCHEMA, "oneOf")).toBe(true);
    const out = toOpenAiStrictSchema(ASSEMBLY_REPLY_SCHEMA);
    expect(JSON.stringify(ASSEMBLY_REPLY_SCHEMA)).toBe(before);
    for (const k of ["oneOf", "minItems", "maxItems", "minLength", "maxLength", "pattern", "format", "minimum", "maximum"]) {
      expect(anyKey(out, k)).toBe(false);
    }
    expect(anyKey(out, "anyOf")).toBe(true);
    expect(count(out, "additionalProperties")).toBe(count(ASSEMBLY_REPLY_SCHEMA, "additionalProperties"));
    expect(count(out, "required")).toBe(count(ASSEMBLY_REPLY_SCHEMA, "required"));
    expect(count(out, "additionalProperties")).toBeGreaterThan(0);
    expect(JSON.stringify(out).includes('"additionalProperties":true')).toBe(false);
  });
});
