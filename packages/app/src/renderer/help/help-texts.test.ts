import { describe, expect, it } from "vitest";

import { parseManual } from "../manual.js";
import { MANUAL_SOURCE } from "../manual-source.js";
import { HELP_ENTRIES } from "./help-source.js";
import {
  panelHelpKey,
  parseHelp,
  phaseHelpKey,
  sectionHelpKey,
} from "./help-texts.js";

const VALID = `# Preamble

Ignored text before the first entry.

## section.media.capture-watcher
Title: Capture watcher
Where: Media panel
Manual: 3. Ingest tab — get material in

### What it's good for
Imports new recordings
by itself, with \`code\` and **bold**.

### How to use it
1. First step.
2. Second step
   continues here.

## panel.media
Title: Media
Where: Media panel

### What it's good for
Your imported clips.

### How to use it
1. Click Import files.
`;

function entry(key: string, body: string): string {
  return `## ${key}\nTitle: T\nWhere: W\n\n${body}`;
}

const GOOD = "### What it's good for\nText.\n\n";
const STEPS = "### How to use it\n1. Step.\n";

describe("parseHelp", () => {
  it("parses an entry into title, where, good-for paragraph, steps and manual link", () => {
    const entries = parseHelp(VALID);
    expect(entries.size).toBe(2);
    expect(entries.get("section.media.capture-watcher")).toEqual({
      key: "section.media.capture-watcher",
      title: "Capture watcher",
      where: "Media panel",
      goodFor: "Imports new recordings by itself, with `code` and **bold**.",
      howTo: ["First step.", "Second step continues here."],
      manual: "3. Ingest tab — get material in",
    });
    expect(entries.get("panel.media")?.manual).toBeUndefined();
  });

  it("rejects malformed entries with the key in the message", () => {
    expect(() => parseHelp(entry("panel.media", GOOD)))
      .toThrow("HELP.md entry panel.media: missing ### How to use it");
    expect(() => parseHelp(entry("panel.media", GOOD + "### How to use it\n\n")))
      .toThrow("HELP.md entry panel.media: ### How to use it has no numbered steps");
    expect(() => parseHelp(entry("panel.media", GOOD + "### How to use it\nplain\n")))
      .toThrow("HELP.md entry panel.media: ### How to use it must be a numbered list");
    expect(() => parseHelp(entry("panel.media", GOOD + STEPS).replace("Where: W", "Where: W\nColour: red")))
      .toThrow("HELP.md entry panel.media: unknown field Colour");
    expect(() => parseHelp(entry("panel.media", GOOD + STEPS).replace("Title: T\n", "")))
      .toThrow("HELP.md entry panel.media: missing Title");
    expect(() => parseHelp(entry("panel.media", GOOD + STEPS).replace("Where: W\n", "")))
      .toThrow("HELP.md entry panel.media: missing Where");
    expect(() => parseHelp(entry("panel.media", STEPS)))
      .toThrow("HELP.md entry panel.media: missing ### What it's good for");
    expect(() => parseHelp(entry("panel.media", GOOD + GOOD + STEPS)))
      .toThrow("HELP.md entry panel.media: duplicate ### What it's good for");
    expect(() => parseHelp(entry("panel.media", GOOD + STEPS + "### Extra\nx\n")))
      .toThrow("HELP.md entry panel.media: unknown part ### Extra");
    expect(() => parseHelp(entry("panel.media", "Stray text.\n\n" + GOOD + STEPS)))
      .toThrow("HELP.md entry panel.media: text outside the two parts");
    const one = entry("panel.media", GOOD + STEPS);
    expect(() => parseHelp(`${one}\n${one}`))
      .toThrow("HELP.md entry panel.media: duplicate key");
    expect(() => parseHelp(entry("Panel.Media", GOOD + STEPS)))
      .toThrow("HELP.md entry Panel.Media: invalid key");
  });

  it("builds help keys", () => {
    expect(panelHelpKey("media")).toBe("panel.media");
    expect(phaseHelpKey("cut")).toBe("phase.cut");
    expect(sectionHelpKey("broll", "Rights indicators")).toBe("section.broll.rights-indicators");
    expect(sectionHelpKey("status", "Derive a short")).toBe("section.status.derive-a-short");
  });
});

describe("bundled HELP.md", () => {
  it("parses and every manual link names a manual heading", () => {
    expect(HELP_ENTRIES.size).toBeGreaterThan(0);
    const manual = parseManual(MANUAL_SOURCE);
    for (const helpEntry of HELP_ENTRIES.values()) {
      if (helpEntry.manual === undefined) continue;
      expect(
        manual.sections.some(({ heading }) => heading === helpEntry.manual),
        `${helpEntry.key} links to unknown manual heading "${helpEntry.manual}"`,
      ).toBe(true);
    }
  });
});
