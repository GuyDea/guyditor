import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_RATES, estimateUsd, resolveRate } from "./pricing.js";

const RATES = {
  "claude-a": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-b": { inputPerMTok: 3, outputPerMTok: 15 },
  "gpt-x": { inputPerMTok: 2, outputPerMTok: 8 },
};

describe("pricing", () => {
  it("unknown model is priced at the provider maximum and marked estimated", () => {
    expect(resolveRate(RATES, "anthropic", "claude-new")).toEqual({ rate: RATES["claude-b"], estimated: true });
    expect(resolveRate(RATES, "openai", "gpt-new")).toEqual({ rate: RATES["gpt-x"], estimated: true });
  });

  it("known model is exact", () => {
    expect(resolveRate(RATES, "anthropic", "claude-a")).toEqual({ rate: RATES["claude-a"], estimated: false });
  });

  it("provider without known models falls back to the global maximum", () => {
    expect(resolveRate({ "claude-b": RATES["claude-b"] }, "openai", "gpt-new").rate).toEqual(RATES["claude-b"]);
  });

  it("stub is free", () => {
    expect(resolveRate(RATES, "stub", "stub-model")).toEqual({
      rate: { inputPerMTok: 0, outputPerMTok: 0 }, estimated: false,
    });
  });

  it("estimateUsd scales per million tokens", () => {
    expect(estimateUsd({ inputPerMTok: 3, outputPerMTok: 15 }, { inputTokens: 1e6, outputTokens: 1e6 })).toBe(18);
  });

  it("ships the Claude 5.5 models", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
      expect(DEFAULT_LLM_RATES[id]).toBeDefined();
    }
  });
});
