# Global Progress Overflow Fix Design

- **Status:** Approved
- **Date:** 2026-07-28
- **Branch:** `fix/global-progress-overflow`
- **Related:** `docs/steering/global-progress-overflow.md`

## Purpose

Keep every part of the title-bar “Project activity” control inside its fixed
40-pixel boundary. The current CSS grid auto-places the waiting badge into an
implicit third row, causing it to overlap the workflow phase strip below.

## Root cause

`.global-progress` declares two columns and two rows, but its children do not have
explicit row placement:

1. the progress copy is auto-placed in the first row;
2. the next DOM child, the full-width progress track, consumes the second row;
3. the waiting badge is then auto-placed into a new implicit third row.

The fixed button height cannot contain that third row, so the badge paints below
the button.

## Selected design

Keep the existing markup and define named CSS grid areas:

```text
"copy  badge"
"track track"
```

The copy, badge, and track receive explicit area assignments. The first column
remains flexible, the badge remains content-sized, and the track retains its
four-pixel height across the full control width.

This is preferred to reordering DOM children because layout no longer depends on
source order. Adding `overflow: hidden` is out of scope because it would conceal
rather than correct the invalid placement.

## Behavior and responsive layout

- The button remains 40 pixels high and keeps its existing padding, colors, and
  border.
- At normal widths, copy and status remain top-left, the waiting badge remains
  top-right, and the track spans the bottom row.
- At the existing compact breakpoint, the “Project activity” label may remain
  hidden while status and badge stay contained.
- At the existing narrow breakpoint, the badge remains hidden as it is today.
- Clicking the control and positioning its progress popover remain unchanged.

## Accessibility

DOM order and accessible semantics do not change. The aggregate progress element
retains its `progressbar` role, and the button retains its label content and dialog
state.

## Verification and acceptance

Test-first Electron coverage will:

- reproduce the current implicit third row and fail before production CSS changes;
- assert the computed grid has only the intended two rows;
- compare each visible child’s bounding rectangle with the button’s border box;
- run at the default viewport and a compact supported width;
- preserve existing tests for waiting counts, popover opening, and proposal
  navigation.

The fix is accepted when no visible child extends beyond any side of the button at
either tested width and the relevant existing Electron tests remain green.
