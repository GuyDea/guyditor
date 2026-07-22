import type { GenerationRequest } from "./types.js";

export type TextFreeGenerationValidation =
  | { ok: true }
  | {
      ok: false;
      error: {
        code: "E_GENERATION_TEXT_OVERLAY";
        message: string;
        suggestion: string;
      };
    };

function includesVisualTextSetting(value: unknown, key = ""): boolean {
  if (/(?:text|title|caption|subtitle|label|watermark).*?(?:overlay|render)?/iu.test(key)) {
    return value !== undefined && value !== null && value !== false && value !== "";
  }
  if (Array.isArray(value)) return value.some((child) => includesVisualTextSetting(child));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([childKey, child]) =>
    includesVisualTextSetting(child, childKey));
}

export function validateTextFreeGenerationRequest(
  request: GenerationRequest,
): TextFreeGenerationValidation {
  if (!includesVisualTextSetting(request.providerSettings)) return { ok: true };
  return {
    ok: false,
    error: {
      code: "E_GENERATION_TEXT_OVERLAY",
      message: "Generated B-roll must be text-free; visual text belongs to the template renderer.",
      suggestion: "Use a programmatic-animation template for all visual text.",
    },
  };
}

