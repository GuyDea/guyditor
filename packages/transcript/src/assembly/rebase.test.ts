import { describe, expect, it } from "vitest";

import { projectFixture } from "../../../core/src/project/test-fixtures.js";

import { isRebaseSafeAssemblyProposal } from "./rebase.js";

const insert = (index: number) => ({
  op: "clip.insert" as const,
  params: { sequenceId: "seq_aaaaaaaaaa", index },
});
const reason = (ref: string) => ({ text: "t", sources: [{ kind: "instruction" as const, ref }] });

describe("isRebaseSafeAssemblyProposal", () => {
  const project = projectFixture(); // two clips on seq_aaaaaaaaaa

  it("accepts an assembly proposal whose insert point is untouched", () => {
    expect(isRebaseSafeAssemblyProposal(
      { operations: [insert(2), insert(3)] as never, reason: reason("asb_aaaaaaaaaa") }, project)).toBe(true);
  });

  it("rejects other proposals, other ops and a moved insert point", () => {
    const ok = [insert(2)] as never;
    expect(isRebaseSafeAssemblyProposal({ operations: ok, reason: reason("other") }, project)).toBe(false);
    expect(isRebaseSafeAssemblyProposal({ operations: [insert(1)] as never, reason: reason("asb_aaaaaaaaaa") }, project)).toBe(false);
    expect(isRebaseSafeAssemblyProposal(
      { operations: [{ op: "clip.split", params: {} }] as never, reason: reason("asb_aaaaaaaaaa") }, project)).toBe(false);
    expect(isRebaseSafeAssemblyProposal({ operations: [], reason: reason("asb_aaaaaaaaaa") }, project)).toBe(false);
  });
});
