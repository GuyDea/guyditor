import { describe, expect, it } from "vitest";

import type { ResolvedSkill } from "./skills/types.js";
import {
  parseBrandTemplateDefaults,
  resolveBrandTemplateParams,
} from "./brand-template.js";

function skill(body: string): ResolvedSkill {
  return {
    manifest: {
      id: "skl_bbbbbbbbbb",
      name: "brand_visual",
      version: "2.0.0",
      title: "Brand visual",
      categories: ["brand_visual"],
      summary: "Visual brand defaults.",
      rules: [],
      examples: { approved: [], rejected: [] },
      contentHash: "b".repeat(64),
    },
    body,
    presetReferences: [],
  };
}

describe("FR-611 brand_visual template convention", () => {
  it("parses the closed guyditor-template-brand/v1 JSON block", () => {
    const defaults = parseBrandTemplateDefaults(skill(`# Brand

\`\`\`guyditor-template-brand/v1
{
  "schema": "guyditor-template-brand/v1",
  "palette": { "accent": "#77E7C4", "background": "#10171C" },
  "fonts": { "display": "Brand Display" },
  "logoSlots": { "primary": "brand" },
  "params": { "accent": "#66CCAA", "fontFamily": "Brand Display", "logoSlot": "primary" },
  "templates": {
    "tpl_a2c3d4e5f6": { "accent": "#FF6B57" }
  }
}
\`\`\`
`));
    expect(defaults).toEqual({
      schema: "guyditor-template-brand/v1",
      palette: { accent: "#77E7C4", background: "#10171C" },
      fonts: { display: "Brand Display" },
      logoSlots: { primary: "brand" },
      params: {
        accent: "#66CCAA",
        fontFamily: "Brand Display",
        logoSlot: "primary",
      },
      templates: {
        "tpl_a2c3d4e5f6": { accent: "#FF6B57" },
      },
    });
  });

  it("resolves explicit params over template brand, global brand, then template defaults", () => {
    const resolved = resolveBrandTemplateParams({
      templateId: "tpl_a2c3d4e5f6",
      schema: {
        type: "object",
        properties: {
          accent: { type: "string", default: "#000000" },
          background: { type: "string", default: "#FFFFFF" },
          fontFamily: { type: "string", default: "Template Sans" },
          logoSlot: { type: "string", default: "none" },
          title: { type: "string", default: "Template title" },
        },
      },
      explicit: {
        title: "Creator title",
        accent: "#123456",
      },
      brand: {
        schema: "guyditor-template-brand/v1",
        palette: {},
        fonts: {},
        logoSlots: {},
        params: {
          accent: "#66CCAA",
          background: "#10171C",
          fontFamily: "Brand Display",
        },
        templates: {
          "tpl_a2c3d4e5f6": { accent: "#FF6B57", logoSlot: "primary" },
        },
      },
    });
    expect(resolved).toEqual({
      accent: "#123456",
      background: "#10171C",
      fontFamily: "Brand Display",
      logoSlot: "primary",
      title: "Creator title",
    });
  });

  it("maps palette, font, and logo resource keys onto matching template params", () => {
    expect(resolveBrandTemplateParams({
      templateId: "tpl_a2c3d4e5f6",
      schema: {
        type: "object",
        properties: {
          accent: { type: "string", default: "#000000" },
          fontFamily: { type: "string", default: "Template Sans" },
          logoSlot: { type: "string", default: "none" },
        },
      },
      explicit: {},
      brand: {
        schema: "guyditor-template-brand/v1",
        palette: { accent: "#77E7C4", unused: "#FFFFFF" },
        fonts: { fontFamily: "Inconsolata Guyditor" },
        logoSlots: { logoSlot: "brand" },
        params: {},
        templates: {},
      },
    })).toEqual({
      accent: "#77E7C4",
      fontFamily: "Inconsolata Guyditor",
      logoSlot: "brand",
    });
  });

  it("rejects malformed or non-brand skill content instead of guessing", () => {
    expect(() => parseBrandTemplateDefaults(skill(
      "```guyditor-template-brand/v1\n{\"schema\":\"wrong\"}\n```",
    ))).toThrow(/schema/iu);
    const wrongCategory = skill(
      "```guyditor-template-brand/v1\n{\"schema\":\"guyditor-template-brand/v1\"}\n```",
    );
    wrongCategory.manifest.name = "pacing";
    expect(() => parseBrandTemplateDefaults(wrongCategory)).toThrow(/brand_visual/iu);
  });
});
