import { estimateTokens } from "../../../transcript/src/index.js";
import type { AssemblyCut, AssemblyFlag, AssemblyReply } from "../../../transcript/src/index.js";
import { messageText, type LlmAdapter, type LlmCompletion, type LlmRequest } from "./types.js";

interface ParsedSegment {
  id: string;
  assetId: string;
  fromWord: string;
  toWord: string;
  groupId: string | null;
  scriptBlock: string | null;
  aside: boolean;
  spoken: string | null;
  text: string;
}

interface ParsedEvidence { segments: ParsedSegment[]; groups: Map<string, string[]> }

function parseEvidence(text: string): ParsedEvidence {
  const segments: ParsedSegment[] = [];
  const groups = new Map<string, string[]>();
  let assetId = "";
  let inGroups = false;
  let pending: ParsedSegment | null = null;
  for (const line of text.split("\n")) {
    if (pending !== null) {
      pending.text = line;
      pending = null;
      continue;
    }
    if (line.startsWith("## ")) {
      inGroups = line === "## Groups";
      if (line.startsWith("## A")) assetId = /asset (\S+)\s*$/u.exec(line)?.[1] ?? assetId;
    } else if (line.startsWith("### C")) {
      const fields = line.split(/\s{3,}/u);
      const id = /^### (C\d+\.\d+)/u.exec(fields[0]!)?.[1];
      const words = fields.map((f) => /^words (\S+)–(\S+)$/u.exec(f)).find((m) => m !== null);
      if (id === undefined || !words) continue;
      const find = (re: RegExp): string | null => {
        for (const f of fields) { const m = re.exec(f); if (m) return m[1]!; }
        return null;
      };
      pending = {
        id, assetId, fromWord: words[1]!, toWord: words[2]!,
        groupId: find(/^group (G\d+)$/u), scriptBlock: find(/^script (\S+) \(/u),
        aside: fields.includes("ASIDE?"), spoken: find(/^spoken: "(.*)"$/u), text: "",
      };
      segments.push(pending);
    } else if (inGroups) {
      const m = /^(G\d+): (.+)$/u.exec(line);
      if (m) groups.set(m[1]!, m[2]!.split(", "));
    }
  }
  return { segments, groups };
}

const blockOrder = (block: string): number => Number(/\d+/u.exec(block)?.[0] ?? Number.MAX_SAFE_INTEGER);

function question(aside: ParsedSegment): AssemblyReply {
  const phrase = aside.spoken ?? aside.text;
  return {
    status: "questions",
    summary: `One passage, ${aside.id}, may be an instruction rather than a line.`,
    questions: [{
      id: "Q1",
      about: { assetId: aside.assetId, fromWord: aside.fromWord, toWord: aside.toWord },
      text: `Is "${phrase}" at ${aside.id} an instruction rather than a line?`,
      options: ["Instruction, drop it", "It is a line, keep it"],
    }],
  };
}

function plan({ segments, groups }: ParsedEvidence): AssemblyReply {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const picks: { segment: ParsedSegment; attempts: number; groupId: string | null }[] = [];
  for (const segment of segments) {
    if (segment.aside) continue;
    if (segment.groupId === null) { picks.push({ segment, attempts: 1, groupId: null }); continue; }
    const members = groups.get(segment.groupId) ?? [segment.id];
    if (members.at(-1) === segment.id) {
      picks.push({ segment: byId.get(segment.id)!, attempts: members.length, groupId: segment.groupId });
    }
  }
  const hasBlocks = picks.some(({ segment }) => segment.scriptBlock !== null);
  const ordered = hasBlocks
    ? picks.map((p, i) => ({ p, i })).sort((a, b) =>
      blockOrder(a.p.segment.scriptBlock ?? "") - blockOrder(b.p.segment.scriptBlock ?? "") || a.i - b.i)
      .map(({ p }) => p)
    : picks;
  const cuts: AssemblyCut[] = [];
  const flags: AssemblyFlag[] = [];
  ordered.forEach(({ segment, attempts, groupId }, index) => {
    cuts.push({
      scriptBlock: segment.scriptBlock, scriptSentences: null, assetId: segment.assetId,
      fromWord: segment.fromWord, toWord: segment.toWord,
      reason: groupId !== null ? `Latest of ${attempts} attempts (${groupId})` : "Only attempt",
    });
    if (attempts > 1) flags.push({ cutIndex: index, kind: "other", note: `${segment.id} chosen from ${attempts} attempts in ${groupId}.` });
  });
  return {
    status: "plan",
    summary: `Stub plan with ${cuts.length} cut${cuts.length === 1 ? "" : "s"}, latest take of each line.`,
    tightening: null, cuts, flags,
  };
}

/** Deterministic adapter for tests: parses the Task 5 evidence layout, never touches the network. */
export class StubLlmAdapter implements LlmAdapter {
  readonly provider = "stub" as const;

  complete(request: LlmRequest): Promise<LlmCompletion> {
    const evidence = parseEvidence(messageText(request.messages.find(({ role }) => role !== "assistant") ?? { role: "user", content: [] }));
    const firstTurn = !request.messages.some(({ role }) => role === "assistant");
    const aside = firstTurn ? evidence.segments.find((s) => s.aside) : undefined;
    const reply = aside ? question(aside) : plan(evidence);
    const inputTokens = estimateTokens(request.system + request.messages.map(messageText).join(""));
    return Promise.resolve({ reply, usage: { inputTokens, outputTokens: 200 } });
  }

  listModels(): Promise<string[]> {
    return Promise.resolve(["stub-model"]);
  }
}
