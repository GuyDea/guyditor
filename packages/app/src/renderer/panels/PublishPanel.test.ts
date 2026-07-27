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
import {
  useSelectionStore,
  useWorkspaceStore,
} from "../state/view-state.js";
import { PublishPanel } from "./PublishPanel.js";

function prepareServerRender(selectedDeliverableId: string | null): void {
  useSelectionStore.setState({
    selectedDeliverableId,
  });
  stateHookMock.selectionServerSnapshot = useSelectionStore.getState();
  const workspace = useWorkspaceStore.getState();
  stateHookMock.workspaceServerSnapshot = {
    ...workspace,
    railCollapsed: {
      ...workspace.railCollapsed,
      publish: false,
    },
  };
}

afterEach(() => {
  stateHookMock.selectionServerSnapshot = undefined;
  stateHookMock.workspaceServerSnapshot = undefined;
  useSelectionStore.setState({ selectedDeliverableId: null });
});

describe("PublishPanel", () => {
  it("shows primary publishing details and the selected short output set", () => {
    const project = projectFixture();
    project.deliverables[0] = {
      ...project.deliverables[0]!,
      status: "approved",
      approvedRevision: "rev_00001",
      profile: "youtube-longform@1.0.0",
      publish: {
        metadata: {
          format: "guyditor-publish/v1",
          deliverableId: "dlv_aaaaaaaaaa",
          profile: "youtube-longform@1.0.0",
          language: "en",
          title: "Creator title",
          description: "Paste-ready description",
          tags: ["editing"],
          hashtags: ["#editing"],
          status: "draft",
        },
        chapters: {
          format: "guyditor-chapters/v1",
          deliverableId: "dlv_aaaaaaaaaa",
          derivedAtRevision: "rev_00001",
          status: "stale",
          textSha256: "a".repeat(64),
          chapters: [{ beatId: "beat_aaaaaaaaaa", title: "Intro", startSeconds: 0 }],
          stale: {
            transactionId: "txn_aaaaaaaaaa",
            revision: "rev_00002",
            detectedAt: "2026-07-22T10:00:00.000Z",
            warning: "Chapter timestamps may have shifted by 30 frames; regenerate and review.",
          },
        },
      },
    };
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
      name: "Portrait short",
      profile: "youtube-shorts@1.0.0",
      sequenceId: "seq_bbbbbbbbbb",
      captionsTrackId: "cts_bbbbbbbbbb",
      status: "approved",
      approvedRevision: "rev_00001",
      dependencies: [],
    });
    expect(validateProject(project).ok).toBe(true);
    const props = {
      snapshot: {
        revision: project.revision,
        master: project,
        sidecarIndex: project.sidecars,
        projectPath: "/fixture",
      },
      transcripts: [],
      annotations: [],
      proposals: [],
      skills: [],
      pinnedSkills: [],
      skillDrafts: [],
      restylePlan: null,
      exportReport: null,
      refreshProject: () => Promise.resolve(),
      refreshAnnotations: () => Promise.resolve(),
      refreshProposals: () => Promise.resolve(),
      refreshSkills: () => Promise.resolve(),
      refreshRestylePlan: () => Promise.resolve(),
      refreshExportReport: () => Promise.resolve(),
      setNotice: () => undefined,
    };

    prepareServerRender(null);
    const primaryHtml = renderToStaticMarkup(createElement(PublishPanel, props));
    expect(primaryHtml).toContain("Creator title");
    expect(primaryHtml).toContain("Metadata limits");
    expect(primaryHtml).toContain("stale");
    expect(primaryHtml).toContain("30 frames");
    expect(primaryHtml).toContain("Keyed cutout");

    prepareServerRender("dlv_bbbbbbbbbb");
    const shortHtml = renderToStaticMarkup(createElement(PublishPanel, props));
    expect(shortHtml).toContain('<option value="dlv_bbbbbbbbbb" selected="">');
    expect(shortHtml).toContain("covers/cover-01..06.jpg");
    expect(shortHtml).not.toContain("thumbnail.png");
    expect(shortHtml).not.toContain("chapters.txt");
    expect(shortHtml).toContain("Batch export");
    expect(shortHtml).toContain("Build upload kit");
    expect(shortHtml).toContain("OpenTimelineIO interchange");
    expect(shortHtml).toContain("Review OTIO losses");
    expect(shortHtml).toContain("Export .otio");
  });
});
