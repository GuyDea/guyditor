import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AdapterRegistry,
  ComfyUiGenerationAdapter,
  DeterministicGenerationAdapter,
  EphemeralCredentialStore,
  HTTP_GENERATION_ADAPTER_ID,
  HttpGenerationAdapter,
  HttpHttpGenerationApi,
  validateTextFreeGenerationRequest,
} from "../index.js";
import type {
  ComfyUiApi,
  GenerationRequest,
  HttpGenerationApi,
} from "../index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    requestId: "01K0GENERATIONREQUEST",
    mode: "video",
    model: "ffmpeg-synth-v1",
    prompt: "Slow orbit around a cobalt glass sculpture",
    width: 320,
    height: 180,
    durationFrames: 12,
    fps: "24/1",
    seed: 17,
    count: 2,
    providerSettings: {},
    ...overrides,
  };
}

describe("FR-602 text-free generation guard", () => {
  it("refuses visual text settings and points to the template path", () => {
    expect(validateTextFreeGenerationRequest(request({
      providerSettings: { textOverlay: { title: "37% growth" } },
    }))).toEqual({
      ok: false,
      error: {
        code: "E_GENERATION_TEXT_OVERLAY",
        message: expect.stringMatching(/template/i),
        suggestion: "Use a programmatic-animation template for all visual text.",
      },
    });
    expect(validateTextFreeGenerationRequest(request())).toEqual({ ok: true });
  });
});

describe("FR-604 deterministic generation adapter", () => {
  it("produces prompt-seeded candidate clips entirely offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-stubgen-"));
    roots.push(root);
    const adapter = new DeterministicGenerationAdapter();
    const estimate = await adapter.estimateCost(request());
    expect(estimate).toMatchObject({ amount: 0, confidence: "quote" });

    const handle = await adapter.submit(request(), new AbortController().signal);
    await expect(adapter.poll(handle)).resolves.toMatchObject({ state: "succeeded" });
    const result = await adapter.fetchResult(handle, root);

    expect(result.outputs).toHaveLength(2);
    expect(result.outputs.map(({ seed }) => seed)).toEqual([17, 18]);
    expect(result.outputs[0]).toMatchObject({
      mime: "video/mp4",
      width: 320,
      height: 180,
      durationSeconds: 0.5,
      rights: {
        origin: "generated",
        confirmedBy: "provider",
        providerTermsUrl: "https://guyditor.dev/terms/deterministic-stub",
      },
    });
    await expect(readFile(result.rawResponseRef, "utf8")).resolves.toContain(
      "deterministic-ffmpeg-stub",
    );
  });
});

class FakeHttpGenerationApi implements HttpGenerationApi {
  public imageRequest: GenerationRequest | undefined;
  public videoRequest: GenerationRequest | undefined;

  public createImages(input: GenerationRequest): Promise<{
    providerJobId: string;
    outputs: Array<{ base64: string; providerMetadata: Record<string, unknown> }>;
    rawResponse: Record<string, unknown>;
  }> {
    this.imageRequest = structuredClone(input);
    return Promise.resolve({
      providerJobId: "http-image-request-1",
      outputs: [{
        base64: Buffer.from("png-image").toString("base64"),
        providerMetadata: { revisedPrompt: "revised" },
      }],
      rawResponse: { created: 123 },
    });
  }

  public createVideo(input: GenerationRequest): Promise<{ providerJobId: string }> {
    this.videoRequest = structuredClone(input);
    return Promise.resolve({ providerJobId: "http-video-request-1" });
  }

  public getVideo(): Promise<{
    state: "succeeded";
    progress: number;
    providerMetadata: Record<string, unknown>;
  }> {
    return Promise.resolve({
      state: "succeeded",
      progress: 1,
      providerMetadata: { providerStatus: "completed" },
    });
  }

  public downloadVideo(): Promise<Buffer> {
    return Promise.resolve(Buffer.from("video-output"));
  }
}

