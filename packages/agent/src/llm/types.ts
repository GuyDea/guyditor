import type { AssemblyEffort, AssemblyProvider } from "../../../transcript/src/index.js";
import { AnthropicLlmAdapter } from "./anthropic.js";
import { ClaudeCliAdapter } from "./claude-cli.js";
import type { SpawnFn } from "./cli-process.js";
import { CodexCliAdapter } from "./codex-cli.js";
import { OpenAiLlmAdapter } from "./openai.js";
import { StubLlmAdapter } from "./stub.js";

/** "validation" is a rejected-reply note; API adapters send it as a user turn. */
export type LlmRole = "user" | "assistant" | "validation";

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: Uint8Array; label: string; name: string }
  | { type: "pdf"; mime: "application/pdf"; data: Uint8Array; label: string; name: string };

export interface LlmMessage { role: LlmRole; content: LlmContentPart[] }

export function textMessage(role: LlmRole, text: string): LlmMessage {
  return { role, content: [{ type: "text", text }] };
}

/** Text parts joined with newlines; images and PDFs contribute nothing. */
export function messageText(message: LlmMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** The text that introduces a binary part, e.g. "F2 (storyboard.png):". */
export function partCaption(part: Exclude<LlmContentPart, { type: "text" }>): string {
  return `${part.label} (${part.name}):`;
}

export function partBase64(part: Exclude<LlmContentPart, { type: "text" }>): string {
  return Buffer.from(part.data).toString("base64");
}

export interface LlmRequest {
  model: string;
  effort: AssemblyEffort;
  system: string;
  messages: LlmMessage[];
  responseSchema: Readonly<Record<string, unknown>>;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface LlmCompletion {
  reply: unknown;
  usage: { inputTokens: number; outputTokens: number };
  /** Set only by CLI adapters, which report their own cost. */
  reportedUsd?: number;
}

export class LlmAdapterError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
    this.name = "LlmAdapterError";
  }
}

export interface LlmAdapter {
  readonly provider: AssemblyProvider;
  complete(request: LlmRequest): Promise<LlmCompletion>;
  listModels(): Promise<string[]>;
}

/** "api" reaches the provider over HTTP with a key; "cli" through the creator's logged-in CLI. */
export type LlmTransport = "api" | "cli";

/** `cwd` is the session's context directory, which the CLI is confined to. */
export interface LlmCliOptions { binary: string; cwd: string; timeoutMs?: number; spawn?: SpawnFn; env?: NodeJS.ProcessEnv }

export interface LlmAdapterOptions { apiKey: string; fetch?: typeof fetch; baseUrl?: string; transport?: LlmTransport; cli?: LlmCliOptions }

/** "stub" ignores options; transport defaults to "api". */
export function createLlmAdapter(provider: AssemblyProvider, ...[options]: [LlmAdapterOptions]): LlmAdapter {
  if (provider === "stub") return new StubLlmAdapter();
  if (options.transport === "cli" && (provider === "anthropic" || provider === "openai")) {
    if (!options.cli) throw new LlmAdapterError("cli options missing", null, false);
    return provider === "anthropic" ? new ClaudeCliAdapter(options.cli) : new CodexCliAdapter(options.cli);
  }
  if (provider === "anthropic") return new AnthropicLlmAdapter(options);
  if (provider === "openai") return new OpenAiLlmAdapter(options);
  throw new LlmAdapterError(`${provider} adapter not available`, null, false);
}
