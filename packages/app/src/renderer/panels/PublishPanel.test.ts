import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import { useWorkspaceStore } from "../state/view-state.js";
import { PublishPanel } from "./PublishPanel.js";

describe("PublishPanel", () => {
  it("shows editable metadata limits, stale chapters, thumbnail candidates, and batch controls", () => {
    useWorkspaceStore.getInitialState().railCollapsed.publish = false;
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
    const html = renderToStaticMarkup(createElement(PublishPanel, {
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
    }));

    expect(html).toContain("Creator title");
    expect(html).toContain("Metadata limits");
    expect(html).toContain("stale");
    expect(html).toContain("30 frames");
    expect(html).toContain("Keyed cutout");
    expect(html).toContain("Batch export");
    expect(html).toContain("Build upload kit");
    expect(html).toContain("OpenTimelineIO interchange");
    expect(html).toContain("Review OTIO losses");
    expect(html).toContain("Export .otio");
  });
});
