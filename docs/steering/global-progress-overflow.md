# Steering Decision: Explicit layout for global project progress

- **Status:** Accepted
- **Date:** 2026-07-28
- **Owners:** Guyditor
- **Related:** `docs/superpowers/specs/2026-07-28-global-progress-overflow-design.md`

## Context

The fixed-height “Project activity” button uses CSS Grid auto-placement for three
children. Because the full-width progress track appears before the waiting badge in
the DOM, it consumes the second grid row and pushes the badge into an implicit third
row below the 40-pixel button.

## Constraints

- The copy, waiting badge, and progress track must remain inside the button at every
  supported width.
- Existing text, click behavior, accessibility semantics, popover positioning, and
  responsive badge hiding must remain unchanged.
- The fix must not increase title-bar height or hide overflow as a substitute for a
  correct layout.

## Decision

Define explicit grid areas for the progress copy, waiting badge, and full-width
track. Assign each child to its area so source order cannot create implicit rows.

## Alternatives

Reordering the DOM children was rejected because it makes layout depend on source
order. Clipping the button with `overflow: hidden` was rejected because it masks the
layout defect and can silently crop content.

## Consequences

The activity control keeps its existing dimensions and appearance, but all visible
children are constrained to the intended two-row grid. The change is CSS-only and
has no project-data or runtime-state impact.

## Boundaries / Interfaces

Only renderer styles for `.global-progress` and its existing children change. React
markup, job state, IPC, popover behavior, project persistence, and autosave remain
fixed.

## Data / Migrations

No data, schema, persistence, or migration work is required.

## Verification / Rollout

An Electron regression will assert that the button creates exactly two grid rows
and that every visible child remains within its border box at normal and compact
supported widths. Existing workspace and onboarding coverage will protect click,
popover, and navigation behavior.
