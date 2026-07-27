import { rm } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { launchApp } from "./helpers/launch-app.js";
import { createWorkspaceProject } from "./helpers/workspace-project.js";

test("persists splitter resize, collapse, and docked tabs across an app relaunch", async () => {
  const template = await createWorkspaceProject({ proposal: true });
  const first = await launchApp({ projectTemplate: template });
  let second: Awaited<ReturnType<typeof launchApp>> | null = null;
  try {
    const splitter = first.page.getByTestId("splitter-left");
    const before = Number(await splitter.getAttribute("data-splitter-value"));
    const box = await splitter.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) throw new Error("Left splitter did not have a bounding box.");
    await first.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await first.page.mouse.down();
    await first.page.mouse.move(box.x + box.width / 2 + 64, box.y + box.height / 2);
    await first.page.mouse.up();
    const resized = Number(await splitter.getAttribute("data-splitter-value"));
    expect(resized).toBeGreaterThan(before);

    await first.page.getByTestId("tool-rail-entry-media").click();
    await first.page.getByTestId("media-panel-toggle").click();
    await expect(first.page.getByTestId("tool-rail-entry-media"))
      .toHaveAttribute("data-state", "collapsed");

    await first.page.getByTestId("transcript-panel-drag-handle")
      .dragTo(first.page.getByTestId("dock-region-right-top"));
    await expect(first.page.getByTestId("dock-tabs-right-top")).toBeVisible();
    await expect(first.page.getByTestId("dock-tab-agent")).toBeVisible();
    await expect(first.page.getByTestId("dock-tab-transcript")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await first.page.getByTestId("dock-tab-transcript")
      .dragTo(first.page.getByTestId("dock-tab-agent"));
    await expect(first.page.getByTestId("dock-tabs-right-top").getByRole("tab"))
      .toHaveText(["TTranscript", "AAgent"]);

    await first.electronApp.close();
    if (first.projectPath === undefined) throw new Error("Relaunch fixture path was missing.");
    second = await launchApp({
      projectPath: first.projectPath,
      userDataDirectory: first.userDataDirectory,
    });

    await expect(second.page.getByTestId("splitter-left"))
      .toHaveAttribute("data-splitter-value", String(resized));
    await expect(second.page.getByTestId("tool-rail-entry-media"))
      .toHaveAttribute("data-state", "collapsed");
    await expect(second.page.getByTestId("dock-tab-transcript")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(second.page.getByTestId("dock-tabs-right-top").getByRole("tab"))
      .toHaveText(["TTranscript", "AAgent"]);

    await second.page.getByTestId("tool-rail-entry-media").click();
    await expect(second.page.getByTestId("media-panel")).toBeVisible();
  } finally {
    await first.electronApp.close().catch(() => undefined);
    await second?.electronApp.close().catch(() => undefined);
    await rm(template, { recursive: true, force: true });
  }
});

test("reset layout restores the section 10.1 regions and splitter defaults", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("transcript-panel-drag-handle")
      .dragTo(launched.page.getByTestId("dock-region-right-top"));
    await launched.page.getByTestId("splitter-left").focus();
    await launched.page.keyboard.press("End");
    await launched.page.getByTestId("tool-rail-entry-media").click();

    await launched.page.getByTestId("reset-layout").click();

    await expect(launched.page.getByTestId("dock-region-center-bottom"))
      .toHaveAttribute("data-active-panel", "transcript");
    await expect(launched.page.getByTestId("dock-region-right-top")
      .getByTestId("dock-tab-transcript")).toHaveCount(0);
    await expect(launched.page.getByTestId("dock-region-right-top"))
      .toHaveAttribute("data-active-panel", "agent");
    await expect(launched.page.getByTestId("splitter-left"))
      .toHaveAttribute("data-splitter-value", "250");
    await expect(launched.page.getByTestId("tool-rail-entry-media"))
      .toHaveAttribute("data-state", "in-another-tab-only");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("docking regions show a structured resting frame", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const appearance = await launched.page
      .getByTestId("dock-region-center-top")
      .evaluate((element) => {
        const style = window.getComputedStyle(element);
        const frameStyle = window.getComputedStyle(element, "::before");
        return {
          borderTopColor: style.borderTopColor,
          borderTopStyle: style.borderTopStyle,
          borderTopWidth: style.borderTopWidth,
          frame: {
            boxShadow: frameStyle.boxShadow,
            content: frameStyle.content,
            pointerEvents: frameStyle.pointerEvents,
            position: frameStyle.position,
            zIndex: frameStyle.zIndex,
          },
        };
      });

    expect(appearance).toMatchObject({
      borderTopColor: "rgb(85, 99, 107)",
      borderTopStyle: "solid",
      borderTopWidth: "1px",
      frame: {
        content: "\"\"",
        pointerEvents: "none",
        position: "absolute",
        zIndex: "4",
      },
    });
    expect(appearance.frame.boxShadow).not.toBe("none");
    expect(appearance.frame.boxShadow).toContain("inset");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("resting dock highlight paints above opaque panel content", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const region = launched.page.getByTestId("dock-region-center-top");
    const bounds = await region.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds === null) throw new Error("Center-top dock region had no layout box.");
    const clip = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: 3,
    };

    const withHighlight = await launched.page.screenshot({
      animations: "disabled",
      clip,
    });
    await launched.page.addStyleTag({
      content: `
        .dock-region { box-shadow: none !important; }
        .dock-region::before { box-shadow: none !important; }
      `,
    });
    const withoutHighlight = await launched.page.screenshot({
      animations: "disabled",
      clip,
    });

    expect(withHighlight.equals(withoutHighlight)).toBe(false);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("vacant docking regions show a checkerboard only while empty", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const region = launched.page.getByTestId("dock-region-center-top");
    await expect(region.locator(".empty-dock-target")).toHaveCount(0);

    await launched.page.getByTestId("tool-rail-entry-preview").click();
    const target = region.locator(".empty-dock-target");
    await expect(target).toBeVisible();
    await expect(target).toContainText("Drop a panel here");

    const appearance = await target.evaluate((element) => {
      const style = window.getComputedStyle(element);
      const prompt = element.querySelector("span");
      if (prompt === null) throw new Error("Empty dock prompt is missing.");
      const promptStyle = window.getComputedStyle(prompt);
      return {
        backgroundLayers: style.backgroundImage.match(/linear-gradient/gmu)?.length ?? 0,
        backgroundSizes: style.backgroundSize.split(",").map((value) => value.trim()),
        borderTopStyle: style.borderTopStyle,
        promptBackgroundColor: promptStyle.backgroundColor,
        promptBorderTopStyle: promptStyle.borderTopStyle,
      };
    });

    expect(appearance).toMatchObject({
      backgroundLayers: 4,
      borderTopStyle: "none",
      promptBorderTopStyle: "solid",
    });
    expect(appearance.backgroundSizes).not.toHaveLength(0);
    expect(appearance.backgroundSizes.every((size) => size === "16px 16px")).toBe(true);
    expect(appearance.promptBackgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    await launched.page.getByTestId("tool-rail-entry-preview").click();
    await expect(region.locator(".empty-dock-target")).toHaveCount(0);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("drag-over emphasis remains stronger than the resting frame", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const region = launched.page.getByTestId("dock-region-center-top");

    await launched.page.getByTestId("preview-panel-toggle").focus();
    await expect.poll(() => region.evaluate(
      (element) => window.getComputedStyle(element, "::before").boxShadow,
    )).toContain("rgb(114, 84, 39)");

    await region.dispatchEvent("dragenter");
    await expect(region).toHaveAttribute("data-drop-active", "true");
    await expect.poll(() => region.evaluate(
      (element) => window.getComputedStyle(element, "::before").boxShadow,
    )).toContain("rgb(242, 184, 75)");
    await expect.poll(() => region.evaluate(
      (element) => window.getComputedStyle(element, "::after").content,
    )).toBe("\"Dock here\"");

    await region.dispatchEvent("dragleave");
    await expect(region).toHaveAttribute("data-drop-active", "false");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("the master rail toggles, flashes, reports three states, and collapses sequentially", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const rail = launched.page.getByTestId("master-tool-rail");
    await expect(rail).toBeVisible();
    await expect(launched.page.getByTestId("tool-rail-entry-preview"))
      .toHaveAttribute("data-state", "expanded-here");
    await expect(launched.page.getByTestId("tool-rail-entry-help"))
      .toHaveAttribute("data-state", "collapsed");
    const media = launched.page.getByTestId("tool-rail-entry-media");
    await expect(media).toHaveAttribute("data-state", "in-another-tab-only");

    await media.focus();
    await launched.page.keyboard.press("ArrowDown");
    await expect(launched.page.getByTestId("tool-rail-entry-broll")).toBeFocused();
    await launched.page.keyboard.press("ArrowUp");
    await expect(media).toBeFocused();
    await launched.page.keyboard.press("Enter");
    await expect(media).toHaveAttribute("data-state", "expanded-here");
    await expect(launched.page.getByTestId("media-panel")).toHaveClass(/panel-flash/u);

    for (const panel of ["media", "transcript", "agent", "timeline"]) {
      await launched.page.getByTestId(`tool-rail-entry-${panel}`).click();
      await expect(launched.page.getByTestId(`${panel}-panel`)).toHaveCount(0);
    }
    await expect(launched.page.getByTestId("preview-panel")).toBeVisible();
    await expect(launched.page.locator(".dock-icon-rail, .collapsed-bottom-bar"))
      .toHaveCount(0);
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});

test("agent and inspector content scroll internally at their minimum layout size", async () => {
  const template = await createWorkspaceProject({ proposal: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    await launched.page.getByTestId("tool-rail-entry-inspector").click();
    await launched.page.getByTestId("timeline-clip-clp_aaaaaaaaaa").click();
    for (const splitterId of ["splitter-timeline", "splitter-status"]) {
      await launched.page.getByTestId(splitterId).focus();
      await launched.page.keyboard.press("End");
    }

    for (const panelId of ["agent", "inspector"]) {
      const scroll = launched.page.getByTestId(`${panelId}-panel-scroll`);
      await expect(scroll).toBeVisible();
      const dimensions = await scroll.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
      await scroll.evaluate((element) => {
        element.scrollTop = 48;
      });
      await expect.poll(() => scroll.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    }

    const overflowViolations = await launched.page.locator("[data-testid$='-panel-scroll']")
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

test("every phase layout fits a 1920x1080 viewport without outer clipping", async () => {
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
            viewportHeight: window.innerHeight,
            viewportWidth: window.innerWidth,
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
        viewportHeight: 1080,
        viewportWidth: 1920,
        workspaceScrollHeight: measurements.workspaceHeight,
        workspaceScrollWidth: measurements.workspaceWidth,
        workspaceBottom: 1054,
        workspaceRight: 1920,
      });
      const railBounds = await launched.page.getByTestId("master-tool-rail").boundingBox();
      expect(railBounds).not.toBeNull();
      if (railBounds === null) throw new Error("Master tool rail had no layout box.");
      expect(railBounds.x).toBe(0);
      expect(railBounds.width).toBeGreaterThan(0);

      const regionBounds = await launched.page.locator("[data-testid^='dock-region-']")
        .evaluateAll((regions) => regions.map((region) => {
          const bounds = region.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        }));
      expect(regionBounds).not.toHaveLength(0);
      for (const bounds of regionBounds) {
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
