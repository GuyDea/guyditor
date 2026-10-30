import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BROLL_SOURCE_TAXONOMY } from "../../../../core/src/index.js";
import { BrollPanel } from "./BrollPanel.js";
import type { WorkspacePanelProps } from "./types.js";

function props(): WorkspacePanelProps {
  const refresh = vi.fn(() => Promise.resolve());
  return {
    snapshot: null,
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

describe("B-roll panel", () => {
  it("exposes every source class, generation preflight, review checklist, and rights state", () => {
    const html = renderToStaticMarkup(createElement(BrollPanel, props()));

    for (const source of BROLL_SOURCE_TAXONOMY) expect(html).toContain(source.label);
    expect(html).toContain('data-testid="generation-request"');
    expect(html).toContain('data-testid="generation-cost-estimate"');
    expect(html).toContain('data-testid="generation-review-queue"');
    expect(html).toContain("Factual relevance");
    expect(html).toContain("Research accuracy");
    expect(html).toContain("Unintended implications");
    expect(html).toContain("Visual plausibility is not factual verification");
    expect(html).toContain("Rights missing");
  });
});
