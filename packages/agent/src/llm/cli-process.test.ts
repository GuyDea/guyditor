import { describe, expect, it, vi } from "vitest";
import { CLI_KILL_GRACE_MS, cliVersion, failureError, runCli } from "./cli-process.js";
import { LlmAdapterError } from "./types.js";
import { fakeSpawn } from "./__fixtures__/fake-spawn.js";

describe("cli process", () => {
  it("captures output, exit code and stdin, and passes cwd and env through", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "out", code: 0 });
    const run = await runCli({ name: "claude", binary: "/x/claude", args: ["-p"], cwd: "/ctx", stdin: "hello", spawn });
    expect(run).toMatchObject({ code: 0, stdout: "out", stderr: "", timedOut: false });
    expect(calls[0]).toMatchObject({ binary: "/x/claude", args: ["-p"], cwd: "/ctx", stdin: "hello" });
    expect(calls[0]!.env).toBe(process.env);
  });

  it("maps ENOENT to the not-found message", async () => {
    const { spawn } = fakeSpawn({ error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) });
    const error = await runCli({ name: "codex", binary: "codex", args: [], cwd: "/ctx", spawn }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmAdapterError);
    expect((error as LlmAdapterError).message).toBe("codex not found — install it or set its path in AI settings");
    expect((error as LlmAdapterError).retryable).toBe(false);
  });

  it("maps other spawn errors to a retryable error", async () => {
    const { spawn } = fakeSpawn({ error: Object.assign(new Error("boom"), { code: "EACCES" }) });
    const error = await runCli({ name: "codex", binary: "codex", args: [], cwd: "/ctx", spawn }).catch((e: unknown) => e);
    expect((error as LlmAdapterError).message).toBe("codex: boom");
    expect((error as LlmAdapterError).retryable).toBe(true);
  });

  it("kills the child and reports a timeout", async () => {
    const { spawn, calls } = fakeSpawn({ hang: true });
    const run = await runCli({ name: "codex", binary: "codex", args: [], cwd: "/ctx", timeoutMs: 10, spawn });
    expect(run.timedOut).toBe(true);
    expect(calls[0]!.killed).toBe("SIGTERM");
    expect(failureError("codex", run).message).toMatch(/^codex: timed out/);
  });

  it("sends SIGKILL after the grace period when SIGTERM is ignored and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, calls } = fakeSpawn({ hang: true, ignoreSigterm: true });
      let settled = false;
      const pending = runCli({ name: "codex", binary: "codex", args: [], cwd: "/ctx", timeoutMs: 10, spawn })
        .finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(10);
      expect(calls[0]!.kills).toEqual(["SIGTERM"]);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(CLI_KILL_GRACE_MS);
      expect(calls[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(await pending).toMatchObject({ timedOut: true, signal: "SIGKILL" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the kill timer when the child exits on SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, calls } = fakeSpawn({ hang: true });
      const pending = runCli({ name: "codex", binary: "codex", args: [], cwd: "/ctx", timeoutMs: 10, spawn });
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toMatchObject({ timedOut: true, signal: "SIGTERM" });
      expect(calls[0]!.kills).toEqual(["SIGTERM"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognises a login failure", () => {
    const error = failureError("codex", { code: 1, signal: null, stdout: "", stderr: "Not logged in. Run codex login", timedOut: false, timeoutMs: 1000 });
    expect(error.message).toBe("codex is not logged in — run `codex` once in a terminal");
    expect(error.retryable).toBe(false);
  });

  it("includes only the last 64 KB of output in a generic failure", () => {
    const stderr = `${"x".repeat(70_000)}END`;
    const error = failureError("claude", { code: 2, signal: null, stdout: "", stderr, timedOut: false, timeoutMs: 1000 });
    expect(error.message.startsWith("claude: exited with code 2")).toBe(true);
    expect(error.message).toContain("END");
    expect(error.message.length).toBeLessThan(66_000);
    expect(error.retryable).toBe(true);
  });

  it("cliVersion reports the version timeout it used", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, calls } = fakeSpawn({ hang: true });
      const pending = cliVersion("claude", "claude", spawn);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({ ok: false, message: "claude: timed out after 10 s" });
      expect(calls[0]!.killed).toBe("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cliVersion returns the first stdout line or the failure", async () => {
    const ok = fakeSpawn({ stdout: "2.1.309 (Claude Code)\n" });
    expect(await cliVersion("claude", "claude", ok.spawn)).toEqual({ ok: true, version: "2.1.309 (Claude Code)" });
    expect(ok.calls[0]!.args).toEqual(["--version"]);
    const missing = fakeSpawn({ error: Object.assign(new Error("nope"), { code: "ENOENT" }) });
    expect(await cliVersion("claude", "claude", missing.spawn)).toEqual({ ok: false, message: expect.stringMatching(/claude not found/) });
  });
});
