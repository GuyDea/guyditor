import type { TemplateBrandDefaults } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolveBrandTemplateParams(input: {
  templateId: string;
  schema: Record<string, unknown>;
  explicit: Record<string, unknown>;
  brand?: TemplateBrandDefaults;
}): Record<string, unknown> {
  const properties = record(input.schema["properties"]);
  const templateDefaults = Object.fromEntries(
    Object.entries(properties).flatMap(([name, property]) => {
      const definition = record(property);
      return definition["default"] === undefined
        ? []
        : [[name, structuredClone(definition["default"])]];
    }),
  );
  const resourceDefaults = Object.fromEntries([
    ...Object.entries(input.brand?.palette ?? {}),
    ...Object.entries(input.brand?.fonts ?? {}),
    ...Object.entries(input.brand?.logoSlots ?? {}),
  ].filter(([name]) => name in properties));
  const globalBrand = input.brand?.params ?? {};
  const templateBrand = input.brand?.templates[input.templateId] ?? {};
  return {
    ...templateDefaults,
    ...structuredClone(resourceDefaults),
    ...structuredClone(globalBrand),
    ...structuredClone(templateBrand),
    ...structuredClone(input.explicit),
  };
}
