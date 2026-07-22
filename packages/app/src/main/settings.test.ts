import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadSettings } from "./settings.js";

describe("loadSettings", () => {
  it("renames malformed settings and recovers with defaults", async () => {
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-settings-"));
    await writeFile(join(userDirectory, "settings.json"), "{broken", "utf8");
    const now = new Date("2026-07-19T10:11:12.345Z");

    const loaded = await loadSettings(userDirectory, () => now);

    expect(loaded.settings.schema).toBe(1);
    expect(loaded.settings.general.reopenLastProject).toBe(true);
    expect(loaded.settings.network.externalCalls).toBe("ask");
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
});
