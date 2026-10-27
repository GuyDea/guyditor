import type { AssemblyEffort } from "../../../transcript/src/index.js";
import { modelIds, requestJson, tokenCount } from "./http.js";
import { ASSEMBLY_REASONING_BUDGET, TRUNCATED_REPLY_MESSAGE } from "./pricing.js";
import {
  LlmAdapterError, messageText, partBase64, partCaption,
  type LlmAdapter, type LlmAdapterOptions, type LlmCompletion, type LlmMessage, type LlmRequest,
} from "./types.js";

type JsonSchema = Record<string, unknown>;

const EFFORT: Record<AssemblyEffort, string> = { low: "low", medium: "medium", high: "high", max: "high" };
const UNSUPPORTED = new Set(["minItems", "maxItems", "minLength", "maxLength", "pattern", "format", "minimum", "maximum"]);

function convert(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convert);
  if (node === null || typeof node !== "object") return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED.has(key)) continue;
    out[key === "oneOf" ? "anyOf" : key] = convert(value);
  }
  return out;
}

/**
 * Deep copy with oneOf -> anyOf and keywords OpenAI strict mode rejects removed (our validator still
 * enforces them), wrapped as `{ reply: <schema> }` because strict mode needs an object root.
 * `$defs` is hoisted to the new root so `#/$defs/...` refs keep resolving.
 */
export function toOpenAiStrictSchema(schema: Readonly<JsonSchema>): JsonSchema {
  const { $schema, $defs, ...inner } = convert(schema) as JsonSchema;
  return {
    ...($schema === undefined ? {} : { $schema }),
    ...($defs === undefined ? {} : { $defs }),
    type: "object",
    properties: { reply: inner },
    required: ["reply"],
    additionalProperties: false,
  };
}

function wireMessage({ role, content }: LlmMessage): { role: "user" | "assistant"; content: unknown } {
  const wireRole = role === "assistant" ? "assistant" : "user";
  if (content.every((part) => part.type === "text")) return { role: wireRole, content: messageText({ role, content }) };
  return {
    role: wireRole,
    content: content.flatMap((part) => {
      if (part.type === "text") return [{ type: "input_text", text: part.text }];
      const caption = { type: "input_text", text: partCaption(part) };
      const url = `data:${part.mime};base64,${partBase64(part)}`;
      return [caption, part.type === "pdf"
        ? { type: "input_file", filename: part.name, file_data: url }
        : { type: "input_image", image_url: url }];
    }),
  };
}

interface OpenAiOutput { content?: Array<{ type?: string; text?: unknown }> }

export class OpenAiLlmAdapter implements LlmAdapter {
  readonly provider = "openai" as const;

  constructor(private readonly options: LlmAdapterOptions) {}

  private get baseUrl(): string { return this.options.baseUrl ?? "https://api.openai.com"; }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" };
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const body = {
      model: request.model,
      instructions: request.system,
      input: request.messages.map(wireMessage),
      reasoning: { effort: EFFORT[request.effort] },
      // OpenAI counts reasoning tokens against max_output_tokens, so the effort budget rides on top.
      max_output_tokens: ASSEMBLY_REASONING_BUDGET[request.effort] + request.maxOutputTokens,
      text: { format: { type: "json_schema", name: "assembly_reply", schema: toOpenAiStrictSchema(request.responseSchema), strict: true } },
    };
    const json = await requestJson(this.options, `${this.baseUrl}/v1/responses`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body), ...(request.signal ? { signal: request.signal } : {}),
    });
    const incomplete = (json.incomplete_details ?? {}) as { reason?: unknown };
    if (json.status === "incomplete" && incomplete.reason === "max_output_tokens") {
      throw new LlmAdapterError(TRUNCATED_REPLY_MESSAGE, null, false);
    }
    const output = Array.isArray(json.output) ? (json.output as OpenAiOutput[]) : [];
    const text = output
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    let reply: unknown;
    try {
      reply = JSON.parse(text);
    } catch {
      throw new LlmAdapterError("non-JSON reply", null, true);
    }
    if (reply === null || typeof reply !== "object" || !("reply" in reply)) {
      throw new LlmAdapterError("reply envelope missing", null, true);
    }
    reply = (reply as { reply: unknown }).reply;
    const usage = (json.usage ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };
    return { reply, usage: { inputTokens: tokenCount(usage.input_tokens), outputTokens: tokenCount(usage.output_tokens) } };
  }

  async listModels(): Promise<string[]> {
    return modelIds(await requestJson(this.options, `${this.baseUrl}/v1/models`, { method: "GET", headers: this.headers() }));
  }
}
