import type { GenerationRequest } from "./types.js";

export interface HttpImageGenerationResponse {
  providerJobId: string;
  outputs: Array<{ base64: string; providerMetadata: Record<string, unknown> }>;
  rawResponse: Record<string, unknown>;
}

export interface HttpVideoGenerationStatus {
  state: "queued" | "running" | "succeeded" | "failed";
  progress?: number;
  error?: string;
  providerMetadata: Record<string, unknown>;
  actualCostUsd?: number;
}

export interface HttpGenerationApi {
  createImages(
    request: GenerationRequest,
    signal: AbortSignal,
  ): Promise<HttpImageGenerationResponse>;
  createVideo(request: GenerationRequest, signal: AbortSignal): Promise<{ providerJobId: string }>;
  getVideo(providerJobId: string): Promise<HttpVideoGenerationStatus>;
  downloadVideo(providerJobId: string): Promise<Buffer>;
  cancel?(providerJobId: string): Promise<void>;
}

export interface HttpGenerationPaths {
  imageGenerate: string;
  videoCreate: string;
  videoStatus: string;
  videoContent: string;
}

export interface HttpHttpGenerationApiOptions {
  apiKey: string;
  baseUrl: string;
  paths?: Partial<HttpGenerationPaths>;
  fetchImplementation?: typeof fetch;
}

const DEFAULT_PATHS: HttpGenerationPaths = {
  imageGenerate: "/images/generations",
  videoCreate: "/videos",
  videoStatus: "/videos/{id}",
  videoContent: "/videos/{id}/content",
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function pathFor(template: string, id?: string): string {
  return id === undefined ? template : template.replace("{id}", encodeURIComponent(id));
}

export class HttpHttpGenerationApi implements HttpGenerationApi {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #paths: HttpGenerationPaths;
  readonly #fetch: typeof fetch;

  public constructor(options: HttpHttpGenerationApiOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.#paths = { ...DEFAULT_PATHS, ...options.paths };
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  #headers(json = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#apiKey}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async #json(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) throw new Error(`HTTP generation provider returned ${String(response.status)}.`);
    return record(await response.json());
  }

  public async createImages(
    request: GenerationRequest,
    signal: AbortSignal,
  ): Promise<HttpImageGenerationResponse> {
    // PROVIDER-VERIFY: OpenAI-compatible services may add image fields; the stable
    // boundary is isolated here and raw fields remain audit metadata.
    const response = await this.#fetch(`${this.#baseUrl}${this.#paths.imageGenerate}`, {
      method: "POST",
      headers: this.#headers(true),
      signal,
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        n: request.count,
        size: `${String(request.width)}x${String(request.height)}`,
        response_format: "b64_json",
        ...(request.seed === undefined ? {} : { seed: request.seed }),
        ...request.providerSettings,
      }),
    });
    const rawResponse = await this.#json(response);
    const rows = Array.isArray(rawResponse["data"]) ? rawResponse["data"] : [];
    const outputs = rows.flatMap((value) => {
      const row = record(value);
      const base64 = row["b64_json"];
      return typeof base64 === "string"
        ? [{ base64, providerMetadata: record(row) }]
        : [];
    });
    if (outputs.length === 0) throw new Error("HTTP image generation returned no b64_json outputs.");
    const providerJobId = typeof rawResponse["id"] === "string"
      ? rawResponse["id"]
      : `image-${request.requestId}`;
    return { providerJobId, outputs, rawResponse };
  }

  public async createVideo(
    request: GenerationRequest,
    signal: AbortSignal,
  ): Promise<{ providerJobId: string }> {
    // PROVIDER-VERIFY: video create fields/status naming are intentionally
    // confined to this OpenAI-compatible wire adapter.
    const response = await this.#fetch(`${this.#baseUrl}${this.#paths.videoCreate}`, {
      method: "POST",
      headers: this.#headers(true),
      signal,
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        size: `${String(request.width)}x${String(request.height)}`,
        ...(request.durationFrames === undefined || request.fps === undefined
          ? {}
          : { duration_frames: request.durationFrames, fps: request.fps }),
        ...(request.seed === undefined ? {} : { seed: request.seed }),
        ...request.providerSettings,
      }),
    });
    const body = await this.#json(response);
    const id = body["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("HTTP video generation response has no id.");
    }
    return { providerJobId: id };
  }

  public async getVideo(providerJobId: string): Promise<HttpVideoGenerationStatus> {
    // PROVIDER-VERIFY: normalize known status synonyms at this boundary.
    const response = await this.#fetch(
      `${this.#baseUrl}${pathFor(this.#paths.videoStatus, providerJobId)}`,
      { method: "GET", headers: this.#headers() },
    );
    const body = await this.#json(response);
    const status = String(body["status"] ?? "").toLowerCase();
    const state = ["completed", "succeeded", "success"].includes(status)
      ? "succeeded"
      : ["failed", "error", "cancelled"].includes(status)
        ? "failed"
        : status === "queued" ? "queued" : "running";
    const progress = typeof body["progress"] === "number" ? body["progress"] : undefined;
    const error = typeof body["error"] === "string" ? body["error"] : undefined;
    return {
      state,
      ...(progress === undefined ? {} : { progress }),
      ...(error === undefined ? {} : { error }),
      providerMetadata: body,
    };
  }

  public async downloadVideo(providerJobId: string): Promise<Buffer> {
    const response = await this.#fetch(
      `${this.#baseUrl}${pathFor(this.#paths.videoContent, providerJobId)}`,
      { method: "GET", headers: this.#headers() },
    );
    if (!response.ok) throw new Error(`HTTP video download returned ${String(response.status)}.`);
    return Buffer.from(await response.arrayBuffer());
  }

  public async cancel(providerJobId: string): Promise<void> {
    // PROVIDER-VERIFY: DELETE cancellation is an optional compatibility shape.
    const response = await this.#fetch(
      `${this.#baseUrl}${pathFor(this.#paths.videoStatus, providerJobId)}`,
      { method: "DELETE", headers: this.#headers() },
    );
    if (!response.ok && response.status !== 404 && response.status !== 405) {
      throw new Error(`HTTP generation cancellation returned ${String(response.status)}.`);
    }
  }
}

