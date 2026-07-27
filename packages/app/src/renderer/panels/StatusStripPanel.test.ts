import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const stateHookMock = vi.hoisted(() => ({
  selectionServerSnapshot: undefined as unknown,
  workspaceServerSnapshot: undefined as unknown,
}));

vi.mock("../state/view-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/view-state.js")>();
  type SelectionSnapshot = ReturnType<typeof actual.useSelectionStore.getState>;
  type WorkspaceSnapshot = ReturnType<typeof actual.useWorkspaceStore.getState>;
  const useSelectionStore = Object.assign(
    <T>(selector: (state: SelectionSnapshot) => T): T => selector(
      (stateHookMock.selectionServerSnapshot ??
        actual.useSelectionStore.getState()) as SelectionSnapshot,
    ),
    actual.useSelectionStore,
  );
  const useWorkspaceStore = Object.assign(
    <T>(selector: (state: WorkspaceSnapshot) => T): T => selector(
      (stateHookMock.workspaceServerSnapshot ??
        actual.useWorkspaceStore.getState()) as WorkspaceSnapshot,
    ),
    actual.useWorkspaceStore,
  );
  return { ...actual, useSelectionStore, useWorkspaceStore };
});

import {
  validateProject,
} from "../../../../core/src/index.js";
import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import type { ProjectSnapshot } from "../../shared/ipc.js";
import {
  useSelectionStore,
  useWorkspaceStore,
} from "../state/view-state.js";
import {
  primaryTimelineSelection,
  StatusStripPanel,
} from "./StatusStripPanel.js";

function selectShortForServerRender(): void {
  useSelectionStore.setState({
    selectedDeliverableId: "dlv_bbbbbbbbbb",
  });
  stateHookMock.selectionServerSnapshot = useSelectionStore.getState();
  const workspace = useWorkspaceStore.getState();
  stateHookMock.workspaceServerSnapshot = {
    ...workspace,
    railCollapsed: {
      ...workspace.railCollapsed,
      status: false,
    },
  };
}

afterEach(() => {
  stateHookMock.selectionServerSnapshot = undefined;
  stateHookMock.workspaceServerSnapshot = undefined;
  useSelectionStore.setState({ selectedDeliverableId: null });
});

describe("AC-008 deliverable staleness UI", () => {
  it("renders the stale badge, affected source range, and refresh review action", () => {
    const project = projectFixture();
    project.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "short",
      clips: [{
        id: "clp_cccccccccc",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 12, fps: "24/1" },
          out: { frames: 24, fps: "24/1" },
        },
      }],
    });
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "video",
      name: "short video",
      order: 0,
      enabled: true,
      locked: false,
      sequence: "seq_bbbbbbbbbb",
    });
    project.captions.push({
      ...structuredClone(project.captions[0]!),
      id: "cts_bbbbbbbbbb",
      name: "short captions",
      sourceLayerIds: ["lyr_bbbbbbbbbb"],
    });
    project.deliverables.push({
      id: "dlv_bbbbbbbbbb",
      kind: "short",
      name: "Stale short",
      profile: "tiktok@1.0.0",
      sequenceId: "seq_bbbbbbbbbb",
      captionsTrackId: "cts_bbbbbbbbbb",
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
    expect(validateProject(project).ok).toBe(true);
    selectShortForServerRender();
    const snapshot: ProjectSnapshot = {
      revision: project.revision,
      master: project,
      sidecarIndex: [],
      projectPath: "/tmp/project",
    };
    const html = renderToStaticMarkup(createElement(
      StatusStripPanel,
      {
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
      },
    ));

    expect(html).toContain('data-testid="stale-badge"');
    expect(html).toContain('data-testid="stale-explanation"');
    expect(html).toMatch(
      /data-testid="deliverable-dlv_bbbbbbbbbb"[^>]*aria-pressed="true"/u,
    );
    expect(html).toContain("12–36@24/1");
    expect(html).toContain("Build refresh review");

    expect(primaryTimelineSelection(project, 0, 30)).toEqual({
      timelineRange: {
        sequenceId: "seq_aaaaaaaaaa",
        start: { frames: 0, fps: "24/1" },
        end: { frames: 30, fps: "24/1" },
      },
    });
  });
});
