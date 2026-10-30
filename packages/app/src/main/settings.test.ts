import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  loadSettings,
  readSettingsKey,
  replaceSettingsKey,
  saveAiSettings,
} from "./settings.js";

describe("loadSettings", () => {
  it("renames malformed settings and recovers with defaults", async () => {
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-settings-"));
    await writeFile(join(userDirectory, "settings.json"), "{broken", "utf8");
    const now = new Date("2026-07-19T10:11:12.345Z");

    const loaded = await loadSettings(userDirectory, () => now);

    expect(loaded.settings.schema).toBe(1);
    expect(loaded.settings.general.reopenLastProject).toBe(true);
    expect(loaded.settings.network.externalCalls).toBe("ask");
    expect(loaded.settings.rights.requirementLevel).toBe("warn");
    expect(loaded.settings.adapters.restyle.kling).toEqual({
      enabled: true,
      apiKeyRef: "apiKey",
      model: "kling-video-o1",
      costPerSecond: 0.14,
      concurrency: 2,
    });
    expect(loaded.recoveredPath).toBe(
      join(userDirectory, `settings.json.bad-${String(now.getTime())}`),
    );
    await expect(readFile(loaded.recoveredPath!, "utf8")).resolves.toBe("{broken");
    expect(loaded.warning).toMatch(/recovered/i);
  });

  it("defaults transport to api and cli paths to the bare names", async () => {
    expect(DEFAULT_SETTINGS.ai.transport).toEqual({ anthropic: "api", openai: "api" });
    expect(DEFAULT_SETTINGS.ai.cli).toEqual({ claudePath: "claude", codexPath: "codex" });
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-settings-"));
    await writeFile(join(userDirectory, "settings.json"), '{"schema":1,"ai":{"provider":"openai"}}', "utf8");
    const { settings } = await loadSettings(userDirectory);
    expect(settings.ai.provider).toBe("openai");
    expect(settings.ai.transport).toEqual({ anthropic: "api", openai: "api" });
    expect(settings.ai.cli).toEqual({ claudePath: "claude", codexPath: "codex" });
  });
});

describe("replaceSettingsKey", () => {
  it("replaces one top-level key and keeps every other key", async () => {
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-settings-"));
    const original = { schema: 1, ai: DEFAULT_SETTINGS.ai, general: { locale: "cs" } };
    await writeFile(join(userDirectory, "settings.json"), JSON.stringify(original), "utf8");

    await replaceSettingsKey(userDirectory, "workspace", { activePhase: "cut" });

    const written = JSON.parse(await readFile(join(userDirectory, "settings.json"), "utf8")) as
      Record<string, unknown>;
    expect(written["ai"]).toEqual(original.ai);
    expect(written["general"]).toEqual(original.general);
    expect(written["workspace"]).toEqual({ activePhase: "cut" });
  });

  it("keeps the workspace key when AI settings are saved", async () => {
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-settings-"));
    await replaceSettingsKey(userDirectory, "workspace", { activePhase: "polish" });

    await saveAiSettings(userDirectory, DEFAULT_SETTINGS.ai);

    expect(await readSettingsKey(userDirectory, "workspace")).toEqual({ activePhase: "polish" });
  });

  it("does not lose either key when both writers run concurrently", async () => {
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-settings-"));

    await Promise.all([
      replaceSettingsKey(userDirectory, "workspace", { activePhase: "review" }),
      saveAiSettings(userDirectory, DEFAULT_SETTINGS.ai),
    ]);

    expect(await readSettingsKey(userDirectory, "workspace")).toEqual({ activePhase: "review" });
    expect(await readSettingsKey(userDirectory, "ai")).toEqual(DEFAULT_SETTINGS.ai);
  });

  it("reads undefined for a missing file, key or unparsable file", async () => {
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-settings-"));
    expect(await readSettingsKey(userDirectory, "workspace")).toBeUndefined();
    await writeFile(join(userDirectory, "settings.json"), "{broken", "utf8");
    expect(await readSettingsKey(userDirectory, "workspace")).toBeUndefined();
  });

  it("loads settings with a workspace key without injecting a default for it", async () => {
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-settings-"));
    await replaceSettingsKey(userDirectory, "workspace", { layouts: { cut: 42 } });

    const loaded = await loadSettings(userDirectory);

    expect("workspace" in DEFAULT_SETTINGS).toBe(false);
    expect(loaded.warning).toBeUndefined();
  });
});
