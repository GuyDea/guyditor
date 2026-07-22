# M3 Publish Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete deterministic output sets, publish documents, thumbnails, upload kits, batch export, the publish UI, AC-007/011, and the full M3 gate.

**Architecture:** Deliver owns pure publication rules and filesystem packaging, render owns media generation and validation, and core owns transactional publish state plus staleness. App and agent are adapters over those shared services.

**Tech Stack:** TypeScript 5 strict mode, Vitest, React 18, Electron IPC, YAML, `@napi-rs/canvas`, FFmpeg/FFprobe, persistent SQLite JobQueue.

---

### Task 1: Publish-domain primitives

**Files:** Create `packages/deliver/src/publish.ts`, `packages/deliver/src/publish.test.ts`; modify `packages/deliver/src/index.ts`.

- [ ] Write failing tests for Unicode metadata limits, counted hashtags, deterministic local drafting/provenance, exact chapter rules, stale-safe text serialization, transcript paragraph extraction, and deterministic six-frame ranking with one-second spacing.
- [ ] Run `pnpm exec vitest run packages/deliver/src/publish.test.ts` and confirm the missing API failure.
- [ ] Implement `validateMetadata`, `draftPublishMetadata`, `generateChapterList`, serializers, transcript extraction, and `selectCoverFrames` with typed inputs and deterministic ordering.
- [ ] Rerun the focused test and keep it green.

### Task 2: Transactional publish lifecycle

**Files:** Modify `packages/core/src/deliverables/types.ts`, `packages/core/src/project/model.ts`, `packages/core/src/deliverables/operations.ts`, `packages/core/src/deliverables/staleness.ts`, `packages/core/src/operations/engine.ts`, `packages/core/schema/guyditor-v1.schema.json`; create operation schemas; modify focused tests.

- [ ] Add failing tests showing metadata edits are low-risk transactions, publish approval records the approved revision, thumbnail selection is reversible, and a 30-frame long-form trim marks approved chapters stale without changing their text hash.
- [ ] Run the core deliverable/staleness tests and observe the missing operation/state failures.
- [ ] Add typed publish state and the three operations, register schemas/catalog entries, extend project schema, and mark only relevant approved artifacts stale in the accepted-transaction hook.
- [ ] Rerun focused core tests and project schema tests.

### Task 3: Output sets and export validation

**Files:** Create `packages/render/src/output-set.test.ts`, `packages/render/src/thumbnail.ts`, `packages/render/src/thumbnail.test.ts`; modify `packages/render/src/service.ts`, `packages/render/src/profile.ts`, `packages/render/src/index.ts`.

- [ ] Add failing tests for canonical output paths, output-set jobs/artifacts, `VAL-401` strict versus non-strict geometry, profile loudness targets/tolerances, and keyed/template thumbnail plans at cover dimensions.
- [ ] Run focused render tests red.
- [ ] Implement canonical paths, output-set finalization, candidate extraction, consolidated report data, profile audio fields, visual validation inputs, and deterministic thumbnail composition.
- [ ] Rerun focused render and existing golden lifecycle tests.

### Task 4: Publish files, kits, and batch chains

**Files:** Create `packages/deliver/src/publish-service.ts`, `packages/deliver/src/publish-service.test.ts`, `packages/deliver/src/batch-export.ts`, `packages/deliver/src/batch-export.test.ts`; modify `packages/core/src/jobs/types.ts`, `packages/core/src/jobs/queue.ts`, queue tests, and deliver exports/dependencies.

- [ ] Add failing tests for atomic YAML/text writes with `publishFiles` hashes, complete short/long-form kits, no destination on validation failure, independent batch failures, terminal parent aggregation, and failed-only retry.
- [ ] Run the focused tests red.
- [ ] Add terminal dependency mode to JobQueue, implement `PublishService` and `BatchExportService`, and return stable per-item envelopes.
- [ ] Rerun focused queue/deliver tests.

### Task 5: Gateway and application publish workspace

**Files:** Modify `packages/agent/src/gateway.ts` and tests; modify app service host/surfaces/shared IPC; create `packages/app/src/renderer/panels/PublishPanel.tsx` and test; modify `App.tsx`, view state, panel numbering, and styles.

- [ ] Add failing gateway coverage for `deliverable_metadata_draft` inputs/provenance and app surface tests for publish state, save/approve/generate/select/build/batch methods.
- [ ] Add a failing static UI test for limit indicators, stale chapter badge, candidate picker, kit action, and per-item batch status.
- [ ] Register gateway/IPC adapters and implement the release-ledger panel with accessible labels and explicit failure guidance.
- [ ] Run focused agent/app tests and app build.

### Task 6: AC fixtures, gate, and traceability

**Files:** Create AC-007/011 tests in deliver/render; modify `scripts/test-ac.mjs`, `scripts/gate.mjs`, their tests, fixture scripts as required, and `docs/traceability.md`.

- [ ] Add failing gate tests requiring FR-800..813 and AC-007/008/011 as implemented and the complete §14.8 command sequence.
- [ ] Add AC-007 assertions for three 1080×1920 profile exports, loudness, both videos, subtitles, covers, reports, shared ordinals, and preserved crop override.
- [ ] Add AC-011 assertions for long/short kit manifests, over-limit metadata rejection, and stale chapters after a 30-frame trim with unchanged text bytes.
- [ ] Wire both suites into `test:ac m3`, update every traceability row with exact evidence, and rerun targeted suites.

### Task 7: Full verification

- [ ] Run `pnpm -r typecheck && pnpm -r lint && pnpm fixtures && pnpm exec vitest run && node scripts/check-conventions.mjs`.
- [ ] Run `pnpm exec vitest run --project golden`, app build, and Playwright e2e.
- [ ] Run M0, M1, M2, and M3 gates with the requested skip flags.
- [ ] Run `git diff --check`, inventory task-owned files, and report output-set/kit contents plus the metadata-limit, stale-chapter, AC-007, and AC-011 evidence without committing.
