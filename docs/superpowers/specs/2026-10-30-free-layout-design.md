# Free-form workspace layout — design

Date: 2026-10-30 · Branch: `feat/free-layout` · Status: approved in conversation, pending plan

## Intent

Screen space should go only to the panels that matter in the current step. Today every
workflow phase (Ingest, Cut, Polish, Review, Publish) renders the same seven fixed dock regions
(`left`, `center-top`, `center-bottom`, `right-top`, `right-bottom`, `bottom-timeline`,
`bottom-status`). Most phases only populate three or four of them, so the rest sit on screen
empty ("Drop a panel here" checkerboards), taking space for no reason.

The fix: replace the fixed regions with a free-form split layout the user builds per phase —
remove any panel, add a panel anywhere, split any panel horizontally or vertically.

## Goals

- A layout is a tree of splits whose leaves are **panel groups** (a tab strip of one or more
  panels, as today). No slot exists unless something is in it.
- Per panel group, the user can: split right, split down, close the group, close individual
  tabs, add a tab.
- Each phase ships with a **preset** layout. The user's edits to a phase's layout are
  remembered and restored next time that phase is entered.
- Layouts persist in **global user settings** (`settings.json` in the user directory), so a
  customized Cut layout follows the user into every project.
- "Reset layout" (current phase) and "Reset all tabs" (all phases) restore presets.

## Non-goals

- No "classic" fixed-region mode. The fixed regions are removed entirely, not kept as an
  alternative.
- No per-project layout overrides.
- No migration of existing per-project layouts (`guyditor/layout/v2` in localStorage). Everyone
  starts from the new presets; the old fixed regions do not map cleanly onto a free tree.
- No drag-to-split (drop zones on panel edges) and no "+" handles between panels — the user
  chose header controls (option B) only.
- No floating / detached windows, no named saved layouts beyond one-per-phase.

## Anti-goals (would make this a failure even if it technically works)

- Any empty placeholder space remaining on screen when the user has not asked for it.
- The same panel appearing in two places at once.
- A layout change in one project not showing up in another (i.e. still project-scoped).

## Decided behaviour (user-confirmed)

### Layout model
- Recursive split tree: a node is either a **split** (`direction: "row" | "column"`, two or
  more children with size fractions) or a **group** (ordered `panelIds`, `activePanelId`).
- **A panel appears at most once in a phase's layout.** Every operation that would place a
  panel must refuse or move it, never duplicate it.
- Different phases may each contain the same panel (Preview in Cut and in Polish) — the
  uniqueness rule is per layout.

### Panel header (option B)
- Each group's header keeps its tab strip (shown even for a single panel, so the controls have
  a home) and gains, on the right: **Split right**, **Split down**, a **⋯ menu**, and **✕**.
- ⋯ menu: Split right · Split down · Add tab… · Close panel.
- **Split right / down** halves the group (50/50) and inserts a new empty group in the new half,
  which immediately opens the **panel picker**.
- **Panel picker** lists all dock panels; ones already in this phase's layout are shown greyed
  out and are not selectable. Picking one fills the new group. Dismissing the picker without a
  choice removes the empty group (the split collapses back).
- **Add tab…** opens the same picker and appends the chosen panel as a tab in that group.

### Closing
- **✕ / Close panel** closes the whole group and all its tabs; the sibling(s) absorb the freed
  space. A split left with one child collapses into that child.
- Closing a single **tab** removes that panel from the layout; if it was the group's last tab,
  the group closes as above.
- Closing everything leaves an empty workspace with a single **"Add panel"** button, which opens
  the picker and creates the root group.

### Resizing and moving
- Dividers between split children are draggable (pointer + keyboard, as today's splitters).
  Sizes are fractions stored in the tree and persist with the phase layout.
- Dragging a tab onto another group's **tab strip** moves it there (today's behaviour). Dragging
  only moves tabs; it never splits. Moving the last tab out of a group closes that group.

### Tool rail
- The master rail keeps listing every panel.
- Clicking a panel already in the current layout **focuses** it (activates its tab).
- Clicking a panel not in the current layout adds it as a tab in the **last-focused group**
  (the group the user last clicked into). If there is no group, it becomes the root group.

### Collapse is removed
- The per-panel −/+ collapse button (`Panel.tsx` `*-panel-toggle`) and all collapse/minimise
  behaviour (46px side strips, 31px bottom rows, `railCollapsed`) go away. Closing (✕) is the
  only way to hide a panel; the rail brings it back.

### App-initiated reveals
- When the app opens a panel on its own (`revealPanel` / `expandPanel` callers: jump to
  proposal / word range / annotation, phase-tab badges, `GlobalProgress`, `GuidedTour` stops)
  and the panel is not in the current phase's layout, it behaves exactly like a rail click:
  added as a tab in the last-focused group **and saved**. No temporary/overlay state.

