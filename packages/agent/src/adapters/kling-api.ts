import { createWriteStream } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

import type { RestyleRequest } from "./types.js";

export interface KlingApiTaskOutput {
  url: string;
  mime: string;
  width: number;
  height: number;
  durationSeconds: number;
}

export interface KlingApiTask {
  taskId: string;
  state: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  error?: string;
  output?: KlingApiTaskOutput;
  actualCostUsd?: number;
  providerMetadata: Record<string, unknown>;
}

export interface KlingApi {
  submitVideoToVideo(request: RestyleRequest, signal: AbortSignal): Promise<KlingApiTask>;
  getTask(taskId: string, signal?: AbortSignal): Promise<KlingApiTask>;
  downloadResult(taskId: string, destination: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
}

export interface HttpKlingApiOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A short, credential-free excerpt of a non-JSON body for the error message. */
function errorSnippet(text: string): string {
  const redacted = text.replace(/Bearer\s+\S+/giu, "Bearer <redacted>");
  const collapsed = redacted.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return "<empty body>";
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

function taskIdFrom(response: Record<string, unknown>): string | undefined {
  const data = record(response["data"]);
  return stringValue(response["task_id"]) ?? stringValue(data["task_id"]);
}

const SUCCEEDED_STATUSES = ["succeed", "succeeded", "success", "completed"];
const FAILED_STATUSES = ["failed", "failure", "error", "cancelled", "canceled"];
const RUNNING_STATUSES = ["processing", "running"];
const PENDING_STATUSES = ["", "queued", "queueing", "pending", "submitted", "created"];
const ABSENT_STATUS = "<absent>";

interface ResolvedState {
  state: KlingApiTask["state"];
  /** The raw status when the provider reported one this client does not know. */
  unrecognized?: string;
}

/**
 * An unrecognized status resolves to `failed`, not `queued`. The poll loop
 * treats `queued` as "keep waiting", so silently defaulting an unknown status
 * would turn any wire-format drift (see the PROVIDER-VERIFY note below) into an
 * unbounded wait instead of an actionable error. Whether an *absent* status is
 * tolerated is the caller's decision - see `requireStatus` below.
 */
function stateFrom(value: unknown): ResolvedState {
  const normalized = String(value ?? "").toLowerCase().trim();
  if (SUCCEEDED_STATUSES.includes(normalized)) return { state: "succeeded" };
  if (FAILED_STATUSES.includes(normalized)) return { state: "failed" };
  if (RUNNING_STATUSES.includes(normalized)) return { state: "running" };
  if (PENDING_STATUSES.includes(normalized)) return { state: "queued" };
  return { state: "failed", unrecognized: normalized };
}

const WIRE_DRIFT_HINT =
  "The provider wire format may have changed; see PROVIDER-VERIFY in kling-api.ts.";

function terminalError(
  unrecognized: string | undefined,
  data: Record<string, unknown>,
  response: Record<string, unknown>,
): string {
  if (unrecognized === undefined) {
    return stringValue(data["task_status_msg"] ?? response["message"]) ?? "Kling task failed.";
  }
  return unrecognized === ABSENT_STATUS
    ? `Kling returned no readable task status. ${WIRE_DRIFT_HINT}`
    : `Kling reported an unrecognized task status "${unrecognized}". ${WIRE_DRIFT_HINT}`;
}

function taskFromResponse(
  response: Record<string, unknown>,
  fallbackTaskId: string,
  /**
   * True on the polling path, where a response carrying no status at all means
   * this client cannot read the provider's shape. Treating that as "still
   * queued" is what turned a renamed field into an unbounded wait, and a
   * renamed field is the likeliest drift given PROVIDER-VERIFY below. The task
   * *creation* path stays lenient: an acknowledgement may carry only a task id.
   */
  requireStatus = false,
): KlingApiTask {
  const data = record(response["data"]);
  const result = record(data["task_result"] ?? response["task_result"]);
  const videos = Array.isArray(result["videos"])
    ? result["videos"].map(record)
    : [];
  const first = videos[0];
  const url = stringValue(first?.["url"] ?? result["video_url"]);
  const rawStatus = data["task_status"] ?? response["task_status"] ?? response["status"];
  const statusMissing = String(rawStatus ?? "").trim().length === 0;
  const { state, unrecognized } = requireStatus && statusMissing
    ? { state: "failed" as const, unrecognized: ABSENT_STATUS }
    : stateFrom(rawStatus);
  return {
    taskId: taskIdFrom(response) ?? fallbackTaskId,
    state,
    progress: numberValue(data["progress"] ?? response["progress"]) ??
      (state === "succeeded" ? 1 : 0),
    ...(state === "failed"
      ? { error: terminalError(unrecognized, data, response) }
      : {}),
    ...(url === undefined
      ? {}
      : {
          output: {
            url,
            mime: stringValue(first?.["mime_type"]) ?? "video/mp4",
            width: numberValue(first?.["width"]) ?? 0,
            height: numberValue(first?.["height"]) ?? 0,
            durationSeconds: numberValue(first?.["duration"]) ?? 0,
          },
        }),
    ...(numberValue(data["cost_usd"] ?? response["cost_usd"]) === undefined
      ? {}
      : { actualCostUsd: numberValue(data["cost_usd"] ?? response["cost_usd"])! }),
    providerMetadata: structuredClone(response),
  };
}

/**
 * Direct Kling REST transport.
 *
 * Public documentation entry points used for the boundary are:
 * - https://kling.ai/document-api/api/video/3-0-omni/video-omni
 * - https://kling.ai/document-api/apiReference/model/videoEffects
 *
 * The latter documents the current API-Key authentication option. This client
 * implements that as `Authorization: Bearer <API key>` against the documented
 * Singapore API host. PROVIDER-VERIFY: Kling's public SPA does not expose a
 * stable machine-readable Video-to-Video/O1 wire schema, so the endpoint path,
 * multipart field names, task response aliases, and cancellation verb below
 * are isolated assumptions. A provider correction must stay within this file.
 */
export class HttpKlingApi implements KlingApi {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  public constructor(options: HttpKlingApiOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api-singapore.klingai.com").replace(/\/$/u, "");
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async #json(response: Response): Promise<Record<string, unknown>> {
    // Read as text and check the status first: provider and gateway errors are
    // routinely non-JSON (an HTML 502, an empty 429), and parsing before the
    // status check replaced the real HTTP status with a JSON syntax error.
    const text = await response.text();
    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text) as unknown;
    } catch {
      parseFailed = true;
    }
    if (!response.ok) {
      const message = parseFailed || parsed === undefined
        ? response.statusText.length > 0 ? response.statusText : errorSnippet(text)
        : errorSnippet(stringValue(record(parsed)["message"]) ?? response.statusText);
      throw new Error(`Kling API ${String(response.status)}: ${message}`);
    }
    if (parseFailed || parsed === undefined) {
      throw new Error(
        `Kling API ${String(response.status)} returned a body that is not JSON: ${errorSnippet(text)}`,
      );
    }
    return record(parsed);
  }

  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#apiKey}` };
  }

  public async submitVideoToVideo(
    request: RestyleRequest,
    signal: AbortSignal,
  ): Promise<KlingApiTask> {
    const form = new FormData();
    form.set("model_name", request.model);
    form.set("prompt", request.prompt);
    if (request.negativePrompt !== undefined) form.set("negative_prompt", request.negativePrompt);
    if (request.seed !== undefined) form.set("seed", String(request.seed));
    form.set("duration", String(request.durationSeconds));
    form.set("mode", "video-to-video");
    form.set("provider_settings", JSON.stringify(request.providerSettings));
    form.set(
      "video",
      new Blob([await readFile(request.inputFilePath)], { type: request.inputMime }),
      "source.mp4",
    );
    // PROVIDER-VERIFY: current Omni/O1 task creation path and multipart shape.
    const response = await this.#fetch(`${this.#baseUrl}/v1/videos/omni-video`, {
      method: "POST",
      headers: this.#headers(),
      body: form,
      signal,
    });
    const body = await this.#json(response);
    const taskId = taskIdFrom(body);
    if (taskId === undefined) throw new Error("Kling task response did not include task_id.");
    return taskFromResponse(body, taskId);
  }

  public async getTask(taskId: string, signal?: AbortSignal): Promise<KlingApiTask> {
    // PROVIDER-VERIFY: current Omni/O1 task-status path.
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/videos/omni-video/${encodeURIComponent(taskId)}`,
      {
        method: "GET",
        headers: this.#headers(),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return taskFromResponse(await this.#json(response), taskId, true);
  }

  public async downloadResult(taskId: string, destination: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (task.state !== "succeeded" || task.output === undefined) {
      throw new Error(`Kling task ${taskId} has no downloadable result.`);
    }
    // The result URL comes from the provider response; only ever follow it over
    // http(s) so a malformed or hostile payload cannot redirect the download at
    // another scheme.
    let resultUrl: URL;
    try {
      resultUrl = new URL(task.output.url);
    } catch {
      throw new Error(`Kling task ${taskId} returned a malformed result URL.`);
    }
    if (resultUrl.protocol !== "https:" && resultUrl.protocol !== "http:") {
      throw new Error(
        `Kling task ${taskId} returned a non-http(s) result URL (${resultUrl.protocol}).`,
      );
    }
    const response = await this.#fetch(resultUrl.toString(), { method: "GET" });
    if (!response.ok) throw new Error(`Kling result download failed with ${String(response.status)}.`);
    // Stream to disk: a restyled 4K segment must not be buffered whole in memory.
    if (response.body === null) {
      await writeFile(destination, "");
      return;
    }
    try {
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream),
        createWriteStream(destination),
      );
    } catch (error: unknown) {
      // Never leave a truncated segment behind: the caller hashes whatever is
      // at this path and would otherwise freeze a partial download.
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async cancel(taskId: string): Promise<void> {
    // PROVIDER-VERIFY: cancellation support and verb for Omni/O1 tasks.
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/videos/omni-video/${encodeURIComponent(taskId)}`,
      { method: "DELETE", headers: this.#headers() },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Kling cancellation failed with ${String(response.status)}.`);
    }
  }
}
