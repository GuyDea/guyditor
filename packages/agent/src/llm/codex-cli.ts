import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssemblyEffort } from "../../../transcript/src/index.js";
import { CLI_TIMEOUT_MS, failureError, runCli } from "./cli-process.js";
import { cliFileList, renderCliConversation } from "./cli-conversation.js";
import { toOpenAiStrictSchema } from "./openai.js";
import { knownModels } from "./pricing.js";
import { LlmAdapterError, type LlmAdapter, type LlmCliOptions, type LlmCompletion, type LlmRequest } from "./types.js";

const CODEX_EFFORT: Record<AssemblyEffort, string> = { low: "low", medium: "medium", high: "high", max: "xhigh" };

/**
 * OpenAI through the creator's logged-in `codex` CLI: `codex exec` in a read-only sandbox rooted at
 * the context directory. The schema and the reply file live in a private temp directory.
 */
export class CodexCliAdapter implements LlmAdapter {
  readonly provider = "openai" as const;

  constructor(private readonly options: LlmCliOptions) {}

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const { cwd } = this.options;
    const { conversation, images, pdfs } = renderCliConversation(request.messages);
    const stdin = `${request.system}\n\n${conversation}`
      + (pdfs.length > 0 ? `\n\nPDF files in the working directory, by path: ${cliFileList(pdfs)}` : "")
      + "\n\nAnswer only with JSON matching the output schema.";
    const dir = await mkdtemp(join(tmpdir(), "guyditor-codex-"));
    try {
      const schemaPath = join(dir, "schema.json");
      const replyPath = join(dir, "reply.json");
      await writeFile(schemaPath, JSON.stringify(toOpenAiStrictSchema(request.responseSchema), null, 2));
      const run = await runCli({
        name: "codex",
        binary: this.options.binary,
        args: [
          "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", cwd,
          "-m", request.model, "-c", `model_reasoning_effort=${CODEX_EFFORT[request.effort]}`,
          "--output-schema", schemaPath, "-o", replyPath,
          // No prompt argument: codex reads it from stdin. Images stay last — `-i` takes several values.
          ...images.flatMap((file) => ["-i", join(cwd, file)]),
        ],
        cwd,
        stdin,
        timeoutMs: this.options.timeoutMs ?? CLI_TIMEOUT_MS,
        env: this.options.env ?? process.env,
        ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
      });
      if (run.timedOut || run.code !== 0) throw failureError("codex", run);
      return { reply: await readReply(replyPath), usage: { inputTokens: 0, outputTokens: 0 }, reportedUsd: 0 };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async listModels(): Promise<string[]> {
    return knownModels(this.provider);
  }
}

async function readReply(replyPath: string): Promise<unknown> {
  const text = await readFile(replyPath, "utf8").catch(() => "");
  if (text.trim() === "") throw new LlmAdapterError("codex returned no structured reply", null, true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LlmAdapterError("codex: returned non-JSON output", null, true);
  }
  if (parsed === null || typeof parsed !== "object" || !("reply" in parsed)) {
    throw new LlmAdapterError("codex returned no structured reply", null, true);
  }
  return parsed.reply;
}
