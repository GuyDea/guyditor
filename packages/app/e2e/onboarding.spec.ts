import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { launchApp } from "./helpers/launch-app.js";
import { createWorkspaceProject } from "./helpers/workspace-project.js";

test("fresh user data shows welcome and Skip persists across relaunch", async () => {
  const first = await launchApp({ seedOnboarding: false });
  let second: Awaited<ReturnType<typeof launchApp>> | null = null;
  try {
    await expect(first.page.getByTestId("welcome-surface")).toBeVisible();
    await first.page.getByTestId("welcome-skip").click();
    await expect(first.page.getByTestId("welcome-surface")).toHaveCount(0);
    await first.electronApp.close();

    second = await launchApp({
      seedOnboarding: false,
      userDataDirectory: first.userDataDirectory,
    });
    await expect(second.page.getByTestId("welcome-surface")).toHaveCount(0);
    await expect(second.page.getByTestId("workflow-phase-tabs")).toBeVisible();
  } finally {
    await first.electronApp.close().catch(() => undefined);
    await second?.electronApp.close().catch(() => undefined);
  }
});

test("tour advances through the phase strip, progress overview, and first panel", async () => {
  const launched = await launchApp({ seedOnboarding: false });
  try {
    await launched.page.getByTestId("welcome-tour").click();
    await expect(launched.page.getByTestId("tour-stop")).toHaveAttribute(
      "data-tour-stop",
      "phase-tabs",
    );
    await launched.page.keyboard.press("ArrowRight");
    await expect(launched.page.getByTestId("tour-stop")).toHaveAttribute(
      "data-tour-stop",
      "global-progress",
    );
    await expect(launched.page.getByTestId("global-progress-popover")).toBeVisible();
    await launched.page.keyboard.press("Enter");
    await expect(launched.page.getByTestId("tour-stop")).toHaveAttribute(
      "data-tour-stop",
      "ingest-media",
    );
    await expect(launched.page.getByTestId("phase-tab-ingest")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await launched.page.keyboard.press("Escape");
    await expect(launched.page.getByTestId("tour-stop")).toHaveCount(0);
  } finally {
    await launched.electronApp.close();
  }
});

test("checklist ticks after an import job completes", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("title-help").click();
    await expect(launched.page.getByTestId("checklist-projectOpened"))
      .toHaveAttribute("data-complete", "true");
    await expect(launched.page.getByTestId("checklist-importedMedia"))
      .toHaveAttribute("data-complete", "false");

    await launched.page.getByTestId("phase-tab-ingest").click();
    await launched.page.getByTestId("ingest-path-input").fill(
      resolve(import.meta.dirname, "../../../.fixtures/disc-track-720p30-8s.mp4"),
    );
    await launched.page.getByTestId("ingest-path-submit").click();
    await expect(launched.page.getByTestId("job-state-ingest")).toHaveText("done", {
      timeout: 30_000,
    });
    await launched.page.getByTestId("title-help").click();
    await expect(launched.page.getByTestId("checklist-importedMedia"))
      .toHaveAttribute("data-complete", "true");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("Help renders the bundled manual and filters its sections", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("title-help").click();
    await expect(launched.page.getByRole("heading", { name: "9. Data safety" }))
      .toBeVisible();
    await launched.page.getByTestId("manual-search").fill("Data safety");
    await expect(launched.page.locator("[data-manual-section='9. Data safety']"))
      .toBeVisible();
    await expect(launched.page.locator("[data-manual-section='5. Polish tab — the look and sound']"))
      .toHaveCount(0);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});
