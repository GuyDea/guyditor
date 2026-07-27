# Panel Boundaries and Empty Dock State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every docking region a crisp resting frame and show a low-contrast alpha-style checkerboard only while that region is vacant.

**Architecture:** Keep the existing `DockRegion` state and markup unchanged. Lock the visual behavior with Electron tests against computed browser styles, then implement the approved structured frame and checkerboard entirely in the renderer stylesheet so docking, persistence, and autosave remain untouched.

**Tech Stack:** React 18, TypeScript, CSS, Electron, Playwright, Vitest, pnpm

---

## File map

- `packages/app/e2e/panel-management.spec.ts` — adds browser-level visual contracts
  for resting region frames, vacant checkerboards, prompt readability, and the
  existing amber drag-over override.
- `packages/app/src/renderer/styles.css` — owns the dock-region frame and vacant
  target presentation. No renderer component or state file changes.
- `docs/superpowers/specs/2026-07-27-panel-boundaries-empty-state-design.md` —
  approved behavior and acceptance criteria; read-only during implementation unless
  the accepted decision changes.
- `docs/steering/panel-boundaries-empty-state.md` — accepted architectural boundary;
  read-only during implementation unless the decision changes.

### Task 1: Establish the browser-level visual contract

**Files:**

- Modify: `packages/app/e2e/panel-management.spec.ts:68-104`
- Test: `packages/app/e2e/panel-management.spec.ts`

- [ ] **Step 1: Add a passing characterization test for the existing amber drag-over state**

Insert this test after the existing “reset layout restores…” test:

```typescript
test("drag-over emphasis remains stronger than the resting frame", async () => {
  const template = await createWorkspaceProject();
  const launched = await launchApp({ projectTemplate: template });
  try {
    const region = launched.page.getByTestId("dock-region-center-top");

    await region.dispatchEvent("dragenter");
    await expect(region).toHaveAttribute("data-drop-active", "true");
    await expect.poll(() => region.evaluate(
      (element) => window.getComputedStyle(element).boxShadow,
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
```

- [ ] **Step 2: Build and run the characterization test before changing styles**

Run:

```bash
pnpm --filter @guyditor/app build
pnpm --filter @guyditor/app exec playwright test --config playwright.config.ts panel-management.spec.ts --grep "drag-over emphasis"
```

Expected: PASS, proving the legacy amber shadow on the parent `.dock-region` and
the “Dock here” overlay are covered before any style changes.

- [ ] **Step 3: Add one failing test for the structured resting frame**

Insert this test immediately before the drag-over characterization:

