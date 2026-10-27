import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WelcomeSurface } from "./WelcomeSurface.js";

const base = {
  onCreateProject: vi.fn(() => Promise.resolve()),
  onOpenProject: vi.fn(() => Promise.resolve()),
  onTakeTour: vi.fn(),
};

describe("WelcomeSurface", () => {
  it("offers Skip when onSkip is provided", () => {
    const html = renderToStaticMarkup(
      createElement(WelcomeSurface, { ...base, onSkip: vi.fn() }),
    );
    expect(html).toContain('data-testid="welcome-skip"');
    expect(html).not.toContain("Open or create a project to start.");
  });

  it("omits Skip and the tour, and shows the hint, when no project is open", () => {
    const html = renderToStaticMarkup(
      createElement(WelcomeSurface, { onCreateProject: base.onCreateProject, onOpenProject: base.onOpenProject }),
    );
    expect(html).not.toContain('data-testid="welcome-skip"');
    expect(html).not.toContain('data-testid="welcome-tour"');
    expect(html).toContain("Open or create a project to start.");
  });
});
