import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DOCK_PANEL_IDS, WORKFLOW_PHASES } from "../state/layout-state.js";
import type { DockPanelId } from "../state/layout-state.js";
import { helpEntries } from "./help-source.js";
import { panelHelpKey, phaseHelpKey, sectionHelpKey } from "./help-texts.js";

const PANELS_DIR = join(import.meta.dirname, "..", "panels");
const CHROME_KEYS = ["chrome.tool-rail", "chrome.global-progress"] as const;

/**
 * Fixed-text section headers that deliberately carry no help key, as `File.tsx: header text`.
 * Add an entry only for a header that repeats once per item, never for a fixed section.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // Sits inside each changed skill's diff block: one per item, not a panel section.
  "SkillsPanel.tsx: Prose body changed",
]);

interface FoundHeader {
  file: string;
  tag: string;
  text: string;
  /** The resolved key, or undefined when the opening tag has no `data-help`. */
  key: string | undefined;
  /** The text a `sectionHelpKey("<panel>", "<header>")` call was given, when written as a call. */
  keyedHeader: string | undefined;
}

function panelSources(): { file: string; source: string }[] {
  return readdirSync(PANELS_DIR)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .map((file) => ({ file, source: readFileSync(join(PANELS_DIR, file), "utf8") }));
}

function resolveKey(
  attributes: string,
): { key: string | undefined; keyedHeader: string | undefined } {
  const literal = /\bdata-help="([^"]*)"/u.exec(attributes);
  if (literal !== null) return { key: literal[1], keyedHeader: undefined };
  const call = /\bdata-help=\{\s*sectionHelpKey\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)\s*\}/u.exec(
    attributes,
  );
  if (call !== null) {
    return {
      key: sectionHelpKey(call[1] as DockPanelId, call[2] as string),
      keyedHeader: call[2],
    };
  }
  return { key: undefined, keyedHeader: undefined };
}

/** Every `<summary>` / `<h3>` whose first child is literal text. */
function fixedHeaders(): FoundHeader[] {
  const found: FoundHeader[] = [];
  for (const { file, source } of panelSources()) {
    for (const match of source.matchAll(/<(summary|h3)\b([^>]*)>([^<{]*)/gu)) {
      const text = (match[3] ?? "").trim();
      if (text === "") continue; // first child is an expression or an element: per-item header
      found.push({ file, tag: match[1] as string, text, ...resolveKey(match[2] ?? "") });
    }
  }
  return found;
}

const entries = helpEntries().entries;
const fixedSectionKeys = (): string[] =>
  fixedHeaders()
    .filter((header) => !ALLOWLIST.has(`${header.file}: ${header.text}`))
    .flatMap((header) => (header.key === undefined ? [] : [header.key]));

describe("help coverage", () => {
  it("every panel, phase and chrome target has a help text", () => {
    expect(entries.size).toBeGreaterThan(0);
    const missing = [
      ...DOCK_PANEL_IDS.map(panelHelpKey),
      ...WORKFLOW_PHASES.map(phaseHelpKey),
      ...CHROME_KEYS,
    ].filter((key) => !entries.has(key));
    expect(missing).toEqual([]);
  });

  it("every fixed section header in a panel carries a help key with a text", () => {
    const headers = fixedHeaders();
    expect(headers.length).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const header of headers) {
      const where = `${header.file} <${header.tag}>${header.text}`;
      if (ALLOWLIST.has(`${header.file}: ${header.text}`)) continue;
      if (header.key === undefined) {
        problems.push(`${where}: no data-help`);
        continue;
      }
      if (header.keyedHeader !== undefined && header.keyedHeader !== header.text) {
        problems.push(`${where}: key is built from "${header.keyedHeader}", not the header text`);
      }
      if (!entries.has(header.key)) problems.push(`${where}: no entry for ${header.key}`);
    }
    expect(problems).toEqual([]);
  });

  it("the scan finds the sections it is known to guard", () => {
    const keys = fixedSectionKeys();
    expect(keys).toContain("section.skills.library");
    expect(keys).toContain("section.media.capture-watcher");
    expect(keys).toContain("section.status.derive-a-short");
    for (const allowed of ALLOWLIST) {
      const found = fixedHeaders().some((header) => `${header.file}: ${header.text}` === allowed);
      expect(found, `${allowed} no longer exists; drop it from ALLOWLIST`).toBe(true);
    }
  });

  it("every help text is used", () => {
    const used = new Set<string>([
      ...DOCK_PANEL_IDS.map(panelHelpKey),
      ...WORKFLOW_PHASES.map(phaseHelpKey),
      ...CHROME_KEYS,
      ...fixedSectionKeys(),
    ]);
    const unused = [...entries.keys()].filter((key) => !used.has(key));
    expect(unused).toEqual([]);
  });
});
