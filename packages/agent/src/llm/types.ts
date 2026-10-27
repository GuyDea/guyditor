import type { AssemblyEffort, AssemblyProvider } from "../../../transcript/src/index.js";
import { StubLlmAdapter } from "./stub.js";

export interface LlmMessage { role: "user" | "assistant"; content: string }

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

export interface LlmAdapterOptions { apiKey: string; fetch?: typeof fetch; baseUrl?: string }

/** "stub" ignores options. */
export function createLlmAdapter(provider: AssemblyProvider, ...options: [LlmAdapterOptions]): LlmAdapter {
  void options;
  if (provider === "stub") return new StubLlmAdapter();
  throw new LlmAdapterError(`${provider} adapter not available`, null, false);
}
