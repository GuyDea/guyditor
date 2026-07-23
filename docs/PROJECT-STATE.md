# Guyditor — build state and resume guide

**Updated:** 2026-07-22
**Build model:** Codex CLI implements; Claude (Claude Code) coordinates, reviews, and commits.
To resume: open Claude Code in this directory and say "continue the Guyditor build"
(Claude's project memory carries the detailed resume procedure).

## Where things stand

- **`main` contains ALL milestones M0–M4 complete** (automated gates green:
  761 unit/property tests, 21 Playwright e2e, golden + contract suites,
  AC-001..012 automated portions). The full BRD Priority A–D scope plus both
  amendments is implemented. Gate reports: `docs/gates/`. Coverage:
  `docs/traceability.md`.
- **Amendment 001 (segmented AI restyle) is COMPLETE and merged** (a8953d5): adapter
  interface, Kling client (stub mode; live wire format PROVIDER-VERIFY-flagged in
  packages/agent/src/adapters/kling-api.ts), ≤10s segmentation planner with cost
  preflight, provenance freezing, staleness, and FR-609 seam concealment
  (interstitials + punch-in) with exact-frame resume proven by golden.
- **Amendment 002** (global progress visibility) implemented as FR-907.
- **User reference:** [`docs/MANUAL.md`](MANUAL.md) is the single source for the
  feature manual and is rendered verbatim in the app’s dockable Help panel.
- **Amendment 003 (motion design system) is COMPLETE and merged** (3e305f7):
  primitives/v1 (word-timed text reveals, springs, charts, cutouts, textures),
  SVG/font/Lottie brand assets (deterministic in-house Lottie subset interpreter
  with named-feature rejection), first-class template.freeze (empty projects can
  start from generated visuals — probe-verified), five Vox-style starter
  templates, and agent-authored templates (FR-612: submit→sandbox-validate→
  creator review→immutable publish; unreviewed drafts hard-blocked from
  deliverables).

## What Claude does on resume

1. Remaining engineering backlog (post-M4, no milestone owner): FR-202 script
   reconciliation, FR-903 comparison preview imagery, NFR-001..003
   formalization sweep, plus the 'partial' traceability rows — each carries an
   explicit deferral note in docs/traceability.md.
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
