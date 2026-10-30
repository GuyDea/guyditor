import { rm } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { launchApp } from "./helpers/launch-app.js";
import { createWorkspaceProject } from "./helpers/workspace-project.js";

function groupWith(page: Page, panelId: string) {
  return page.getByTestId("dock-group").filter({ has: page.getByTestId(`dock-tab-${panelId}`) });
}

test("layout edits persist globally across relaunch and into another project", async () => {
  const firstTemplate = await createWorkspaceProject({ proposal: true });
  const secondTemplate = await createWorkspaceProject();
  const first = await launchApp({ projectTemplate: firstTemplate });
  let second: Awaited<ReturnType<typeof launchApp>> | null = null;
  try {
    await first.page.getByTestId("phase-tab-cut").click();
    const divider = first.page.locator(
      "[data-testid='split-divider'][aria-orientation='vertical']",
    );
    await expect(divider).toHaveCount(1);
    const splitId = await divider.getAttribute("data-split-id");
    await divider.focus();
    for (let step = 0; step < 3; step += 1) await first.page.keyboard.press("ArrowLeft");
    const resized = await divider.getAttribute("aria-valuenow");
    expect(Number(resized)).toBeLessThan(80);

    await groupWith(first.page, "timeline").getByTestId("group-close").click();
    await expect(first.page.getByTestId("timeline-panel")).toHaveCount(0);
    await groupWith(first.page, "preview").getByTestId("group-split-right").click();
    await first.page.getByTestId("panel-picker-option-inspector").click();
    await expect(first.page.getByTestId("dock-tab-inspector")).toBeVisible();

    await first.electronApp.close();
    second = await launchApp({
      projectTemplate: secondTemplate,
      userDataDirectory: first.userDataDirectory,
    });

    await expect(second.page.getByTestId("phase-tab-cut")).toHaveAttribute("aria-selected", "true");
    await expect(second.page.getByTestId("dock-tab-inspector")).toBeVisible();
    await expect(second.page.getByTestId("timeline-panel")).toHaveCount(0);
    await expect(second.page.locator(`[data-split-id='${String(splitId)}']`))
      .toHaveAttribute("aria-valuenow", String(resized));
  } finally {
    await first.electronApp.close().catch(() => undefined);
    await second?.electronApp.close().catch(() => undefined);
    await rm(firstTemplate, { recursive: true, force: true });
    await rm(secondTemplate, { recursive: true, force: true });
  }
});

