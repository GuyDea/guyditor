import { CLI_OUTPUT_EXCERPT, CLI_TIMEOUT_MS, failureError, runCli } from "./cli-process.js";
import { cliFileList, renderCliConversation } from "./cli-conversation.js";
import { toOpenAiStrictSchema } from "./openai.js";
import { knownModels } from "./pricing.js";
import { LlmAdapterError, type LlmAdapter, type LlmCliOptions, type LlmCompletion, type LlmRequest } from "./types.js";

/** The one object `claude -p --output-format json` prints. */
interface ClaudeEnvelope {
  is_error?: boolean;
  result?: string;
  subtype?: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
}

/** Anthropic through the creator's logged-in `claude` CLI, confined to the context directory with only Read. */
export class ClaudeCliAdapter implements LlmAdapter {
  readonly provider = "anthropic" as const;

  constructor(private readonly options: LlmCliOptions) {}

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const { conversation, images, pdfs } = renderCliConversation(request.messages);
    const files = [...images, ...pdfs];
    const stdin = conversation
      + (files.length > 0
        ? `\n\nAttached files in the working directory — read each with the Read tool before answering: ${cliFileList(files)}`
        : "")
      + "\n\nAnswer only through the structured output.";
    const run = await runCli({
      name: "claude",
      binary: this.options.binary,
      args: [
        "-p", "--safe-mode", "--restricted", "--no-session-persistence", "--tools", "Read",
        "--output-format", "json", "--json-schema", JSON.stringify(toOpenAiStrictSchema(request.responseSchema)),
        "--model", request.model, "--effort", request.effort, "--append-system-prompt", request.system,
      ],
      cwd: this.options.cwd,
      stdin,
      timeoutMs: this.options.timeoutMs ?? CLI_TIMEOUT_MS,
      env: this.options.env ?? process.env,
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
    });
    if (run.timedOut || run.code !== 0) throw failureError("claude", run);

    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stdout);
    } catch {
      throw new LlmAdapterError(`claude: returned non-JSON output\n${run.stdout.slice(0, CLI_OUTPUT_EXCERPT)}`, null, true);
    }
    const envelope: ClaudeEnvelope = parsed !== null && typeof parsed === "object" ? parsed : {};
    if (envelope.is_error === true) throw new LlmAdapterError(`claude: ${envelope.result ?? envelope.subtype ?? "error"}`, null, true);
    const output = envelope.structured_output;
    if (output === null || typeof output !== "object" || !("reply" in output)) {
      throw new LlmAdapterError("claude returned no structured reply", null, true);
    }
    return {
      reply: output.reply,
      usage: { inputTokens: envelope.usage?.input_tokens ?? 0, outputTokens: envelope.usage?.output_tokens ?? 0 },
      reportedUsd: envelope.total_cost_usd ?? 0,
    };
  }

  async listModels(): Promise<string[]> {
    return knownModels(this.provider);
  }
}
