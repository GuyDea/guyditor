# Segmented AI Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The creator explicitly requires inline execution on `impl/restyle-001`, with no worktree, branch creation, commits, or design-approval pauses.

**Goal:** Implement Amendment 001 FR-607 and FR-608: a secure restyle-adapter boundary, isolated Kling live API integration with deterministic FFmpeg fallback, semantically snapped segmentation plans, plan-level cost control, queued generation, immutable accepted assets, reviewable placement, and overlap staleness. FR-609 seam concealment remains deliberately out of scope.

**Architecture:** Core owns the versioned `guyditor.restyle/v1` sidecar, proposal-only restyle operations, immutable provenance/rights records, and commit-time stale marking. Deliver owns pure segmentation planning because it converts timeline/transcript/analysis signals into a delivery-specific plan without provider calls or project mutation. Agent owns adapter discovery, credentials, the isolated Kling API boundary, cost preflight, and JobQueue orchestration. Media owns deterministic timeline extraction and stub filtering; render consumes accepted frozen assets as ordinary full-frame, timeline-anchored video items. App wires Electron safeStorage, non-secret adapter settings, review controls, and the external-wait overview source.

**Tech Stack:** TypeScript strict, JSON Schema, Node filesystem/crypto/fetch, Electron safeStorage, FFmpeg/FFprobe, SQLite JobQueue, React 18, Vitest, Playwright.

---

### Task 1: Define the core restyle contract and proposal operations

**Files:**
- Create: `packages/core/schema/sidecars/guyditor-restyle-v1.schema.json`
- Create: `packages/core/src/restyle/types.ts`
- Create: `packages/core/src/restyle/sidecar.ts`
- Create: `packages/core/src/restyle/operations.ts`
- Create: `packages/core/src/restyle/restyle.test.ts`
- Modify: `packages/core/src/project/model.ts`
- Modify: `packages/core/src/operations/engine.ts`
- Modify: `packages/core/src/operations/index.ts`
- Modify: `packages/core/src/index.ts`
- Add: `packages/core/src/operations/schemas/restyle.plan.create.json`
- Add: `packages/core/src/operations/schemas/restyle.segment.approve.json`

- [x] Write failing tests for schema round-tripping, deliverable coverage settings, consequential/proposal-only enforcement, and exact-range overlay placement.
- [x] Run `pnpm exec vitest run packages/core/src/restyle/restyle.test.ts` and confirm the imports/operations fail.
- [x] Add strict types for adapter constraints, plans, chunks, status, semantic anchors, provider provenance, and rights metadata; ship and export the v1 schema.
- [x] Register `restyle.plan.create` and `restyle.segment.approve` as consequential operations. The plan operation stores coverage plus a deterministic sidecar reference. Approval adds the frozen asset/provenance reference and inserts a full-frame video item on a dedicated top layer at the chunk's exact timeline range, retaining source audio from the underlying sequence.
- [x] Re-run the focused core tests green.

### Task 2: Add canonical sidecar promotion, frozen assets, and self-contained staleness

**Files:**
- Modify: `packages/core/src/store/store.ts`
- Modify: `packages/core/src/store/store.test.ts`
- Modify: `packages/core/src/store/history.ts`
- Modify: `packages/core/src/restyle/sidecar.ts`

- [x] Write failing store tests proving accepted plan proposals materialize `sidecars/restyle/*.json`, accepted chunk proposals promote cache output into `media/generated`, write immutable provenance, and update references/hashes before the canonical master is committed.
- [x] Add a failing overlap test: an accepted trim that changes a chunk's source interval marks that chunk stale, while non-overlap leaves it current.
- [x] Implement deterministic commit-time materialization and rollback-safe file handling through ProjectStore, including read-only frozen assets and sidecars.
- [x] Compare accepted before/after timeline ranges for non-restyle edits and update only overlapping restyle chunks. Keep this local dependency shape explicitly compatible with later FR-807 unification.
- [x] Re-run store/restyle tests green.

### Task 3: Implement deterministic semantic segmentation in deliver

**Files:**
- Create: `packages/deliver/src/restyle-planner.ts`
- Modify: `packages/deliver/src/index.ts`
- Modify: `packages/deliver/src/index.test.ts`
- Modify: `packages/deliver/package.json`
- Modify: `scripts/make-fixtures.mjs`
- Modify: `scripts/make-fixtures.test.mjs`

- [x] Write failing planner tests over the speech+bars fixture for full and targeted coverage, silence snapping, chunk caps, semantic anchors, deterministic ordering, and exact cost totals.
- [x] Add edge-case tests for a range shorter than the cap, resolution/fps rejection, and no-word fallback to low-motion or a hard cap.
- [x] Run the focused deliver/fixture tests red.
- [x] Implement a pure planner that normalizes coverage, greedily chooses the best boundary at or before each cap from VAD silence centers, low-motion frames, word gaps, and beats using stable priorities/distance tie-breaks, then computes per-chunk and total adapter cost.
- [x] Extend generated fixture analysis inputs with deterministic VAD/scene signals and run the focused tests green.

### Task 4: Implement credentials, registry, Kling, and deterministic media fallback

