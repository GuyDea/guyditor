import { expect, test } from "@playwright/test";

import { launchApp } from "./helpers/launch-app.js";

test("opens the secure Electron shell with the generated facade and jobs panel", async () => {
  const launched = await launchApp();
  try {
    await expect(launched.page.getByTestId("jobs-panel")).toBeVisible();
    await expect(launched.page.getByTestId("revision-indicator")).toContainText("no revision");
    await expect.poll(() => launched.page.evaluate(() => ({
      call: typeof window.guyditor?.call,
      on: typeof window.guyditor?.on,
      keys: Object.keys(window.guyditor ?? {}).sort(),
    }))).toEqual({ call: "function", on: "function", keys: ["call", "on"] });
  } finally {
    await launched.electronApp.close();
  }
});
