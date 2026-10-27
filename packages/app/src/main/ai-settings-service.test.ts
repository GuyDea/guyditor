import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EphemeralCredentialStore } from "../../../agent/src/index.js";
import type { createLlmAdapter } from "../../../agent/src/index.js";
import { AiSettingsService } from "./ai-settings-service.js";
import { DEFAULT_SETTINGS, loadSettings } from "./settings.js";

async function setup(factory?: typeof createLlmAdapter) {
  const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-ai-"));
  const service = new AiSettingsService({
    userDirectory,
    credentials: new EphemeralCredentialStore(),
    initial: structuredClone(DEFAULT_SETTINGS.ai),
    externalCalls: "ask",
    encryptionAvailable: false,
    ...(factory === undefined ? {} : { adapterFactory: factory }),
  });
  return { userDirectory, service, surface: service.surface() as Record<string, (p: unknown) => Promise<never>> };
}

describe("AiSettingsService", () => {
  it("reports key presence without the value", async () => {
    const { service } = await setup();
    await service.setKey("anthropic", "sk-secret-123");
    const view = await service.get();
    expect(view.keys.anthropic).toBe(true);
    expect(view.keys.openai).toBe(false);
    expect(JSON.stringify(view)).not.toContain("sk-secret-123");
    expect(await service.apiKey("anthropic")).toBe("sk-secret-123");
    await service.clearKey("anthropic");
    expect((await service.get()).keys.anthropic).toBe(false);
  });

  it("persists updates and keeps unknown settings keys", async () => {
    const { userDirectory, service } = await setup();
    await writeFile(join(userDirectory, "settings.json"), '{"schema":1,"custom":true}', "utf8");
    await service.update({ effort: "low" });
    const raw = JSON.parse(await readFile(join(userDirectory, "settings.json"), "utf8")) as {
      custom: boolean;
      ai: { effort: string };
    };
    expect(raw.custom).toBe(true);
    expect(raw.ai.effort).toBe("low");
    expect((await loadSettings(userDirectory)).settings.ai.effort).toBe("low");
    expect(service.current().effort).toBe("low");
  });

  it("rejects an unknown provider and bad rates", async () => {
    const { service } = await setup();
    await expect(service.update({ provider: "x" } as never)).rejects.toThrow(/E_AI_SETTINGS_INVALID/);
    await expect(service.update({ rates: { m: { inputPerMTok: -1, outputPerMTok: 1 } } })).rejects.toThrow(
      /E_AI_SETTINGS_INVALID/,
    );
    expect(service.current().provider).toBe("anthropic");
  });

  it("listModels requires a key", async () => {
    let usedKey = "";
    const factory = ((_p: string, options: { apiKey: string }) => {
      usedKey = options.apiKey;
      return { listModels: () => Promise.resolve(["m1", "m2"]) };
    }) as unknown as typeof createLlmAdapter;
    const { service } = await setup(factory);
    await expect(service.listModels("openai")).rejects.toThrow(/E_AI_KEY_MISSING/);
    await service.setKey("openai", "k-1");
    expect(await service.listModels("openai")).toEqual(["m1", "m2"]);
    expect(usedKey).toBe("k-1");
  });

  it("exposes the five IPC methods", async () => {
    const { surface } = await setup();
    expect(Object.keys(surface).sort()).toEqual(["clearKey", "get", "listModels", "setKey", "update"]);
  });
});
