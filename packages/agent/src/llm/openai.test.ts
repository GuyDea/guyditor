import { describe, expect, it, vi } from "vitest";
import { ASSEMBLY_REPLY_SCHEMA } from "../../../transcript/src/index.js";
import { OpenAiLlmAdapter, toOpenAiStrictSchema } from "./openai.js";
import { LlmAdapterError, textMessage, type LlmMessage, type LlmRequest } from "./types.js";

const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

const FILES: LlmMessage = {
  role: "user",
  content: [
    { type: "text", text: "hi" },
    { type: "image", mime: "image/png", data: new Uint8Array([1, 2, 3]), label: "F2", name: "storyboard.png" },
    { type: "pdf", mime: "application/pdf", data: new Uint8Array([1, 2, 3]), label: "F3", name: "deck.pdf" },
  ],
};

function req(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "gpt-5.5", effort: "medium", system: "SYS", maxOutputTokens: 1000,
    messages: [textMessage("user", "hi")], responseSchema: SCHEMA, ...over,
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
  it("sends images as data URLs and PDFs as input_file", async () => {
    const fetchFn = vi.fn(async () => ok('{"reply":{}}'));
    await new OpenAiLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).complete(req({ messages: [FILES] }));
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).input[0].content).toEqual([
      { type: "input_text", text: "hi" },
      { type: "input_text", text: "F2 (storyboard.png):" },
      { type: "input_image", image_url: "data:image/png;base64,AQID" },
      { type: "input_text", text: "F3 (deck.pdf):" },
      { type: "input_file", filename: "deck.pdf", file_data: "data:application/pdf;base64,AQID" },
    ]);
  });

  it("sends reasoning effort and strict json schema", async () => {
    const fetchFn = vi.fn(async () => ok('{"reply":{}}'));
    const signal = new AbortController().signal;
    await new OpenAiLlmAdapter({ apiKey: "sk-test", fetch: fetchFn as unknown as typeof fetch }).complete(req({ effort: "max", signal }));
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(signal);
    expect(init.headers).toEqual({ authorization: "Bearer sk-test", "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-5.5", instructions: "SYS", input: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" }, max_output_tokens: 32768 + 1000,
      text: { format: { type: "json_schema", name: "assembly_reply", schema: toOpenAiStrictSchema(SCHEMA), strict: true } },
    });
  });

  it("maps effort low and medium straight through", async () => {
    const fetchFn = vi.fn(async () => ok('{"reply":{}}'));
    const adapter = new OpenAiLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch });
    await adapter.complete(req({ effort: "low" }));
    await adapter.complete(req({ effort: "medium" }));
    const efforts = fetchFn.mock.calls.map((c) => JSON.parse(((c as unknown as [string, RequestInit])[1].body) as string).reasoning.effort);
    expect(efforts).toEqual(["low", "medium"]);
  });

  it.each([["low", 2048], ["medium", 8192], ["high", 16384], ["max", 32768]] as const)(
    "caps output at the %s reasoning budget plus the reply allowance",
    async (effort, budget) => {
      const fetchFn = vi.fn(async () => ok('{"reply":{}}'));
      await new OpenAiLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).complete(req({ effort }));
      const body = JSON.parse(((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body) as string);
      expect(body.max_output_tokens).toBe(budget + 1000);
    },
  );

  it("reports an incomplete max_output_tokens response as a non-retryable truncation", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ content: [{ type: "output_text", text: '{"reply":{"sta' }] }],
      usage: { input_tokens: 5, output_tokens: 9 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const err = await new OpenAiLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch })
      .complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmAdapterError);
    expect(err).toMatchObject({ status: null, retryable: false });
    expect((err as Error).message).toMatch(/^E_ASSEMBLY_REPLY_TRUNCATED: /u);
  });

  it("parses output_text json", async () => {
    const fetchFn = vi.fn(async () => reply({
      output: [{ type: "message", content: [{ type: "output_text", text: '{"reply":{"a":' }, { type: "refusal", text: "x" }, { type: "output_text", text: '"x"}}' }] }],
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

  it("fails when the reply envelope is missing", async () => {
    const err = await new OpenAiLlmAdapter({ apiKey: "k", fetch: (async () => ok('{"a":"x"}')) as unknown as typeof fetch })
      .complete(req()).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: "reply envelope missing", status: null, retryable: true });
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
    expect(out.type).toBe("object");
    expect(Object.keys(out.properties as object)).toEqual(["reply"]);
    expect(out.required).toEqual(["reply"]);
    expect(out.additionalProperties).toBe(false);
    expect(out.$defs).toBeDefined();
    expect((out.properties as { reply: Record<string, unknown> }).reply.$defs).toBeUndefined();
    // wrapper adds one additionalProperties and one required; every original one survives
    expect(count(out, "additionalProperties")).toBe(count(ASSEMBLY_REPLY_SCHEMA, "additionalProperties") + 1);
    expect(count(out, "required")).toBe(count(ASSEMBLY_REPLY_SCHEMA, "required") + 1);
    expect(JSON.stringify(out).includes('"additionalProperties":true')).toBe(false);
  });
});
