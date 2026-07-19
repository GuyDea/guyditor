import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { launchApp } from "./helpers/launch-app.js";
import { createWorkspaceProject } from "./helpers/workspace-project.js";

test("imports media and surfaces completed proxy work", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("ingest-path-input").fill(
      resolve(import.meta.dirname, "../../../.fixtures/avsync-video.mp4"),
    );
    await launched.page.getByTestId("ingest-path-submit").click();
    await expect(launched.page.getByTestId("job-state-ingest")).toHaveText("done", {
      timeout: 30_000,
    });
    await expect(launched.page.getByTestId("job-state-proxy-generate")).toHaveText("done", {
      timeout: 30_000,
    });
    await expect(launched.page.getByTestId("asset-list")).toContainText("avsync-video.mp4");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("trims and splits from the timeline and journals both operations", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("timeline-clip-clp_aaaaaaaaaa").click();
    await launched.page.getByTestId("timeline-trim-value").fill("1");
    await launched.page.getByTestId("timeline-trim-tail").click();
    await launched.page.getByTestId("timeline-trim-submit").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00002");
    await launched.page.getByTestId("preview-frame-input").fill("8");
    await launched.page.getByTestId("timeline-split-submit").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00003");
    const journal = await readFile(join(launched.projectPath!, "history/transactions.jsonl"), "utf8");
    expect(journal).toContain('"op":"clip.trim"');
    expect(journal).toContain('"op":"clip.split"');
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("journals semantic reorder, gap, remove, and layer toggle operations", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const first = launched.page.getByTestId("timeline-clip-clp_aaaaaaaaaa");
    const second = launched.page.getByTestId("timeline-clip-clp_bbbbbbbbbb");
    await second.dragTo(first);
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00002");

    await launched.page.getByTestId("timeline-clip-clp_bbbbbbbbbb").click();
    await launched.page.getByTestId("timeline-gap-value").fill("3");
    await launched.page.getByTestId("timeline-gap-submit").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00003");

    await launched.page.getByTestId("layer-enable-lyr_aaaaaaaaaa").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00004");
    await launched.page.getByTestId("layer-lock-lyr_aaaaaaaaaa").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00005");
    await launched.page.getByTestId("layer-lock-lyr_aaaaaaaaaa").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00006");
    await launched.page.getByTestId("timeline-remove-submit").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00007");

    const journal = (await readFile(
      join(launched.projectPath!, "history/transactions.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line) as {
      operations: Array<{ op: string; params: Record<string, unknown> }>;
    });
    const editJournal = journal.filter(({ operations }) =>
      operations.every(({ op }) => op !== "project.create"));
    expect(editJournal.map(({ operations }) => operations.map(({ op }) => op))).toEqual([
      ["clip.move"],
      ["clip.gap.set"],
      ["layer.disable"],
      ["layer.lock"],
      ["layer.unlock"],
      ["clip.remove"],
    ]);
    expect(editJournal.at(-1)!.operations[0]!.params).toMatchObject({ closeGap: true });
    expect(editJournal.flatMap(({ operations }) => operations).some(({ op }) => op === "clip.restore"))
      .toBe(false);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("removes a selected transcript range through the canonical sidecar operation", async () => {
  const template = await createWorkspaceProject({ transcript: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("transcript-word-w000002").click();
    await launched.page.getByTestId("transcript-range-remove").click();
    await expect(launched.page.getByTestId("shell-status")).toContainText("Removed transcript range");
    const journal = await readFile(join(launched.projectPath!, "history/transactions.jsonl"), "utf8");
    expect(journal).toContain('"op":"transcript.range.remove"');
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("creates and resolves a paused-preview annotation", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("annotation-tool-pin").click();
    await launched.page.getByTestId("annotation-body").fill("Check the center");
    await launched.page.getByTestId("annotation-create-center").click();
    const row = launched.page.getByTestId("annotation-list").getByText("Check the center");
    await expect(row).toBeVisible();
    await launched.page.getByTestId("annotation-resolve-first").click();
    await expect(launched.page.getByTestId("annotation-list")).toContainText("resolved");
    const sidecar = await readFile(join(launched.projectPath!, "sidecars/annotations.yaml"), "utf8");
    expect(sidecar).toContain("state: resolved");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("accepts a directly persisted proposal from its semantic diff", async () => {
  const template = await createWorkspaceProject({ proposal: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await expect(launched.page.getByTestId("proposal-prp_bbbbbbbbbb")).toBeVisible();
    await expect(launched.page.getByTestId("proposal-diff-prp_bbbbbbbbbb"))
      .toContainText("Trim");
    await launched.page.getByTestId("proposal-accept-prp_bbbbbbbbbb").click();
    await expect(launched.page.getByTestId("proposal-list")).toContainText("No open proposals");
    const journal = await readFile(join(launched.projectPath!, "history/transactions.jsonl"), "utf8");
    expect(journal).toContain('"proposal":"prp_bbbbbbbbbb"');
    expect(journal).toContain('"op":"annotation.resolve"');
    const sidecar = await readFile(join(launched.projectPath!, "sidecars/annotations.yaml"), "utf8");
    expect(sidecar).toContain("state: resolved");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("undoes and redoes a direct timeline edit as forward transactions", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("timeline-clip-clp_aaaaaaaaaa").click();
    await launched.page.getByTestId("timeline-trim-value").fill("1");
    await launched.page.getByTestId("timeline-trim-tail").click();
    await launched.page.getByTestId("timeline-trim-submit").click();
    await launched.page.getByTestId("undo-action").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00003");
    await launched.page.getByTestId("redo-action").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00004");
    const journal = await readFile(join(launched.projectPath!, "history/transactions.jsonl"), "utf8");
    expect(journal).toContain('"undoOf"');
    expect(journal).toContain('"redoOf"');
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});
