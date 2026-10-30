# Free-form Workspace Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Guyditor's seven fixed dock regions with a per-phase split tree the user edits via header controls (split right / split down / ⋯ / ✕), persisted globally in `settings.json`.

**Architecture:** A pure, unit-tested tree module (`layout-tree.ts`) owns every operation and invariant (no empty groups, each panel at most once per phase). The Zustand workspace store wraps it and hands the whole `{activePhase, layouts}` document to an injected saver, which calls a new non-project `WorkspaceLayout` RPC service that replaces only the `workspace` key of `settings.json`. `DockWorkspace` becomes a recursive renderer; `Panel` stops drawing its own bar and portals its actions into the group header.

**Tech Stack:** Electron, React 18.3, Zustand 5, TypeScript, Vitest (root `vitest.config.ts`, project `unit`), Playwright e2e (`packages/app/e2e`).

**Spec:** `docs/superpowers/specs/2026-10-30-free-layout-design.md`

## Global Constraints

- Worktree setup before Task 1: `pnpm install` at the worktree root, then `pnpm fixtures` (e2e never regenerates `.fixtures`).
- No new runtime dependency (hand-rolled tree).
- No fixed-region mode, no per-project layouts, no migration of `guyditor/layout/v2` localStorage data.
- No drag-to-split, no edge "+" handles; drag only moves tabs between tab strips.
- No collapse/minimise anywhere: the `−/+` button, `railCollapsed`, 46px/31px strips all go.
- A panel appears at most once in a phase's layout; different phases may share a panel.
- The tree never contains an empty group; the "empty half" during a split is UI-only state.
- App-initiated reveals (`revealPanel` callers) behave exactly like a rail click and are saved.
- One header row per group: tab strip + Split right + Split down + ⋯ + ✕ + the active panel's actions.
- Settings: layouts under top-level key `workspace` in `<userDirectory>/settings.json`, written atomically preserving other keys; `workspace` is **not** in `DEFAULT_SETTINGS` (never deep-merged).
- Commit message trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A `settings.json` whose `workspace.layouts.cut` is garbage while other phases are valid → Cut gets its preset, the others load as saved (Task 1 `normalizeLayoutsDocument` test, Task 2 round-trip test).
2. Stored tree naming a panel twice or a panel id that no longer exists → duplicate/unknown dropped, empty groups and one-child splits collapsed, sizes renormalized (Task 1).
3. User closes the group they last clicked into, then clicks a rail entry → panel lands in the first remaining group (or becomes the root), never lost (Task 3).
4. Phase switch (tab, shortcut, tour, badge) while the panel picker is open → picker cancelled, no pending split shows up in the new phase (Task 3).
5. Divider dragged hard toward a neighbour on a small window → neither child goes below `MIN_GROUP_PX`, and nothing is saved until pointer-up (Task 1 `resizeSplit` test, Task 4 divider).

---

### Task 1: Pure layout tree and presets

**Files:**
- Create: `packages/app/src/renderer/state/layout-tree.ts`
- Create: `packages/app/src/renderer/state/layout-presets.ts`
- Test: `packages/app/src/renderer/state/layout-tree.test.ts`
- Modify: `packages/app/src/renderer/state/layout-state.ts` — keep only `WORKFLOW_PHASES`, `WorkflowPhase`, `DOCK_PANEL_IDS`, `DockPanelId`, `LAYOUT_STORAGE_KEY`/`LEGACY_LAYOUT_STORAGE_KEY` (onboarding still reads them, Task 3). Delete regions, splitters, placements, migrations and their types **in Task 3** once nothing imports them; in this task only add, don't delete.

