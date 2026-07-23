import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { launchApp } from "../helpers/launch-app.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");

test("AC-006 — drags a constrained PiP and keyframes it at a word", async () => {
  test.setTimeout(60_000);
  const launched = await launchApp({ projectTemplate: join(REPOSITORY_ROOT, ".fixtures/projects/ac006") });
  try {
    await launched.page.getByTestId("layer-select-lyr_bbbbbbbbbb").click();
    await launched.page.getByTestId("phase-tab-polish").click();
    await expect(launched.page.getByTestId("pip-inspector")).toBeVisible();
    await launched.page.getByTestId("pip-anchor").selectOption("bottom_right");
    await launched.page.getByTestId("pip-width").fill("24%");
    await launched.page.getByTestId("pip-margin").fill("4%");
    await launched.page.getByTestId("pip-place").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00002");

    const canvas = launched.page.getByTestId("pip-preview-canvas");
    await canvas.scrollIntoViewIfNeeded();
    await canvas.evaluate((element) => {
      const body = element.closest(".panel-body");
      if (body instanceof HTMLElement) body.scrollTop = Math.max(0, element.clientHeight * 0.45);
    });
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("PiP preview canvas is missing.");
    expect(await launched.page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return { tag: target?.tagName, testId: target?.getAttribute("data-testid") };
    }, { x: box.x + box.width * 0.84, y: box.y + box.height * 0.81 })).toEqual({
      tag: "CANVAS", testId: "pip-preview-canvas",
    });
    await launched.page.mouse.move(box.x + box.width * 0.84, box.y + box.height * 0.81);
    await launched.page.mouse.down();
    await launched.page.mouse.move(box.x + box.width * 0.16, box.y + box.height * 0.81, { steps: 6 });
    await launched.page.mouse.up();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00003");

    await launched.page.getByTestId("transcript-word-w000123").click();
    await launched.page.getByTestId("pip-preset").selectOption("pre_pipsmoothm");
    await expect(launched.page.getByTestId("pip-review-anchor")).toContainText("word:w000123");
    await launched.page.getByTestId("pip-keyframe-add").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00004");

    if (launched.projectPath === undefined) throw new Error("AC-006 project was not copied.");
    const journal = await readFile(join(launched.projectPath, "history/transactions.jsonl"), "utf8");
    expect(journal).toContain('"op":"pip.place"');
    expect(journal).toContain('"op":"pip.preset.apply"');
    expect(journal).toContain("word:w000123");
    expect(journal).toContain("pre_pipsmoothm");
  } finally {
    await launched.electronApp.close();
  }
});
