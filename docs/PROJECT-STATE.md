# Guyditor — build state and resume guide

**Updated:** 2026-07-22
**Build model:** Codex CLI implements; Claude (Claude Code) coordinates, reviews, and commits.
To resume: open Claude Code in this directory and say "continue the Guyditor build"
(Claude's project memory carries the detailed resume procedure).

## Where things stand

- **`main`** contains milestones **M0, M1, M2, M3 complete** (automated gates green:
  645 unit/property tests, 21 Playwright e2e, golden + contract suites,
  AC-001..008 + 011 automated, AC-009 harness).
  Gate reports: `docs/gates/`. Requirement coverage: `docs/traceability.md`.
- **Amendment 001 (segmented AI restyle) is COMPLETE and merged** (a8953d5): adapter
  interface, Kling client (stub mode; live wire format PROVIDER-VERIFY-flagged in
  packages/agent/src/adapters/kling-api.ts), ≤10s segmentation planner with cost
  preflight, provenance freezing, staleness, and FR-609 seam concealment
  (interstitials + punch-in) with exact-frame resume proven by golden.
- **Amendment 002** (global progress visibility) implemented as FR-907.

## What Claude does on resume

1. M4 campaign (Priority D): editorial skills + preference examples, take
   comparison, B-roll adapters + provenance, specialist critic, archival/
   migration/backup hardening, AC-009/010/012.
2. On credentials: verify the Kling wire format against live docs (one file:
   `packages/agent/src/adapters/kling-api.ts`).

## Waiting on the creator (Martin)

- **Kling API credentials** — needed for live restyle calls (stored in OS keychain;
  stub mode works without them).
- **Real episode footage** — needed for the M1/M2/M3 dogfood episodes (M3 needs a
  long-form episode plus ≥2 published-quality shorts via upload kits) to formally
  close those milestones (`pnpm --filter @guyditor/app dev` launches the app).

## Useful commands

- `pnpm test` / `pnpm test:e2e` / `pnpm test:contract` / `pnpm test:golden`
- `node scripts/gate.mjs m0|m1|m2` (`-- --skip-dogfood` for m1/m2 until footage exists)
- `pnpm fixtures` — regenerate test media; `node scripts/video-zero.mjs` — M0 demo
- `bash workers/mlworker/setup.sh` — (re)provision the Python 3.11 ML worker via uv