**Interfaces:**
- Produces (in `layout-tree.ts`):
  ```ts
  export type SplitDirection = "row" | "column";          // row = children side by side
  export interface LayoutGroup { kind: "group"; id: string; panelIds: DockPanelId[]; activePanelId: DockPanelId }
  export interface LayoutSplit { kind: "split"; id: string; direction: SplitDirection; children: LayoutNode[]; sizes: number[] }
  export type LayoutNode = LayoutGroup | LayoutSplit;
  export interface PhaseLayout { root: LayoutNode | null }
  export interface LayoutsDocument { activePhase: WorkflowPhase; layouts: Record<WorkflowPhase, PhaseLayout> }
  export const MIN_GROUP_PX = 120;
  export function newNodeId(prefix: "g" | "s"): string;   // `${prefix}_${crypto.randomUUID().slice(0, 8)}`
  export function groupOf(layout: PhaseLayout, panelId: DockPanelId): LayoutGroup | null;
  export function findGroup(layout: PhaseLayout, groupId: string): LayoutGroup | null;
  export function firstGroup(layout: PhaseLayout): LayoutGroup | null;
  export function placedPanels(layout: PhaseLayout): DockPanelId[];
  export function splitGroup(layout: PhaseLayout, groupId: string, side: "right" | "down", panelId: DockPanelId): PhaseLayout;
  export function addTab(layout: PhaseLayout, groupId: string | null, panelId: DockPanelId): PhaseLayout;
  export function moveTab(layout: PhaseLayout, panelId: DockPanelId, targetGroupId: string, index?: number): PhaseLayout;
  export function activateTab(layout: PhaseLayout, panelId: DockPanelId): PhaseLayout;
  export function closeTab(layout: PhaseLayout, panelId: DockPanelId): PhaseLayout;
  export function closeGroup(layout: PhaseLayout, groupId: string): PhaseLayout;
  export function resizeSplit(layout: PhaseLayout, splitId: string, dividerIndex: number, delta: number, containerPx: number): PhaseLayout;
  export function revealInLayout(layout: PhaseLayout, panelId: DockPanelId, focusedGroupId: string | null): { layout: PhaseLayout; added: boolean };
  export function normalizeLayout(value: unknown): PhaseLayout | null;
  export function normalizeLayoutsDocument(value: unknown): LayoutsDocument;
  ```
- Produces (in `layout-presets.ts`): `export function presetLayout(phase: WorkflowPhase): PhaseLayout;` and `export function presetLayouts(activePhase?: WorkflowPhase): LayoutsDocument;` (fresh ids each call; default active phase `"cut"`).

Semantics the tests pin:
- `splitGroup`: no-op if `panelId` is already placed. `side` `"right"` → direction `row`, `"down"` → `column`. If the group's parent split already has that direction, insert the new group right after it and give both halves of the group's old size; otherwise replace the group with a new split `[group, newGroup]`, sizes `[0.5, 0.5]`.
- `addTab`: if `panelId` is placed elsewhere it is moved (never duplicated). `groupId === null` or unknown → append to `firstGroup`; empty layout → new root group.
- `closeTab`/`moveTab` out of a group's last tab → that group closes. Closing the active tab activates its left neighbour (else right).
- `closeGroup`: siblings absorb the freed fraction proportionally; a split left with one child is replaced by that child; last group → `root: null`.
- `resizeSplit`: moves `delta` px across divider `dividerIndex` (between children i and i+1); clamps so neither child is below `MIN_GROUP_PX / containerPx`; sum of sizes unchanged.
- `revealInLayout`: placed → `activateTab`, `added: false`; else `addTab(focusedGroupId)`, `added: true`.
- `normalizeLayout`: `null` for non-objects or a root that isn't a group/split shape; otherwise drops unknown panel ids and duplicates (first wins, depth-first), removes empty groups, collapses one-child splits, renormalizes sizes to sum 1 (missing/invalid sizes → equal), fixes `activePanelId` not in `panelIds`. `{ root: null }` is valid (empty workspace).
- `normalizeLayoutsDocument`: per phase, `normalizeLayout` or that phase's preset; invalid `activePhase` → `"cut"`.