describe("FR-604 generic HTTP adapter", () => {
  it("maps synchronous images and asynchronous videos behind one provider contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-httpgen-"));
    roots.push(root);
    const credentials = new EphemeralCredentialStore();
    await credentials.set(HTTP_GENERATION_ADAPTER_ID, "apiKey", "secret");
    const api = new FakeHttpGenerationApi();
    const adapter = new HttpGenerationAdapter({
      credentials,
      config: {
        apiKeyRef: "apiKey",
        baseUrl: "https://api.example.invalid/v1",
        models: [
          { id: "image-1", mode: "image" },
          { id: "video-1", mode: "video" },
        ],
        pricing: {
          currency: "USD",
          imagePerOutput: { "1024x1024": 0.04 },
          videoPerSecond: { default: 0.35 },
        },
      },
      apiFactory: ({ apiKey, baseUrl }) => {
        expect({ apiKey, baseUrl }).toEqual({
          apiKey: "secret",
          baseUrl: "https://api.example.invalid/v1",
        });
        return api;
      },
    });

    const baseImageRequest = request();
    const imageRequest: GenerationRequest = {
      ...baseImageRequest,
      mode: "image",
      model: "image-1",
      width: 1024,
      height: 1024,
      count: 1,
    };
    delete imageRequest.durationFrames;
    delete imageRequest.fps;
    const imageHandle = await adapter.submit(imageRequest, new AbortController().signal);
    await expect(adapter.poll(imageHandle)).resolves.toMatchObject({ state: "succeeded" });
    const images = await adapter.fetchResult(imageHandle, join(root, "images"));
    await expect(readFile(images.outputs[0]!.filePath)).resolves.toEqual(Buffer.from("png-image"));

    const videoRequest = request({ model: "video-1", count: 1 });
    const videoHandle = await adapter.submit(videoRequest, new AbortController().signal);
    await expect(adapter.poll(videoHandle)).resolves.toMatchObject({ state: "succeeded" });
    const videos = await adapter.fetchResult(videoHandle, join(root, "videos"));
    await expect(readFile(videos.outputs[0]!.filePath)).resolves.toEqual(Buffer.from("video-output"));
    await expect(adapter.estimateCost(videoRequest)).resolves.toMatchObject({ amount: 0.175 });
  });

  it("isolates the PROVIDER-VERIFY bearer wire shapes and status normalization", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null; body?: string }> = [];
    const wireFetch: typeof fetch = (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        authorization: new Headers(init?.headers).get("Authorization"),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      if (url.endsWith("/images/generations")) {
        return Promise.resolve(new Response(JSON.stringify({
          id: "image-job",
          data: [{ b64_json: Buffer.from("image").toString("base64") }],
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.endsWith("/videos") && method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ id: "video/job" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      if (url.endsWith("/videos/video%2Fjob/content")) {
        return Promise.resolve(new Response(Buffer.from("video"), { status: 200 }));
      }
      if (method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response(JSON.stringify({ status: "completed", progress: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    };
    const api = new HttpHttpGenerationApi({
      apiKey: "wire-secret",
      baseUrl: "https://provider.invalid/v1/",
      fetchImplementation: wireFetch,
    });
    const abort = new AbortController().signal;

    await api.createImages(request({ mode: "image", model: "image-1" }), abort);
    const video = await api.createVideo(request({ model: "video-1" }), abort);
    await expect(api.getVideo(video.providerJobId)).resolves.toMatchObject({ state: "succeeded" });
    await expect(api.downloadVideo(video.providerJobId)).resolves.toEqual(Buffer.from("video"));
    await api.cancel?.(video.providerJobId);

    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: "https://provider.invalid/v1/images/generations", method: "POST" },
      { url: "https://provider.invalid/v1/videos", method: "POST" },
      { url: "https://provider.invalid/v1/videos/video%2Fjob", method: "GET" },
      { url: "https://provider.invalid/v1/videos/video%2Fjob/content", method: "GET" },
      { url: "https://provider.invalid/v1/videos/video%2Fjob", method: "DELETE" },
    ]);
    expect(calls.every(({ authorization }) => authorization === "Bearer wire-secret")).toBe(true);
    expect(JSON.parse(calls[1]!.body ?? "{}")).toMatchObject({
      duration_frames: 12,
      fps: "24/1",
      seed: 17,
    });
  });
});

class FakeComfyUiApi implements ComfyUiApi {
  public submitted: Record<string, unknown> | undefined;

  public probe(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public submit(workflow: Record<string, unknown>): Promise<{ promptId: string }> {
    this.submitted = structuredClone(workflow);
    return Promise.resolve({ promptId: "comfy-prompt-1" });
  }

  public history(): Promise<{
    state: "succeeded";
    outputs: Array<{ filename: string; width: number; height: number }>;
    providerMetadata: Record<string, unknown>;
  }> {
    return Promise.resolve({
      state: "succeeded",
      outputs: [{ filename: "output.png", width: 512, height: 512 }],
      providerMetadata: { node: "9" },
    });
  }

  public download(): Promise<Buffer> {
    return Promise.resolve(Buffer.from("comfy-output"));
  }
}

describe("FR-604 future local adapter contract", () => {
  it("injects declared workflow values while remaining unavailable until configured", async () => {
    const api = new FakeComfyUiApi();
    const unavailable = new ComfyUiGenerationAdapter({
      config: { workflows: {} },
      api,
    });
    expect(unavailable.descriptor.availability).toBe("declared-unavailable");

    const adapter = new ComfyUiGenerationAdapter({
      config: {
        enabled: true,
        workflows: {
          "local-video": {
            graph: { prompt: "$prompt", seed: "$seed", frames: "$frames" },
          },
        },
      },
      api,
    });
    const handle = await adapter.submit(request({ model: "local-video", count: 1 }),
      new AbortController().signal);
    expect(api.submitted).toEqual({
      prompt: "Slow orbit around a cobalt glass sculpture",
      seed: 17,
      frames: 12,
    });
    await expect(adapter.poll(handle)).resolves.toMatchObject({ state: "succeeded" });
  });
});

describe("R-005 generation registry", () => {
  it("lists generation capability separately and reports absent adapters gracefully", () => {
    const registry = new AdapterRegistry();
    const stub = new DeterministicGenerationAdapter();
    registry.register(stub);

    expect(registry.resolveGeneration(stub.descriptor.adapterId)).toBe(stub);
    expect(registry.generationAdapters()).toEqual([stub]);
    expect(registry.generationAvailability("adp_removedaaa")).toEqual({
      available: false,
      reason: "Generation adapter adp_removedaaa is not installed.",
    });
  });
});
