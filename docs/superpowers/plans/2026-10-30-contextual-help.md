# Contextual Help Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A title-bar toggle puts Guyditor into help mode, where clicking any panel, section, phase tab, rail entry, dock tab or the progress button opens a centred popup explaining what it is good for and how to use it, and nothing else in the app reacts.

**Architecture:** Help texts live in `docs/HELP.md`, bundled raw into the renderer and parsed into entries keyed by help key. A small zustand store holds help-mode state; one capture-phase event gate installed on `window` intercepts clicks, pointer presses, keys and drag/drop while help mode is on, resolves the innermost `[data-help]` element and opens the popup. Elements opt in with a `data-help="<key>"` attribute; the toggle and popup opt out of the gate with `data-help-allow`.

**Tech Stack:** React 19, zustand 5, TypeScript, Vite `?raw` imports, vitest (`--project unit`, node environment, no DOM), Playwright e2e on Electron.

**Spec:** `docs/superpowers/specs/2026-10-30-contextual-help-design.md`

## Global Constraints

- Help mode is a toggle; while on, clicks explain things instead of doing them; nothing navigates (phase tabs, tool-rail entries, dock tabs explain themselves; a collapsed section's header explains instead of expanding).
- Keyboard shortcuts, typing and drag-and-drop are blocked in help mode except `Esc` and `Shift+F1`. `Esc` closes an open popup; `Esc` with no popup leaves help mode. Help mode is not remembered across restarts.
- The toggle, the popup itself and the title-bar Help button (`data-testid="title-help"`) keep working in help mode.
- Popup: centred modal over a dimmed app; title; a "where" line; **What it's good for** (paragraph) and **How to use it** (numbered list); optional **Open in manual**; **Close**. Closing keeps help mode on.
- Granularity: panels and sections with a fixed header only — never individual buttons, badges or fields.
- Text rules (spec "The texts"): plain words, every term defined; written for someone editing a vlog from phone or OBS footage; "How to use it" is 2–5 steps ending with what you'll see when it works, and when you don't need it; true to the code (read the code, not only the manual; where they disagree, follow the code and record the discrepancy in the task report); short enough to fit the popup without scrolling.
- Help keys: `panel.<DockPanelId>`, `phase.<WorkflowPhase>`, `chrome.tool-rail`, `chrome.global-progress`, `section.<DockPanelId>.<kebab-header-text>`.
- New help-mode CSS goes in a new file `packages/app/src/renderer/help/help-mode.css`; `styles.css` is at 101,953 bytes against the 100 KiB per-file cap (`pnpm check:conventions`).
- Relative cross-package imports with `.js` extensions; renderer unit tests run in node with no DOM, so DOM behaviour is tested through pure functions plus the e2e spec.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A text field already has focus when help mode turns on** → typing must not reach it. Pinned in Task 2 (`helpKeyDecision` blocks printable keys and Backspace).
2. **Clicking a `<summary>` in help mode** → the `<details>` must not open or close. Pinned in Task 7's e2e (Capture watcher stays collapsed/expanded as it was).
3. **Dragging files from the desktop onto the Media panel in help mode** → no import starts. Pinned in Task 2 (`helpDragDecision` refuses `dragover`/`drop`/`dragstart`).
4. **A help key with no entry at runtime** → the popup shows a clear "No help text yet" message with the key, not a crash or an empty box. Pinned in Task 3.
5. **`Esc` pressed while the popup is open** → only the popup closes; help mode stays on; a second `Esc` leaves help mode. Pinned in Task 2 (`helpKeyDecision`) and Task 7 (e2e).

## File Structure

- `docs/HELP.md` — every help text (Tasks 1, 4, 5, 6).
- `packages/app/src/renderer/help/help-texts.ts` — `HelpEntry` type, `parseHelp`, key helpers. `help-texts.test.ts`.
- `packages/app/src/renderer/help/help-source.ts` — `HELP_SOURCE` (raw import of `docs/HELP.md`) and `HELP_ENTRIES` (parsed once).
- `packages/app/src/renderer/help/help-mode.ts` — zustand store `useHelpMode`.
- `packages/app/src/renderer/help/help-gate.ts` — pure decisions (`helpTargetFor`, `helpKeyDecision`, `helpDragDecision`) and `installHelpGate(target: Window)`. `help-gate.test.ts`.
- `packages/app/src/renderer/help/HelpModeToggle.tsx`, `HelpModeBanner.tsx`, `HelpPopup.tsx` (+ `HelpPopup.test.ts`), `help-mode.css`.
- Modified: `App.tsx` (mount toggle, banner, popup, gate), `panels/Panel.tsx`, `DockWorkspace.tsx`, `MasterToolRail.tsx`, `WorkflowPhaseTabs.tsx`, `GlobalProgress.tsx`, `manual.tsx` (export `InlineMarkdown`), `panels/HelpPanel.tsx` (manual jump + keyboard map), the panels that own sections.
- `packages/app/src/renderer/help/help-coverage.test.ts` — source scan + key/entry cross-check (Task 7).
- `packages/app/e2e/help-mode.spec.ts` (Task 7). Docs: `docs/MANUAL.md`, `docs/amendments/010-contextual-help.md`, `docs/traceability.md` (Task 7).

---

### Task 1: Help text format and parser

**Files:**
- Create: `docs/HELP.md`, `packages/app/src/renderer/help/help-texts.ts`, `packages/app/src/renderer/help/help-source.ts`
- Test: `packages/app/src/renderer/help/help-texts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HelpEntry { key: string; title: string; where: string; goodFor: string; howTo: string[]; manual?: string }
  export function parseHelp(source: string): Map<string, HelpEntry>   // throws Error(`HELP.md entry ${key}: ${problem}`)
  export function panelHelpKey(id: DockPanelId): string               // "panel.media"
  export function phaseHelpKey(phase: WorkflowPhase): string          // "phase.ingest"
  export function sectionHelpKey(panel: DockPanelId, header: string): string // ("media","Capture watcher") → "section.media.capture-watcher"
  export const HELP_SOURCE: string;                                   // help-source.ts
  export const HELP_ENTRIES: ReadonlyMap<string, HelpEntry>;          // help-source.ts
  ```

**Format of `docs/HELP.md`** (a short preamble before the first entry is allowed and ignored):

```markdown
## section.media.capture-watcher
Title: Capture watcher
Where: Media panel
Manual: 3. Ingest tab — get material in

### What it's good for
Paragraph text (one or more lines, joined with spaces). Inline `code` and **bold** allowed.

### How to use it
1. First step.
2. Second step.
```

`Manual:` is optional and must equal a `## ` heading of `docs/MANUAL.md` exactly (as produced by `parseManual`). Keys match `/^(panel|phase|chrome|section)\.[a-z0-9-]+(\.[a-z0-9-]+)?$/u`. Unknown `Field:` lines, a missing Title/Where, a missing or empty part, a duplicate key, or text outside the two parts are errors.

- [ ] **Step 1: Write the failing tests** in `help-texts.test.ts`:
  - `parses an entry into title, where, good-for paragraph, steps and manual link` — a two-entry fixture string; assert `parseHelp(src).get("section.media.capture-watcher")` equals the full `HelpEntry` with `howTo` length 2 and `manual` set, and the second entry has `manual === undefined`.
  - `rejects malformed entries with the key in the message` — `expect(() => parseHelp(x)).toThrow("HELP.md entry panel.media: …")` for each of: missing `### How to use it`, empty steps, unknown field `Colour:`, duplicate key, bad key `Panel.Media`.
  - `builds help keys` — `panelHelpKey("media") === "panel.media"`, `phaseHelpKey("cut") === "phase.cut"`, `sectionHelpKey("broll", "Rights indicators") === "section.broll.rights-indicators"`, `sectionHelpKey("status", "Derive a short") === "section.status.derive-a-short"`.
  - `the bundled HELP.md parses and every manual link names a manual heading` — `HELP_ENTRIES.size > 0`; for each entry with `manual`, `parseManual(MANUAL_SOURCE).sections.some(({ heading }) => heading === entry.manual)`.

- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/app/src/renderer/help/help-texts.test.ts` — expect FAIL (module missing).

- [ ] **Step 3: Implement** `parseHelp` and the key helpers in `help-texts.ts`, and `help-source.ts` following `manual-source.ts` (`import source from "../../../../../docs/HELP.md?raw"`). Seed `docs/HELP.md` with a one-paragraph preamble (what this file is, the format, "Martin reports unclear texts in chat; edit the entry and re-check the code") and two real entries that follow the text rules: `panel.media` and `section.media.capture-watcher` (start from the approved mockup text: "Imports new recordings by itself…"; verify against `packages/media/src/capture-watcher.ts` and `docs/capture-integration.md`).

- [ ] **Step 4: Run** the test file — expect PASS. Run `pnpm --filter @guyditor/app typecheck` and `lint` — clean.

- [ ] **Step 5: Commit** `feat(app): help text file and parser`.

### Task 2: Help mode state, event gate, toggle and banner

**Files:**
- Create: `help/help-mode.ts`, `help/help-gate.ts`, `help/HelpModeToggle.tsx`, `help/HelpModeBanner.tsx`, `help/help-mode.css`
- Modify: `App.tsx` (title bar next to `title-help`; mount banner; call `installHelpGate(window)` in an effect with cleanup), `panels/HelpPanel.tsx` (`KEYBOARD_MAP` gains `["Shift+F1", "Turn help mode on or off"]`)
- Test: `help/help-gate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // help-mode.ts
  interface HelpModeState { active: boolean; openKey: string | null; manualRequest: { heading: string; nonce: number } | null;
    toggle(): void; open(key: string): void; close(): void; exit(): void; requestManual(heading: string): void; consumeManualRequest(): void }
  export const useHelpMode: UseBoundStore<StoreApi<HelpModeState>>;   // exit() clears openKey too; toggle() off also clears openKey
  // help-gate.ts
  export interface ElementLike { closest(selector: string): ElementLike | null; getAttribute(name: string): string | null }
  export function helpTargetFor(target: ElementLike | null): { key: string } | "allow" | null
  export type HelpKeyDecision = "toggle" | "close-popup" | "exit" | "allow" | "block";
  export function helpKeyDecision(event: { key: string; shiftKey: boolean; inAllowedRegion: boolean }, state: { active: boolean; popupOpen: boolean }): HelpKeyDecision
  export function helpDragDecision(type: string, active: boolean): "refuse" | "pass"
  export function installHelpGate(target: Window): () => void           // returns uninstall
  ```
- `helpTargetFor`: if `target.closest("[data-help-allow]")` → `"allow"`; else `target.closest("[data-help]")` → `{ key }` from its attribute (innermost by construction of `closest`); else `null`.

- [ ] **Step 1: Write the failing tests** in `help-gate.test.ts` using plain fake `ElementLike` trees (a parent map and attribute map):
  - `resolves the innermost help target` — a summary inside a panel: `helpTargetFor(summary)` → `{ key: "section.media.capture-watcher" }`; a button in the panel body → `{ key: "panel.media" }`; an element outside any target → `null`; anything inside `[data-help-allow]` → `"allow"`.
  - `keys while help mode is off only toggle on Shift+F1` — `{key:"F1",shiftKey:true}` → `"toggle"`; `{key:"Escape"}` and `{key:"a"}` → `"allow"`.
  - `keys while help mode is on` — Shift+F1 → `"toggle"`; Escape with popup open → `"close-popup"`; Escape without popup → `"exit"`; `"a"`, `" "`, `"Backspace"`, `"z"` with ctrl, `"ArrowLeft"`, `"Enter"`, `"Tab"` → `"block"`; `"Tab"`/`"Enter"` with `inAllowedRegion: true` → `"allow"` (so the popup's buttons stay keyboard-usable).
  - `refuses drag and drop only in help mode` — `helpDragDecision("dragstart"|"dragover"|"drop", true)` → `"refuse"`; with `false` → `"pass"`.

- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/app/src/renderer/help/help-gate.test.ts` — expect FAIL.

- [ ] **Step 3: Implement** the store, the pure decisions and `installHelpGate`. `installHelpGate` adds **capture-phase** listeners on `window` for `keydown`, `pointerdown`, `mousedown`, `mouseup`, `click`, `dblclick`, `auxclick`, `contextmenu`, `dragstart`, `dragover`, `drop`, reading `useHelpMode.getState()`:
  - `keydown` is always observed (Shift+F1 must toggle help mode on); act on the decision: `toggle`/`close-popup`/`exit` call the store and `preventDefault()`+`stopPropagation()`; `block` does `preventDefault()`+`stopPropagation()`; `allow` does nothing.
  - pointer/mouse/click events only while active: `"allow"` → pass; otherwise `preventDefault()`+`stopPropagation()`, and on `click` with a `{ key }` call `open(key)`. (Preventing the click's default stops `<summary>` toggling; stopping propagation at the window capture phase keeps React and the app's window listeners from seeing it.)
  - drag events only while active: `refuse` → `preventDefault()`+`stopPropagation()`, and on `dragover` set `dataTransfer.dropEffect = "none"`.
  - While active, set `document.documentElement.dataset.helpMode = "on"` (remove when off) by subscribing to the store inside `installHelpGate`; the CSS keys off `:root[data-help-mode="on"]`.
  `HelpModeToggle` (`data-testid="help-mode-toggle"`, `data-help-allow`, `aria-pressed`, label "Help mode" when on, a glyph distinct from the existing "?" Help button) goes next to `title-help` in `App.tsx`; give the existing `title-help` button `data-help-allow` too. `HelpModeBanner` (`data-testid="help-mode-banner"`, `data-help-allow`) renders only while active with the copy `Help mode: click a panel or section to see what it does. Esc to leave.` `help-mode.css`: dashed outline on `:root[data-help-mode="on"] [data-help]`, highlight on `[data-help]:hover:not(:has([data-help]:hover))`, `cursor: help`; import it from `HelpModeToggle.tsx`.

- [ ] **Step 4: Run** the test file — PASS; `pnpm --filter @guyditor/app typecheck`, `lint`, `pnpm check:conventions` — clean.

- [ ] **Step 5: Commit** `feat(app): help mode toggle and event gate`.

### Task 3: Help popup and "Open in manual"

**Files:**
- Create: `help/HelpPopup.tsx`
- Modify: `App.tsx` (render `<HelpPopup />`), `manual.tsx` (export `InlineMarkdown`), `panels/HelpPanel.tsx` (consume `manualRequest`)
- Test: `help/HelpPopup.test.ts`

**Interfaces:**
- Consumes: `useHelpMode`, `HELP_ENTRIES`, `HelpEntry` (Tasks 1–2); `revealPanel` from `workspace-navigation.ts`.
- Produces: `export function HelpPopupView(props: { entry: HelpEntry | undefined; helpKey: string; onClose(): void; onOpenManual(heading: string): void }): React.JSX.Element` (pure, tested) and `export function HelpPopup(): React.JSX.Element | null` (store-connected; renders nothing while `openKey === null`).

- [ ] **Step 1: Write the failing tests** with `renderToStaticMarkup(HelpPopupView(...))`:
  - `shows title, where, both labelled parts and numbered steps` — contains `data-testid="help-popup"`, the title, the where line, `What it&#x27;s good for`, `How to use it`, an `<ol>` with one `<li>` per step, inline `code` rendered as `<code>`.
  - `offers Open in manual only when the entry links a manual section` — `help-popup-manual` present with `manual`, absent without.
  - `explains a missing entry instead of failing` — `entry: undefined, helpKey: "section.media.unknown"` renders `No help text yet` and the key, plus Close.

- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/app/src/renderer/help/HelpPopup.test.ts` — FAIL.

- [ ] **Step 3: Implement.** Popup root and backdrop carry `data-help-allow`; `role="dialog"`, `aria-modal="true"`, labelled by the title; test ids `help-popup`, `help-popup-title`, `help-popup-good`, `help-popup-how`, `help-popup-manual`, `help-popup-close`; focus the Close button on open. Clicking the dimmed backdrop closes the popup. Open in manual: `requestManual(entry.manual)`, `close()`, `revealPanel("help")`. In `HelpPanel`, an effect on `manualRequest`: clear the search query, then after render `scrollIntoView` the `[data-manual-section="<heading>"]` element (use `CSS.escape`), then `consumeManualRequest()`.

- [ ] **Step 4: Run** the test file and `manual.test.ts` — PASS; typecheck, lint clean.

- [ ] **Step 5: Commit** `feat(app): help popup with manual link`.

### Task 4: Chrome targets and Ingest texts

Attach help keys to the workspace chrome and every panel generically, and write the chrome and Ingest-group texts.

**Files:**
- Modify: `panels/Panel.tsx` (`data-help={panelHelpKey(id)}` on the `<section>`), `DockWorkspace.tsx` (each `dock-tab-${panelId}` gets its panel key), `MasterToolRail.tsx` (container `chrome.tool-rail`; each `tool-rail-entry-${panelId}` its panel key), `WorkflowPhaseTabs.tsx` (each `phase-tab-${phase}` gets `phaseHelpKey(phase)`), `GlobalProgress.tsx` (the `global-progress` button and its popover root `chrome.global-progress`), `panels/MediaBrowserPanel.tsx` and `panels/BrollPanel.tsx` (section headers), `docs/HELP.md`

**Entries to write** (11 + the 2 from Task 1 reviewed): `phase.ingest`, `phase.cut`, `phase.polish`, `phase.review`, `phase.publish` (what that stage of the work is for and which panels it brings up — read `PANEL_PLACEMENTS` in `state/layout-state.ts`), `chrome.tool-rail`, `chrome.global-progress` (also explains the Running / Queued-blocked / Needs attention / Waiting on you / External providers lists, "ETA pending", "Retry chain"), `section.media.pickup-repair`, `panel.broll`, `section.broll.source-classes`, `section.broll.generation-request`, `section.broll.candidate-review`, `section.broll.rights-indicators`. Section keys go on the `<summary>` / `<h3>` element itself via `sectionHelpKey`.

- [ ] **Step 1:** For each entry, read the panel/service code behind it (e.g. `packages/media/src/pickup.ts`, `packages/media/src/broll.ts`, `packages/core/src/jobs/queue.ts` for the progress lists) and the manual, then write the entry to the text rules. Record in the task report any place where the manual and the code disagree.
- [ ] **Step 2:** Add the `data-help` attributes listed above.
- [ ] **Step 3: Run** `help-texts.test.ts` (bundled file still parses, links valid), the renderer unit tests (`pnpm exec vitest run --project unit packages/app/src/renderer`), typecheck, lint, `pnpm check:conventions` — all green.
- [ ] **Step 4: Commit** `feat(app): help for workspace chrome and ingest panels`.

### Task 5: Cut and Polish texts

**Files:** `docs/HELP.md`; `panels/SkillsPanel.tsx` (section headers).

**Entries:** `panel.transcript`, `panel.assemble`, `panel.timeline`, `panel.preview`, `panel.graphics`, `panel.skills`, `section.skills.project-pins`, `section.skills.draft-revisions`. ("Prose body changed" in `SkillsPanel` is a per-skill header — no entry; Task 7 allowlists it.)

- [ ] **Step 1:** Read each panel and the service code it calls (e.g. `packages/transcript`, `packages/app/src/main/assembly-*.ts`, `packages/agent/src/skills`) and write the entries to the text rules; report manual/code disagreements.
- [ ] **Step 2:** Add `data-help` to the Project pins and Draft revisions `<h3>`s.
- [ ] **Step 3: Run** the same checks as Task 4 Step 3 — green.
- [ ] **Step 4: Commit** `feat(app): help for cut and polish panels`.

### Task 6: Review, Publish and System texts

**Files:** `docs/HELP.md`; `panels/StatusStripPanel.tsx`, `panels/HelpPanel.tsx`, `panels/StoragePanel.tsx`, `panels/InspectorPanel.tsx` (section headers).

**Entries:** `panel.agent`, `panel.status`, `section.status.derive-a-short`, `panel.publish`, `panel.help`, `section.help.getting-started`, `section.help.keyboard-map`, `panel.storage`, `section.storage.cleanup-review`, `panel.inspector`, `section.inspector.semantic-history`.

- [ ] **Step 1:** Read each panel and its services; write the entries to the text rules; report disagreements. `panel.help` mentions help mode and Shift+F1.
- [ ] **Step 2:** Add `data-help` to the five section headers.
- [ ] **Step 3: Run** the same checks as Task 4 Step 3 — green.
- [ ] **Step 4: Commit** `feat(app): help for review, publish and system panels`.

### Task 7: Coverage guard, end-to-end test and docs

**Files:**
- Create: `packages/app/src/renderer/help/help-coverage.test.ts`, `packages/app/e2e/help-mode.spec.ts`, `docs/amendments/010-contextual-help.md`
- Modify: `docs/MANUAL.md`, `docs/traceability.md`

- [ ] **Step 1: Write the coverage tests** in `help-coverage.test.ts` (read renderer sources with `readFileSync`):
  - `every panel, phase and chrome target has a help text` — for each `DOCK_PANEL_IDS` id `HELP_ENTRIES.has(panelHelpKey(id))`; each `WORKFLOW_PHASES` phase `phaseHelpKey`; `chrome.tool-rail`, `chrome.global-progress`.
  - `every fixed section header in a panel carries a help key with a text` — scan `panels/*.tsx` (excluding tests) for `<summary…>` and `<h3…>` whose first child text is literal (not starting with `{`); each opening tag must contain `data-help=`, and the key it names must be in `HELP_ENTRIES`; an explicit `ALLOWLIST` with a comment per item exempts per-item headers (`SkillsPanel.tsx` "Prose body changed").
  - `every help text is used` — every `HELP_ENTRIES` key is a panel/phase/chrome key from the lists above or a `section.*` key found by the scan.
- [ ] **Step 2: Run** it — PASS if Tasks 4–6 are complete; fix any gap it reveals (missing attribute or entry) rather than allowlisting a fixed header.
- [ ] **Step 3: Write `help-mode.spec.ts`** (pattern of `e2e/workspace.spec.ts`: `createWorkspaceProject` + `launchApp`): go to the Ingest tab; note whether the Capture watcher `<details>` is open; click `help-mode-toggle`; `help-mode-banner` visible; click the Capture watcher summary → `help-popup-title` has "Capture watcher", both parts visible, the `<details>` open state unchanged; `Escape` → popup gone, banner still visible; click `phase-tab-cut` → popup for the Cut phase, active phase still Ingest; `Escape` twice → banner gone; click `phase-tab-cut` → Cut tab becomes active (normal clicks work again). Add `Shift+F1` toggles the banner on and off.
- [ ] **Step 4: Run** `pnpm --filter @guyditor/app test:e2e help-mode.spec.ts` (with `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`; regenerate `.fixtures` with `pnpm fixtures` first if missing) — PASS.
- [ ] **Step 5: Docs.** `docs/MANUAL.md`: a "Help mode" row in the workspace table (toggle, Shift+F1, Esc, nothing acts while it is on) and `Shift+F1` in the keyboard map; `docs/amendments/010-contextual-help.md` following 009's shape (what changed, why, decisions from the spec, limitations: texts are static and fixed through chat); a traceability row for the feature following the ASM rows' style.
- [ ] **Step 6: Run** the full unit suite (`pnpm test`) and `node scripts/test-e2e.mjs` (env as above) — green; re-run any timeout-only failure in isolation before suspecting the change.
- [ ] **Step 7: Commit** `test(app): help coverage guard and help-mode e2e; docs`.
