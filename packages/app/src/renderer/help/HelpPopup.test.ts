import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { HelpPopupView } from "./HelpPopup.js";
import type { HelpEntry } from "./help-texts.js";

const ENTRY: HelpEntry = {
  key: "section.media.capture-watcher",
  title: "Capture watcher",
  where: "Media panel",
  goodFor: "Imports new recordings by itself, with `code` and **bold**.",
  howTo: ["Pick a folder.", "Press `Start`."],
  manual: "3. Ingest tab — get material in",
};

function render(props: { entry: HelpEntry | undefined; helpKey: string; error?: string }): string {
  return renderToStaticMarkup(
    createElement(HelpPopupView, { onClose: vi.fn(), onOpenManual: vi.fn(), ...props }),
  );
}

describe("HelpPopupView", () => {
  it("shows title, where, both labelled parts and numbered steps", () => {
    const html = render({ entry: ENTRY, helpKey: ENTRY.key });
    expect(html).toContain('data-testid="help-popup"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Capture watcher");
    expect(html).toContain("Media panel");
    expect(html).toContain("What it&#x27;s good for");
    expect(html).toContain("How to use it");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<ol");
    expect(html.match(/<li>/gu)).toHaveLength(2);
    expect(html).toContain("<code>Start</code>");
    expect(html).toContain('data-testid="help-popup-close"');
    expect(html).toContain("data-help-allow");
  });

  it("offers Open in manual only when the entry links a manual section", () => {
    expect(render({ entry: ENTRY, helpKey: ENTRY.key })).toContain('data-testid="help-popup-manual"');
    const withoutManual: HelpEntry = { ...ENTRY };
    delete withoutManual.manual;
    expect(render({ entry: withoutManual, helpKey: ENTRY.key })).not.toContain("help-popup-manual");
  });

  it("explains a missing entry instead of failing", () => {
    const html = render({ entry: undefined, helpKey: "section.media.unknown" });
    expect(html).toContain("No help text yet");
    expect(html).toContain("section.media.unknown");
    expect(html).toContain('data-testid="help-popup-close"');
    expect(html).not.toContain("help-popup-manual");
  });

  it("shows the help-file parse error instead of crashing", () => {
    const html = render({
      entry: undefined,
      helpKey: "panel.media",
      error: "HELP.md entry panel.media: missing Title",
    });
    expect(html).toContain('data-testid="help-popup-error"');
    expect(html).toContain("HELP.md entry panel.media: missing Title");
    expect(html).not.toContain("No help text yet");
    expect(html).toContain('data-testid="help-popup-close"');
  });
});
