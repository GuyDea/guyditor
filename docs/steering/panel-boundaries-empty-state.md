# Steering Decision: Structured panel frames and vacant-dock checkerboard

- **Status:** Accepted
- **Date:** 2026-07-27
- **Owners:** Guyditor
- **Related:** `docs/amendments/004-panel-management.md`,
  `docs/superpowers/specs/2026-07-27-panel-boundaries-empty-state-design.md`

## Context

Docking regions use closely related dark surfaces whose resting boundaries are easy
to lose. Vacant regions accept dragged panels but currently use a plain dark fill
and dashed outline that do not communicate emptiness as clearly as a conventional
alpha-channel checkerboard.

## Constraints

- The editor must remain compact and avoid visually heavy card chrome.
- Amber remains reserved for focus, selection, and drag-over emphasis.
- Existing panel docking, resizing, phase layouts, persistence, and viewport fit
  must remain unchanged.
- Checkerboard treatment applies only to a vacant docking region, never an
  empty-content state inside a populated panel.

## Decision

Give every `.dock-region` a persistent one-pixel neutral frame using the existing
hot-line palette and a restrained inset highlight. Preserve the stronger existing
amber focus and drag-over treatments.

When the existing `activePanelId === null` branch renders `.empty-dock-target`, fill
that target with a low-contrast 16-pixel alpha-style checkerboard and place the
existing instruction on a dark bordered plate. Remove the redundant full-surface
dashed border.

## Alternatives

### Quiet outline

A lower-contrast frame and smaller, subtler checkerboard were rejected because panel
edges could still disappear on dim or low-contrast displays.

### High-contrast bays

Two-pixel frames, bright active borders, and a larger checkerboard were rejected
because they made the dense multi-panel workspace feel boxed in and competed with
editor content.

## Consequences

- Region boundaries and vacant drop destinations become easier to recognize at a
  glance.
- The checkerboard borrows a familiar transparency/editing convention without
  changing behavior.
- The workspace gains slightly more resting contrast, while amber remains the
  dominant interaction color.
- The change remains CSS-focused and can be reverted without data migration.

## Boundaries / Interfaces

Only renderer presentation for `.dock-region` and `.empty-dock-target` changes.
React component interfaces, layout state, drag events, splitters, IPC, project
storage, and autosave remain fixed.

## Data / Migrations

No data, schema, persistence, or migration changes are required.

## Security / Scale

The gradients are local CSS with no assets, network requests, or user content. The
fixed-size pattern has negligible rendering cost and does not scale with project
size.

## Verification / Rollout

Panel-management coverage will verify the computed resting frame, empty-only
checkerboard, readable prompt, preserved amber drag-over override, and unchanged
viewport fit. Reverting the renderer style changes restores the previous treatment
without affecting saved projects.
