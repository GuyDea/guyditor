import {
  resolveBrandTemplateParams,
} from "../../core/src/index.js";
import type {
  ProjectStore,
  TemplateBrandDefaults,
} from "../../core/src/index.js";
import type { ResolvedSkill } from "./skills/types.js";

const BLOCK = /```guyditor-template-brand\/v1[ \t]*\r?\n([\s\S]*?)\r?\n```/gu;
const TEMPLATE_ID = /^tpl_[a-z2-7]{10}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new TypeError(`${label} contains unsupported fields: ${extras.join(", ")}.`);
  }
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  const entries = Object.entries(value);
  if (entries.some(([, child]) => typeof child !== "string" || child.length === 0)) {
    throw new TypeError(`${label} values must be non-empty strings.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parameterRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return structuredClone(value);
}

function templateRecords(value: unknown): Record<string, Record<string, unknown>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError("brand templates must be an object.");
  return Object.fromEntries(Object.entries(value).map(([templateId, params]) => {
    if (!TEMPLATE_ID.test(templateId)) {
      throw new TypeError(`Brand template key ${templateId} is not a template ID.`);
    }
    return [templateId, parameterRecord(params, `brand templates.${templateId}`)];
  }));
}

export function parseBrandTemplateDefaults(
  skill: ResolvedSkill,
): TemplateBrandDefaults {
  if (
    skill.manifest.name !== "brand_visual" ||
    !skill.manifest.categories.includes("brand_visual")
  ) {
    throw new TypeError("Template brand defaults require a brand_visual skill.");
  }
  const blocks = [...skill.body.matchAll(BLOCK)];
  if (blocks.length !== 1) {
    throw new TypeError("A brand_visual skill must contain exactly one guyditor-template-brand/v1 block.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0]![1]!) as unknown;
  } catch (error: unknown) {
    throw new TypeError(
      `The guyditor-template-brand/v1 block is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
  if (!isRecord(parsed)) throw new TypeError("Template brand defaults must be an object.");
  exactKeys(
    parsed,
    ["schema", "palette", "fonts", "logoSlots", "params", "templates"],
    "template brand defaults",
  );
  if (parsed["schema"] !== "guyditor-template-brand/v1") {
    throw new TypeError("Template brand defaults schema must be guyditor-template-brand/v1.");
  }
  return {
    schema: "guyditor-template-brand/v1",
    palette: stringRecord(parsed["palette"], "brand palette"),
    fonts: stringRecord(parsed["fonts"], "brand fonts"),
    logoSlots: stringRecord(parsed["logoSlots"], "brand logoSlots"),
    params: parameterRecord(parsed["params"], "brand params"),
    templates: templateRecords(parsed["templates"]),
  };
}

export async function pinnedBrandTemplateDefaults(
  store: ProjectStore,
  registry: { pinned(project: ProjectStore): Promise<ResolvedSkill[]> },
): Promise<TemplateBrandDefaults | undefined> {
  const pin = store.currentProject.skills.find(({ name }) => name === "brand_visual");
  if (pin === undefined) return undefined;
  const brand = (await registry.pinned(store)).find(
    ({ manifest }) => manifest.id === pin.id,
  );
  return brand?.body.includes("```guyditor-template-brand/v1") === true
    ? parseBrandTemplateDefaults(brand)
    : undefined;
}

export { resolveBrandTemplateParams };
