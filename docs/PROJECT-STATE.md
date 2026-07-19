# Guyditor — build state and resume guide

**Updated:** 2026-07-19 (end of coordinated build session)
**Build model:** Codex CLI implements; Claude (Claude Code) coordinates, reviews, and commits.
To resume: open Claude Code in this directory and say "continue the Guyditor build"
(Claude's project memory carries the detailed resume procedure).

## Where things stand

- **`main`** contains milestones **M0, M1, M2 complete** (automated gates green:
  536 unit/property tests, 19 Playwright e2e, golden + contract suites,
  AC-001/002/003/004/005/006 automated, AC-009 harness).
  Gate reports: `docs/gates/`. Requirement coverage: `docs/traceability.md`.
- **Branch `impl/restyle-001`** (current): amendment 001 task in progress — restyle
  adapter interface, Kling adapter (deterministic stub mode until credentials exist),
  ≤10s segmentation planner with cost preflight. Work may sit **uncommitted** in the
  working tree awaiting Claude's review; do not discard it.
- **Amendments** (`docs/amendments/`): 001 segmented AI restyle (accepted; in
  progress), 002 global progress visibility (accepted; implemented as FR-907).

## What Claude does on resume

1. Review the uncommitted task-29 work (or resume the Codex session to finish it),
   run the full verification chain, commit.
2. Next task: FR-609 seam application (punch-in alternation + infographic
   interstitial templates on chunk boundaries).
3. Then: M3 campaign (shorts, vertical recomposition, publish kits).

## Waiting on the creator (Martin)

- **Kling API credentials** — needed for live restyle calls (stored in OS keychain;
  stub mode works without them).
- **Real episode footage** — needed to run the M1/M2 dogfood episodes and formally
  close those milestones (`pnpm --filter @guyditor/app dev` launches the app).

## Useful commands

- `pnpm test` / `pnpm test:e2e` / `pnpm test:contract` / `pnpm test:golden`
- `node scripts/gate.mjs m0|m1|m2` (`-- --skip-dogfood` for m1/m2 until footage exists)
- `pnpm fixtures` — regenerate test media; `node scripts/video-zero.mjs` — M0 demo
- `bash workers/mlworker/setup.sh` — (re)provision the Python 3.11 ML worker via uv