test("the split picker greys out placed panels and dismissing it leaves no empty space", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const { page } = launched;
    await page.getByTestId("phase-tab-cut").click();
    const groups = await page.getByTestId("dock-group").count();

    await groupWith(page, "preview").getByTestId("group-split-down").click();
    await expect(page.getByTestId("pending-split")).toBeVisible();
    await expect(page.getByTestId("panel-picker-option-preview"))
      .toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("panel-picker-option-transcript"))
      .toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("panel-picker-option-inspector"))
      .toHaveAttribute("aria-disabled", "false");
    await page.getByTestId("panel-picker-option-transcript").click({ force: true });
    await expect(page.getByTestId("pending-split")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pending-split")).toHaveCount(0);
    await expect(page.getByTestId("dock-group")).toHaveCount(groups);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("the panel menu adds tabs and closes on Escape", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const { page } = launched;
    await page.getByTestId("phase-tab-review").click();
    const media = groupWith(page, "media");

    await media.getByTestId("group-menu").click();
    await expect(page.getByTestId("group-menu-list")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("group-menu-list")).toHaveCount(0);

    await media.getByTestId("group-menu").click();
    await page.getByTestId("group-menu-add-tab").click();
    await page.getByTestId("panel-picker-option-broll").click();
    await expect(groupWith(page, "media").getByTestId("dock-tab-broll"))
      .toHaveAttribute("aria-selected", "true");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("closing every panel leaves only Add panel, which restores a root panel", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const { page } = launched;
    await page.getByTestId("phase-tab-publish").click();
    while (await page.getByTestId("dock-group").count() > 0) {
      await page.getByTestId("dock-group").first().getByTestId("group-close").click();
    }
    await expect(page.getByTestId("workspace-add-panel")).toBeVisible();

    await page.getByTestId("workspace-add-panel").click();
    await page.getByTestId("panel-picker-option-help").click();

    await expect(page.getByTestId("dock-group")).toHaveCount(1);
    await expect(page.getByTestId("help-panel")).toBeVisible();
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("the rail focuses placed panels and adds absent ones to the last-used panel", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const { page } = launched;
    await page.getByTestId("phase-tab-cut").click();
    await expect(page.getByTestId("tool-rail-entry-preview")).toHaveAttribute("data-state", "here");
    await expect(page.getByTestId("tool-rail-entry-media"))
      .toHaveAttribute("data-state", "other-phase");
    await expect(page.getByTestId("tool-rail-entry-help")).toHaveAttribute("data-state", "absent");

    await page.getByTestId("tool-rail-entry-preview").click();
    await expect(page.getByTestId("preview-panel")).toBeFocused();

    // The rail widens over the workspace while hovered; leave it before clicking a tab.
    await page.mouse.move(960, 600);
    await page.getByTestId("dock-tab-transcript").click();
    await page.getByTestId("tool-rail-entry-inspector").click();
    await expect(groupWith(page, "transcript").getByTestId("dock-tab-inspector"))
      .toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("inspector-panel")).toHaveClass(/panel-flash/u);
    await expect(page.getByTestId("tool-rail-entry-inspector")).toHaveAttribute("data-state", "here");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("a panel the app opens on its own is saved into the layout", async () => {
  const template = await createWorkspaceProject({ proposal: true });
  const first = await launchApp({ projectTemplate: template });
  let second: Awaited<ReturnType<typeof launchApp>> | null = null;
  try {
    await first.page.getByTestId("phase-tab-review").click();
    await groupWith(first.page, "agent").getByTestId("group-close").click();
    await expect(first.page.getByTestId("agent-panel")).toHaveCount(0);

    await first.page.getByTestId("phase-badge-review").click();
    await expect(first.page.getByTestId("agent-panel")).toBeVisible();

    await first.electronApp.close();
    if (first.projectPath === undefined) throw new Error("Relaunch fixture path was missing.");
    second = await launchApp({
      projectPath: first.projectPath,
      userDataDirectory: first.userDataDirectory,
    });
    await second.page.getByTestId("phase-tab-review").click();
    await expect(second.page.getByTestId("dock-tab-agent")).toBeVisible();
  } finally {
    await first.electronApp.close().catch(() => undefined);
    await second?.electronApp.close().catch(() => undefined);
    await rm(template, { recursive: true, force: true });
  }
});

test("reset layout restores this phase's preset and reset all restores every phase", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const { page } = launched;
    await page.getByTestId("phase-tab-cut").click();
    await groupWith(page, "timeline").getByTestId("group-close").click();
    await page.getByTestId("phase-tab-review").click();
    await groupWith(page, "media").getByTestId("group-close").click();

    await page.getByTestId("reset-layout").click();
    await expect(page.getByTestId("media-panel")).toBeVisible();
    await page.getByTestId("phase-tab-cut").click();
    await expect(page.getByTestId("timeline-panel")).toHaveCount(0);

    await page.getByTestId("reset-all-layouts").click();
    await expect(page.getByTestId("timeline-panel")).toBeVisible();
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("agent content scrolls internally when its panel is small", async () => {
  const template = await createWorkspaceProject({ proposal: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    const { page } = launched;
    await page.getByTestId("phase-tab-cut").click();
    await groupWith(page, "agent").getByTestId("group-split-down").click();
    await page.getByTestId("panel-picker-option-inspector").click();
    await page.getByTestId("timeline-clip-clp_aaaaaaaaaa").click();

    const scroll = page.getByTestId("agent-panel-scroll");
    const dimensions = await scroll.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
    await scroll.evaluate((element) => {
      element.scrollTop = 48;
    });
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const overflowViolations = await page.locator("[data-testid$='-panel-scroll']")
      .evaluateAll((elements) => elements.flatMap((element) => {
        const style = window.getComputedStyle(element);
        const needsVerticalScroll = element.scrollHeight > element.clientHeight;
        const needsHorizontalScroll = element.scrollWidth > element.clientWidth;
        const verticalScrollable = style.overflowY === "auto" || style.overflowY === "scroll";
        const horizontalScrollable = style.overflowX === "auto" || style.overflowX === "scroll";
        return needsVerticalScroll && !verticalScrollable ||
          needsHorizontalScroll && !horizontalScrollable
          ? [element.getAttribute("data-testid") ?? element.className]
          : [];
      }));
    expect(overflowViolations).toEqual([]);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("every phase preset fits 1920x1080 with no empty placeholder", async () => {
  const template = await createWorkspaceProject({ proposal: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.setViewportSize({ width: 1920, height: 1080 });
    for (const phase of ["ingest", "cut", "polish", "review", "publish"]) {
      await launched.page.getByTestId(`phase-tab-${phase}`).click();
      await launched.page.getByTestId("reset-layout").click();

      const measurements = await launched.page.getByTestId("workspace-layout")
        .evaluate((workspace) => {
          const bounds = workspace.getBoundingClientRect();
          return {
            documentHeight: document.documentElement.scrollHeight,
            documentWidth: document.documentElement.scrollWidth,
            workspaceHeight: workspace.clientHeight,
            workspaceScrollHeight: workspace.scrollHeight,
            workspaceScrollWidth: workspace.scrollWidth,
            workspaceWidth: workspace.clientWidth,
            workspaceBottom: bounds.bottom,
            workspaceRight: bounds.right,
            workspaceTop: bounds.top,
          };
        });
      expect(measurements).toMatchObject({
        documentHeight: 1080,
        documentWidth: 1920,
        workspaceScrollHeight: measurements.workspaceHeight,
        workspaceScrollWidth: measurements.workspaceWidth,
        workspaceBottom: 1054,
        workspaceRight: 1920,
      });
      await expect(launched.page.locator(".empty-dock-target, .pending-split")).toHaveCount(0);

      const groupBounds = await launched.page.getByTestId("dock-group")
        .evaluateAll((groups) => groups.map((group) => {
          const bounds = group.getBoundingClientRect();
          return { bottom: bounds.bottom, height: bounds.height, left: bounds.left,
            right: bounds.right, top: bounds.top, width: bounds.width };
        }));
      expect(groupBounds).not.toHaveLength(0);
      for (const bounds of groupBounds) {
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.top).toBeGreaterThanOrEqual(measurements.workspaceTop);
        expect(bounds.right).toBeLessThanOrEqual(1920);
        expect(bounds.bottom).toBeLessThanOrEqual(1054);
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.height).toBeGreaterThan(0);
      }
    }
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});
