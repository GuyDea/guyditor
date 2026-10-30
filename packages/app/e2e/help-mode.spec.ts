import { rm } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { launchApp } from "./helpers/launch-app.js";
import { createWorkspaceProject } from "./helpers/workspace-project.js";

test("help mode explains a section, swallows clicks, and leaves cleanly", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  const { page } = launched;
  try {
    await page.getByTestId("phase-tab-ingest").click();
    await expect(page.getByTestId("phase-tab-ingest")).toHaveAttribute("aria-selected", "true");

    const summary = page.locator('summary[data-help="section.media.capture-watcher"]');
    const watcher = page.locator("details", { has: summary });
    await expect(summary).toBeVisible();
    const openBefore = await watcher.evaluate((element: HTMLDetailsElement) => element.open);
    const heights = async (): Promise<number[]> => Promise.all(
      ["media-panel", "master-tool-rail"].map(async (id) => (await page.getByTestId(id).boundingBox())?.height ?? 0),
    );
    const heightsOff = await heights();
    expect(heightsOff.every((height) => height > 100)).toBe(true);

    await page.getByTestId("help-mode-toggle").click();
    await expect(page.getByTestId("help-mode-banner")).toBeVisible();

    // The banner overlays the workspace; it must not take a row of the shell grid.
    const heightsOn = await heights();
    heightsOn.forEach((height, index) => expect(Math.abs(height - (heightsOff[index] ?? 0))).toBeLessThanOrEqual(2));

    // Everything outside the help chrome shows the help cursor, even resize/pointer cursors.
    const cursor = async (testId: string): Promise<string> =>
      page.getByTestId(testId).evaluate((element) => getComputedStyle(element).cursor);
    expect(await cursor("reset-layout")).toBe("help");
    expect(await cursor("media-panel-drag-handle")).toBe("help");
    expect(await cursor("help-mode-toggle")).not.toBe("help");

    // The click explains the section instead of toggling it.
    await summary.click();
    await expect(page.getByTestId("help-popup-title")).toHaveText("Capture watcher");
    await expect(page.getByTestId("help-popup-good")).toBeVisible();
    await expect(page.getByTestId("help-popup-how")).toBeVisible();
    expect(await watcher.evaluate((element: HTMLDetailsElement) => element.open)).toBe(openBefore);

    // Esc closes the popup; help mode stays on.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("help-popup")).toHaveCount(0);
    await expect(page.getByTestId("help-mode-banner")).toBeVisible();

    // A phase tab explains the phase and does not switch to it.
    await page.getByTestId("phase-tab-cut").click();
    await expect(page.getByTestId("help-popup-title")).toBeVisible();
    await expect(page.getByTestId("help-popup-title")).toHaveText(/cut/iu);
    await expect(page.getByTestId("phase-tab-ingest")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("phase-tab-cut")).toHaveAttribute("aria-selected", "false");

    // Esc twice: popup, then help mode.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("help-popup")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("help-mode-banner")).toHaveCount(0);

    // Normal clicks work again.
    await page.getByTestId("phase-tab-cut").click();
    await expect(page.getByTestId("phase-tab-cut")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("help-popup")).toHaveCount(0);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("Open in manual lands with the section heading below the manual search bar", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  const { page } = launched;
  try {
    await page.getByTestId("phase-tab-ingest").click();
    await page.getByTestId("help-mode-toggle").click();
    await page.locator('summary[data-help="section.media.capture-watcher"]').click();
    await expect(page.getByTestId("help-popup-title")).toHaveText("Capture watcher");

    await page.getByTestId("help-popup-manual").click();
    await expect(page.getByTestId("help-popup")).toHaveCount(0);
    const panel = page.getByTestId("help-panel");
    await expect(panel).toBeVisible();

    const heading = panel.locator('[data-manual-section="3. Ingest tab — get material in"] h2').first();
    await expect(heading).toBeVisible();
    const tools = panel.locator(".help-tools");
    const scroller = page.getByTestId("help-panel-scroll");
    // The heading sits fully below the sticky search bar and inside the scrolled area.
    await expect.poll(async () => {
      const [headingBox, toolsBox, scrollBox] = await Promise.all([
        heading.boundingBox(), tools.boundingBox(), scroller.boundingBox(),
      ]);
      if (headingBox === null || toolsBox === null || scrollBox === null) return false;
      return headingBox.y >= toolsBox.y + toolsBox.height - 1
        && headingBox.y + headingBox.height <= scrollBox.y + scrollBox.height;
    }).toBe(true);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("Shift+F1 turns help mode on and off", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  const { page } = launched;
  try {
    await expect(page.getByTestId("help-mode-banner")).toHaveCount(0);
    await page.keyboard.press("Shift+F1");
    await expect(page.getByTestId("help-mode-banner")).toBeVisible();
    await page.keyboard.press("Shift+F1");
    await expect(page.getByTestId("help-mode-banner")).toHaveCount(0);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});
