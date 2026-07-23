import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import type { ProjectSnapshot } from "../../shared/ipc.js";
import { useWorkspaceStore } from "../state/view-state.js";
import { StatusStripPanel } from "./StatusStripPanel.js";

describe("AC-008 deliverable staleness UI", () => {
  it("renders the stale badge, affected source range, and refresh review action", () => {
    useWorkspaceStore.getInitialState().collapsed.status = false;
    const project = projectFixture();
    project.deliverables.push({
      id: "dlv_bbbbbbbbbb",
      kind: "short",
      name: "Stale short",
      profile: "tiktok@1.0.0",
      sequenceId: "seq_bbbbbbbbbb",
      status: "stale",
      dependencies: [],
      staleReasons: [{
        transactionId: "txn_bbbbbbbbbb",
        revision: "rev_00002",
        detectedAt: "2026-07-22T08:00:00Z",
        affected: [{
          dependency: {
            derivativeClipId: "clp_cccccccccc",
            source: {
              assetId: "ast_aaaaaaaaaa",
              range: { start: { frames: 12, fps: "24/1" }, end: { frames: 36, fps: "24/1" } },
              longformClipId: "clp_aaaaaaaaaa",
            },
          },
          change: "clip.trim removed source used by derivative clip clp_cccccccccc",
        }],
      }],
    });
    const snapshot: ProjectSnapshot = {
      revision: project.revision,
      master: project,
      sidecarIndex: [],
      projectPath: "/tmp/project",
    };
    const html = renderToStaticMarkup(createElement(StatusStripPanel, {
      snapshot,
      transcripts: [],
      annotations: [],
      proposals: [],
      skills: [],
      pinnedSkills: [],
      skillDrafts: [],
      restylePlan: null,
      exportReport: null,
      refreshProject: async () => undefined,
      refreshAnnotations: async () => undefined,
      refreshProposals: async () => undefined,
      refreshSkills: async () => undefined,
      refreshRestylePlan: async () => undefined,
      refreshExportReport: async () => undefined,
      setNotice: () => undefined,
    }));

    expect(html).toContain('data-testid="stale-badge"');
    expect(html).toContain('data-testid="stale-explanation"');
    expect(html).toContain("12–36@24/1");
    expect(html).toContain("Build refresh review");
  });
});
