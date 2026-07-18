export type FfmpegErrorCode = "E_FFMPEG_FAILED" | "E_FFMPEG_MISSING";
export type FfmpegRetry = "safe" | "none";
export type MediaErrorCode =
  | "E_MEDIA_INGEST_INVALID_SOURCE"
  | "E_MEDIA_PROBE_FAILED";

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

export interface MediaErrorDetails {
  affected?: readonly string[];
  binary?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrLines?: readonly string[];
  suggestion?: string;
}

/** Structured Part 0 envelope for ingest failures handled by JobQueue. */
export class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly affected: string[];
  readonly acceptedStateChanged = false;
  readonly retry: FfmpegRetry;
  readonly binary?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderrLines?: string[];
  readonly suggestion?: string;

  public constructor(
    code: MediaErrorCode,
    message: string,
    retry: FfmpegRetry,
    details: MediaErrorDetails = {},
  ) {
    super(message);
    this.name = "MediaError";
    this.code = code;
    this.affected = [...(details.affected ?? [])];
    this.retry = retry;
    if (details.binary !== undefined) this.binary = details.binary;
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    if (details.signal !== undefined) this.signal = details.signal;
    if (details.stderrLines !== undefined) this.stderrLines = [...details.stderrLines];
    if (details.suggestion !== undefined) this.suggestion = details.suggestion;
  }

  public toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      affected: this.affected,
      acceptedStateChanged: this.acceptedStateChanged,
      retry: this.retry,
      ...(this.binary === undefined ? {} : { binary: this.binary }),
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
      ...(this.stderrLines === undefined ? {} : { stderrLines: this.stderrLines }),
      ...(this.suggestion === undefined ? {} : { suggestion: this.suggestion }),
    };
  }
}
