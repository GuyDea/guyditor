export type FfmpegErrorCode = "E_FFMPEG_FAILED" | "E_FFMPEG_MISSING";
export type FfmpegRetry = "safe" | "none";

export interface FfmpegErrorDetails {
  binary?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrLines?: readonly string[];
  suggestion?: string;
}

/** Error plus the binding Part 0 structured-error envelope fields. */
export class FfmpegError extends Error {
  readonly code: FfmpegErrorCode;
  readonly affected: string[];
  readonly acceptedStateChanged = false;
  readonly retry: FfmpegRetry;
  readonly binary?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderrLines?: string[];
  readonly suggestion?: string;

  constructor(
    code: FfmpegErrorCode,
    message: string,
    retry: FfmpegRetry,
    details: FfmpegErrorDetails = {},
  ) {
    super(message);
    this.name = "FfmpegError";
    this.code = code;
    this.affected = [];
    this.retry = retry;
    if (details.binary !== undefined) this.binary = details.binary;
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    if (details.signal !== undefined) this.signal = details.signal;
    if (details.stderrLines !== undefined) {
      this.stderrLines = [...details.stderrLines];
    }
    if (details.suggestion !== undefined) this.suggestion = details.suggestion;
  }
}
