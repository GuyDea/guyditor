---
status: accepted        # accepted 2026-07-23 by the project owner (conversation)
affects: ["Part 10 §10.1 (layout)", "Decision D10-01 clarification"]
brd_ids: [FR-900, NFR-100]
author: Claude Fable 5 (coordinator), from creator requirements 2026-07-23
date: 2026-07-23
---

# Amendment 004 — Panel management: reorder between docking regions

## Problem

§10.1 mandates resizable splitters and collapsible panels but fixes each panel to
its region. The creator requires reordering: moving panels between docking regions
(and stacking multiple panels in one region as tabs) so the workspace adapts to the
task at hand and to varying screen sizes. Panels currently clip on smaller layouts.

## Proposed change

§10.1 gains: panels are **assignable to any docking region** by dragging their
header; a region holding multiple panels renders them as tabs; the default
arrangement stays the §10.1 sketch; `layout` remains pure view state (per-project,
persisted, resettable to default). D10-01 (no free-floating windows) is unchanged.
Every panel must remain fully usable at its minimum size — content scrolls within
the panel rather than clipping (NFR-100 usability clause).

## Migration

None — additive view-state schema; older persisted layouts absent the new fields
reset to default.

## Alternatives considered

Free-floating tool windows — rejected, D10-01 stands. Fixed regions with only
resize/collapse — rejected: does not meet the creator's stated need.
