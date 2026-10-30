import { rm } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { launchApp } from "./helpers/launch-app.js";
import { createWorkspaceProject } from "./helpers/workspace-project.js";

const PHASES = ["ingest", "cut", "polish", "review", "publish"] as const;

test("phase tabs render their curated panel sets", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const expectedPanels = {
      ingest: ["assemble", "media", "status", "storage"],
      cut: ["agent", "preview", "timeline", "transcript"],
      polish: ["agent", "graphics", "inspector", "preview", "transcript"],
      review: ["agent", "media", "preview"],
      publish: ["publish", "status"],
    };

    for (const phase of PHASES) {
      await launched.page.getByTestId(`phase-tab-${phase}`).click();
      await expect(launched.page.getByTestId(`phase-tab-${phase}`))
        .toHaveAttribute("aria-selected", "true");
      const renderedPanels = await launched.page.locator("[data-panel]")
        .evaluateAll((panels) => panels.map((panel) => panel.getAttribute("data-panel")).sort());
      expect(renderedPanels).toEqual(expectedPanels[phase]);
    }
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("phase-specific customization persists independently across relaunch", async () => {
  const template = await createWorkspaceProject();
  const first = await launchApp({ projectTemplate: template });
  let second: Awaited<ReturnType<typeof launchApp>> | null = null;
  const firstDivider = (page: typeof first.page) =>
    page.locator("[data-testid='split-divider'][aria-orientation='vertical']").first();
  try {
    await first.page.getByTestId("phase-tab-cut").click();
    await firstDivider(first.page).focus();
    for (let step = 0; step < 3; step += 1) await first.page.keyboard.press("ArrowLeft");
    const cutValue = await firstDivider(first.page).getAttribute("aria-valuenow");
    expect(cutValue).toBe("74");

    await first.page.getByTestId("phase-tab-review").click();
    await firstDivider(first.page).focus();
    for (let step = 0; step < 2; step += 1) await first.page.keyboard.press("ArrowRight");
    const reviewValue = await firstDivider(first.page).getAttribute("aria-valuenow");
    expect(reviewValue).toBe("22");

    await first.electronApp.close();
    if (first.projectPath === undefined) throw new Error("Relaunch fixture path was missing.");
    second = await launchApp({
      projectPath: first.projectPath,
      userDataDirectory: first.userDataDirectory,
    });

    await expect(second.page.getByTestId("phase-tab-review"))
      .toHaveAttribute("aria-selected", "true");
    await expect(firstDivider(second.page)).toHaveAttribute("aria-valuenow", "22");

    await second.page.getByTestId("phase-tab-cut").click();
    await expect(firstDivider(second.page)).toHaveAttribute("aria-valuenow", "74");
  } finally {
    await first.electronApp.close().catch(() => undefined);
    await second?.electronApp.close().catch(() => undefined);
    await rm(template, { recursive: true, force: true });
  }
});

test("a pending proposal badges Review and badge click jumps to its panel", async () => {
  const template = await createWorkspaceProject({ proposal: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    const badge = launched.page.getByTestId("phase-badge-review");
    await expect(badge).toHaveText("1");
    await expect(launched.page.getByTestId("tool-rail-badge-agent")).toBeVisible();
    await expect(launched.page.getByTestId("tool-rail-badge-agent")).toHaveText("1");
    await badge.click();

    await expect(launched.page.getByTestId("phase-tab-review"))
      .toHaveAttribute("aria-selected", "true");
    await expect(launched.page.getByTestId("agent-panel")).toBeFocused();
    await expect(launched.page.getByTestId("proposal-diff-prp_bbbbbbbbbb")).toBeVisible();
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("Ctrl+Alt+1 through Ctrl+Alt+5 switch workflow phases", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("phase-tab-cut").focus();
    for (const [index, phase] of PHASES.entries()) {
      await launched.page.keyboard.press(`Control+Alt+${String(index + 1)}`);
      await expect(launched.page.getByTestId(`phase-tab-${phase}`))
        .toHaveAttribute("aria-selected", "true");
    }
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});