Presets (exact trees; fractions are the spec's "roughly today's proportions"):
| Phase | Tree |
|---|---|
| ingest | column[0.82,0.18]( row[0.2,0.6,0.2](media · storage · assemble) , status ) |
| cut | column[0.82,0.18]( row[0.8,0.2]( column[0.58,0.42](preview , transcript) , [agent, assemble] ) , timeline ) |
| polish | row[0.19,0.61,0.2]( graphics , column[0.62,0.38](preview , transcript) , column[0.52,0.48](agent , inspector) ) |
| review | row[0.18,0.6,0.22]( media , preview , agent ) |
| publish | column[0.78,0.22]( publish , status ) |

- [ ] **Step 1: Write failing tests** in `layout-tree.test.ts`, one `describe` per function. Required cases (assert structure via a helper `shape(node)` that strips ids, e.g. `{row:[["preview"],["agent"]]}`):
  - `splitGroup` right on a lone root group → `row[0.5,0.5]`; split right again on the right child of a row → three children, sizes `[0.5,0.25,0.25]`; split with an already-placed panel → `toBe(layout)`-equal structure.
  - `addTab` of a panel placed in another group moves it and the source group closes if emptied; `placedPanels` has no duplicates.
  - `closeGroup` in `row[0.2,0.6,0.2]` closing the middle → `row[0.5,0.5]`; closing one of two → parent collapses to the remaining group; closing the only group → `root: null`.
  - `closeTab` of the active tab in `[agent, assemble]` (active agent) → active `assemble`.
  - `resizeSplit` with `containerPx 1000`, sizes `[0.5,0.5]`, `delta -900` → first size `0.12`, sum `1`.
  - `revealInLayout` with a stale `focusedGroupId` → lands in `firstGroup`, `added: true`; on `{root:null}` → root group.
  - **Review Focus 2:** `normalizeLayout` of a tree containing `preview` twice and `"bogus"` → `preview` once, no `"bogus"`, no empty group, sizes sum 1.
  - **Review Focus 1:** `normalizeLayoutsDocument({activePhase:"polish", layouts:{cut: 42, polish: <valid>}})` → `cut` deep-equals `shape(presetLayout("cut"))`, `polish` kept, `activePhase "polish"`.
  - Every `presetLayout(phase)` passes `normalizeLayout` unchanged in shape and has no duplicate panel.
- [ ] **Step 2: Run** `pnpm vitest run --project unit packages/app/src/renderer/state/layout-tree.test.ts` from the worktree root. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `layout-tree.ts` and `layout-presets.ts` to the interfaces above. All functions are pure (return new objects; inputs untouched).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `layout-tree.ts`, `layout-presets.ts`, `layout-tree.test.ts` — "Add free-form layout tree model and phase presets".

---

### Task 2: Global persistence over RPC

**Files:**
- Modify: `packages/app/src/main/settings.ts` — extract `replaceSettingsKey(userDirectory: string, key: string, value: unknown, now?: () => Date): Promise<void>` from `saveAiSettings` (same atomic temp-file + rename, unknown keys kept); `saveAiSettings` becomes a one-line call to it. Add `export function readSettingsKey(userDirectory: string, key: string): Promise<unknown>` (missing file or key → `undefined`; unparsable file → `undefined`, no rename — `loadSettings` already owns recovery).
- Create: `packages/app/src/main/workspace-layout-service.ts`
- Modify: `packages/app/src/shared/ipc.ts` — add `"WorkspaceLayout"` to `ServiceName`.
- Modify: `packages/app/src/main/surfaces.ts` — `workspaceLayoutSurface` in `IPC_SURFACES`.
- Modify: `packages/app/src/main/service-host.ts` — construct the service next to `aiSettings`; `case "WorkspaceLayout"`; add it to the not-project-bound list in `resolveService`.
- Test: `packages/app/src/main/workspace-layout-service.test.ts`, extend `packages/app/src/main/surfaces.test.ts`, extend `packages/app/src/main/settings.test.ts` (create if absent).

**Interfaces:**
- Produces:
  ```ts
  export class WorkspaceLayoutService {
    constructor(options: { userDirectory: string });
    get(): Promise<unknown>;                       // raw stored `workspace` value or null; renderer normalizes
    save(document: unknown): Promise<void>;        // replaceSettingsKey(userDirectory, "workspace", document); serialized (one write in flight, latest wins)
    surface(): { get: () => Promise<unknown>; save: (params: { document: unknown }) => Promise<void> };
  }
  ```
- RPC: `window.guyditor.call<unknown>("WorkspaceLayout", "get", {})` and `call<void>("WorkspaceLayout", "save", { document })`. Surface schemas: `get` → `emptyParams`; `save` → `{ type: "object", required: ["document"], properties: { document: { type: "object" } }, additionalProperties: false }`; both `resultSchema: anyResult`, `budgetMs: 50`.

- [ ] **Step 1: Write failing tests:**
  - `settings.test.ts`: `replaceSettingsKey` on a file containing `{schema:1, ai:{…}, general:{…}}` writing `workspace` keeps `ai` and `general` byte-equal after JSON parse; `saveAiSettings` still keeps `workspace` intact.
  - `workspace-layout-service.test.ts` (tmp dir): `get()` on a missing file → `null`; `save(doc)` then a **new** service instance `get()` deep-equals `doc`; two concurrent `save`s → file holds the second; **Review Focus 1:** a stored `{activePhase:"cut", layouts:{cut:42}}` round-trips untouched (normalization is the renderer's job).
  - `surfaces.test.ts`: `WorkspaceLayout.save` rejects `{}` and `{document: 1}`, accepts `{document:{}}`.
  - `loadSettings` on a file with a `workspace` key returns settings without a `workspace` default injected and doesn't throw.
- [ ] **Step 2: Run** `pnpm vitest run --project unit packages/app/src/main/settings.test.ts packages/app/src/main/workspace-layout-service.test.ts packages/app/src/main/surfaces.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the settings helpers, service, surface, ServiceName entry and service-host wiring.
- [ ] **Step 4: Run** the same command plus `pnpm --filter @guyditor/app typecheck`. Expected: PASS / no errors.
- [ ] **Step 5: Commit** — "Persist workspace layouts in global settings via WorkspaceLayout RPC".

---

### Task 3: Workspace store, rail and reveal on the tree

**Files:**
- Modify: `packages/app/src/renderer/state/view-state.ts` (`WorkspaceState` + `useWorkspaceStore`)
- Modify: `packages/app/src/renderer/state/tool-rail.ts` (drop `PANEL_HOME_REGIONS`, `panelRegion`, `togglePanelFromRail`)
- Modify: `packages/app/src/renderer/workspace-navigation.ts` (`revealPanel` → `useWorkspaceStore.getState().revealPanel`)
- Modify: `packages/app/src/renderer/state/onboarding.ts` (`hasPriorProject`)
- Modify: `packages/app/src/renderer/App.tsx` (hydrate on mount; replace `setProjectKey` call at ~651 with `markProjectOpened(window.localStorage)`)
- Modify: `packages/app/src/renderer/state/layout-state.ts` (delete everything not listed in Task 1)
- Test: rewrite `packages/app/src/renderer/state/workspace.test.ts` layout cases and `tool-rail.test.ts`; extend `onboarding.test.ts`.

**Interfaces:**
- Consumes: Task 1 tree functions/types; Task 2 RPC names.
- Produces (`WorkspaceState`, replacing region/splitter/collapse members):
  ```ts
  layouts: Record<WorkflowPhase, PhaseLayout>;
  layout: PhaseLayout;                              // layouts[activePhase]
  activePhase: WorkflowPhase;
  focusedGroupId: string | null;
  focusedPanel: PanelId;
  flashingPanel: PanelId | null;
  picker: PickerRequest | null;                     // export type PickerRequest = { mode: "split"; groupId: string; side: "right" | "down" } | { mode: "add-tab"; groupId: string } | { mode: "root" }
  hydrateLayouts: (stored: unknown) => void;        // normalizeLayoutsDocument; does not save
  setPhase: (phase: WorkflowPhase) => void;         // also sets picker null
  focusPanel: (panel: PanelId) => void;             // sets focusedPanel + focusedGroupId = groupOf(layout, panel)?.id
  revealPanel: (panel: PanelId) => void;            // revealInLayout; flash + focus when added; saves
  activateTab: (panel: PanelId) => void;
  closeTab: (panel: PanelId) => void;
  closeGroup: (groupId: string) => void;
  openPicker: (request: PickerRequest) => void;
  cancelPicker: () => void;
  choosePanel: (panel: DockPanelId) => void;        // commits per picker.mode (splitGroup / addTab / addTab(null)), clears picker, focuses panel
  moveTab: (panel: DockPanelId, targetGroupId: string, index?: number) => void;
  resizeSplit: (splitId: string, dividerIndex: number, delta: number, containerPx: number, persist?: boolean) => void;
  resetLayout: () => void;                          // presetLayout(activePhase)
  resetAllLayouts: () => void;                      // presetLayouts(activePhase)
  ```
  Removed: `projectKey`, `setProjectKey`, `railCollapsed`, `togglePanel`, `expandPanel`, `assignPanel`, `reorderPanel`, `activatePanel`, `setSplitter`, `leftWidth`, `rightWidth`, `statusHeight`, `jobsPanelWidth`, `setLeftWidth`, `setRightWidth`, `setJobsPanelWidth`, `clearPanelFlash` stays.
  - `export function configureLayoutSaver(save: (document: LayoutsDocument) => void): void;` in `view-state.ts`. Every mutating action except `hydrateLayouts`, `openPicker`, `cancelPicker`, `focusPanel`, and `resizeSplit(..., persist=false)` calls the saver with `{activePhase, layouts}`. App wires it once to a 250 ms trailing-debounced `call("WorkspaceLayout","save",{document})`, then `call("WorkspaceLayout","get",{})` → `hydrateLayouts`.
- `tool-rail.ts`: `export type ToolRailPanelState = "here" | "other-phase" | "absent";` `toolRailPanelState(layouts, activePhase, panelId)` — placed in current → `"here"`; placed in another phase only → `"other-phase"`; else `"absent"`. `MasterToolRail` click → `revealPanel`.
- `onboarding.ts`: `export const PROJECT_OPENED_KEY = "guyditor/project-opened";` `export function markProjectOpened(storage: Storage): void;` `hasPriorProject` = flag set **or** the legacy layout document (v2/v1 keys) has a non-empty `projects` (so existing users don't get the welcome surface again).

- [ ] **Step 1: Write failing tests** (`workspace.test.ts`, reset the store and inject a `vi.fn()` saver in `beforeEach`):
  - `hydrateLayouts(garbage)` → every phase equals its preset shape; saver not called.
  - `openPicker({mode:"split", groupId: <preview group>, side:"right"})` + `choosePanel("inspector")` → `inspector` placed in a row next to preview; picker null; saver called once with `activePhase` and all five layouts.
  - `openPicker` + `cancelPicker` → layout unchanged, saver not called.
  - **Review Focus 4:** `openPicker(...)` then `setPhase("polish")` → `picker === null`, polish layout equals its preset shape.
  - **Review Focus 3:** `focusPanel("agent")`, `closeGroup(<agent group>)`, `revealPanel("inspector")` → inspector placed in `firstGroup`; `flashingPanel === "inspector"`.
  - `revealPanel` of an already-placed panel → activates its tab, `flashingPanel` unchanged, saver called (active tab is part of the saved layout).
  - `resizeSplit(..., persist=false)` → saver not called; `persist` default → called.
  - `tool-rail.test.ts`: the three states using presets (`cut`: `preview` here, `media` other-phase, `help` absent).
  - `onboarding.test.ts`: `markProjectOpened` makes `shouldShowWelcome` false; a legacy `guyditor/layout/v2` doc with one project also makes it false.
- [ ] **Step 2: Run** `pnpm vitest run --project unit packages/app/src/renderer/state`. Expected: FAIL.
- [ ] **Step 3: Implement** store, rail state, navigation, onboarding, App wiring; delete dead code from `layout-state.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS. (App typecheck goes green at the end of Task 4 — `DockWorkspace`/`Panel` still reference removed members.)
- [ ] **Step 5: Commit** — "Drive workspace store, rail and reveals from the layout tree".

---

### Task 4: Recursive dock renderer and single header row

**Files:**
- Modify: `packages/app/src/renderer/DockWorkspace.tsx` (rewrite)
- Create: `packages/app/src/renderer/PanelPicker.tsx`
- Modify: `packages/app/src/renderer/panels/Panel.tsx`
- Modify: `packages/app/src/renderer/MasterToolRail.tsx` (`STATE_LABELS` for the new states; click → `revealPanel`)
- Modify: `packages/app/src/renderer/GuidedTour.tsx` (rail stop copy: no "home region"; say tools are added to the panel you last used)
- Modify: `packages/app/src/renderer/styles.css` (remove fixed-grid, region, checkerboard/resting-frame, collapsed-strip rules; add group/split/divider/picker rules)
- Modify: any panel test that asserts `-panel-toggle`, `panel-bar` or regions (`BrollPanel.test.ts`, `StatusStripPanel.test.ts`, `StoragePanel.test.ts`, `AssemblePanel.test.ts`, `SkillsPanel.test.ts`, `PublishPanel.test.ts`) — update to the new markup.

**Interfaces:**
- Consumes: Task 3 store members.
- Produces (DOM contract used by Task 5):
  - Group: `<section data-testid="dock-group" data-group-id data-active-panel>`; tab strip `role="tablist"`, always rendered (even for one panel); tab `data-testid="dock-tab-${panelId}" id="${panelId}-title" role="tab" draggable title={eyebrow}`; tab close `dock-tab-close-${panelId}`.
  - Header controls in the group: `group-split-right`, `group-split-down`, `group-menu` (menu items `group-menu-split-right`, `group-menu-split-down`, `group-menu-add-tab`, `group-menu-close`), `group-close`; actions slot `group-actions`.
  - Split: `<div data-testid="dock-split" data-direction>`; divider `data-testid="split-divider" role="separator" aria-valuenow={round(size_i*100)}` with pointer drag (`resizeSplit(..., false)` on move, `persist` on up) and ArrowLeft/Right (row) or ArrowUp/Down (column) = ±2% of container.
  - Pending split: when `picker.mode === "split"`, the target group renders inside a temporary split with a placeholder half `data-testid="pending-split"` holding the picker.
  - Picker: `data-testid="panel-picker"`, options `panel-picker-option-${panelId}` (`aria-disabled="true"` + not clickable when placed in the current layout), Escape / click-outside → `cancelPicker`.
  - Empty workspace: only `data-testid="workspace-add-panel"` button → `openPicker({mode:"root"})`.
  - `export const PanelActionsSlot: React.Context<HTMLElement | null>` (in `DockWorkspace.tsx`); `Panel` keeps its props (`id`, `title`, `eyebrow`, `className`, `actions`, `children`), renders no `panel-bar`, and `createPortal(actions, slot)` when `slot !== null`. `aria-labelledby` stays `${id}-title` (now the tab). Remove `beginPanelDrag` use from `Panel`; keep `beginPanelDrag` exported for tabs.
  - Clicking anywhere inside a group calls `focusPanel(activePanelId)` (so `focusedGroupId` tracks the last group used).

- [ ] **Step 1: Update failing panel unit tests** to the new markup (no `-panel-toggle`; actions found via the slot), and run `pnpm vitest run --project unit packages/app/src/renderer`. Expected: FAIL where markup changed.
- [ ] **Step 2: Implement** `DockWorkspace`, `PanelPicker`, `Panel`, rail/tour/style changes.
- [ ] **Step 3: Run** `pnpm vitest run --project unit packages/app/src/renderer` and `pnpm --filter @guyditor/app typecheck` and `pnpm --filter @guyditor/app lint`. Expected: all PASS / clean.
- [ ] **Step 4: Manual check** with the `run` skill (dev app, a fixture project): split right on Preview opens the picker with Preview/Transcript greyed; Escape removes the half; ✕ on a group lets neighbours grow; no empty placeholders in any phase; close everything → "Add panel". Screenshot each phase.
- [ ] **Step 5: Commit** — "Render the workspace as an editable split tree with one header row per group".

---

### Task 5: End-to-end coverage

**Files:**
- Rewrite: `packages/app/e2e/panel-management.spec.ts`
- Modify: `packages/app/e2e/phase-tabs.spec.ts` (splitter assertions → divider `aria-valuenow`)
- Check/adjust: `packages/app/e2e/workspace.spec.ts:302`, `packages/app/e2e/assembly.spec.ts:29`, `packages/app/e2e/onboarding.spec.ts`

**Interfaces:**
- Consumes: Task 4 DOM contract; `launchApp({ projectTemplate, userDataDirectory })` and `createWorkspaceProject` helpers.

- [ ] **Step 1: Write tests** in `panel-management.spec.ts`:
  - "layout edits persist globally across relaunch and projects": in Cut, split Preview right → pick Inspector; drag a divider; close the timeline group; relaunch with the same `userDataDirectory` **and a different project template** → Inspector group present, timeline absent, divider `aria-valuenow` equal to before.
  - "split picker greys out placed panels and dismiss leaves no empty space": `panel-picker-option-preview` has `aria-disabled="true"`; Escape → no `pending-split`, group count unchanged.
  - "closing every group shows only Add panel; picking restores a root group".
  - "rail focuses placed panels and adds absent ones to the last-used group": click into Transcript, click rail Inspector → `dock-tab-inspector` inside the Transcript group.
  - "app reveal is saved" (spec decision): in Publish, click the phase badge that reveals Status/Agent per `WorkflowPhaseTabs`, relaunch → still placed.
  - "reset layout / reset all tabs restore presets".
  - "no phase shows an empty placeholder and every preset fits 1920×1080 without clipping" (adapt the existing fit test; assert `.empty-dock-target` count 0).
  - Drop the resting-frame/checkerboard/drag-over-emphasis tests.
- [ ] **Step 2: Run** `pnpm test:e2e -- panel-management phase-tabs workspace assembly onboarding` from the worktree root. Expected: PASS (shared-box 5 s load flakes: rerun the single failing test once before investigating).
- [ ] **Step 3: Run** the full `pnpm test` (typecheck + lint + unit). Expected: PASS.
- [ ] **Step 4: Commit** — "Cover free-form layout editing and global persistence end to end".
