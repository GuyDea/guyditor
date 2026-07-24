import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SkillManifest } from "../../../../agent/src/index.js";
import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import { useWorkspaceStore } from "../state/view-state.js";
import { latestSkillVersions, SkillsPanel } from "./SkillsPanel.js";

function skill(id: string, title: string, version: string): SkillManifest {
  return {
    id,
    name: title.toLowerCase().replaceAll(" ", "-"),
    version,
    title,
    categories: ["pacing"],
    summary: title,
    rules: [],
    examples: { approved: [], rejected: [] },
    contentHash: version.replaceAll(".", "").padEnd(64, "0"),
  };
}

describe("SkillsPanel", () => {
  it("presents the newest immutable library version without changing project pins", () => {
    expect(latestSkillVersions([
      skill("skl_aaaaaaaaaa", "Pacing", "1.0.0"),
      skill("skl_aaaaaaaaaa", "Pacing", "1.10.0"),
      skill("skl_aaaaaaaaaa", "Pacing", "1.2.0"),
      skill("skl_bbbbbbbbbb", "Voice", "2.0.0"),
    ]).map(({ id, version }) => ({ id, version }))).toEqual([
      { id: "skl_aaaaaaaaaa", version: "1.10.0" },
      { id: "skl_bbbbbbbbbb", version: "2.0.0" },
    ]);
  });

  it("renders library, exact project pin, upgrade review, and inactive draft controls", () => {
    useWorkspaceStore.getInitialState().railCollapsed.skills = false;
    const v1 = skill("skl_aaaaaaaaaa", "Pacing", "1.0.0");
    const v2 = skill("skl_aaaaaaaaaa", "Pacing", "2.0.0");
    const draft = skill("skl_aaaaaaaaaa", "Pacing", "2.1.0");
    const project = projectFixture();
    const html = renderToStaticMarkup(createElement(SkillsPanel, {
      snapshot: {
        revision: project.revision,
        master: project,
        sidecarIndex: project.sidecars,
        projectPath: "/fixture",
      },
      transcripts: [],
      annotations: [],
      proposals: [],
      skills: [v1, v2],
      pinnedSkills: [{ manifest: v1, body: "# Pacing\n", presetReferences: [] }],
      skillDrafts: [{ manifest: draft, body: "# Draft\n", presetReferences: [] }],
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

    expect(html).toContain('data-testid="project-skill-pins"');
    expect(html).toContain("Pacing");
    expect(html).toContain("v1.0.0");
    expect(html).toContain("Review v2.0.0");
    expect(html).toContain('data-testid="skill-drafts"');
    expect(html).toContain("Review draft");
  });
});
