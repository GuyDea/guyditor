import type { AssemblyEffort, AssemblyProvider } from "../../../transcript/src/index.js";

export interface LlmRate { inputPerMTok: number; outputPerMTok: number }

/**
 * USD per million tokens, fetched 2026-10-27.
 * Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (base input / output).
 *   Haiku 5.5 is tiered by prompt size; the over-100K-token tier is used so estimates never undershoot.
 * OpenAI: https://developers.openai.com/api/docs/pricing (standard tier, short context <=272K).
 * User-editable in settings later; unknown models fall back via resolveRate.
 */
export const DEFAULT_LLM_RATES: Readonly<Record<string, LlmRate>> = {
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-5-5": { inputPerMTok: 0.5, outputPerMTok: 2.5 },
  "gpt-6.1-sol": { inputPerMTok: 2, outputPerMTok: 10 },
  "gpt-6.1-terra": { inputPerMTok: 1, outputPerMTok: 5 },
  "gpt-6-sol": { inputPerMTok: 2, outputPerMTok: 10 },
  "gpt-5.6-sol": { inputPerMTok: 4, outputPerMTok: 20 },
  "gpt-5.6-terra": { inputPerMTok: 2, outputPerMTok: 12 },
  "gpt-5.5": { inputPerMTok: 5, outputPerMTok: 30 },
  "gpt-5.4": { inputPerMTok: 2.5, outputPerMTok: 15 },
  "gpt-5.4-mini": { inputPerMTok: 0.75, outputPerMTok: 4.5 },
};

/** Typical reply size, used only for the pre-call cost estimate (not as a cap). */
export const ASSEMBLY_OUTPUT_TOKEN_ESTIMATE = 4000;

/** Visible-reply token cap per turn; adapters add the reasoning budget on top. */
export const ASSEMBLY_REPLY_TOKEN_ALLOWANCE = 16_000;

/** Reasoning budget per effort: Anthropic thinking `budget_tokens`; OpenAI's share of `max_output_tokens`. */
export const ASSEMBLY_REASONING_BUDGET: Readonly<Record<AssemblyEffort, number>> = {
  low: 2048, medium: 8192, high: 16384, max: 32768,
};

/** The message both adapters use when the provider stopped at the output cap. */
export const TRUNCATED_REPLY_MESSAGE =
  "E_ASSEMBLY_REPLY_TRUNCATED: the reply hit the output-token limit before it finished; try a lower effort or a shorter request";

const total = (rate: LlmRate): number => rate.inputPerMTok + rate.outputPerMTok;

function highest(entries: [string, LlmRate][]): LlmRate | null {
  let best: LlmRate | null = null;
  for (const [, rate] of entries) if (best === null || total(rate) > total(best)) best = rate;
  return best;
}

export function resolveRate(
  rates: Readonly<Record<string, LlmRate>>,
  provider: AssemblyProvider,
  model: string,
): { rate: LlmRate; estimated: boolean } {
  if (provider === "stub") return { rate: { inputPerMTok: 0, outputPerMTok: 0 }, estimated: false };
  const known = rates[model];
  if (known !== undefined) return { rate: known, estimated: false };
  const all = Object.entries(rates);
  const own = all.filter(([id]) => id.startsWith("claude-") === (provider === "anthropic"));
  const rate = highest(own) ?? highest(all) ?? { inputPerMTok: 0, outputPerMTok: 0 };
  return { rate, estimated: true };
}

export function estimateUsd(rate: LlmRate, usage: { inputTokens: number; outputTokens: number }): number {
  return (usage.inputTokens / 1e6) * rate.inputPerMTok + (usage.outputTokens / 1e6) * rate.outputPerMTok;
}

/** Model ids in the rate table for one provider, sorted. */
export function knownModels(
  provider: "anthropic" | "openai",
  rates: Readonly<Record<string, LlmRate>> = DEFAULT_LLM_RATES,
): string[] {
  return Object.keys(rates).filter((id) => id.startsWith("claude-") === (provider === "anthropic")).sort();
}
