import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import {
  TemplateAuthoringService,
  TemplateRegistry,
} from "../../render/src/index.js";
import { launchApp } from "./helpers/launch-app.js";
import { createWorkspaceProject } from "./helpers/workspace-project.js";

test("imports media and surfaces completed proxy work", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("phase-tab-ingest").click();
    await launched.page.getByTestId("ingest-path-input").fill(
      resolve(import.meta.dirname, "../../../.fixtures/disc-track-720p30-8s.mp4"),
    );
    await launched.page.getByTestId("ingest-path-submit").click();
    await launched.page.getByTestId("global-progress").click();
    await expect(launched.page.getByTestId("global-progress-queued")).toContainText(
      /Generate proxy for[\s\S]*Blocked on[\s\S]*Ingest 1 assets/u,
      { timeout: 10_000 },
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

test("reviews restyle seam markers, previews an interstitial, and proposes its override", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("restyle-coverage").selectOption("range");
    await launched.page.getByLabel("Restyle start frame").fill("1");
    await launched.page.getByLabel("Restyle end frame").fill("47");
    await launched.page.getByTestId("restyle-plan-create").click();
    await expect(launched.page.getByTestId("restyle-seam-list")).toContainText("2 boundaries");
    await expect(launched.page.getByTestId("proposal-list")).toContainText("restyle-seam");
    await launched.page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(launched.page.getByTestId("restyle-plan-review")).toContainText("accepted plan");
    await expect(launched.page.getByTestId("restyle-timeline-seam-restyle-seam-001"))
      .toHaveAttribute("data-kind", "punch-in");

    await launched.page.getByTestId("restyle-seam-kind-restyle-seam-001")
      .selectOption("interstitial");
    await expect(launched.page.getByTestId("restyle-seam-preview-restyle-seam-001"))
      .toHaveAttribute("src", /^data:image\/png;base64,/u);
    await launched.page.getByTestId("restyle-seam-duration-restyle-seam-001").fill("24");
    await launched.page.getByTestId("restyle-seam-propose-restyle-seam-001").click();
    await expect(launched.page.getByTestId("shell-status"))
      .toContainText("Prepared interstitial override");
    await expect(launched.page.getByTestId("proposal-list")).toContainText("restyle-seam");
    await expect(launched.page.getByTestId("proposal-list")).toContainText("interstitial");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("cancels queued work from the global progress popover", async () => {
  const template = await createWorkspaceProject({ queuedJob: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("phase-tab-ingest").click();
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

test("renders master metering and journals automatic and manual ducking", async () => {
  const template = await createWorkspaceProject({ audioPost: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await expect(launched.page.getByTestId("loudness-meter")).toBeVisible();
    await expect(launched.page.getByTestId("loudness-target"))
      .toContainText("master −16.0 LUFS · ceiling −1.5 dBTP");
    await launched.page.getByTestId("loudness-reset").click();

    await launched.page.getByTestId("layer-select-lyr_bbbbbbbbbb").click();
    await launched.page.getByTestId("panel-rail-inspector").click();
    await expect(launched.page.getByTestId("audio-inspector")).toBeVisible();
    await launched.page.getByTestId("duck-db").fill("-15");
    await launched.page.getByTestId("duck-save").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00002", {
      timeout: 15_000,
    });
    await expect(launched.page.getByTestId("ducking-visualization-lyr_bbbbbbbbbb"))
      .toHaveAttribute("data-enabled", "true");

    await launched.page.getByTestId("duck-mode").selectOption("manual");
    await launched.page.getByTestId("duck-save").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00003", {
      timeout: 15_000,
    });
    await launched.page.getByTestId("duck-override-anchor").fill("timeline:12@24/1");
    await launched.page.getByTestId("duck-override-gain").fill("-9");
    await launched.page.getByTestId("duck-override-add").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00004", {
      timeout: 15_000,
    });

    const journal = await readFile(join(launched.projectPath!, "history/transactions.jsonl"), "utf8");
    const operations = journal.trim().split("\n").flatMap((line) =>
      (JSON.parse(line) as { operations: Array<{ op: string }> }).operations);
    expect(operations.filter(({ op }) => op === "layer.ducking.set")).toHaveLength(2);
    expect(operations.filter(({ op }) => op === "layer.ducking.override")).toHaveLength(1);
    const master = await readFile(join(launched.projectPath!, "episode.guyditor.yaml"), "utf8");
    expect(master).toContain("mode: manual");
    expect(master).toContain("timeline:12@24/1");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("removes a selected transcript range through the canonical sidecar operation", async () => {
  const template = await createWorkspaceProject({ transcript: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("phase-tab-polish").click();
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
    await launched.page.getByTestId("phase-tab-polish").click();
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
      "kinetic-title",
      "stat-counter-card",
      "bar-chart-card",
      "cutout-collage-card",
      "highlight-underline",
      "lottie-card",
    ]);
    await expect(launched.page.getByTestId("graphics-panel")).toContainText("Brand lower third");
    await expect(launched.page.getByTestId("template-import")).toHaveText("Import package");
    await launched.page.getByTestId("template-lottie-card").click();
    await expect(launched.page.getByTestId("lottie-feature-profile"))
      .toContainText("precomposition");
    await launched.page.getByTestId("template-lower-third").click();
    await expect(launched.page.getByTestId("template-browser-freeze"))
      .toHaveText("Freeze selected to clip");
    await expect(launched.page.getByTestId("template-freeze")).toHaveText("Freeze to clip");
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

test("reviews an agent-authored template preview strip before enabling deliverable actions", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({
    projectTemplate: template,
    prepareUserData: async (userDataDirectory) => {
      const root = join(userDataDirectory, ".guyditor", "templates");
      const registry = new TemplateRegistry({
        builtinsRoot: join(userDataDirectory, "empty-builtins"),
        userRoot: root,
        draftRoot: join(root, ".drafts"),
      });
      const ids = ["tas_a2c3d4e5f6", "tpl_b2c3d4e5f6"];
      const authoring = new TemplateAuthoringService({
        registry,
        draftRoot: join(root, ".drafts"),
        idFactory: () => ids.shift()!,
        probe: { frames: 3, framesPerSecondFloor: 0.1 },
      });
      const result = await authoring.submit({
        name: "Agent stat badge",
        description: "A compact, animated review fixture.",
        manifest: {
          params: {
            type: "object",
            additionalProperties: false,
            required: ["value"],
            properties: {
              value: { type: "number", minimum: 0, maximum: 100, default: 72 },
            },
          },
          duration: { mode: "fixed", default: { frames: 24, fps: "24/1" } },
          assets: [],
        },
        source: `import { primitivesV1 as motion } from "@guyditor/render/primitives/v1";
export default {
  render(ctx, params) {
    motion.shapes.roundedRect(ctx.canvas, {
      x: 40, y: 40, width: 80 + params.value, height: 48,
      radius: 8, fill: "#4DD6A4"
    });
  }
};`,
      }, { sessionId: "ses_a2c3d4e5f6", model: "e2e-director" });
      if (!result.ok) throw new Error("Could not seed authored-template e2e draft.");
    },
  });
  try {
    await launched.page.getByTestId("phase-tab-polish").click();
    await launched.page.getByTestId("template-tas_a2c3d4e5f6").click();
    await expect(launched.page.getByTestId("template-author-review"))
      .toContainText("Awaiting creator review");
    await expect(launched.page.getByTestId("template-preview-strip").locator("img"))
      .toHaveCount(3);
    await expect(launched.page.getByTestId("graphic-add")).toBeDisabled();
    await expect(launched.page.getByTestId("template-freeze")).toBeDisabled();
    await launched.page.getByTestId("template-review-approve").click();
    await expect(launched.page.getByTestId("template-author-review")).toHaveCount(0);
    await expect(launched.page.getByTestId("graphic-add")).toBeEnabled();
    await expect.poll(() => launched.page.evaluate(() =>
      window.guyditor.call<{ status: string }>(
        "TemplateAuthoringService",
        "status",
        { submissionId: "tas_a2c3d4e5f6" },
      ))).toMatchObject({ status: "published" });
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

test("surfaces a jump-cut seam and prepares concealment without silently editing", async () => {
  const template = await createWorkspaceProject({ jumpCut: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    const seam = launched.page.getByTestId("jumpcut-propose-clp_aaaaaaaaaa");
    await expect(seam).toBeVisible();
    await seam.click();
    await expect(launched.page.getByTestId("proposal-list"))
      .toContainText("assist.jumpcuts.conceal");
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00001");
    const accepted = await launched.page.evaluate(() =>
      window.guyditor.call<{ master: { sequences: Array<{ clips: Array<{ punchIn?: unknown }> }> } }>(
        "ProjectStore",
        "getSnapshot",
        {},
      ));
    expect(accepted.master.sequences[0]!.clips[1]!.punchIn).toBeUndefined();
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("configures a capture folder and shows stable session ingest and seeded take work", async () => {
  test.setTimeout(60_000);
  const template = await createWorkspaceProject();
  const watchRoot = join(template, "capture-inbox");
  const sessionRoot = join(watchRoot, "20260719-2130_step-seven");
  await mkdir(sessionRoot, { recursive: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("phase-tab-ingest").click();
    await launched.page.getByTestId("watch-folder-panel").click();
    await launched.page.getByTestId("watch-folder-path").fill(watchRoot);
    const panel = launched.page.getByTestId("watch-folder-panel");
    await panel.getByRole("checkbox", { name: "proxy" }).uncheck();
    await panel.getByRole("checkbox", { name: "analysis" }).uncheck();
    await panel.getByRole("checkbox", { name: "transcription" }).uncheck();
    await launched.page.getByTestId("watch-folder-add").click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00002");

    const source = resolve(import.meta.dirname, "../../../.fixtures/disc-track-720p30-8s.mp4");
    await copyFile(source, join(sessionRoot, "cam-a_t03.mp4"));
    await expect(launched.page.getByTestId("asset-list")).toContainText("cam-a_t03.mp4", {
      timeout: 30_000,
    });
    await expect(launched.page.locator('[data-testid^="takes-"]')).toContainText("1 takes");

    const state = await launched.page.evaluate(async () => {
      const snapshot = await window.guyditor.call<{
        master: { assets: Array<{ path: string; session?: string; takes?: string[] }> };
      }>("ProjectStore", "getSnapshot", {});
      const jobs = await window.guyditor.call<Array<{ kind: string; state: string }>>(
        "JobQueue",
        "list",
        {},
      );
      return { asset: snapshot.master.assets.find(({ path }) => path.endsWith("cam-a_t03.mp4")), jobs };
    });
    expect(state.asset).toMatchObject({
      session: expect.stringMatching(/^ses_[a-z2-7]{10}$/u),
      takes: [expect.stringMatching(/^tak_[a-z2-7]{10}$/u)],
    });
    expect(state.jobs).toContainEqual(expect.objectContaining({ kind: "ingest", state: "done" }));
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
