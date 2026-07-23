import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TemplateRegistry } from "./template-registry.js";

describe("FR-600 built-in graphics templates", () => {
  it("ships the starter set with schema-driven preview parameters", async () => {
    const registry = new TemplateRegistry({
      builtinsRoot: resolve(process.cwd(), "templates"),
      userRoot: await mkdtemp(`${tmpdir()}/guyditor-empty-template-library-`),
    });

    const catalog = await registry.list();

    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(catalog.value.map(({ builtinName }) => builtinName)).toEqual([
      "lower-third",
      "title-card",
      "callout-box",
      "full-frame-infographic",
      "kinetic-title",
      "stat-counter-card",
      "bar-chart-card",
      "cutout-collage-card",
      "highlight-underline",
    ]);
    expect(catalog.value.map(({ kind }) => kind)).toEqual([
      "lower_third",
      "title",
      "callout",
      "diagram",
      "title",
      "diagram",
      "diagram",
      "motion",
      "highlight",
    ]);
    const infographic = catalog.value.find(
      ({ builtinName }) => builtinName === "full-frame-infographic",
    );
    expect(infographic?.params).toMatchObject({
      additionalProperties: false,
      required: ["title", "body", "accent", "logoSlot"],
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        accent: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        logoSlot: { type: "string" },
      },
    });
    expect(infographic?.duration).toEqual({
      mode: "fixed",
      default: { frames: 150, fps: "30/1" },
    });
  });
});
