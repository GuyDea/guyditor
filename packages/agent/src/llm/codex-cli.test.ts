import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeSpawn, type FakeRun } from "./__fixtures__/fake-spawn.js";
import { CodexCliAdapter } from "./codex-cli.js";
import { toOpenAiStrictSchema } from "./openai.js";
import { knownModels } from "./pricing.js";
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

function argAfter(args: readonly string[], flag: string): string {
  return args[args.indexOf(flag) + 1]!;
}

/** A run that writes `content` to the `-o` file, the way codex exec does. */
function writesReply(content: string, extra: FakeRun = {}): FakeRun {
  return { ...extra, onSpawn: (_binary, args) => { writeFileSync(argAfter(args, "-o"), content); } };
}

function adapter(...runs: FakeRun[]): { codex: CodexCliAdapter; calls: ReturnType<typeof fakeSpawn>["calls"] } {
  const { spawn, calls } = fakeSpawn(...runs);
  return { codex: new CodexCliAdapter({ binary: "codex", cwd: "/ctx", spawn, timeoutMs: 50 }), calls };
}

async function failure(promise: Promise<unknown>): Promise<LlmAdapterError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(LlmAdapterError);
  return error as LlmAdapterError;
}

describe("CodexCliAdapter", () => {
  it("invokes codex exec read-only in the context directory with the schema and images", async () => {
    let schema: unknown;
    const { codex, calls } = adapter({
      onSpawn: (_binary, args) => {
        schema = JSON.parse(readFileSync(argAfter(args, "--output-schema"), "utf8"));
        writeFileSync(argAfter(args, "-o"), '{"reply":{"a":"x"}}');
      },
    });
    await codex.complete(req({ effort: "high", messages: [FILES] }));
    const args = calls[0]!.args;
    const schemaPath = argAfter(args, "--output-schema");
    const replyPath = argAfter(args, "-o");
    expect(dirname(schemaPath)).toBe(dirname(replyPath));
    expect(dirname(dirname(schemaPath))).toBe(tmpdir());
    expect(basename(dirname(schemaPath))).toMatch(/^guyditor-codex-/);
    expect([basename(schemaPath), basename(replyPath)]).toEqual(["schema.json", "reply.json"]);
    expect(args).toEqual([
      "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", "/ctx",
      "-m", "gpt-5.5", "-c", "model_reasoning_effort=high", "--output-schema", schemaPath, "-o", replyPath,
      "-i", join("/ctx", "F2-storyboard.png"),
    ]);
    expect(calls[0]!.cwd).toBe("/ctx");
    expect(calls[0]!.stdin.startsWith("SYS\n\n")).toBe(true);
    expect(calls[0]!.stdin).toContain("Creator: hi\n[F2 storyboard.png — see file F2-storyboard.png]");
    expect(calls[0]!.stdin).toContain("PDF files in the working directory, by path: F3-deck.pdf (F3)");
    expect(calls[0]!.stdin.endsWith("Answer only with JSON matching the output schema.")).toBe(true);
    expect(schema).toEqual(toOpenAiStrictSchema(SCHEMA));
  });

  it("omits image and PDF hints for a text-only conversation", async () => {
    const { codex, calls } = adapter(writesReply('{"reply":{"a":"x"}}'));
    await codex.complete(req());
    expect(calls[0]!.args.at(-1)).toBe(argAfter(calls[0]!.args, "-o"));
    expect(calls[0]!.args).not.toContain("-");
    expect(calls[0]!.args).not.toContain("-i");
    expect(calls[0]!.stdin).toBe("SYS\n\nCreator: hi\n\nAnswer only with JSON matching the output schema.");
  });

  it("reads the reply from the output file and records zero cost", async () => {
    const { codex, calls } = adapter(writesReply('{"reply":{"a":"x"}}'));
    expect(await codex.complete(req())).toEqual({ reply: { a: "x" }, usage: { inputTokens: 0, outputTokens: 0 }, reportedUsd: 0 });
    expect(existsSync(dirname(argAfter(calls[0]!.args, "--output-schema")))).toBe(false);
  });

  it("maps effort max to xhigh", async () => {
    const { codex, calls } = adapter(writesReply('{"reply":{"a":"x"}}'));
    await codex.complete(req({ effort: "max" }));
    expect(argAfter(calls[0]!.args, "-c")).toBe("model_reasoning_effort=xhigh");
  });

  it("fails when the output file is missing or not JSON", async () => {
    const { codex, calls } = adapter({}, writesReply(""), writesReply("not json"));
    const missing = await failure(codex.complete(req()));
    expect(missing.message).toBe("codex returned no structured reply");
    expect((await failure(codex.complete(req()))).message).toBe("codex returned no structured reply");
    const nonJson = await failure(codex.complete(req()));
    expect(nonJson.message).toMatch(/^codex: returned non-JSON output/);
    expect(missing.retryable && nonJson.retryable).toBe(true);
    for (const call of calls) expect(existsSync(dirname(argAfter(call.args, "--output-schema")))).toBe(false);
  });

  it("maps not-found, login, exit code and timeout", async () => {
    const { codex, calls } = adapter(
      { error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) },
      { code: 1, stderr: "Not logged in. Run codex login" },
      writesReply('{"reply":{"a":"x"}}', { code: 2, stderr: "bad flag" }),
      { hang: true },
    );
    expect((await failure(codex.complete(req()))).message).toBe("codex not found — install it or set its path in AI settings");
    expect((await failure(codex.complete(req()))).message).toBe("codex is not logged in — run `codex` once in a terminal");
    expect((await failure(codex.complete(req()))).message).toMatch(/^codex: exited with code 2/);
    expect((await failure(codex.complete(req()))).message).toMatch(/^codex: timed out/);
    for (const call of calls) expect(existsSync(dirname(argAfter(call.args, "--output-schema")))).toBe(false);
  });

  it("lists the known models without spawning", async () => {
    const { codex, calls } = adapter();
    expect(await codex.listModels()).toEqual(knownModels("openai"));
    expect(calls).toHaveLength(0);
  });
});
