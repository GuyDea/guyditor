import type { DockPanelId, WorkflowPhase } from "../state/layout-state.js";

export interface HelpEntry {
  key: string;
  title: string;
  where: string;
  goodFor: string;
  howTo: string[];
  manual?: string;
}

const KEY_PATTERN = /^(panel|phase|chrome|section)\.[a-z0-9-]+(\.[a-z0-9-]+)?$/u;
const GOOD_FOR_HEADING = "What it's good for";
const HOW_TO_HEADING = "How to use it";

function fail(key: string, problem: string): never {
  throw new Error(`HELP.md entry ${key}: ${problem}`);
}

function parseEntry(key: string, lines: readonly string[]): HelpEntry {
  const fields = new Map<string, string>();
  const parts = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const part = line.match(/^###\s+(.+?)\s*$/u);
    if (part !== null) {
      const name = part[1] ?? "";
      if (name !== GOOD_FOR_HEADING && name !== HOW_TO_HEADING) {
        fail(key, `unknown part ### ${name}`);
      }
      if (parts.has(name)) fail(key, `duplicate ### ${name}`);
      current = [];
      parts.set(name, current);
    } else if (current !== undefined) {
      current.push(line);
    } else if (line.trim() !== "") {
      const field = line.match(/^([A-Za-z][A-Za-z ]*?):\s*(.*?)\s*$/u);
      if (field === null) fail(key, "text outside the two parts");
      const name = field[1] ?? "";
      if (name !== "Title" && name !== "Where" && name !== "Manual") {
        fail(key, `unknown field ${name}`);
      }
      if (fields.has(name)) fail(key, `duplicate field ${name}`);
      fields.set(name, field[2] ?? "");
    }
  }

  const title = fields.get("Title");
  if (title === undefined || title === "") fail(key, "missing Title");
  const where = fields.get("Where");
  if (where === undefined || where === "") fail(key, "missing Where");

  const goodForLines = parts.get(GOOD_FOR_HEADING);
  if (goodForLines === undefined) fail(key, `missing ### ${GOOD_FOR_HEADING}`);
  const goodFor = goodForLines.map((line) => line.trim()).filter((line) => line !== "").join(" ");
  if (goodFor === "") fail(key, `### ${GOOD_FOR_HEADING} is empty`);

  const howToLines = parts.get(HOW_TO_HEADING);
  if (howToLines === undefined) fail(key, `missing ### ${HOW_TO_HEADING}`);
  const howTo: string[] = [];
  for (const line of howToLines) {
    const text = line.trim();
    if (text === "") continue;
    const step = text.match(/^\d+\.\s+(.+)$/u);
    if (step !== null) howTo.push(step[1] ?? "");
    else if (howTo.length === 0) fail(key, `### ${HOW_TO_HEADING} must be a numbered list`);
    else howTo[howTo.length - 1] = `${howTo[howTo.length - 1] ?? ""} ${text}`;
  }
  if (howTo.length === 0) fail(key, `### ${HOW_TO_HEADING} has no numbered steps`);

  const manual = fields.get("Manual");
  return {
    key,
    title,
    where,
    goodFor,
    howTo,
    ...(manual === undefined || manual === "" ? {} : { manual }),
  };
}

export function parseHelp(source: string): Map<string, HelpEntry> {
  const entries = new Map<string, HelpEntry>();
  let key: string | null = null;
  let lines: string[] = [];
  const flush = (): void => {
    if (key === null) return;
    if (!KEY_PATTERN.test(key)) fail(key, "invalid key");
    if (entries.has(key)) fail(key, "duplicate key");
    entries.set(key, parseEntry(key, lines));
  };
  for (const line of source.replace(/\r\n?/gu, "\n").split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/u);
    if (heading !== null) {
      flush();
      key = heading[1] ?? "";
      lines = [];
    } else if (key !== null) {
      lines.push(line);
    }
  }
  flush();
  return entries;
}

export function panelHelpKey(id: DockPanelId): string {
  return `panel.${id}`;
}

export function phaseHelpKey(phase: WorkflowPhase): string {
  return `phase.${phase}`;
}

export function sectionHelpKey(panel: DockPanelId, header: string): string {
  const slug = header
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `section.${panel}.${slug}`;
}
