import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { launchApp } from "../helpers/launch-app.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");

test("AC-003 — corrects caption layout on the exact shared preview frame", async () => {
  test.setTimeout(60_000);
  const launched = await launchApp({
    projectTemplate: join(REPOSITORY_ROOT, ".fixtures/projects/ac003"),
  });
  try {
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00001");
    await expect(launched.page.getByTestId("caption-track-panel")).toContainText("cts_aaaaaaaaaa");
    await launched.page.getByTestId("transcript-word-w000005").click();
    await launched.page.getByTestId("preview-frame-input").fill("56");
    await launched.page.getByTestId("preview-frame-input").press("Enter");
    await expect(launched.page.getByTestId("preview-frame-input")).toHaveValue("56");
    await expect.poll(() => launched.page.getByTestId("preview-caption-overlay").evaluate(
      (canvas) => {
        if (!(canvas instanceof HTMLCanvasElement)) return 0;
        const context = canvas.getContext("2d");
        if (context === null) return 0;
        return context.getImageData(0, 0, canvas.width, canvas.height).data.some(
          (value, index) => index % 4 === 3 && value !== 0,
        ) ? 1 : 0;
      },
    )).toBe(1);

    await launched.page.getByTestId("caption-emphasis-toggle").check();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00002");
    await launched.page.getByTestId("caption-break-select").selectOption("line");
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00003");
    await launched.page.getByTestId("caption-style-words-per-line").fill("3");
    await launched.page.getByTestId("caption-style-words-per-line").press("Tab");
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00004");
    await launched.page.getByTestId("caption-start-nudge").fill("-20");
    await launched.page.getByTestId("caption-end-nudge").fill("30");
    await launched.page.getByTestId("caption-timing-apply").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00005");

    if (launched.projectPath === undefined) throw new Error("AC-003 project was not copied.");
    const journal = await readFile(join(launched.projectPath, "history/transactions.jsonl"), "utf8");
    expect(journal).toContain('"op":"caption.word.emphasis.set"');
    expect(journal).toContain('"op":"caption.break.set"');
    expect(journal).toContain('"op":"caption.style.set"');
    expect(journal).toContain('"op":"caption.cue.retime"');
  } finally {
    await launched.electronApp.close();
  }
});
