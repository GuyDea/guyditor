---
status: accepted        # accepted 2026-07-23 by the project owner (conversation)
affects: ["Part 10 §10.1 (workspace)", "Amendment 004 (layout system)", "FR-907 (waiting-on surfacing)"]
brd_ids: [FR-900, FR-907, NFR-100]
author: Claude Fable 5 (coordinator), from creator requirements 2026-07-23
date: 2026-07-23
---

# Amendment 005 — Workflow phase tabs (layout presets + badges, no gating)

## Problem

The workspace has grown well beyond the original seven panels (graphics, B-roll,
skills, restyle plans, key/PiP inspectors, storage, publish, ...). Showing
everything always overloads the screen and gives no sense of workflow progression.
The creator proposed top-level phase tabs; hard stage-gating was considered and
rejected (editing is iterative and agent proposals arrive asynchronously).

## Proposed change (owner decision: "layout presets + badges")

§10.1 gains a top-level **phase tab strip**: `Ingest · Cut · Polish · Review ·
Publish`. Each tab is a **curated layout preset** over the amendment-004 layout
system — a default panel arrangement suited to that phase:

- **Ingest**: media browser, capture/watch folders, job status, storage.
- **Cut**: transcript, timeline, preview, filler assist.
- **Polish**: preview, graphics/templates, key & PiP inspectors, captions, restyle.
- **Review**: proposals/agent, preview + annotations, take comparison, assessments.
- **Publish**: deliverables, kits, metadata/chapters/thumbnails, batch export, cost.

Rules:

1. **No gating** — every panel remains reachable from every tab; a tab is a
   default, and per-project customizations of a tab's layout persist (view state,
   layout/v2 extending layout/v1 with per-tab layouts; older state migrates by
   seeding the Cut tab with the previous single layout).
2. **Badges, not gates** — FR-907 waiting-on data badges the relevant tab (e.g.
   proposals pending → Review badge; export blockers → Publish badge; running
   ingest chain → Ingest badge). The global progress bar stays global.
3. Keyboard: tab switching shortcuts consistent with §10.9 conventions.
4. Reset-layout works per tab; "reset all tabs" restores the five defaults.

## Migration

View-state only; layout/v1 states seed the Cut tab. No project-format change.

## Alternatives considered

Single workspace with a next-step hint (too weak for 15+ panels); guided checklist
stages (over-opinionated, fights asynchronous agent work) — both offered to the
owner and declined in favor of presets + badges.