```typescript
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
          frameBoxShadow: frameStyle.boxShadow,
        };
      });

    expect(appearance).toMatchObject({
      borderTopColor: "rgb(85, 99, 107)",
      borderTopStyle: "solid",
      borderTopWidth: "1px",
    });
    expect(appearance.frameBoxShadow).not.toBe("none");
    expect(appearance.frameBoxShadow).toContain("inset");
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Add one failing test for the empty-only checkerboard**

Insert this test between the resting-frame test and the drag-over characterization:

```typescript
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
```

- [ ] **Step 5: Run both new tests and verify the expected failures**

Run:

```bash
pnpm --filter @guyditor/app build
pnpm --filter @guyditor/app exec playwright test --config playwright.config.ts panel-management.spec.ts --grep "structured resting frame|checkerboard only"
```

Expected: FAIL for the new behavior. The frame test reports the current
`borderTopWidth` as `0px` instead of `1px` and the foreground pseudo shadow as
`none`; the vacant-state test reports zero gradient layers instead of four. If
either test errors for fixture or selector reasons, correct the test and rerun
until it fails only because the approved visual behavior is absent.

### Task 2: Implement the structured frame and vacant checkerboard

**Files:**

- Modify: `packages/app/src/renderer/styles.css:471-566`
- Test: `packages/app/e2e/panel-management.spec.ts`

> **Implementation correction (2026-07-27):** The original plan placed the inset
> highlight on `.dock-region`, where opaque panel descendants occluded it. The
> corrected implementation paints frame, focus, and drag shadows on a foreground
> `::before` layer. A browser regression compares the top three rendered pixels
> before and after disabling that layer, proving actual paint rather than only a
> computed declaration.

- [ ] **Step 1: Add the neutral resting frame as a foreground layer**

Use `.dock-region::before` for the frame and its focus/drag precedence:

```css
.dock-region {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--line-hot);
  background: var(--panel);
  transition: background 90ms ease-out;
}
.dock-region::before {
  content: "";
  position: absolute;
  z-index: 4;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 1px rgb(232 236 234 / 6%);
  transition: box-shadow 90ms ease-out;
}
.dock-region:focus-within::before {
  box-shadow: inset 0 0 0 1px var(--amber-dim);
}
.dock-region[data-drop-active="true"] {
  z-index: 3;
  background: #202b30;
}
.dock-region[data-drop-active="true"]::before {
  box-shadow: inset 0 0 0 2px var(--amber), inset 0 0 34px rgb(242 184 75 / 10%);
}
```

After migrating the shadows, update the Task 1, Step 1 drag characterization so
its final assertion follows the foreground layer:

```typescript
await expect.poll(() => region.evaluate(
  (element) => window.getComputedStyle(element, "::before").boxShadow,
)).toContain("rgb(242, 184, 75)");
```

The parent-shadow lookup is only the pre-style characterization and must not remain
in the final test.

The existing `.dock-region[data-drop-active="true"]::after` drag label remains at
`z-index: 5`, above the frame at `z-index: 4`. The actual-pixel regression samples
an occupied region only after asserting that neither `:focus-within` nor
`[data-drop-active="true"]` applies.

- [ ] **Step 2: Replace the vacant target treatment and style its prompt**

Replace the existing `.empty-dock-target` rule and add the direct-child prompt rule:

```css
.empty-dock-target {
  width: 100%;
  height: 100%;
  min-height: 48px;
  display: grid;
  place-items: center;
  border: 0;
  color: var(--muted);
  background-color: #11191e;
  background-image:
    linear-gradient(45deg, #1d282e 25%, transparent 25%),
    linear-gradient(-45deg, #1d282e 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #1d282e 75%),
    linear-gradient(-45deg, transparent 75%, #1d282e 75%);
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-size: 16px 16px;
  font: 600 var(--fs-body)/1 ui-monospace, monospace;
  text-transform: uppercase;
}
.empty-dock-target > span {
  padding: 5px 8px;
  border: 1px solid var(--line-hot);
  border-radius: 3px;
  background: rgb(13 20 24 / 86%);
  box-shadow: 0 2px 10px rgb(0 0 0 / 22%);
}
```

- [ ] **Step 3: Rebuild and run the four focused visual tests**

Run:

```bash
pnpm --filter @guyditor/app build
pnpm --filter @guyditor/app exec playwright test --config playwright.config.ts panel-management.spec.ts --grep "structured resting frame|paints above opaque panel content|checkerboard only|drag-over emphasis"
```

Expected: PASS for all four tests. The computed resting frame is one-pixel solid
`--line-hot`, its top highlight changes rendered pixels above opaque content, the
empty target has four 16-pixel gradient layers and a bordered prompt, and
drag-over still exposes the amber shadow and overlay.

- [ ] **Step 4: Run the complete panel-management regression file**

Run:

```bash
pnpm --filter @guyditor/app exec playwright test --config playwright.config.ts panel-management.spec.ts
```

Expected: all panel-management tests PASS, including splitter persistence, docking,
collapse/expand behavior, internal scrolling, and viewport-fit coverage.

- [ ] **Step 5: Inspect and commit the cohesive implementation checkpoint**

Run:

```bash
git diff --check
git diff -- packages/app/e2e/panel-management.spec.ts packages/app/src/renderer/styles.css
git status --short
git add -- packages/app/e2e/panel-management.spec.ts packages/app/src/renderer/styles.css
git diff --cached --check
git diff --cached
git commit -m "feat(app): clarify dock panel boundaries"
```

Expected: only the two task-owned app files are staged; `.superpowers/` remains
untracked and absent from the commit.

### Task 3: Run the completion gate

**Files:**

- Verify: `packages/app/e2e/panel-management.spec.ts`
- Verify: `packages/app/src/renderer/styles.css`
- Verify: `docs/superpowers/specs/2026-07-27-panel-boundaries-empty-state-design.md`
- Verify: `docs/steering/panel-boundaries-empty-state.md`

- [ ] **Step 1: Run all workspace typechecks, linters, and unit tests**

Run:

```bash
pnpm test
```

Expected: every workspace typecheck and lint command passes, followed by a green
Vitest run.

- [ ] **Step 2: Run repository convention checks**

Run:

```bash
pnpm check:conventions
```

Expected: PASS with no convention violations.

- [ ] **Step 3: Build the Electron application from the final source**

Run:

```bash
pnpm build:app
```

Expected: electron-vite completes the main, preload, and renderer production builds
without errors.

- [ ] **Step 4: Run the complete packaged Electron suite**

Run:

```bash
pnpm test:e2e
```

Expected: the build and every Electron Playwright test pass, including the new
panel-boundary visual contracts.

- [ ] **Step 5: Verify final ownership and history**

Run:

```bash
git diff --check
git status --short --branch
git log -3 --oneline --decorate
```

Expected: product and test changes are committed on
`feat/panel-boundaries-empty-state`; only the temporary `.superpowers/` visual
session may remain untracked. The branch contains the documentation decision commit
and the cohesive app implementation commit.
