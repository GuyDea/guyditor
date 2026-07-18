import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FfmpegError } from "./errors.js";

export interface ResolvedBinary {
  path: string;
  source: "environment" | "bundled" | "path";
  /** First non-empty line emitted by `<binary> -version`. */
  version: string;
}

interface BinarySpec {
  environmentVariable: "GUYDITOR_FFMPEG" | "GUYDITOR_FFPROBE";
  executableName: "ffmpeg" | "ffprobe";
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function executableFileName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function canExecute(candidate: string): boolean {
  try {
    accessSync(
      candidate,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function pathExtensions(): string[] {
  if (process.platform !== "win32") return [""];
  return (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
}

function lookupOnPath(command: string): string | undefined {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    const absolute = path.resolve(command);
    return canExecute(absolute) ? absolute : undefined;
  }

  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of pathExtensions()) {
      const candidate = path.resolve(directory, `${command}${extension}`);
      if (canExecute(candidate)) return candidate;
    }
  }
  return undefined;
}

function versionOf(candidate: string): string | undefined {
  const result = spawnSync(candidate, ["-version"], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  return `${result.stdout}${result.stderr}`
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
}

function bundledCandidates(executableName: string): string[] {
  const fileName = executableFileName(executableName);
  return [
    path.join(
      packageRoot,
      "vendor",
      `${process.platform}-${process.arch}`,
      fileName,
    ),
    path.join(packageRoot, "vendor", process.platform, fileName),
  ];
}

function resolveBinary(spec: BinarySpec): ResolvedBinary {
  const candidates: Array<{
    candidate: string;
    source: ResolvedBinary["source"];
  }> = [];
  const override = process.env[spec.environmentVariable];
  if (override !== undefined && override.trim().length > 0) {
    candidates.push({ candidate: override.trim(), source: "environment" });
  }
  candidates.push(
    ...bundledCandidates(spec.executableName).map((candidate) => ({
      candidate,
      source: "bundled" as const,
    })),
    { candidate: spec.executableName, source: "path" },
  );

  for (const { candidate, source } of candidates) {
    const resolvedPath = lookupOnPath(candidate);
    if (resolvedPath === undefined) continue;
    const version = versionOf(resolvedPath);
    if (version !== undefined) {
      return { path: resolvedPath, source, version };
    }
  }

  throw new FfmpegError(
    "E_FFMPEG_MISSING",
    `No working ${spec.executableName} binary was found.`,
    "none",
    {
      suggestion: `Set ${spec.environmentVariable} to a working executable or install the bundled runtime.`,
    },
  );
}

export function resolveFfmpeg(): ResolvedBinary {
  return resolveBinary({
    environmentVariable: "GUYDITOR_FFMPEG",
    executableName: "ffmpeg",
  });
}

export function resolveFfprobe(): ResolvedBinary {
  return resolveBinary({
    environmentVariable: "GUYDITOR_FFPROBE",
    executableName: "ffprobe",
  });
}
