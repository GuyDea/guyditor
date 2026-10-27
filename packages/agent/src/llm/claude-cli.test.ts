import { describe, expect, it } from "vitest";
import { fakeSpawn, type FakeRun } from "./__fixtures__/fake-spawn.js";
import { AnthropicLlmAdapter } from "./anthropic.js";
import { ClaudeCliAdapter } from "./claude-cli.js";
import { CodexCliAdapter } from "./codex-cli.js";
import { OpenAiLlmAdapter, toOpenAiStrictSchema } from "./openai.js";
import { knownModels } from "./pricing.js";
import { createLlmAdapter, LlmAdapterError, textMessage, type LlmMessage, type LlmRequest } from "./types.js";

const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

const FILES: LlmMessage = {
  role: "user",
  content: [
    { type: "text", text: "hi" },
    { type: "image", mime: "image/png", data: new Uint8Array([1, 2, 3]), label: "F2", name: "storyboard.png" },
    { type: "pdf", mime: "application/pdf", data: new Uint8Array([1, 2, 3]), label: "F3", name: "deck.pdf" },
  ],
};

const OK = JSON.stringify({ type: "result", is_error: false, structured_output: { reply: { a: "x" } } });

function req(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "claude-opus-5-5", effort: "medium", system: "SYS", maxOutputTokens: 1000,
    messages: [textMessage("user", "hi")], responseSchema: SCHEMA, ...over,
  };
}

function adapter(...runs: FakeRun[]): { claude: ClaudeCliAdapter; calls: ReturnType<typeof fakeSpawn>["calls"] } {
  const { spawn, calls } = fakeSpawn(...runs);
  return { claude: new ClaudeCliAdapter({ binary: "claude", cwd: "/ctx", spawn, timeoutMs: 50 }), calls };
}

async function failure(promise: Promise<unknown>): Promise<LlmAdapterError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(LlmAdapterError);
  return error as LlmAdapterError;
}

describe("ClaudeCliAdapter", () => {
  it("invokes claude confined to the context directory with the schema, model and effort", async () => {
    const { claude, calls } = adapter({ stdout: OK }, { stdout: OK });
    await claude.complete(req({ effort: "high" }));
    expect(calls[0]!.binary).toBe("claude");
    expect(calls[0]!.args).toEqual([
      "-p", "--safe-mode", "--restricted", "--no-session-persistence", "--tools", "Read",
      "--output-format", "json", "--json-schema", JSON.stringify(toOpenAiStrictSchema(SCHEMA)),
      "--model", "claude-opus-5-5", "--effort", "high", "--append-system-prompt", "SYS",
    ]);
    expect(calls[0]!.cwd).toBe("/ctx");
    expect(calls[0]!.stdin).toContain("Creator: hi");
    expect(calls[0]!.stdin.endsWith("Answer only through the structured output.")).toBe(true);
    expect(calls[0]!.stdin).not.toContain("Read tool");

    await claude.complete(req({ messages: [FILES] }));
    expect(calls[1]!.stdin).toContain("F2-storyboard.png (F2)");
    expect(calls[1]!.stdin).toContain("Read tool");
    expect(calls[1]!.stdin).toContain("Attached files in the working directory — read each with the Read tool before answering: F2-storyboard.png (F2), F3-deck.pdf (F3)");
    expect(calls[1]!.stdin).toContain("Creator: hi\n[F2 storyboard.png — see file F2-storyboard.png]\n[F3 deck.pdf — see file F3-deck.pdf]");
  });

  it("returns the structured reply, usage and the reported cost", async () => {
    const { claude } = adapter({
      stdout: '{"type":"result","is_error":false,"structured_output":{"reply":{"a":"x"}},"usage":{"input_tokens":11,"output_tokens":22},"total_cost_usd":0.0123}',
    });
    expect(await claude.complete(req())).toEqual({ reply: { a: "x" }, usage: { inputTokens: 11, outputTokens: 22 }, reportedUsd: 0.0123 });
  });

  it("defaults missing usage and cost to zero", async () => {
    const { claude } = adapter({ stdout: OK });
    expect(await claude.complete(req())).toEqual({ reply: { a: "x" }, usage: { inputTokens: 0, outputTokens: 0 }, reportedUsd: 0 });
  });

  it("fails on non-JSON stdout, a prose-only envelope and an error envelope", async () => {
    const { claude } = adapter(
      { stdout: "hello" },
      { stdout: '{"type":"result","result":"prose"}' },
      { stdout: '{"is_error":true,"result":"boom"}' },
    );
    const nonJson = await failure(claude.complete(req()));
    expect(nonJson.message).toMatch(/^claude: returned non-JSON/);
    expect(nonJson.message).toContain("hello");
    const prose = await failure(claude.complete(req()));
    expect(prose.message).toBe("claude returned no structured reply");
    const boom = await failure(claude.complete(req()));
    expect(boom.message).toBe("claude: boom");
    expect([nonJson, prose, boom].map((error) => error.retryable)).toEqual([true, true, true]);
  });

  it("maps not-found, login, exit code and timeout", async () => {
    const { claude } = adapter(
      { error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) },
      { code: 1, stderr: "Not logged in · Please run /login" },
      { code: 2, stderr: "bad flag" },
      { hang: true },
    );
    expect((await failure(claude.complete(req()))).message).toBe("claude not found — install it or set its path in AI settings");
    expect((await failure(claude.complete(req()))).message).toBe("claude is not logged in — run `claude` once in a terminal");
    expect((await failure(claude.complete(req()))).message).toMatch(/^claude: exited with code 2/);
    expect((await failure(claude.complete(req()))).message).toMatch(/^claude: timed out/);
  });

  it("renders validation turns distinguishably", async () => {
    const { claude, calls } = adapter({ stdout: OK });
    await claude.complete(req({
      messages: [
        textMessage("user", "go"),
        textMessage("assistant", '{"a":1}'),
        textMessage("validation", "Your reply was rejected: a must be a string"),
      ],
    }));
    expect(calls[0]!.stdin).toContain("Creator: go");
    expect(calls[0]!.stdin).toContain("Assistant: {");
    expect(calls[0]!.stdin).toContain("Validation: Your reply was rejected");
    expect(calls[0]!.stdin).toContain('Creator: go\n\nAssistant: {"a":1}\n\nValidation: Your reply was rejected');
  });

  it("lists the known models without spawning", async () => {
    const { claude, calls } = adapter();
    expect(await claude.listModels()).toEqual(knownModels("anthropic"));
    expect(calls).toHaveLength(0);
  });
});

describe("createLlmAdapter transport", () => {
  it("createLlmAdapter picks the CLI adapters for transport cli", () => {
    const cli = { binary: "x", cwd: "/ctx" };
    expect(createLlmAdapter("anthropic", { apiKey: "", transport: "cli", cli })).toBeInstanceOf(ClaudeCliAdapter);
    expect(createLlmAdapter("openai", { apiKey: "", transport: "cli", cli })).toBeInstanceOf(CodexCliAdapter);
  });

  it("picks the API classes by default and for transport api", () => {
    expect(createLlmAdapter("anthropic", { apiKey: "k" })).toBeInstanceOf(AnthropicLlmAdapter);
    expect(createLlmAdapter("openai", { apiKey: "k", transport: "api" })).toBeInstanceOf(OpenAiLlmAdapter);
  });

  it("rejects transport cli without cli options", () => {
    expect(() => createLlmAdapter("anthropic", { apiKey: "", transport: "cli" })).toThrow(new LlmAdapterError("cli options missing", null, false));
  });
});
