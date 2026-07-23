---
status: accepted        # accepted 2026-07-24 by the project owner (conversation)
affects: ["Part 10 §10.1 (workspace)", "Amendment 005 (phase tabs)"]
brd_ids: [FR-900, NFR-100]
author: Claude Fable 5 (coordinator), from creator requirements 2026-07-24
date: 2026-07-24
---

# Amendment 006 — Onboarding flow and in-app manual

## Problem

A first-time user faces fifteen panels across five tabs with no guidance, and the
feature manual exists only as a repo document.

## Proposed change

1. **First-run welcome**: on first launch (no prior project history), a welcome
   surface offering create/open project and an optional guided tour.
2. **Guided tour**: skippable, re-runnable coach-mark tour over the phase tabs,
   global progress bar, and each tab's curated panels; pure overlay, no gating.
3. **Getting-started checklist**: driven ONLY by real project events (project
   created → first import → transcript ready → first accepted edit → first
   proposal reviewed → first export); dismissible; lives in the help surface.
4. **In-app manual**: `docs/MANUAL.md` shipped with the build and rendered in a
   Help panel, searchable, plus the keyboard map. The repo file remains the
   single source; the app renders it verbatim.

All view-state/help surface only — no project-format or operation changes.
