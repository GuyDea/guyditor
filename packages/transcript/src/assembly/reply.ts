import { Ajv2020 } from "ajv/dist/2020.js";
import { failure, makeGuyditorError, success, type Result } from "../../../core/src/index.js";
import type { AssemblyReply, ScriptBlock } from "./types.js";

const str = { type: "string" } as const;
const nullable = (inner: Record<string, unknown>): Record<string, unknown> => ({ ...inner, type: [inner.type, "null"] });

const wordRange = {
  type: "object",
  properties: { assetId: str, fromWord: str, toWord: str },
  required: ["assetId", "fromWord", "toWord"],
  additionalProperties: false,
};

/** Strict-compatible (OpenAI strict mode): all properties required, optionals are `[type, "null"]`. */
export const ASSEMBLY_REPLY_SCHEMA: Readonly<Record<string, unknown>> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: {
    question: {
      type: "object",
      properties: {
        id: str,
        about: { oneOf: [{ $ref: "#/$defs/wordRange" }, { type: "null" }] },
        text: str,
        options: nullable({ type: "array", items: str }),
      },
      required: ["id", "about", "text", "options"],
      additionalProperties: false,
    },
    wordRange,
    cut: {
      type: "object",
      properties: {
        scriptBlock: nullable(str),
        scriptSentences: nullable({ type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 }),
        assetId: str,
        fromWord: str,
        toWord: str,
        reason: str,
      },
      required: ["scriptBlock", "scriptSentences", "assetId", "fromWord", "toWord", "reason"],
      additionalProperties: false,
    },
    flag: {
      type: "object",
      properties: {
        cutIndex: { type: "integer", minimum: 0 },
        kind: { enum: ["stitch", "override", "low-confidence", "unmatched", "other"] },
        note: str,
      },
      required: ["cutIndex", "kind", "note"],
      additionalProperties: false,
    },
  },
  oneOf: [
    {
      type: "object",
      properties: {
        status: { const: "questions" },
        summary: str,
        questions: { type: "array", items: { $ref: "#/$defs/question" } },
      },
      required: ["status", "summary", "questions"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        status: { const: "plan" },
        summary: str,
        tightening: { enum: ["gentle", "off", null] },
        cuts: { type: "array", items: { $ref: "#/$defs/cut" } },
        flags: { type: "array", items: { $ref: "#/$defs/flag" } },
      },
      required: ["status", "summary", "tightening", "cuts", "flags"],
      additionalProperties: false,
    },
  ],
};

export interface ReplyContext {
  words: Map<string, { assetId: string; state: "active" | "deleted"; order: number }>;
  scriptBlocks: ScriptBlock[];
  assetIds: string[];
}

const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(ASSEMBLY_REPLY_SCHEMA);

function invalid(problems: string[]): Result<AssemblyReply> {
  return failure(makeGuyditorError("E_ASSEMBLY_REPLY_INVALID", problems.join("; "), { retry: "none" }));
}

/** Checks one `[fromWord, toWord]` span; returns its order range when usable. */
function checkSpan(
  label: string,
  span: { assetId: string; fromWord: string; toWord: string },
  context: ReplyContext,
  problems: string[],
): [number, number] | null {
  const before = problems.length;
  if (!context.assetIds.includes(span.assetId)) problems.push(`${label}: unknown asset ${span.assetId}`);
  const ends = [span.fromWord, span.toWord].map((id) => {
    const word = context.words.get(id);
    if (word === undefined) problems.push(`${label}: word ${id} does not exist`);
    else if (word.state !== "active") problems.push(`${label}: word ${id} is deleted`);
    else if (word.assetId !== span.assetId) problems.push(`${label}: word ${id} belongs to asset ${word.assetId}, not ${span.assetId}`);
    return word;
  });
  const [from, to] = ends;
  if (problems.length > before || from === undefined || to === undefined) return null;
  if (from.order > to.order) {
    problems.push(`${label}: fromWord ${span.fromWord} comes after toWord ${span.toWord} (reversed word order)`);
    return null;
  }
  return [from.order, to.order];
}

export function validateAssemblyReply(value: unknown, context: ReplyContext): Result<AssemblyReply> {
  if (!validateSchema(value)) {
    const problems = (validateSchema.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
    return invalid(problems.length > 0 ? problems : ["reply does not match the schema"]);
  }
  const reply = value as AssemblyReply;
  const problems: string[] = [];

  if (reply.status === "questions") {
    if (reply.questions.length < 1) problems.push("questions: at least one question is required");
    reply.questions.forEach((q, i) => {
      if (q.about !== null) checkSpan(`questions[${i}].about`, q.about, context, problems);
    });
  } else {
    if (reply.cuts.length < 1) problems.push("cuts: at least one cut is required");
    const byAsset = new Map<string, { index: number; range: [number, number] }[]>();
    reply.cuts.forEach((cut, i) => {
      const range = checkSpan(`cuts[${i}]`, cut, context, problems);
      if (cut.scriptBlock !== null && !context.scriptBlocks.some((b) => b.id === cut.scriptBlock)) {
        problems.push(`cuts[${i}]: unknown script block ${cut.scriptBlock}`);
      }
      if (range === null) return;
      const list = byAsset.get(cut.assetId) ?? [];
      for (const other of list) {
        if (range[0] <= other.range[1] && other.range[0] <= range[1]) {
          problems.push(`cuts[${other.index}] and cuts[${i}] overlap in asset ${cut.assetId}`);
        }
      }
      list.push({ index: i, range });
      byAsset.set(cut.assetId, list);
    });
    reply.flags.forEach((flag, i) => {
      if (flag.cutIndex >= reply.cuts.length) problems.push(`flags[${i}]: cutIndex ${flag.cutIndex} is out of range`);
    });
  }

  return problems.length > 0 ? invalid(problems) : success(reply);
}
