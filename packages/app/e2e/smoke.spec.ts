import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { launchApp } from "./helpers/launch-app.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const BASIC_PROJECT = join(REPOSITORY_ROOT, ".fixtures/projects/basic");

test("opens the secure Electron shell with the generated facade and jobs panel", async () => {
  const launched = await launchApp({ projectTemplate: BASIC_PROJECT });
  try {
    await launched.page.getByTestId("phase-tab-ingest").click();
    await expect(launched.page.getByTestId("jobs-panel")).toBeVisible();
    await expect(launched.page.getByTestId("welcome-surface")).toHaveCount(0);
    await expect(launched.page.getByTestId("shell-status")).not.toContainText("unavailable");
    await expect.poll(() => launched.page.evaluate(() => ({
      call: typeof window.guyditor?.call,
      on: typeof window.guyditor?.on,
      pathForFile: typeof window.guyditor?.pathForFile,
      keys: Object.keys(window.guyditor ?? {}).sort(),
    }))).toEqual({
      call: "function",
      on: "function",
      pathForFile: "function",
      keys: ["call", "on", "pathForFile"],
    });
  } finally {
    await launched.electronApp.close();
  }
});

test("keeps the seven section 10.1 panels reachable through phase layouts", async () => {
  const launched = await launchApp({ projectTemplate: BASIC_PROJECT });
  try {
    const phaseByPanel = {
      media: "ingest",
      preview: "cut",
      transcript: "cut",
      inspector: "polish",
      agent: "review",
      timeline: "cut",
      status: "publish",
    };
    for (const [panel, phase] of Object.entries(phaseByPanel)) {
      await launched.page.getByTestId(`phase-tab-${phase}`).click();
      await expect(launched.page.getByTestId(`${panel}-panel`)).toBeVisible();
    }

    await launched.page.getByTestId("phase-tab-cut").focus();
    await launched.page.keyboard.press("8");
    await expect(launched.page.getByTestId("graphics-panel")).toBeFocused();
    await launched.page.keyboard.press("9");
    await expect(launched.page.getByTestId("publish-panel")).toBeFocused();
  } finally {
    await launched.electronApp.close();
  }
});
