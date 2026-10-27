import { describe, expect, it } from "vitest";
import { assemblySystemPrompt } from "./assembly-prompt.js";

describe("assemblySystemPrompt", () => {
  const prompt = assemblySystemPrompt();

  it("carries the creator's rules and output contract", () => {
    expect(prompt).toContain("Latest take wins");
    expect(prompt).toContain("Ask, don't guess");
    expect(prompt).toContain("status");
    expect(prompt).toContain("assembly_reply");
  });

  it("has no template leftovers", () => {
    expect(prompt).not.toMatch(/\{\{|\$\{|\{[a-zA-Z]+\}/u);
    expect(prompt).not.toContain("{");
  });
});
