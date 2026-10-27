import type { ScriptBlock } from "./index.js";

/** Split text into sentences on `.`, `!` or `?` followed by whitespace or end of text. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])(?:\s+|$)/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function cleanText(raw: string): string {
  return raw
    .replace(/\[F-\d+\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<\/?u>/gu, "")
    .replace(/\*/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Parse a Markdown episode script into numbered blocks (`S001…`) in document order. */
export function parseScriptBlocks(markdown: string): ScriptBlock[] {
  const lines = markdown.split(/\r?\n/u);
  const hasQuotes = lines.some((l) => l.trimStart().startsWith(">"));
  const blocks: ScriptBlock[] = [];
  let section = "";
  let current: string[] = [];

  const flush = (): void => {
    const text = cleanText(current.join(" "));
    current = [];
    if (text === "") return;
    blocks.push({
      id: `S${String(blocks.length + 1).padStart(3, "0")}`,
      section,
      text,
      sentences: splitSentences(text),
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^##\s+(.*)$/u.exec(trimmed);
    if (heading) {
      flush();
      section = (heading[1] ?? "").trim();
    } else if (trimmed.startsWith("#")) {
      flush();
    } else if (hasQuotes) {
      const body = trimmed.startsWith(">") ? trimmed.slice(1).trim() : null;
      if (body === null || body === "") flush();
      else current.push(body);
    } else if (trimmed === "") {
      flush();
    } else {
      current.push(trimmed);
    }
  }
  flush();
  return blocks;
}
