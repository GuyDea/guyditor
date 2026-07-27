import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { parse as parseYaml } from "yaml";

import { launchApp } from "./helpers/launch-app.js";
import { createWorkspaceProject } from "./helpers/workspace-project.js";

test("one project-portable active short drives every phase and edit target", async () => {
  const template = await createWorkspaceProject({
    transcript: true,
    derivedShort: true,
  });
  const first = await launchApp({ projectTemplate: template });
  let second: Awaited<ReturnType<typeof launchApp>> | null = null;
  const copyRoot = await mkdtemp(join(tmpdir(), "guyditor-active-copy-"));
  try {
    const protectedPaths = [
      "episode.guyditor.yaml",
      "history/HEAD",
      "history/transactions.jsonl",
    ];
    const before = await Promise.all(protectedPaths.map((path) =>
      readFile(join(first.projectPath!, path), "utf8")
    ));

    await first.page.getByTestId("phase-tab-publish").click();
    await first.page.getByTestId("deliverable-dlv_bbbbbbbbbb").click();
    await expect(first.page.getByTestId("deliverable-dlv_bbbbbbbbbb"))
      .toHaveAttribute("aria-pressed", "true");
    await expect(first.page.getByTestId("publish-panel").getByLabel("Deliverable"))
      .toHaveValue("dlv_bbbbbbbbbb");

    const afterSwitch = await Promise.all(protectedPaths.map((path) =>
      readFile(join(first.projectPath!, path), "utf8")
    ));
    expect(afterSwitch).toEqual(before);
    await expect.poll(() =>
      readFile(join(first.projectPath!, "workspace.guyditor.yaml"), "utf8")
    ).toContain("activeDeliverableId: dlv_bbbbbbbbbb");

    await first.page.getByTestId("phase-tab-cut").click();
    await expect(first.page.getByTestId("preview-surface"))
      .toHaveAttribute("data-aspect", "portrait");
    await expect(first.page.getByTestId("timeline-clip-clp_cccccccccc"))
      .toBeVisible();
    await expect(first.page.getByTestId("timeline-clip-clp_aaaaaaaaaa"))
      .toHaveCount(0);
    await expect(first.page.getByTestId("caption-track-panel"))
      .toContainText("cts_bbbbbbbbbb");

    await first.page.getByTestId("phase-tab-polish").click();
    await first.page.getByTestId("template-lower-third").click();
    await first.page.getByLabel("title *", { exact: true })
      .fill("Short-only title");
    await first.page.getByTestId("graphic-anchor").selectOption("playhead");
    await first.page.getByTestId("graphic-add").click();
    await expect(first.page.getByTestId("graphic-instance-list"))
      .toContainText("Short-only title");
    await expect.poll(async () => {
      const journal = await readFile(
        join(first.projectPath!, "history/transactions.jsonl"),
        "utf8",
      );
      const records = journal.trim().split("\n").map((line) =>
        JSON.parse(line) as {
          id?: string;
          divergence?: string;
          operations?: Array<{ params?: { anchor?: string } }>;
        });
      const graphicTransaction = records.find(({ operations }) =>
        operations?.some(({ params }) =>
          params?.anchor === "timeline:seq_bbbbbbbbbb@0"));
      const master = parseYaml(await readFile(
        join(first.projectPath!, "episode.guyditor.yaml"),
        "utf8",
      )) as {
        deliverables?: Array<{
          id?: string;
          divergences?: Array<{
            class?: string;
            transactionIds?: string[];
          }>;
        }>;
      };
      const recorded = master.deliverables
        ?.find(({ id }) => id === "dlv_bbbbbbbbbb")
        ?.divergences
        ?.find(({ class: divergence }) => divergence === "graphics")
        ?.transactionIds
        ?.includes(graphicTransaction?.id ?? "") ?? false;
      return {
        journal: graphicTransaction?.divergence,
        deliverable: recorded,
      };
    }).toEqual({
      journal: "graphics",
      deliverable: true,
    });

    await first.electronApp.close();
    const copiedProject = join(copyRoot, "copied-project");
    await cp(first.projectPath!, copiedProject, { recursive: true });
    second = await launchApp({
      projectPath: copiedProject,
      userDataDirectory: join(copyRoot, "fresh-profile"),
    });

    await expect(second.page.getByTestId("preview-surface"))
      .toHaveAttribute("data-aspect", "portrait");
    await expect(second.page.getByTestId("timeline-clip-clp_cccccccccc"))
      .toBeVisible();
    await expect(second.page.getByTestId("caption-track-panel"))
      .toContainText("cts_bbbbbbbbbb");
  } finally {
    await first.electronApp.close().catch(() => undefined);
    await second?.electronApp.close().catch(() => undefined);
    await rm(template, { recursive: true, force: true });
    await rm(copyRoot, { recursive: true, force: true });
  }
});
