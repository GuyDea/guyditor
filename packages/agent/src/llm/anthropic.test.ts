import { describe, expect, it, vi } from "vitest";
import { AnthropicLlmAdapter } from "./anthropic.js";
import { createLlmAdapter, LlmAdapterError, textMessage, type LlmMessage, type LlmRequest } from "./types.js";
import { OpenAiLlmAdapter } from "./openai.js";

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
    model: "claude-opus-5-5", effort: "medium", system: "SYS", maxOutputTokens: 1000,
    messages: [textMessage("user", "hi")], responseSchema: SCHEMA, ...over,
  };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("AnthropicLlmAdapter", () => {
  it("sends thinking budget and the reply tool", async () => {
    const fetchFn = vi.fn(async () => reply({ content: [{ type: "tool_use", name: "assembly_reply", input: {} }], usage: { input_tokens: 1, output_tokens: 2 } }));
    const adapter = new AnthropicLlmAdapter({ apiKey: "sk-test", fetch: fetchFn as unknown as typeof fetch });
    const signal = new AbortController().signal;
    await adapter.complete(req({ effort: "high", signal }));
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(signal);
    expect(init.headers).toEqual({ "x-api-key": "sk-test", "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "claude-opus-5-5", max_tokens: 16384 + 1000, system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 16384 },
      tools: [{ name: "assembly_reply", description: "Return the assembly reply.", input_schema: SCHEMA }],
      tool_choice: { type: "auto" },
    });
  });

  it.each([["low", 2048], ["medium", 8192], ["high", 16384], ["max", 32768]] as const)("effort %s budget", async (effort, budget) => {
    const fetchFn = vi.fn(async () => reply({ content: [{ type: "tool_use", input: {} }], usage: { input_tokens: 0, output_tokens: 0 } }));
    await new AnthropicLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch, baseUrl: "http://x" }).complete(req({ effort }));
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x/v1/messages");
    expect(JSON.parse(init.body as string).thinking.budget_tokens).toBe(budget);
  });

  it("returns the tool_use input and usage", async () => {
    const fetchFn = vi.fn(async () => reply({
      content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "ok" }, { type: "tool_use", name: "assembly_reply", input: { a: "x" } }],
      usage: { input_tokens: 11, output_tokens: 22 },
    }));
    const out = await new AnthropicLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).complete(req());
    expect(out).toEqual({ reply: { a: "x" }, usage: { inputTokens: 11, outputTokens: 22 } });
  });

  it("fails readably on 429", async () => {
    const fetchFn = vi.fn(async () => reply({ error: { message: "slow down" } }, 429));
    const err = await new AnthropicLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmAdapterError);
    expect((err as LlmAdapterError).retryable).toBe(true);
    expect((err as LlmAdapterError).status).toBe(429);
    expect((err as LlmAdapterError).message).toContain("429");
    expect((err as LlmAdapterError).message).toContain("slow down");
  });

  it("marks 400 as not retryable and network failure as retryable", async () => {
    const bad = new AnthropicLlmAdapter({ apiKey: "k", fetch: (async () => reply({}, 400)) as unknown as typeof fetch });
    expect(await bad.complete(req()).catch((e: unknown) => e)).toMatchObject({ status: 400, retryable: false });
    const down = new AnthropicLlmAdapter({ apiKey: "k", fetch: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    expect(await down.complete(req()).catch((e: unknown) => e)).toMatchObject({ message: "ECONNRESET", status: null, retryable: true });
  });

  it("reports stop_reason max_tokens as a non-retryable truncation", async () => {
    const fetchFn = vi.fn(async () => reply({
      stop_reason: "max_tokens",
      content: [{ type: "thinking", thinking: "..." }, { type: "tool_use", name: "assembly_reply", input: { a: "x" } }],
      usage: { input_tokens: 1, output_tokens: 9192 },
    }));
    const err = await new AnthropicLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmAdapterError);
    expect(err).toMatchObject({ status: null, retryable: false });
    expect((err as Error).message).toMatch(/^E_ASSEMBLY_REPLY_TRUNCATED: /u);
  });

  it("fails when no tool call", async () => {
    const fetchFn = vi.fn(async () => reply({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const err = await new AnthropicLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).complete(req()).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: "model did not call assembly_reply", status: null, retryable: true });
  });

  it("lists models", async () => {
    const fetchFn = vi.fn(async () => reply({ data: [{ id: "b" }, { id: "a" }] }));
    expect(await new AnthropicLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).listModels()).toEqual(["a", "b"]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(init.method).toBe("GET");
  });

  it("sends images and PDFs as base64 blocks captioned with their label", async () => {
    const fetchFn = vi.fn(async () => reply({ content: [{ type: "tool_use", input: {} }], usage: { input_tokens: 0, output_tokens: 0 } }));
    await new AnthropicLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).complete(req({ messages: [FILES] }));
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).messages[0].content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "F2 (storyboard.png):" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "text", text: "F3 (deck.pdf):" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AQID" } },
    ]);
  });

  it("text-only messages stay plain strings and validation turns are sent as user", async () => {
    const fetchFn = vi.fn(async () => reply({ content: [{ type: "tool_use", input: {} }], usage: { input_tokens: 0, output_tokens: 0 } }));
    const messages = [textMessage("user", "a"), textMessage("assistant", "b"), textMessage("validation", "c")];
    await new AnthropicLlmAdapter({ apiKey: "k", fetch: fetchFn as unknown as typeof fetch }).complete(req({ messages }));
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).messages).toEqual([
      { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" },
    ]);
  });

  it("createLlmAdapter returns the right class per provider", () => {
    expect(createLlmAdapter("anthropic", { apiKey: "k" })).toBeInstanceOf(AnthropicLlmAdapter);
    expect(createLlmAdapter("openai", { apiKey: "k" })).toBeInstanceOf(OpenAiLlmAdapter);
    expect(createLlmAdapter("stub", { apiKey: "" }).provider).toBe("stub");
  });
});
