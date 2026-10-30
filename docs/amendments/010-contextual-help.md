---
status: accepted        # implemented on feat/contextual-help 2026-10-30
affects: ["Part 10 §10.1 (workspace)", "Amendment 006 (onboarding)", "Amendment 007 (tool rail)"]
brd_ids: [HLP-001]
author: Claude Sonnet 5.5, from creator requirements 2026-10-30
date: 2026-10-30
---

# Amendment 010 — Contextual help ("help mode")

## Problem

The manual (Help panel) and the guided tour exist, but neither answers "what is *this
thing in front of me* for, and how do I use it?" at the moment the question comes up.
A creator looking at a Media panel full of "Generate proxy", "Capture watcher" and
"Pickup repair" had to leave the work and search.

## Change

A **help mode** toggle in the title bar (and `Shift+F1`). While it is on, every panel,
workflow phase tab, tool-rail entry, dock tab, the master tool rail, the global progress
button and every fixed section header (a `<summary>` or `<h3>` with fixed text) is a
help target, outlined with a dashed line. Clicking the innermost target opens a centred
popup with that target's two-part text, "What it's good for" and "How to use it", a
"where" line, and, when a manual section matches, an **Open in manual** button. A banner
says that help mode is on. `Esc` closes the popup; `Esc` again leaves help mode. Help
mode is not remembered across restarts.

The texts live in one Markdown file, `docs/HELP.md`, one `##` section per help key
(`panel.<id>`, `phase.<phase>`, `chrome.<name>`, `section.<panel>.<header-slug>`),
bundled into the renderer with `?raw` like the manual. A malformed file reports its error
in the popup instead of blanking the renderer.

- Design: [`docs/superpowers/specs/2026-10-30-contextual-help-design.md`](../superpowers/specs/2026-10-30-contextual-help-design.md)
- Plan: [`docs/superpowers/plans/2026-10-30-contextual-help.md`](../superpowers/plans/2026-10-30-contextual-help.md)
- Creator-facing description: MANUAL.md, "The workspace" (Help mode row) and the
  keyboard map.

## Decisions

- **Nothing navigates in help mode.** Phase tabs, rail entries and dock tabs open their
  explanation instead of switching, and a collapsed section's header explains the
  section instead of expanding it. To look at something that is not on screen the
  creator leaves help mode, goes there, and turns it back on.
- **Nothing acts in help mode.** One capture-phase gate on `window` swallows clicks,
  key presses and drops except on the toggle, the popup, the banner and the title-bar
  Help button (`data-help-allow`) and except `Esc` and `Shift+F1`, so help mode cannot
  start an import, cancel a job or change the project. `Tab`/`Enter` on those allowed
  controls keep their native effect but reach no other window listener (so `Enter` on the
  popup cannot advance the guided tour). The release of a pointer pressed before help mode
  turned on still reaches the app, so a drag begun earlier is not left captured.
- **Granularity is panels and sections.** Individual buttons, badges and fields have no
  text. Headers generated per item (per clip, per proposal entity type, per changed
  skill) are not sections and get none.
- **Texts are checked against the code, not only the manual.** Where the two disagree
  the text follows the code. One discrepancy was corrected at the same time: redo is
  `Ctrl/Cmd+Shift+Z` (the keyboard handler has no `Ctrl+Y`), so the in-app keyboard map
  and the manual now say so.
- **Coverage cannot rot silently.** `help-coverage.test.ts` fails when a panel, phase or
  chrome target lacks a text, when a fixed `<summary>`/`<h3>` in `panels/*.tsx` carries
  no help key or a key without a text, and when a text is used by nothing. Per-item
  headers are exempt only through a commented allowlist (currently `SkillsPanel.tsx`
  "Prose body changed").

## New persisted names

None. No project, settings or sidecar format changes. New repository file: `docs/HELP.md`.

## Known limitations

- The texts are static. They are fixed through chat (the creator says which ones did not
  help; the text is edited in `docs/HELP.md` after re-checking the code), not in the app,
  and there is no "this did not help" button.
- Text quality cannot be tested; it is judged in use.
- Help mode is mouse-only: help targets are not reachable by keyboard. From the keyboard
  only `Shift+F1`, `Esc`, and `Tab`/`Enter` on the toggle and popup buttons work.
- `Shift+F1` cannot turn help mode on while the welcome screen is shown, because that
  screen covers the toggle and the banner.
- The popup has no focus trap: `Tab` can move focus behind it. Help mode swallows keys
  and clicks, so the page behind cannot be acted on, but focus is not confined.
- Manual links are coarse: most manual headings cover a whole tab.

## Migration

None.
