import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import type { Proposal } from "../../../../core/src/index.js";
import type { ProjectSnapshot } from "../../shared/ipc.js";
import { ProposalPanel } from "./ProposalPanel.js";
import type { WorkspacePanelProps } from "./types.js";

const insert = (index: number) => ({
  op: "clip.insert",
  params: { sequenceId: "seq_aaaaaaaaaa", index },
});

function proposal(operations: unknown[], ref: string): Proposal {
  return {
    id: "prp_aaaaaaaaaa",
    status: "ready",
    baseRevision: "rev_00001",
    operations,
    actor: { kind: "agent", id: "stub:model" },
    riskClass: "normal",
    addresses: [],
    reason: { text: "t", sources: [{ kind: "instruction", ref }] },
  } as unknown as Proposal;
}

function render(candidate: Proposal): string {
  const project = projectFixture(); // two clips on seq_aaaaaaaaaa
  const snapshot: ProjectSnapshot = {
    revision: "rev_00009", // newer than the proposal base, so it is stale
    master: project,
    sidecarIndex: [],
    projectPath: "/tmp/project",
  };
  const noop = vi.fn(() => Promise.resolve());
  const props: WorkspacePanelProps = {
    snapshot,
    transcripts: [],
    annotations: [],
    proposals: [candidate],
    skills: [],
    pinnedSkills: [],
    skillDrafts: [],
    restylePlan: null,
    exportReport: null,
    refreshProject: noop,
    refreshAnnotations: noop,
    refreshProposals: noop,
    refreshSkills: noop,
    refreshRestylePlan: noop,
    refreshExportReport: noop,
    setNotice: vi.fn(),
  };
  return renderToStaticMarkup(createElement(ProposalPanel, props));
}

const acceptButton = (html: string): string =>
  /<button[^>]*data-testid="proposal-accept-prp_aaaaaaaaaa"[^>]*>[^<]*<\/button>/u.exec(html)?.[0] ?? "";

describe("ProposalPanel stale assembly proposals", () => {
  it("offers Rebase + accept while the insert spot is untouched", () => {
    const button = acceptButton(render(proposal([insert(2), insert(3)], "asb_aaaaaaaaaa")));
    expect(button).toContain("Rebase + accept");
    expect(button).not.toContain("disabled");
  });

  it("disables Accept when the insert spot moved", () => {
    const button = acceptButton(render(proposal([insert(1)], "asb_aaaaaaaaaa")));
    expect(button).toContain("disabled");
  });

  it("disables Accept for inserts without an assembly session source", () => {
    expect(acceptButton(render(proposal([insert(2)], "other")))).toContain("disabled");
  });

  it("disables Accept for mixed operations", () => {
    const mixed = proposal([insert(2), { op: "clip.remove", params: {} }], "asb_aaaaaaaaaa");
    expect(acceptButton(render(mixed))).toContain("disabled");
  });
});
