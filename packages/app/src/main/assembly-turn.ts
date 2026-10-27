import { ASSEMBLY_REPLY_TOKEN_ALLOWANCE } from "../../../agent/src/index.js";
import type { LlmAdapter, LlmMessage } from "../../../agent/src/index.js";
import { validateAssemblyReply } from "../../../transcript/src/index.js";
import type { AssemblyMessage, AssemblySession, ReplyContext } from "../../../transcript/src/index.js";

export interface TurnDeps {
  adapter: LlmAdapter;
  system: string;
  schema: Readonly<Record<string, unknown>>;
  context: ReplyContext;
  maxTurns: number;
  /** Message timestamps; defaults to the wall clock. */
  now?: () => string;
  signal?: AbortSignal;
  /** Prices one completion for the stored per-message usage; defaults to unpriced. */
  price?: (usage: TurnUsage) => { usd: number; estimated: boolean };
}

export interface TurnUsage { inputTokens: number; outputTokens: number }

export const TIGHTENING_HINT = "Tightening preference: ask me before planning. ";

/**
 * A turn that failed after the user message was appended. `session` carries the
 * messages exchanged so far so the caller can persist what was sent.
 */
export class TurnError extends Error {
  public constructor(
    message: string,
    public readonly kind: "provider" | "invalid",
    public readonly session: AssemblySession,
    public readonly usage: TurnUsage,
  ) {
    super(message);
    this.name = "TurnError";
  }
}

/** Messages as the provider sees them: the evidence rides on the first user message, validation notes are user turns. */
export function llmMessages(session: AssemblySession, hint = false): LlmMessage[] {
  const evidence = session.evidence?.text ?? "";
  let first = true;
  return session.messages.map(({ role, content }) => {
    if (role === "assistant") return { role, content };
    if (!first) return { role: "user", content };
    first = false;
    return { role: "user", content: `${evidence}\n\n${hint ? TIGHTENING_HINT : ""}${content}` };
  });
}

export function assistantTurns(session: AssemblySession): number {
  return session.messages.filter(({ role, reply }) => role === "assistant" && reply !== null).length;
}

const sum = (a: TurnUsage, b: TurnUsage): TurnUsage =>
  ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });

export async function runAssemblyTurn(
  session: AssemblySession,
  userText: string,
  deps: TurnDeps,
): Promise<{ session: AssemblySession; usage: TurnUsage }> {
  if (session.evidence === null) throw new Error("E_ASSEMBLY_STATE: evidence missing");
  if (assistantTurns(session) >= deps.maxTurns) {
    throw new Error(`E_ASSEMBLY_TURN_LIMIT: the conversation reached ${deps.maxTurns} turns`);
  }
  const now = deps.now ?? ((): string => new Date().toISOString());
  const hint = session.settings.tightening === "ask";
  let current: AssemblySession = {
    ...session,
    messages: [...session.messages, { role: "user", content: userText, reply: null, usage: null, at: now() }],
  };
  let usage: TurnUsage = { inputTokens: 0, outputTokens: 0 };
  let problems = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let completion;
    try {
      completion = await deps.adapter.complete({
        model: session.settings.model,
        effort: session.settings.effort,
        system: deps.system,
        messages: llmMessages(current, hint),
        responseSchema: deps.schema,
        maxOutputTokens: ASSEMBLY_REPLY_TOKEN_ALLOWANCE,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
    } catch (error: unknown) {
      throw new TurnError(error instanceof Error ? error.message : String(error), "provider", current, usage);
    }
    usage = sum(usage, completion.usage);
    const checked = validateAssemblyReply(completion.reply, deps.context);
    const turnUsage = { ...completion.usage, ...(deps.price?.(completion.usage) ?? { usd: 0, estimated: true }) };
    if (checked.ok) {
      const assistant: AssemblyMessage = {
        role: "assistant", content: JSON.stringify(checked.value), reply: checked.value, usage: turnUsage, at: now(),
      };
      return {
        session: {
          ...current,
          messages: [...current.messages, assistant],
          status: checked.value.status === "plan" ? "planned" : "conversing",
          plan: checked.value.status === "plan" ? checked.value : current.plan,
          error: null,
        },
        usage,
      };
    }
    problems = checked.error.message;
    current = {
      ...current,
      messages: [
        ...current.messages,
        { role: "assistant", content: JSON.stringify(completion.reply), reply: null, usage: turnUsage, at: now() },
        {
          role: "validation",
          content: `Your reply was rejected: ${problems}. Reply again through the schema, fixing these problems.`,
          reply: null, usage: null, at: now(),
        },
      ],
    };
  }
  throw new TurnError(`E_ASSEMBLY_REPLY_INVALID: ${problems}`, "invalid", current, usage);
}
