import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseScriptBlocks } from "./script.js";

describe("parseScriptBlocks", () => {
  it("parses quoted paragraphs under headings", async () => {
    const md = await readFile(new URL("./__fixtures__/script.raw.md", import.meta.url), "utf8");
    const blocks = parseScriptBlocks(md);
    expect(blocks.length).toBeGreaterThanOrEqual(10);
    expect(blocks[0]?.id).toBe("S001");
    expect(blocks[0]?.section).toBe("1. The answer that sounded right");
    expect(blocks[0]?.text.startsWith("Could AI talk you into")).toBe(true);
    for (const b of blocks) {
      expect(b.text).not.toContain("<u>");
      expect(b.text).not.toContain("**");
      expect(b.text).not.toContain("](http");
    }
  });

  it("splits a multi-sentence block into sentences", async () => {
    const md = await readFile(new URL("./__fixtures__/script.raw.md", import.meta.url), "utf8");
    const block = parseScriptBlocks(md).find((b) => b.text.startsWith("In a case reported in 2024"));
    expect(block?.sentences.length).toBe(2);
  });

  it("falls back to plain paragraphs", () => {
    const blocks = parseScriptBlocks("# T\n\n## A\n\nFirst para.\n\nSecond para.");
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.section)).toEqual(["A", "A"]);
  });

  it("empty input yields no blocks", () => {
    expect(parseScriptBlocks("")).toEqual([]);
  });
});
