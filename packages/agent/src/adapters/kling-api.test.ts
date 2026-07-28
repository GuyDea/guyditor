import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HttpKlingApi } from "./kling-api.js";
import type { RestyleRequest } from "./types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) =>
    rm(directory, { force: true, recursive: true })));
});

async function inputFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "guyditor-kling-"));
  directories.push(directory);
  const path = join(directory, "source.mp4");
  await writeFile(path, "source-bytes");
  return path;
}

async function restyleRequest(): Promise<RestyleRequest> {
  return {
    requestId: "rsp_aaaaaaaaaa-chunk-0",
    model: "kling-video-o1",
    prompt: "cinematic",
    inputFilePath: await inputFile(),
    inputMime: "video/mp4",
    referenceAssetIds: [],
    sourceRange: {
      sequenceId: "seq_aaaaaaaaaa",
      start: { frames: 0, fps: "30/1" },
      duration: { frames: 300, fps: "30/1" },
    },
    width: 1920,
    height: 1080,
    fps: "30/1",
    durationSeconds: 10,
    providerSettings: {},
  } as unknown as RestyleRequest;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpKlingApi error reporting", () => {
  it("reports the HTTP status when the provider returns a non-JSON error body", async () => {
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async () =>
        new Response("<html><head><title>502 Bad Gateway</title></head></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    });

    await expect(api.getTask("task-1")).rejects.toThrow(/502/u);
  });

  it("reports the HTTP status when the provider returns an empty error body", async () => {
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async () => new Response(null, { status: 429 }),
    });

    await expect(api.getTask("task-1")).rejects.toThrow(/429/u);
  });

  it("prefers the provider message on a structured error body", async () => {
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async () =>
        jsonResponse(400, { message: "duration exceeds the model maximum" }),
    });

    await expect(api.getTask("task-1"))
      .rejects.toThrow(/duration exceeds the model maximum/u);
  });

  it("never leaks the API key in an error message", async () => {
    const api = new HttpKlingApi({
      apiKey: "super-secret-key",
      fetchImplementation: async () =>
        new Response("Authorization: Bearer super-secret-key rejected", { status: 401 }),
    });

    await expect(api.getTask("task-1")).rejects.toThrow(
      expect.not.stringContaining("super-secret-key") as unknown as string,
    );
  });

  it("rejects a successful response whose body is not JSON", async () => {
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async () => new Response("not json at all", { status: 200 }),
    });

    await expect(api.getTask("task-1")).rejects.toThrow(/Kling API/u);
  });

  it("still parses a successful task response", async () => {
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async () =>
        jsonResponse(200, {
          data: {
            task_id: "task-1",
            task_status: "succeed",
            task_result: { videos: [{ url: "https://cdn.example/out.mp4", duration: 10 }] },
          },
        }),
    });

    const task = await api.getTask("task-1");
    expect(task).toMatchObject({
      taskId: "task-1",
      state: "succeeded",
      output: { url: "https://cdn.example/out.mp4", mime: "video/mp4" },
    });
  });

  it("surfaces an unrecognized task status instead of polling forever", async () => {
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async () =>
        jsonResponse(200, { data: { task_id: "task-1", task_status: "quota_exhausted" } }),
    });

    const task = await api.getTask("task-1");
    expect(task.state).toBe("failed");
    expect(task.error).toMatch(/quota_exhausted/u);
  });

  it("fails a polled task whose response carries no readable status", async () => {
    const api = new HttpKlingApi({
      apiKey: "secret",
      // The likeliest wire drift is a renamed field, which lands here.
      fetchImplementation: async () =>
        jsonResponse(200, { data: { task_id: "task-1", state: "processing" } }),
    });

    const task = await api.getTask("task-1");
    expect(task.state).toBe("failed");
    expect(task.error).toMatch(/no readable task status/u);
  });

  it("accepts a task-creation acknowledgement that omits the status", async () => {
    const request = await restyleRequest();
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async () => jsonResponse(200, { data: { task_id: "task-9" } }),
    });

    const task = await api.submitVideoToVideo(request, AbortSignal.timeout(5_000));
    expect(task).toMatchObject({ taskId: "task-9", state: "queued" });
  });

  it("keeps a genuinely pending task in a non-terminal state", async () => {
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async () =>
        jsonResponse(200, { data: { task_id: "task-1", task_status: "submitted" } }),
    });

    expect((await api.getTask("task-1")).state).toBe("queued");
  });

  it("submits a video-to-video task and returns its identifier", async () => {
    const request = await restyleRequest();
    let seenAuthorization: string | null = null;
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async (_input, init) => {
        seenAuthorization = new Headers(init?.headers).get("authorization");
        return jsonResponse(200, { data: { task_id: "task-9", task_status: "submitted" } });
      },
    });

    const task = await api.submitVideoToVideo(request, AbortSignal.timeout(5_000));
    expect(task.taskId).toBe("task-9");
    expect(seenAuthorization).toBe("Bearer secret");
  });

  it("downloads a finished result to disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "guyditor-kling-out-"));
    directories.push(directory);
    const destination = join(directory, "result.mp4");
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async (input) =>
        String(input).startsWith("https://cdn.example")
          ? new Response("result-bytes", { status: 200 })
          : jsonResponse(200, {
              data: {
                task_id: "task-1",
                task_status: "succeed",
                task_result: { videos: [{ url: "https://cdn.example/out.mp4" }] },
              },
            }),
    });

    await api.downloadResult("task-1", destination);
    expect(await readFile(destination, "utf8")).toBe("result-bytes");
  });

  it("refuses a result URL that is not http(s)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "guyditor-kling-out-"));
    directories.push(directory);
    const api = new HttpKlingApi({
      apiKey: "secret",
      fetchImplementation: async () =>
        jsonResponse(200, {
          data: {
            task_id: "task-1",
            task_status: "succeed",
            task_result: { videos: [{ url: "file:///etc/passwd" }] },
          },
        }),
    });

    await expect(api.downloadResult("task-1", join(directory, "result.mp4")))
      .rejects.toThrow(/http/u);
  });
});
