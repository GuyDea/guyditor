import { spawn as nodeSpawn } from "node:child_process";
import { LlmAdapterError } from "./types.js";

export type CliName = "claude" | "codex";

export interface CliChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type SpawnFn = (
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => CliChild;

export const CLI_TIMEOUT_MS = 300_000;
export const CLI_OUTPUT_EXCERPT = 65_536;
const VERSION_TIMEOUT_MS = 10_000;
const LOGIN_PATTERN = /not logged in|unauthorized|please run \/login|run codex login/i;

const defaultSpawn: SpawnFn = (binary, args, options) =>
  nodeSpawn(binary, [...args], { cwd: options.cwd, env: options.env, stdio: "pipe" });

/** Streams are captured in full. */
export interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The timeout runCli actually applied. */
  timeoutMs: number;
}

function collect(stream: NodeJS.ReadableStream | null): () => string {
  const chunks: Buffer[] = [];
  stream?.on("data", (chunk: Buffer | string) => { chunks.push(Buffer.from(chunk)); });
  return () => Buffer.concat(chunks).toString("utf8");
}

export function runCli(input: {
  name: CliName; binary: string; args: readonly string[]; cwd: string;
  stdin?: string; timeoutMs?: number; spawn?: SpawnFn; env?: NodeJS.ProcessEnv;
}): Promise<CliRun> {
  const { name, binary, args, cwd } = input;
  return new Promise<CliRun>((resolve, reject) => {
    const child = (input.spawn ?? defaultSpawn)(binary, args, { cwd, env: input.env ?? process.env });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const timeoutMs = input.timeoutMs ?? CLI_TIMEOUT_MS;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error.code === "ENOENT"
        ? new LlmAdapterError(`${name} not found — install it or set its path in AI settings`, null, false)
        : new LlmAdapterError(`${name}: ${error.message}`, null, true));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout(), stderr: stderr(), timedOut, timeoutMs });
    });

    // A closed pipe (child exited early) must not crash the process; close/error report the outcome.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input.stdin ?? "");
  });
}

export function failureError(name: CliName, run: CliRun): LlmAdapterError {
  if (run.timedOut) {
    return new LlmAdapterError(`${name}: timed out after ${Math.round(run.timeoutMs / 1000)} s`, null, true);
  }
  if (LOGIN_PATTERN.test(run.stdout + run.stderr)) {
    return new LlmAdapterError(`${name} is not logged in — run \`${name}\` once in a terminal`, null, false);
  }
  const errTail = run.stderr.slice(-CLI_OUTPUT_EXCERPT);
  const outRoom = CLI_OUTPUT_EXCERPT - errTail.length;
  const outTail = outRoom > 0 ? run.stdout.slice(-outRoom) : "";
  return new LlmAdapterError(`${name}: exited with code ${run.code}\n${errTail}${outTail}`, null, true);
}

export async function cliVersion(
  binary: string, name: CliName, spawn?: SpawnFn,
): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  try {
    const run = await runCli({
      name, binary, args: ["--version"], cwd: process.cwd(), timeoutMs: VERSION_TIMEOUT_MS, ...(spawn ? { spawn } : {}),
    });
    if (run.timedOut || run.code !== 0) return { ok: false, message: failureError(name, run).message };
    return { ok: true, version: run.stdout.split("\n")[0]!.trim() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