### One header row per group
- The group's tab strip is the **only** header. Each panel's own `panel-bar` (P-number, eyebrow,
  title, collapse button, drag handle) is removed; the panel-specific action buttons move into
  the group header row, shown for the active tab. The tab is the only drag handle. Every panel
  component is reworked accordingly.

### Persistence
- Stored under a new top-level key in `settings.json` (e.g. `workspace.layouts`), holding one
  layout tree per phase plus the last active phase. Written atomically, preserving other keys,
  the same way `saveAiSettings` replaces only the `ai` key.
- Missing or invalid stored layouts fall back to the phase preset (per phase, not all-or-nothing).
- The per-project localStorage layout document is no longer read or written.
- *Designer's call:* layouts are loaded once at startup (not per project open), and the layout
  key is kept out of `mergeDefaults` — presets must never be deep-merged into a saved tree.
- *Designer's call:* e2e tests run against an isolated user directory so a test's saved layout
  never leaks into another test or into the developer's real settings.

## Presets (builder's call, derived from today's placements)

Each preset contains only the panels the current `PANEL_PLACEMENTS` puts in that phase, arranged
to roughly match today's proportions — and nothing else:

| Phase   | Panels in today's placement                         |
|---------|------------------------------------------------------|
| Ingest  | media · storage · assemble · status                  |
| Cut     | preview · transcript · agent+assemble (tabs) · timeline |
| Polish  | graphics · preview · transcript · agent · inspector  |
| Review  | media · preview · agent                              |
| Publish | publish · status                                     |

The exact tree shape and fractions are left to the builder; the bar is "fits a 1920×1080
viewport without clipping and looks intentional" (the existing e2e check).

## Constraints

- Electron + React 18 renderer, Zustand store (`renderer/state/view-state.ts`), pure layout
  logic in `renderer/state/layout-state.ts` with unit tests alongside. Keep that split: pure
  tree operations in a state module, thin React components.
- Settings live in the main process (`main/settings.ts`, `loadSettings` / `save*`); the renderer
  reaches main via the `gd:rpc` facade. Layout persistence needs an RPC pair (read layouts,
  save layouts) following the AI settings service pattern.
- Saves should be debounced/coalesced during divider drags (today: `setSplitter(..., false)`
  during the drag and persist on pointer-up).
- No new dependency is required; a layout library (dockview, flexlayout) is the builder's call
  only if it supports option-B header controls, tabs and the uniqueness rule without fighting
  the existing styling. Default expectation: hand-rolled tree.

## What changes / goes away (map for the builder)

- `layout-state.ts`: `DOCK_REGION_IDS`, `SPLITTER_IDS`, `PANEL_PLACEMENTS`, `DEFAULT_SPLITTERS`,
  `railCollapsed`, and the v1/pre-onboarding/pre-assemble migration chain are replaced by the
  tree model + presets. `WORKFLOW_PHASES` and `DOCK_PANEL_IDS` stay.
- `DockWorkspace.tsx`: fixed grid + named splitters → recursive renderer of the tree.
- `tool-rail.ts`: `PANEL_HOME_REGIONS` and the `collapsed` rail state go away. Rail states become
  "in this layout" / "in another phase only" / "not placed" (builder may simplify).
- `onboarding.ts` `hasPriorProject` reads the localStorage layout document to decide whether to
  show the welcome surface — needs a replacement signal (builder's call: e.g. recent-projects
  list, or a dedicated localStorage flag).
- `Panel.tsx` and every panel component: `panel-bar` removed, actions hoisted into the group
  header (see "One header row per group").
- `view-state.ts` reveal/expand paths and `workspace-navigation.ts`: route through the same
  "add to last-focused group" operation as the rail.
- `GuidedTour.tsx` copy mentions "return to their home region" — update the wording.
- `styles.css` grid rules for the fixed regions, empty-dock checkerboard/resting frame styling.
- Unit tests that assert region ids, and `e2e/panel-management.spec.ts` (persistence across
  relaunch, reset, resting frame/checkerboard, rail three-states, 1920×1080 fit) — rewrite for
  the new model; the checkerboard/"vacant region" tests become obsolete.

## Left to the builder

- Exact data shape, ids for groups/splits, and the settings schema key name.
- Minimum panel sizes and how a divider stops at them.
- Visual design of the header controls and picker (match existing tab/rail styling).
- Keyboard access for split/close/picker (should at least be reachable and labelled).
- Test strategy beyond keeping the existing e2e intent (persist across relaunch, reset, fit).
