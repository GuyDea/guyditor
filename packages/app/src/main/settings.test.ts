import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, loadSettings } from "./settings.js";

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
