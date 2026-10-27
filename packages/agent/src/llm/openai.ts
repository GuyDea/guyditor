import type { AssemblyEffort } from "../../../transcript/src/index.js";
import { modelIds, requestJson, tokenCount } from "./http.js";
import {
  LlmAdapterError, type LlmAdapter, type LlmAdapterOptions, type LlmCompletion, type LlmRequest,
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

/** Deep copy with oneOf -> anyOf and keywords OpenAI strict mode rejects removed; our validator still enforces them. */
export function toOpenAiStrictSchema(schema: Readonly<JsonSchema>): JsonSchema {
  return convert(schema) as JsonSchema;
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
      input: request.messages,
      reasoning: { effort: EFFORT[request.effort] },
      max_output_tokens: request.maxOutputTokens,
      text: { format: { type: "json_schema", name: "assembly_reply", schema: toOpenAiStrictSchema(request.responseSchema), strict: true } },
    };
    const json = await requestJson(this.options, `${this.baseUrl}/v1/responses`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body), ...(request.signal ? { signal: request.signal } : {}),
    });
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
    const usage = (json.usage ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };
    return { reply, usage: { inputTokens: tokenCount(usage.input_tokens), outputTokens: tokenCount(usage.output_tokens) } };
  }

  async listModels(): Promise<string[]> {
    return modelIds(await requestJson(this.options, `${this.baseUrl}/v1/models`, { method: "GET", headers: this.headers() }));
  }
}
