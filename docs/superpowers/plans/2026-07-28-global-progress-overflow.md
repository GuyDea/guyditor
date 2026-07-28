# Global Progress Overflow Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every visible child of the fixed-height “Project activity” control inside its border at normal and compact supported widths.

**Architecture:** Preserve the existing React markup and state flow. Replace CSS Grid auto-placement with named areas for copy, badge, and track, then protect the actual rendered geometry with an Electron test.

**Tech Stack:** React, CSS Grid, TypeScript, Electron, Playwright

---

### Task 1: Reproduce and fix the activity-control overflow

**Files:**

- Modify: `packages/app/e2e/workspace.spec.ts:45-60`
- Modify: `packages/app/src/renderer/styles.css:100-119`

- [ ] **Step 1: Add the failing rendered-geometry regression**

Insert this test immediately before
`shows a ready proposal as waiting on the creator and jumps to review` in
`packages/app/e2e/workspace.spec.ts`:

```typescript
test("keeps all project activity content inside its control", async () => {
  const template = await createWorkspaceProject({ proposal: true });
  const launched = await launchApp({ projectTemplate: template });
  try {
    const control = launched.page.getByTestId("global-progress");
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 900, height: 800 },
    ]) {
      await launched.page.setViewportSize(viewport);
      await expect(control).toBeVisible();

      const geometry = await control.evaluate((element) => {
        const controlBounds = element.getBoundingClientRect();
        const visibleChildren = Array.from(element.children)
          .filter((child): child is HTMLElement =>
            child instanceof HTMLElement &&
            window.getComputedStyle(child).display !== "none")
          .map((child) => {
            const bounds = child.getBoundingClientRect();
            return {
              bottom: bounds.bottom,
              label: child.className,
              left: bounds.left,
              right: bounds.right,
              top: bounds.top,
            };
          });
        return {
          clientHeight: element.clientHeight,
          control: {
            bottom: controlBounds.bottom,
            left: controlBounds.left,
            right: controlBounds.right,
            top: controlBounds.top,
          },
          gridTemplateAreas: window.getComputedStyle(element).gridTemplateAreas,
          scrollHeight: element.scrollHeight,
          visibleChildren,
        };
      });

      expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
      for (const child of geometry.visibleChildren) {
        expect(child.left, `${child.label} left at ${String(viewport.width)}px`)
          .toBeGreaterThanOrEqual(geometry.control.left);
        expect(child.right, `${child.label} right at ${String(viewport.width)}px`)
          .toBeLessThanOrEqual(geometry.control.right);
        expect(child.top, `${child.label} top at ${String(viewport.width)}px`)
          .toBeGreaterThanOrEqual(geometry.control.top);
        expect(child.bottom, `${child.label} bottom at ${String(viewport.width)}px`)
          .toBeLessThanOrEqual(geometry.control.bottom);
      }
      expect(geometry.gridTemplateAreas).toBe("\"copy badge\" \"track track\"");
    }
  } finally {
    await launched.electronApp.close();
    await rm(template, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Build and run the new test to verify RED**

Run:

```bash
pnpm --filter @guyditor/app build
DISPLAY=:0 pnpm --filter @guyditor/app exec playwright test --config playwright.config.ts workspace.spec.ts --grep "keeps all project activity content"
```

Expected: FAIL because the waiting badge extends below the button and the computed
grid has no named areas. Confirm the failure is a containment or grid-area
assertion, not an Electron launch, fixture, or selector error.

- [ ] **Step 3: Replace auto-placement with explicit grid areas**

Update the existing `.global-progress` declaration in
`packages/app/src/renderer/styles.css`:

```css
.global-progress {
  width: 260px;
  height: 40px;
  display: grid;
  grid-template-areas:
    "copy badge"
    "track track";
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: auto 4px;
  gap: 4px 8px;
  padding: 5px 7px;
  border-color: #3a474e;
  text-align: left;
  background: #10171b;
}
```

Assign each existing child to its area and remove the track’s redundant
`grid-column` placement:

```css
.global-progress-copy {
  grid-area: copy;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.global-progress-track {
  grid-area: track;
  position: relative;
  height: 4px;
  overflow: hidden;
  border-radius: 1px;
  background: repeating-linear-gradient(90deg, #29343a 0 11px, #11181c 11px 13px);
}
.global-waiting-badge {
  grid-area: badge;
  flex: none;
  align-self: center;
  padding: 2px 5px;
  border: 1px solid #3b464c;
  border-radius: 999px;
  color: var(--dim);
  font: 650 var(--fs-label)/1 ui-monospace, monospace;
  text-transform: uppercase;
}
```

Do not add `overflow: hidden`, change the 40-pixel height, reorder the DOM, or
change responsive media rules.

- [ ] **Step 4: Rebuild and verify GREEN**

Run:

```bash
pnpm --filter @guyditor/app build
DISPLAY=:0 pnpm --filter @guyditor/app exec playwright test --config playwright.config.ts workspace.spec.ts --grep "keeps all project activity content"
```

Expected: PASS at both 1920px and 900px. The button has named two-row areas,
`scrollHeight <= clientHeight`, and all visible child rectangles are contained by
the button rectangle.

- [ ] **Step 5: Run the surrounding activity-control regressions**

Run:

```bash
DISPLAY=:0 pnpm --filter @guyditor/app exec playwright test --config playwright.config.ts workspace.spec.ts --grep "imports media and surfaces completed proxy work|shows a ready proposal as waiting on the creator and jumps to review|cancels queued work from the global progress popover"
DISPLAY=:0 pnpm --filter @guyditor/app exec playwright test --config playwright.config.ts onboarding.spec.ts --grep "tour introduces the phase strip, master rail, progress, and first panel"
pnpm --filter @guyditor/app typecheck
pnpm --filter @guyditor/app lint
```

Expected: all selected Electron tests pass; app typecheck and lint exit zero.

- [ ] **Step 6: Inspect and commit the cohesive fix**

Run:

```bash
git diff --check
git diff -- packages/app/e2e/workspace.spec.ts packages/app/src/renderer/styles.css
git status --short
git add -- packages/app/e2e/workspace.spec.ts packages/app/src/renderer/styles.css
git diff --cached --check
git diff --cached -- packages/app/e2e/workspace.spec.ts packages/app/src/renderer/styles.css
git commit -m "fix(app): contain global project progress"
```

Expected: the commit contains only the Electron regression and explicit CSS grid
placement.

### Task 2: Complete branch verification

**Files:**

- Verify: `packages/app/e2e/workspace.spec.ts`
- Verify: `packages/app/src/renderer/styles.css`
- Verify: `docs/steering/global-progress-overflow.md`
- Verify: `docs/superpowers/specs/2026-07-28-global-progress-overflow-design.md`
- Verify: `docs/superpowers/plans/2026-07-28-global-progress-overflow.md`

- [ ] **Step 1: Run repository conventions and complete tests**

Run:

```bash
pnpm check:conventions
pnpm test
pnpm build:app
DISPLAY=:0 pnpm test:e2e
```

Expected: conventions, workspace typechecks/lints, unit/golden tests, production
build, and all Electron tests pass. If sandbox restrictions hide FFmpeg, deny
loopback sockets, or block Electron startup, rerun the unchanged command with the
required process permissions rather than changing code.

- [ ] **Step 2: Verify final scope and history**

Run:

```bash
git diff --check main..HEAD
git status --short --branch
git log --oneline --decorate main..HEAD
git diff --stat main..HEAD
```

Expected: the worktree is clean; the branch contains the accepted documentation
checkpoint and cohesive implementation checkpoint; only the five task-owned
documentation, test, and stylesheet files differ from `main`.

- [ ] **Step 3: Request independent review**

Request specification-compliance and code-quality review of `main..HEAD`.
Reviewers must inspect the overflow root cause, the normal/compact geometry test,
the explicit grid-area implementation, responsive rules, and accidental scope.
Resolve every Critical, Important, or Minor finding before presenting branch
integration options.
