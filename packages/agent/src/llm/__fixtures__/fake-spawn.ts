import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { CliChild, SpawnFn } from "../cli-process.js";

export interface FakeRun {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: NodeJS.ErrnoException;
  hang?: boolean;
  /** kill("SIGTERM") is recorded but does not close; only SIGKILL ends the run. */
  ignoreSigterm?: boolean;
  onSpawn?: (binary: string, args: readonly string[], cwd: string) => void;
}

export interface FakeSpawn {
  spawn: SpawnFn;
  calls: {
    binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string;
    killed: NodeJS.Signals | null; kills: NodeJS.Signals[];
  }[];
}

/** Each spawn consumes the next run; no real process is ever started. */
export function fakeSpawn(...runs: FakeRun[]): FakeSpawn {
  const calls: FakeSpawn["calls"] = [];
  const spawn: SpawnFn = (binary, args, options) => {
    const run = runs[calls.length] ?? {};
    const call = {
      binary, args: [...args], cwd: options.cwd, env: options.env, stdin: "",
      killed: null as NodeJS.Signals | null, kills: [] as NodeJS.Signals[],
    };
    calls.push(call);
    run.onSpawn?.(binary, args, options.cwd);

    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.on("data", (chunk: Buffer | string) => { call.stdin += chunk.toString(); });
    let closed = false;
    const close = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (closed) return;
      closed = true;
      stdout.end();
      stderr.end();
      emitter.emit("close", code, signal);
    };
    const child = Object.assign(emitter, {
      stdout, stderr, stdin,
      kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        call.killed = signal;
        call.kills.push(signal);
        if (run.ignoreSigterm === true && signal === "SIGTERM") return true;
        close(null, signal);
        return true;
      },
    }) as unknown as CliChild;

    setImmediate(() => {
      if (run.error) { emitter.emit("error", run.error); return; }
      if (run.hang) return;
      if (run.stdout) stdout.write(run.stdout);
      if (run.stderr) stderr.write(run.stderr);
      close(run.code ?? 0, null);
    });
    return child;
  };
  return { spawn, calls };
}
