import { LlmAdapterError, type LlmAdapterOptions } from "./types.js";

/** Sends a request and returns the parsed JSON body; maps HTTP and network failures to LlmAdapterError. */
export async function requestJson(
  options: LlmAdapterOptions, url: string, init: RequestInit,
): Promise<Record<string, unknown>> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(url, init);
  } catch (error) {
    throw new LlmAdapterError(error instanceof Error ? error.message : String(error), null, true);
  }
  if (response.status >= 400) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { error?: { message?: unknown } };
      if (typeof body?.error?.message === "string" && body.error.message) detail = body.error.message;
    } catch { /* non-JSON error body: keep statusText */ }
    const { status } = response;
    throw new LlmAdapterError(`${status} ${detail}`.trim(), status, status === 429 || status >= 500);
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new LlmAdapterError("non-JSON response", response.status, true);
  }
}

export function modelIds(body: Record<string, unknown>): string[] {
  const data = Array.isArray(body.data) ? (body.data as Array<{ id?: unknown }>) : [];
  return data.flatMap((m) => (typeof m.id === "string" ? [m.id] : [])).sort();
}

export function tokenCount(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
