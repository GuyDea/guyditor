export type GuyditorErrorCode = `E_${Uppercase<string>}`;
export type GuyditorRetry = "safe" | "unsafe" | "none";

export interface GuyditorError {
  code: GuyditorErrorCode;
  message: string;
  affected: string[];
  acceptedStateChanged: boolean;
  retry: GuyditorRetry;
  suggestion?: string;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: GuyditorError };

export interface GuyditorErrorOptions {
  affected?: readonly string[];
  acceptedStateChanged?: boolean;
  retry?: GuyditorRetry;
  suggestion?: string;
}

export function makeGuyditorError(
  code: GuyditorErrorCode,
  message: string,
  options: GuyditorErrorOptions = {},
): GuyditorError {
  const error: GuyditorError = {
    code,
    message,
    affected: [...(options.affected ?? [])],
    acceptedStateChanged: options.acceptedStateChanged ?? false,
    retry: options.retry ?? "none",
  };

  if (options.suggestion !== undefined) {
    error.suggestion = options.suggestion;
  }

  return error;
}

export function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failure(error: GuyditorError): {
  ok: false;
  error: GuyditorError;
} {
  return { ok: false, error };
}
