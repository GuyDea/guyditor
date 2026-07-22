import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AdapterRegistry,
  FileCredentialStore,
  KLING_ADAPTER_CANONICAL_NAME,
  KlingRestyleAdapter,
  SafeStorageCredentialStore,
} from "../index.js";
import type {
  KlingApi,
  KlingApiTask,
  RestyleRequest,
} from "../index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

async function directory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function request(inputFilePath: string): RestyleRequest {
  return {
    requestId: "restyle-request-adapter-001",
    model: "kling-video-o1",
    prompt: "Watercolor documentary",
    inputFilePath,
    inputMime: "video/mp4",
    referenceAssetIds: ["ast_aaaaaaaaaa"],
    sourceRange: { sequenceId: "seq_aaaaaaaaaa", startFrame: 0, endFrame: 60 },
    width: 1920,
    height: 1080,
    fps: "30/1",
    durationSeconds: 2,
    seed: 7,
    providerSettings: { creativity: 0.35 },
  };
}

class CompleteFakeKlingApi implements KlingApi {
  public submitted: RestyleRequest | undefined;

  public async submitVideoToVideo(input: RestyleRequest): Promise<KlingApiTask> {
    this.submitted = structuredClone(input);
    return {
      taskId: "kling-task-001",
      state: "queued",
      progress: 0,
      providerMetadata: { requestId: "provider-request-001" },
    };
  }

  public getTask(): Promise<KlingApiTask> {
    return Promise.resolve({
      taskId: "kling-task-001",
      state: "succeeded",
      progress: 1,
      output: {
        url: "https://provider.invalid/output.mp4",
        mime: "video/mp4",
        width: 1920,
        height: 1080,
        durationSeconds: 2,
      },
      actualCostUsd: 0.3,
      providerMetadata: {
        requestId: "provider-request-001",
        model: "kling-video-o1",
      },
    });
  }

  public async downloadResult(_taskId: string, destination: string): Promise<void> {
    await writeFile(destination, "fake-kling-result");
  }

  public cancel(): Promise<void> {
    return Promise.resolve();
  }
}

describe("FR-607 adapter and credentials", () => {
  it("stores headless credentials outside projects with mode 0600", async () => {
    const userDir = await directory("guyditor-credentials-");
    const store = new FileCredentialStore({ userDir });

    await store.set("adp_klingaaaaa", "apiKey", "kling-secret-value");

    expect(await store.get("adp_klingaaaaa", "apiKey")).toBe("kling-secret-value");
    expect(await store.values()).toEqual(["kling-secret-value"]);
    const credentialsPath = join(userDir, "state/credentials.json");
    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(credentialsPath, "utf8")).toContain("kling-secret-value");
  });

  it("uses an injected safeStorage codec without serializing plaintext", async () => {
    const userDir = await directory("guyditor-safe-credentials-");
    const codec = {
      isEncryptionAvailable: () => true,
      encryptString(value: string): Buffer {
        return Buffer.from([...value].reverse().join(""), "utf8");
      },
      decryptString(value: Buffer): string {
        return [...value.toString("utf8")].reverse().join("");
      },
    };
    const store = new SafeStorageCredentialStore({ userDir, codec });

    await store.set("adp_klingaaaaa", "apiKey", "never-plaintext");

    expect(await store.get("adp_klingaaaaa", "apiKey")).toBe("never-plaintext");
    const persisted = await readFile(join(userDir, "state/credentials.safe.json"), "utf8");
    expect(persisted).not.toContain("never-plaintext");
  });

  it("registers Kling by canonical name and rejects secret-bearing user config", async () => {
    const userDir = await directory("guyditor-registry-");
    const credentials = new FileCredentialStore({ userDir });
    const adapter = new KlingRestyleAdapter({
      credentials,
      config: { apiKeyRef: "apiKey", model: "kling-video-o1" },
      stubMode: true,
    });
    const registry = new AdapterRegistry();

    registry.register(adapter);
    expect(adapter.descriptor).toMatchObject({
      capabilities: ["restyle"],
      modes: ["video"],
      maxConcurrent: 2,
    });
    expect(registry.resolve(KLING_ADAPTER_CANONICAL_NAME)).toBe(adapter);
    expect(registry.resolve("adp_klingaaaaa")).toBe(adapter);
    expect(() => registry.configure("adp_klingaaaaa", {
      enabled: true,
      apiKey: "must-not-be-settings",
    })).toThrow(/secret/i);
    registry.configure("adp_klingaaaaa", {
      enabled: true,
      baseUrl: "https://api-singapore.klingai.com",
      apiKeyRef: "apiKey",
      model: "kling-video-o1",
    });
    expect(registry.configuration("adp_klingaaaaa")).toEqual({
      enabled: true,
      baseUrl: "https://api-singapore.klingai.com",
      apiKeyRef: "apiKey",
      model: "kling-video-o1",
    });
  });

  it("maps the live restyle request through KlingApi polling and result metadata", async () => {
    const root = await directory("guyditor-kling-adapter-");
    const inputPath = join(root, "input.mp4");
    await writeFile(inputPath, "fake-input");
    const credentials = new FileCredentialStore({ userDir: root });
    await credentials.set("adp_klingaaaaa", "apiKey", "live-key");
    const fakeApi = new CompleteFakeKlingApi();
    const adapter = new KlingRestyleAdapter({
      credentials,
      config: { apiKeyRef: "apiKey", model: "kling-video-o1" },
      stubMode: false,
      apiFactory: ({ apiKey }) => {
        expect(apiKey).toBe("live-key");
        return fakeApi;
      },
    });

    const handle = await adapter.restyle(request(inputPath), new AbortController().signal);
    expect(handle).toEqual({ adapterId: "adp_klingaaaaa", providerJobId: "kling-task-001" });
    expect(fakeApi.submitted).toEqual(request(inputPath));
    await expect(adapter.poll(handle)).resolves.toMatchObject({
      state: "succeeded",
      providerMetadata: { requestId: "provider-request-001" },
      actualCostUsd: 0.3,
    });
    const destination = join(root, "result");
    await mkdir(destination);
    const result = await adapter.fetchResult(handle, destination);
    expect(result).toMatchObject({
      output: {
        filePath: join(destination, "restyled.mp4"),
        mime: "video/mp4",
        width: 1920,
        height: 1080,
        durationSeconds: 2,
        providerMetadata: {
          requestId: "provider-request-001",
          model: "kling-video-o1",
        },
      },
      actualCostUsd: 0.3,
    });
    await chmod(join(destination, "restyled.mp4"), 0o600);
  });
});
