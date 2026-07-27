# Panel Boundaries and Empty Dock State Design

- **Status:** Approved
- **Date:** 2026-07-27
- **Branch:** `feat/panel-boundaries-empty-state`
- **Related:** `docs/amendments/004-panel-management.md`,
  `docs/steering/panel-boundaries-empty-state.md`

## Purpose

Guyditor's docking regions currently share nearly identical dark surfaces. Their
resting edges can disappear into the workspace, which makes it harder to see where
one panel ends and another begins. A vacant docking region has a dashed outline and
plain dark fill, but it does not immediately read as an empty canvas that accepts a
dragged panel.

This change gives every docking region a clearer resting boundary and uses the
familiar alpha-channel checkerboard only for completely vacant docking regions.

## Goals

- Make the boundary of every docking region visible without making the dense editor
  feel boxed in.
- Preserve amber as the stronger focus and drag-over signal.
- Make a completely vacant docking region unmistakably empty and available as a
  panel drop target.
- Remove the checkerboard immediately when a panel occupies the region.
- Preserve layout dimensions, resizing, docking, persistence, and accessibility.

## Non-goals

- Apply the checkerboard to empty-content states inside populated panels such as
  Media, Graphics, or B-roll.
- Change panel layout state, drag-and-drop behavior, project persistence, or
  autosave.
- Add new animation, panel chrome, labels, preferences, or themes.
- Redesign splitters, tabs, panel headers, or the master tool rail.

## Selected visual treatment

The selected direction is **Structured frame**, option B from the approved visual
comparison.

### Occupied docking regions

Each `.dock-region` receives a persistent one-pixel neutral frame derived from the
existing `--line-hot` palette. A restrained inset top highlight adds enough depth to
separate adjacent dark surfaces without introducing rounded cards or shadows that
would compete with the editor content.

The frame remains neutral at rest. Existing amber interaction hierarchy is
preserved:

- keyboard/programmatic panel focus retains the dim amber inset treatment;
- drag-over retains the two-pixel amber frame, amber wash, and “Dock here” overlay;
- the neutral resting frame must not obscure either state.

The existing global `border-box` sizing keeps the frame inside each region's
allocated dimensions, so splitter geometry and viewport fit do not change.

### Vacant docking regions

The checkerboard appears only when `DockRegion` already resolves
`activePanelId === null` and renders `.empty-dock-target`. No new state or DOM branch
is required.

The empty surface uses a low-contrast 16-pixel checker tile made from CSS gradients
in two neighboring dark blue-gray tones. It fills the available docking region and
does not appear behind an occupied panel. The existing “Drop a panel here” text
remains centered on an opaque dark plate with a one-pixel neutral border so it stays
readable over the pattern.

The full-surface dashed border is removed to avoid a doubled frame. The persistent
dock-region frame communicates the boundary; the checkerboard and centered prompt
communicate vacancy and action.

## Behavior and state

This is a presentation-only change. Existing layout state remains the source of
truth:

1. A region with an expanded active panel renders that panel over the normal panel
   surface.
2. A region without an expanded active panel renders `.empty-dock-target`, which
   supplies the checkerboard.
3. Dropping or expanding a panel updates the existing layout state and replaces the
   empty target with panel content.
4. Dragging over either an empty or occupied region activates the existing amber
   drop treatment.

There are no new persistence, autosave, IPC, schema, error-handling, or recovery
paths.

## Accessibility

- “Drop a panel here” remains real text; the checkerboard is decorative CSS.
- No information is conveyed by color alone: vacancy has both a pattern and an
  instruction, while drag-over has a border, wash, and label.
- No motion is added, so reduced-motion behavior is unchanged.
- Existing focus-visible and drag interaction states remain stronger than the
  resting frame.

## Verification and acceptance

Test-first coverage will establish the intended visual contract before production
styles change:

- occupied docking regions compute to a visible one-pixel solid resting border;
- a completely vacant docking region renders `.empty-dock-target` with a
  non-`none` checkerboard background image;
- occupied regions do not render the empty target;
- the empty prompt remains visible and readable;
- drag-over styling still overrides the resting frame with the existing amber
  treatment;
- every phase layout continues to fit the supported viewport without outer
  clipping.

Run the targeted panel-management tests first, followed by the app's proportional
typecheck, lint, unit, build, and Electron end-to-end checks required by the
repository.
