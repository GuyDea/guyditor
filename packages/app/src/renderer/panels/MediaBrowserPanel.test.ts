import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { validateProject } from "../../../../core/src/index.js";
import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import { MediaBrowserPanel } from "./MediaBrowserPanel.js";
import type { WorkspacePanelProps } from "./types.js";

function props(snapshot: WorkspacePanelProps["snapshot"]): WorkspacePanelProps {
  const refresh = vi.fn(() => Promise.resolve());
  return {
    snapshot,
    transcripts: [],
    annotations: [],
    proposals: [],
    skills: [],
    pinnedSkills: [],
    skillDrafts: [],
    restylePlan: null,
    exportReport: null,
    refreshProject: refresh,
    refreshAnnotations: refresh,
    refreshProposals: refresh,
    refreshSkills: refresh,
    refreshRestylePlan: refresh,
    refreshExportReport: refresh,
    setNotice: vi.fn(),
  };
}

const DISABLED_PICKER = /data-testid="media-ingest-picker"[^>]*\bdisabled=""/;

describe("Media browser panel", () => {
  it("withholds the import controls until a project is open", () => {
    const html = renderToStaticMarkup(createElement(MediaBrowserPanel, props(null)));
    expect(html).toMatch(DISABLED_PICKER);
    expect(html).toContain("Open a project to import media.");
    expect(html).not.toContain("or drop media here");
  });

  it("offers the import controls once a project is open", () => {
    const project = projectFixture();
    expect(validateProject(project).ok).toBe(true);
    const html = renderToStaticMarkup(createElement(MediaBrowserPanel, props({
      revision: project.revision,
      master: project,
      sidecarIndex: project.sidecars,
      projectPath: "/fixture",
    })));
    expect(html).not.toMatch(DISABLED_PICKER);
    expect(html).toContain("or drop media here");
    expect(html).not.toContain("Open a project to import media.");
  });
});
