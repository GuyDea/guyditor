import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { launchApp } from "./helpers/launch-app.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

interface Snapshot {
  master: {
    sequences: Array<{
      id: string;
      clips: Array<{ asset: string; source: { in: { frames: number; fps: string } } }>;
    }>;
    settings: { primaryDeliverable: string };
    deliverables: Array<{ id: string; sequenceId: string }>;
  };
}

test("AI assembly — asks one question, plans three cuts, and accepts the proposal", async () => {
  test.setTimeout(120_000);
  process.env.GUYDITOR_ASSEMBLY_STUB = "1";
  const launched = await launchApp({
    projectTemplate: join(REPOSITORY_ROOT, ".fixtures/projects/assembly"),
  });
  const { page } = launched;
  try {
    await page.getByTestId("phase-tab-cut").click();
    await page.getByTestId("dock-tab-assemble").click();
    await page.getByTestId("assembly-script-path")
      .fill(join(REPOSITORY_ROOT, ".fixtures/scripts/assembly.raw.md"));
    await page.getByTestId("assembly-analyze").click();
    await expect(page.getByTestId("assembly-evidence-summary")).toContainText("3 clips");

    await page.getByTestId("assembly-input").fill("Assemble the hook from the best takes.");
    await page.getByTestId("assembly-send").click();
    await expect(page.getByTestId("assembly-question-0")).toBeVisible();
    await page.getByTestId("assembly-option-0-0").click();

    await expect(page.getByTestId("assembly-plan")).toBeVisible();
    for (const index of [0, 1, 2]) {
      await expect(page.getByTestId(`assembly-cut-${index}`)).toBeVisible();
    }

    await page.getByTestId("assembly-create-proposal").click();
    await expect(page.getByTestId("assembly-open-proposal")).toBeVisible();
    await page.getByTestId("assembly-open-proposal").click();
    const accept = page.locator('[data-testid^="proposal-accept-"]');
    await expect(accept).toBeVisible();
    await accept.click();
    await expect(page.getByTestId("proposal-list")).toContainText("No open proposals");

    const state = await page.evaluate(async () => {
      const snapshot = await window.guyditor.call<Snapshot>("ProjectStore", "getSnapshot", {});
      const jobs = await window.guyditor.call<Array<{ kind: string }>>("JobQueue", "list", {});
      return { snapshot, jobs };
    });
    const master = state.snapshot.master;
    const deliverable = master.deliverables.find(({ id }) => id === master.settings.primaryDeliverable);
    const sequence = master.sequences.find(({ id }) => id === deliverable?.sequenceId);
    expect(sequence?.clips).toHaveLength(3);
    expect(sequence?.clips[0]?.asset).toBe("ast_assemblyaa");
    expect(sequence?.clips[0]?.source.in.fps).toBe("30/1");
    expect(sequence?.clips[0]?.source.in.frames).toBeGreaterThan(150);
    // The review marker is written right after acceptance; poll past the sidecar write/register window.
    await expect.poll(async () => page.evaluate(async () => {
      try {
        const annotations = await window.guyditor.call<Array<{ author: { kind: string } }>>(
          "AnnotationService",
          "list",
          {},
        );
        return annotations.filter(({ author }) => author.kind === "agent").length;
      } catch {
        return -1;
      }
    })).toBe(1);
    expect(state.jobs.filter(({ kind }) => kind === "assist.fillers.detect")).toHaveLength(0);
  } finally {
    await launched.electronApp.close();
  }
});
