import { describe, expect, it } from "vitest";

import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import type { CompiledCut } from "../../../transcript/src/index.js";

import { isRebaseSafeAssemblyProposal, rederiveStarts } from "./assembly-proposal.js";

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

describe("rederiveStarts", () => {
  it("sums the lengths of the clips before each cut", () => {
    const project = projectFixture();
    const fps = "24/1";
    project.sequences[0]!.clips.push({
      id: "clp_cccccccccc",
      asset: "ast_aaaaaaaaaa",
      source: { in: { frames: 0, fps }, out: { frames: 10, fps } },
    });
    const cut = { index: 2, timelineStart: { frames: 999, fps } } as CompiledCut;
    expect(rederiveStarts(project, "seq_aaaaaaaaaa", [cut])[0]!.timelineStart).toEqual({ frames: 48, fps });
  });
});
