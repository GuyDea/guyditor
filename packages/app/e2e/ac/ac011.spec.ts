import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { launchApp } from "../helpers/launch-app.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");

test("AC-011 — edits publish metadata and exposes kit, chapter, thumbnail, and batch controls", async () => {
  const launched = await launchApp({ projectTemplate: resolve(REPOSITORY_ROOT, ".fixtures/projects/basic") });
  try {
    await launched.page.getByTestId("phase-tab-publish").click();
    const panel = launched.page.getByTestId("publish-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Draft from transcript + beats" }).click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00002");
    await panel.getByLabel("Title").fill("Creator-edited upload title");
    await panel.getByRole("button", { name: "Save draft" }).click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00003");
    await expect(panel).toContainText("Metadata limits");
    await expect(panel).toContainText("Keyed cutout");
    await expect(panel.getByRole("button", { name: "Build upload kit" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Batch export" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Generate from beats" })).toBeVisible();
  } finally {
    await launched.electronApp.close();
  }
});
