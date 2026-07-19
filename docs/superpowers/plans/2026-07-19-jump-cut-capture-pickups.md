# Guyditor M2 Jump-Cut, Capture, Takes, and Pickups Implementation Plan

> **For agentic workers:** Execute inline on `impl/m2-priority-b`; the repository owner explicitly forbids subagents, worktrees, commits, and design-approval pauses for this task. Use test-first steps and keep all generated edits unstaged.

**Goal:** Implement FR-311 jump-cut concealment, FR-009 capture watching, FR-010 take markers, and the import-only FR-011 pickup workflow as review-gated, exact-time features.

**Architecture:** Core owns durable capture/take models and semantic operations plus concealment proposal generation. Media owns stable-file watching, capture naming/session parsing, ingest-job chaining, and pickup-file import; transcript owns intake marker conversion, spoken detection, pickup alignment/retiming, and caption impact; render lowers static punch-in crops; app exposes validated services and creator review surfaces.

**Tech Stack:** TypeScript strict mode, AJV operation/project schemas, Node `fs.watch` with a pinned in-repository stability policy, SQLite-backed `JobQueue`, React/Electron IPC, Vitest, Playwright.

---

### Task 1: Jump-cut concealment and operations

**Files:**
- Create: `packages/core/src/assist/jumpcuts.ts`
- Create: `packages/core/src/assist/jumpcuts.test.ts`
- Create: `packages/core/src/operations/schemas/clip.punchin.set.json`
- Create: `packages/core/src/operations/schemas/clip.source.switch.json`
- Modify: `packages/core/src/operations/engine.ts`
- Modify: `packages/core/src/operations/clip.ts`
- Modify: `packages/core/src/assist/index.ts`

- [ ] Add failing tests for adjacent alternating zoom levels, feasibility limits, short/manual-transform fallbacks, synchronized-angle preference/N/A reporting, and proposal-only output.
- [ ] Run `pnpm exec vitest run packages/core/src/assist/jumpcuts.test.ts` and confirm failures are caused by the missing API.
- [ ] Add validated `clip.punchin.set` and `clip.source.switch` semantics, then generate one ready proposal with evidence-linked reasons and no direct-apply path.
- [ ] Re-run the focused core tests and keep them green while refactoring.

### Task 2: Punch-in render lowering

**Files:**
- Modify: `packages/render/src/graph.ts`
- Modify: `packages/render/src/graph.test.ts`

- [ ] Add a failing graph test asserting a 1.25× centered/anchored punch-in becomes a static normalized crop plus deliverable-size scale.
- [ ] Run the focused test and confirm the current Part 6 unsupported error.
- [ ] Lower the crop factor deterministically and re-run render graph/filtergraph tests.

### Task 3: Take-marker contract and metadata

**Files:**
- Create: `packages/core/schema/sidecars/guyditor-take-markers-v1.schema.json`
- Create: `packages/core/src/takes/types.ts`
- Create: `packages/core/src/takes/sidecar.ts`
- Create: `packages/core/src/operations/schemas/asset.markers.attach.json`
- Create: `packages/core/src/operations/schemas/asset.takes.set.json`
- Create: `packages/transcript/src/take-markers.ts`
- Create: `packages/transcript/src/take-markers.test.ts`
- Modify: `packages/core/src/project/model.ts`
- Modify: `packages/core/src/operations/engine.ts`
- Modify: `packages/core/src/operations/asset.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/transcript/src/index.ts`

- [ ] Add failing fixtures/tests for JSON intake, notes intake, exact frame conversion with ties earlier, take assembly, and spoken phrases anchored to word IDs.
- [ ] Run the focused tests and confirm the new parsers/operations are absent.
- [ ] Implement strict persisted sidecars, import conversion, spoken candidate detection, and low-risk asset attachment operations.
- [ ] Re-run focused core/transcript tests and convention validation.

### Task 4: CaptureWatcher and job-chain visibility

**Files:**
- Create: `packages/media/src/capture-watcher.ts`
- Create: `packages/media/src/capture-watcher.test.ts`
- Modify: `packages/media/src/ingest.ts`
- Modify: `packages/media/src/index.ts`
- Modify: `packages/media/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/app/src/main/service-host.ts`
- Modify: `packages/app/src/shared/ipc.ts`
- Create: `docs/capture-integration.md`

- [ ] Add a failing temp-directory test: drop a fixture, wait through injected stability checks, parse `ses_` metadata, enqueue ingest/proxy/peaks/analysis/transcribe dependencies, emit `watcher.ingested`, reconcile idempotently, and import marker files.
- [ ] Run the focused test and confirm `CaptureWatcher` is missing.
- [ ] Implement the canonical service with injected clock/stability durations for fast deterministic tests and real 2 s + 3 s defaults.
- [ ] Re-run the watcher test and JobQueue overview tests.

### Task 5: Imported pickup proposal

**Files:**
- Create: `packages/transcript/src/pickup.ts`
- Create: `packages/transcript/src/pickup.test.ts`
- Create: `packages/core/src/operations/schemas/pickup.splice.json`
- Modify: `packages/transcript/src/engine.ts`
- Modify: `packages/transcript/src/captions/sync.ts`
- Modify: `packages/core/src/operations/engine.ts`
- Modify: `packages/app/src/main/service-host.ts`

- [ ] Add a failing round-trip test for imported pickup asset provenance, force-alignment confidence, word timing replacement, caption retime impact, continuity warnings, and ready proposal state.
- [ ] Run focused tests and confirm the pickup orchestration API is absent.
- [ ] Implement import-to-`media/pickups`, existing-worker job handoff, guarded splice operation dispatch, and proposal generation; surface low confidence without a splice.
- [ ] Re-run focused transcript/core tests.

### Task 6: Creator UI

**Files:**
- Modify: `packages/app/src/renderer/panels/TimelinePanel.tsx`
- Modify: `packages/app/src/renderer/panels/MediaBrowserPanel.tsx`
- Create: `packages/app/src/renderer/panels/CapturePanel.tsx`
- Create: `packages/app/src/renderer/panels/PickupWizard.tsx`
- Modify: `packages/app/src/renderer/App.tsx`
- Modify: `packages/app/src/renderer/styles.css`
- Modify: `packages/app/e2e/workspace.spec.ts`

- [ ] Add failing component/e2e assertions for timeline warning actions, watch-folder configuration, take browsing, pickup file import, and resulting proposals.
- [ ] Implement compact accessible controls using existing workspace panel and proposal conventions.
- [ ] Run app typecheck/build and the focused Playwright spec.

### Task 7: Traceability and complete verification

**Files:**
- Modify: `docs/traceability.md`
- Modify: `scripts/check-conventions.mjs` only when required for the new sidecar/operation schemas.

- [ ] Record FR-311 (angle-switch partial when model-only), FR-009, FR-010, FR-011 import-only/synthetic-voice exclusion, and FR-208 low-confidence behavior.
- [ ] Run every verification command from the task exactly as supplied and preserve truthful output for handoff.
