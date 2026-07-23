import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MANUAL_SOURCE } from "./manual-source.js";
import {
  MarkdownDocument,
  filterManualSections,
  parseManual,
} from "./manual.js";

describe("in-app manual markdown pipeline", () => {
  it("parses and renders the real docs/MANUAL.md with anchored headings and tables", () => {
    const document = parseManual(MANUAL_SOURCE);
    const html = renderToStaticMarkup(createElement(MarkdownDocument, {
      document,
      onRepositoryLink: () => undefined,
    }));

    expect(MANUAL_SOURCE).toContain("# Guyditor Manual");
    expect(document.sections.some(({ heading }) => heading === "1. Quick start")).toBe(true);
    expect(html).toContain('id="1-quick-start"');
    expect(html).toContain("<table>");
    expect(html).toContain("Global progress bar");
  });

  it("filters whole manual sections by heading or body text", () => {
    const document = parseManual(MANUAL_SOURCE);

    expect(filterManualSections(document, "Data safety").sections.map(({ heading }) => heading))
      .toEqual(["9. Data safety"]);
    expect(filterManualSections(document, "Kling").sections.map(({ heading }) => heading))
      .toContain("5. Polish tab — the look and sound");
    expect(filterManualSections(document, "no-such-manual-term").sections).toEqual([]);
  });
});