**Files:**
- Create: `packages/agent/src/adapters/types.ts`
- Create: `packages/agent/src/adapters/credentials.ts`
- Create: `packages/agent/src/adapters/registry.ts`
- Create: `packages/agent/src/adapters/kling-api.ts`
- Create: `packages/agent/src/adapters/kling.ts`
- Create: `packages/agent/src/adapters/adapters.test.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/package.json`
- Create: `packages/media/src/restyle.ts`
- Create: `packages/media/src/restyle.test.ts`
- Modify: `packages/media/src/index.ts`

- [x] Write failing tests for canonical-name registry lookup, non-secret config/credential separation, 0600 fallback storage, injected encrypted storage, exact-value scrub compatibility, provider polling, and stub selection when forced or uncredentialed.
- [x] Write failing FFmpeg tests for deterministic extraction and a visibly changed, duration/resolution/fps-preserving stub output.
- [x] Implement `RestyleAdapter` and async job interfaces beside generate capabilities. Add registry configuration that stores only credential references.
- [x] Implement file-mode-0600 and injected safe-storage credential backends outside projects.
- [x] Isolate the assumed current Kling Bearer-auth REST shape in `kling-api.ts`; label base URL, endpoints, multipart payload, task polling, and output mapping `PROVIDER-VERIFY` so a provider correction changes one file.
- [x] Implement the Kling adapter and deterministic `curves+hue` FFmpeg mode with `maxSegmentSeconds: 10`; run focused tests green.

### Task 5: Queue and execute accepted plans with one whole-plan preflight

**Files:**
- Create: `packages/agent/src/restyle-execution.ts`
- Create: `packages/agent/src/restyle-execution.test.ts`
- Modify: `packages/agent/src/cost-meter.ts`
- Modify: `packages/agent/src/cost-meter.test.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/core/src/jobs/types.ts`

- [x] Write failing integration tests proving one plan-level preflight occurs before any enqueue/provider call, tiny budgets block the entire plan, warning confirmation is explicit, and every chunk becomes a dependency-aware `restyle.generate` job.
- [x] Add failing assertions that active polling appears in `waitingOnExternal` with provider, elapsed seconds, and spend, and completion creates a `restyle.segment.approve` proposal rather than mutating the timeline.
- [x] Implement execution orchestration: materialize source chunks, submit/poll/fetch, record actual spend, hash cached results, build complete provenance/rights, and create approval proposals.
- [x] Keep provider calls inside the registered adapter and make polling/backoff injectable and deterministic in tests.
- [x] Re-run agent integration tests green.

### Task 6: Prove render placement and expose app review controls

**Files:**
- Modify: `packages/render/src/graph.ts`
- Modify: `packages/render/src/graph.test.ts`
- Create: `packages/render/test/golden/restyle.golden.test.ts`
- Add: `packages/render/test/golden/restyle.golden.json`
- Modify: `packages/app/src/main/settings.ts`
- Modify: `packages/app/src/main/index.ts`
- Modify: `packages/app/src/main/service-host.ts`
- Modify: `packages/app/src/main/surfaces.ts`
- Modify: `packages/app/src/shared/ipc.ts`
- Modify: `packages/app/src/preload/facade.ts`
- Create: `packages/app/src/renderer/panels/RestylePanel.tsx`
- Modify: `packages/app/src/renderer/App.tsx`
- Modify: `packages/app/src/renderer/styles.css`
- Modify: `packages/app/src/renderer/state/project-mirror.ts`
- Modify: `packages/app/package.json`
- Modify: `packages/app/e2e/workspace.spec.ts`

- [x] Write failing graph/golden coverage showing accepted full-frame restyle assets burn in only within their chunk ranges and visibly differ from the source.
- [x] Write failing settings/IPC/UI tests for non-secret adapter config, safeStorage injection, plan cost and chunk rows, boundary timeline markers, per-chunk status/actions, and provider external-wait rows.
- [x] Preserve accepted restyle placement as ordinary deterministic video overlays in the render graph; do not implement FR-609 seam effects.
- [x] Wire safeStorage-backed credentials and registry/execution services in main, add typed IPC, expose external waits to the existing global progress overview, and build an intentional compact restyle review panel.
- [x] Run focused render, app unit, build, and e2e tests green.

### Task 7: Traceability and full verification

**Files:**
- Modify: `docs/traceability.md`
- Modify: `scripts/check-conventions.mjs` only if the new schema/operation catalogs require an explicit convention rule

- [x] Mark FR-607 implemented with the Kling live path flagged `PROVIDER-VERIFY`, FR-608 implemented, FR-609 todo/next task, and NFR-006 plan-level preflight live, owned by Amendment 001 / Part 7.
- [x] Run exactly:

```sh
pnpm -r typecheck && pnpm -r lint && pnpm fixtures && pnpm exec vitest run && node scripts/check-conventions.mjs
pnpm exec vitest run --project golden
pnpm --filter @guyditor/app build && pnpm test:e2e
node scripts/gate.mjs m0 && node scripts/gate.mjs m1 -- --skip-dogfood && node scripts/gate.mjs m2 -- --skip-dogfood
```

- [x] Record exact pass counts/output and prepare the final handoff with interface summary, all `PROVIDER-VERIFY` assumptions, planner algorithm/placement/staleness notes, stub golden evidence, and verification results.
