import { modelIds, requestJson, tokenCount } from "./http.js";
import { ASSEMBLY_REASONING_BUDGET, TRUNCATED_REPLY_MESSAGE } from "./pricing.js";
import {
  LlmAdapterError, type LlmAdapter, type LlmAdapterOptions, type LlmCompletion, type LlmRequest,
} from "./types.js";

interface AnthropicBlock { type?: string; name?: string; input?: unknown }

export class AnthropicLlmAdapter implements LlmAdapter {
  readonly provider = "anthropic" as const;

  constructor(private readonly options: LlmAdapterOptions) {}

  private get baseUrl(): string { return this.options.baseUrl ?? "https://api.anthropic.com"; }

  private headers(): Record<string, string> {
    return { "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const budget = ASSEMBLY_REASONING_BUDGET[request.effort];
    const body = {
      model: request.model,
      max_tokens: budget + request.maxOutputTokens,
      system: request.system,
      messages: request.messages,
      thinking: { type: "enabled", budget_tokens: budget },
      tools: [{ name: "assembly_reply", description: "Return the assembly reply.", input_schema: request.responseSchema }],
      tool_choice: { type: "auto" },
    };
    const json = await requestJson(this.options, `${this.baseUrl}/v1/messages`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body), ...(request.signal ? { signal: request.signal } : {}),
    });
    if (json.stop_reason === "max_tokens") throw new LlmAdapterError(TRUNCATED_REPLY_MESSAGE, null, false);
    const content = Array.isArray(json.content) ? (json.content as AnthropicBlock[]) : [];
    const call = content.find((block) => block.type === "tool_use");
    if (!call) throw new LlmAdapterError("model did not call assembly_reply", null, true);
    const usage = (json.usage ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };
    return { reply: call.input, usage: { inputTokens: tokenCount(usage.input_tokens), outputTokens: tokenCount(usage.output_tokens) } };
  }

  async listModels(): Promise<string[]> {
    return modelIds(await requestJson(this.options, `${this.baseUrl}/v1/models`, { method: "GET", headers: this.headers() }));
  }
}
