import { spawn } from "node:child_process";

import {
  resolveFfmpeg,
  resolveFfprobe,
} from "./binaries.js";
import type { ResolvedBinary } from "./binaries.js";
import { FfmpegError } from "./errors.js";

export interface RunFfmpegOptions {
  cwd?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
}

export interface FfmpegRunResult {
  binary: ResolvedBinary;
  exitCode: 0;
  stderrLines: string[];
  stdout: string;
}

function runBinary(
  binary: ResolvedBinary,
  args: readonly string[],
  options: RunFfmpegOptions,
): Promise<FfmpegRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary.path, [...args], {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"] as const,
      windowsHide: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrLines: string[] = [];
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let spawnError: Error | undefined;

    function recordStderrLine(line: string): void {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      stderrLines.push(normalized);
      options.onStderrLine?.(normalized);
    }

    function recordStdoutLine(line: string): void {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      options.onStdoutLine?.(normalized);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (options.onStdoutLine === undefined) return;
      stdoutRemainder += chunk.toString("utf8");
      const lines = stdoutRemainder.split("\n");
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) recordStdoutLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrRemainder += chunk;
      const lines = stderrRemainder.split("\n");
      stderrRemainder = lines.pop() ?? "";
      for (const line of lines) recordStderrLine(line);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      if (stdoutRemainder.length > 0) recordStdoutLine(stdoutRemainder);
      if (stderrRemainder.length > 0) recordStderrLine(stderrRemainder);
      const lastStderrLines = stderrLines.slice(-20);
      if (spawnError !== undefined) {
        reject(
          new FfmpegError(
            "E_FFMPEG_FAILED",
            `${pathLabel(binary.path)} could not be started: ${spawnError.message}`,
            "safe",
            {
              binary: binary.path,
              exitCode,
              signal,
              stderrLines: lastStderrLines,
            },
          ),
        );
        return;
      }
      if (exitCode !== 0) {
        reject(
          new FfmpegError(
            "E_FFMPEG_FAILED",
            `${pathLabel(binary.path)} exited with code ${exitCode ?? "unknown"}.`,
            "safe",
            {
              binary: binary.path,
              exitCode,
              signal,
              stderrLines: lastStderrLines,
            },
          ),
        );
        return;
      }
      resolve({
        binary,
        exitCode: 0,
        stderrLines,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      });
    });
  });
}

function pathLabel(binaryPath: string): string {
  return binaryPath.endsWith("ffprobe") || binaryPath.endsWith("ffprobe.exe")
    ? "ffprobe"
    : "ffmpeg";
}

export function runFfmpeg(
  args: readonly string[],
  options: RunFfmpegOptions = {},
): Promise<FfmpegRunResult> {
  return runBinary(resolveFfmpeg(), args, options);
}

export function runFfprobe(
  args: readonly string[],
): Promise<FfmpegRunResult> {
  return runBinary(resolveFfprobe(), args, {});
}
