import { readFile, writeFile } from "node:fs/promises";

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

function taskIdFrom(response: Record<string, unknown>): string | undefined {
  const data = record(response["data"]);
  return stringValue(response["task_id"]) ?? stringValue(data["task_id"]);
}

function stateFrom(value: unknown): KlingApiTask["state"] {
  const normalized = String(value ?? "").toLowerCase();
  if (["succeed", "succeeded", "success", "completed"].includes(normalized)) {
    return "succeeded";
  }
  if (["failed", "error"].includes(normalized)) return "failed";
  if (["processing", "running"].includes(normalized)) return "running";
  return "queued";
}

function taskFromResponse(response: Record<string, unknown>, fallbackTaskId: string): KlingApiTask {
  const data = record(response["data"]);
  const result = record(data["task_result"] ?? response["task_result"]);
  const videos = Array.isArray(result["videos"])
    ? result["videos"].map(record)
    : [];
  const first = videos[0];
  const url = stringValue(first?.["url"] ?? result["video_url"]);
  const state = stateFrom(data["task_status"] ?? response["task_status"] ?? response["status"]);
  return {
    taskId: taskIdFrom(response) ?? fallbackTaskId,
    state,
    progress: numberValue(data["progress"] ?? response["progress"]) ??
      (state === "succeeded" ? 1 : 0),
    ...(state === "failed"
      ? { error: stringValue(data["task_status_msg"] ?? response["message"]) ?? "Kling task failed." }
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
    const body = await response.json() as unknown;
    if (!response.ok) {
      const parsed = record(body);
      throw new Error(
        `Kling API ${String(response.status)}: ${stringValue(parsed["message"]) ?? response.statusText}`,
      );
    }
    return record(body);
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
    return taskFromResponse(await this.#json(response), taskId);
  }

  public async downloadResult(taskId: string, destination: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (task.state !== "succeeded" || task.output === undefined) {
      throw new Error(`Kling task ${taskId} has no downloadable result.`);
    }
    const response = await this.#fetch(task.output.url, { method: "GET" });
    if (!response.ok) throw new Error(`Kling result download failed with ${String(response.status)}.`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
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
