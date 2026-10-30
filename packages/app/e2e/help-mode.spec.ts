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

    await page.getByTestId("help-mode-toggle").click();
    await expect(page.getByTestId("help-mode-banner")).toBeVisible();

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
