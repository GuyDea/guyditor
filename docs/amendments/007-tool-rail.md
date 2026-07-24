---
status: accepted        # accepted 2026-07-24 by the project owner (conversation)
affects: ["Part 10 §10.1 (workspace)", "Amendments 004/005 (layout, phase tabs)"]
brd_ids: [FR-900, FR-907, NFR-100]
author: Claude Fable 5 (coordinator), from creator requirements 2026-07-24
date: 2026-07-24
---

# Amendment 007 — Master tool rail

## Problem

Collapsed panels live in per-region icon rails scattered around the screen; there
is no single inventory of all tools, no one place to expand/collapse them, and no
clear confirmation of where an activated tool appeared.

## Proposed change (owner design, coordinator refinements)

A **master tool rail** on the left-most edge, replacing all per-region collapse
rails:

1. Lists every panel, grouped under compact phase headers (Ingest / Cut / Polish /
   Review / Publish / System), forming a persistent capability map.
2. Per-entry state indicator: expanded in current tab · collapsed · lives in
   another tab. Click toggles expand/collapse; expanding a panel not in the
   current tab places it in its home region.
3. **Flash confirmation**: on expand, the target panel's border pulses briefly so
   the eye finds it immediately.
4. Waiting-on badges (FR-907 data) per entry, consistent with tab badges.
5. Rail is always visible, narrow, keyboard-navigable; layout persistence
   (layout/v2) absorbs the rail-driven collapse state.

Also: service-status footer messages ("RenderService is unavailable") are
suppressed while no project is open — neutral empty states instead of internal
error strings.

## Migration

View-state only. Per-region rails are removed; their collapse state maps to the
master rail.
