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
      resolve(import.meta.dirname, "../../../.fixtures/disc-track-720p30-8s.mp4"),
    );
    await launched.page.getByTestId("ingest-path-submit").click();
    await launched.page.getByTestId("global-progress").click();
    await expect(launched.page.getByTestId("global-progress-queued")).toContainText(
      "Generate proxy for",
      { timeout: 10_000 },
    );
    await expect(launched.page.getByTestId("global-progress-queued")).toContainText(
      "Blocked on",
    );
    await expect(launched.page.getByTestId("global-progress-queued")).toContainText(
      "Ingest 1 assets",
    );
    await launched.page.getByTestId("global-progress").click();
    await expect(launched.page.getByTestId("job-state-ingest")).toHaveText("done", {
      timeout: 30_000,
    });
    await expect(launched.page.getByTestId("job-state-proxy-generate")).toHaveText("done", {
      timeout: 30_000,
    });
    await expect(launched.page.getByTestId("asset-list")).toContainText("disc-track-720p30-8s.mp4");
    await expect(launched.page.getByTestId("global-progress-status")).toHaveText(
      "idle — no background work, nothing awaiting review",
      { timeout: 30_000 },
    );
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("shows a ready proposal as waiting on the creator and jumps to review", async () => {
  const template = await createWorkspaceProject({ proposal: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await expect(launched.page.getByTestId("global-progress-waiting-count"))
      .toHaveText("1 waiting on you");
    await launched.page.getByTestId("global-progress").click();
    await launched.page.getByTestId("global-proposal-jump-prp_bbbbbbbbbb").click();
    await expect(launched.page.getByTestId("agent-panel")).toBeFocused();
    await expect(launched.page.getByTestId("proposal-diff-prp_bbbbbbbbbb")).toBeVisible();
    await expect(launched.page.getByTestId("global-progress-popover")).toHaveCount(0);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("cancels queued work from the global progress popover", async () => {
  const template = await createWorkspaceProject({ queuedJob: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await expect(launched.page.getByTestId("global-progress-status")).toHaveText("1 active · 0%");
    await launched.page.getByTestId("global-progress").click();
    const queued = launched.page.getByTestId("global-progress-queued");
    await expect(queued).toContainText("Manual cancellable hold");
    await queued.getByRole("button", { name: "Cancel" }).click();
    await expect(launched.page.getByTestId("job-state-manual-wait")).toHaveText("cancelled");
    await expect(launched.page.getByTestId("global-progress-status")).toHaveText(
      "idle — no background work, nothing awaiting review",
    );
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
    const journalPath = join(launched.projectPath!, "history/transactions.jsonl");
    await expect.poll(() => readFile(journalPath, "utf8"))
      .toContain('"op":"transcript.range.remove"');
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("places a schema-driven lower third at a word and previews the journaled graphic", async () => {
  const template = await createWorkspaceProject({ transcript: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("transcript-word-w000002").click();
    const catalog = await launched.page.evaluate(() =>
      window.guyditor.call<Array<{ builtinName?: string }>>(
        "RenderService",
        "templateCatalog",
        {},
      ));
    expect(catalog.map(({ builtinName }) => builtinName)).toEqual([
      "lower-third",
      "title-card",
      "callout-box",
      "full-frame-infographic",
    ]);
    await expect(launched.page.getByTestId("graphics-panel")).toContainText("Brand lower third");
    await launched.page.getByTestId("template-lower-third").click();
    await launched.page.getByLabel("title *", { exact: true }).fill("Word anchored title");
    await launched.page.getByTestId("graphic-anchor").selectOption("word");
    await launched.page.getByTestId("graphic-add").click();

    await expect(launched.page.getByTestId("graphic-instance-list"))
      .toContainText("Word anchored title");
    const overlay = launched.page.getByTestId("preview-graphic-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveAttribute("src", /^data:image\/png;base64,/u);
    const journal = await readFile(join(launched.projectPath!, "history/transactions.jsonl"), "utf8");
    expect(journal).toContain('"op":"graphic.add"');
    expect(journal).toContain("word:w000002");
    const master = await readFile(join(launched.projectPath!, "episode.guyditor.yaml"), "utf8");
    expect(master).toContain("tpl_a2c3d4e5f6");
    expect(master).toContain("Word anchored title");
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
