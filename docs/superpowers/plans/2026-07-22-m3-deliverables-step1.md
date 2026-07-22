# M3 Deliverables Step 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full platform profiles, short derivation/lifecycle/divergence, unified staleness and refresh review, AC-008, and the M3 partial gate.

**Architecture:** Core owns persisted types and accepted-transaction invariants; deliver owns profile I/O and pure derivation/candidate/refresh planning; agent and app adapt those services to gateway and UI boundaries. Exact half-open source intersections are shared by derivative and restyle staleness.

**Tech Stack:** TypeScript 5 strict mode, AJV 2020, YAML, Vitest/fast-check, Electron IPC, React 18, Playwright, Node gate scripts.

---

### Task 1: Complete and centralize platform profiles

**Files:**
- Create: `packages/deliver/src/profile.ts`
- Create: `packages/deliver/src/schemas/guyditor-profile-v1.schema.json`
- Create: `packages/deliver/src/profile.test.ts`
- Modify: `packages/deliver/src/index.ts`
- Modify: `packages/deliver/package.json`
- Modify: `packages/render/src/profile.ts`
- Modify: `packages/render/src/profile.test.ts`
- Modify: `packages/render/package.json`
- Create: `profiles/youtube-shorts/1.0.0.yaml`
- Create: `profiles/tiktok/1.0.0.yaml`
- Create: `profiles/instagram-reels/1.0.0.yaml`
- Modify: `profiles/youtube-longform/1.0.0.yaml`

- [ ] Add a test that imports `loadPlatformProfile`, loads all four exact pins, and asserts aspect, resolution, duration, loudness, safe areas, codec, caption defaults, metadata, cover, and chapter constraints.
- [ ] Run `pnpm exec vitest run packages/deliver/src/profile.test.ts` and confirm failure because the loader is absent.
- [ ] Implement `PlatformProfile`, JSON-Schema validation, project→user→built-in lookup, SHA-256 reporting, and `resolveProfileOverrides(profile, patch)` with recursive object merge and array/scalar replacement.
- [ ] Run the focused deliver profile test and confirm it passes.
- [ ] Replace render's filesystem loader with a narrow adapter over `loadPlatformProfile` that maps profile codec/audio values to FFmpeg settings; run `packages/render/src/profile.test.ts`.

### Task 2: Type and apply deliverable lifecycle operations

**Files:**
- Create: `packages/core/src/deliverables/types.ts`
- Create: `packages/core/src/deliverables/operations.ts`
- Create: `packages/core/src/deliverables/operations.test.ts`
- Create: `packages/core/src/operations/schemas/deliverable.derive.json`
- Create: `packages/core/src/operations/schemas/deliverable.status.set.json`
- Create: `packages/core/src/operations/schemas/deliverable.approve.json`
- Create: `packages/core/src/operations/schemas/deliverable.refresh.json`
- Modify: `packages/core/src/project/model.ts`
- Modify: `packages/core/src/project/index.ts`
- Modify: `packages/core/src/project/validate.ts`
- Modify: `packages/core/schema/guyditor-v1.schema.json`
- Modify: `packages/core/src/project/canonical.ts`
- Modify: `packages/core/src/operations/engine.ts`
- Modify: `packages/core/src/operations/types.ts`
- Modify: `packages/core/src/store/types.ts`

- [ ] Add lifecycle tests for one-longform invariants, independent short sequence creation, draft→in-review→approved, `approvedRevision`, invalid transitions, and proposal-only derive/refresh.
- [ ] Run the focused core test and confirm missing operation/schema failures.
- [ ] Implement typed `WordRange`, `SourceRangeRef`, `DependencyEntry`, `StaleReason`, `DivergenceClass`, operation schemas and applications. `deliverable.approve` records the operation's resulting revision.
- [ ] Add and fail tests that edit derivative clips without `OperationContext.divergence`, then implement closed-set validation and transaction/deliverable accumulation.
- [ ] Add and fail split/trim provenance tests, then update dependencies from before/after clip ranges and mark inserted derivative clips `origin: local`.
- [ ] Run the focused lifecycle suite and core project/schema tests.

### Task 3: Resolve selections and discover candidates

**Files:**
- Create: `packages/deliver/src/model.ts`
- Create: `packages/deliver/src/derivation.ts`
- Create: `packages/deliver/src/derivation.test.ts`
- Create: `packages/deliver/src/candidates.ts`
- Create: `packages/deliver/src/candidates.test.ts`
- Modify: `packages/deliver/src/index.ts`

- [ ] Add tests showing transcript word, explicit clip, beat span, and timeline range selections all resolve to ordered explicit `SourceRangeRef[]` with asset/range/word/longform clip anchors.
- [ ] Run the derivation test and confirm the APIs are missing.
- [ ] Implement exact sample→native-frame conversion and long-form timeline clipping, then build deterministic ID-populated `deliverable.derive` proposal parameters.
- [ ] Add candidate tests for duration filtering, >2-second silence splitting, hook/coherence/payoff scoring, 0.4/0.35/0.25 overall weights, must-include beats, >50% overlap suppression, evidence, and top-N ordering.
- [ ] Run candidate tests red, implement pure scoring and versioned revision cache serialization, then rerun green.

### Task 4: Unify staleness and build refresh proposals

**Files:**
- Create: `packages/core/src/deliverables/staleness.ts`
- Create: `packages/core/src/deliverables/staleness.test.ts`
- Modify: `packages/core/src/operations/engine.ts`
- Modify: `packages/core/src/store/store.ts`
- Create: `packages/deliver/src/refresh.ts`
- Create: `packages/deliver/src/refresh.test.ts`
- Modify: `packages/deliver/src/index.ts`

- [ ] Add a fast-check property asserting exact half-open overlap for random edit/dependency pairs, including touching-boundary non-overlap, and run it red.
- [ ] Implement `rangesOverlap`, word ordinal intersection, accepted change expansion, and stale-reason generation; use the same overlap function in restyle sidecar updates.
- [ ] Add AC-008 integration coverage: approve a derived short, hash its export fixture, accept overlapping trim, accept outside edit, assert one stale reason/affected range, refresh preview+diff, and unchanged hash.
- [ ] Add refresh tests for deleted/shrunk word anchors, preserved local/divergent clips, orphan explanations, stale-on-reject, and in-review-on-accept.
- [ ] Implement proposal construction plus preview job metadata and rerun focused core/deliver tests.

### Task 5: Expose agent gateway and app/UI flows

**Files:**
- Modify: `packages/agent/src/gateway.ts`
- Modify: `packages/agent/src/gateway.test.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/package.json`
- Modify: `packages/app/src/main/surfaces.ts`
- Modify: `packages/app/src/main/service-host.ts`
- Modify: `packages/app/src/main/surfaces.test.ts`
- Modify: `packages/app/src/shared/ipc.ts`
- Modify: `packages/app/src/renderer/ipc.ts`
- Modify: `packages/app/src/renderer/panels/StatusStripPanel.tsx`
- Create: `packages/app/src/renderer/panels/status-strip.test.ts`
- Modify: `packages/app/src/renderer/styles.css`

- [ ] Add a gateway test that calls `deliverable_candidates_discover`, verifies candidate records and disclosed criteria, and confirms audit data classes include transcript/metadata.
- [ ] Run the gateway test red, register the tool with an injected discovery service, then rerun green.
- [ ] Add service-surface tests for profile list, candidate list/discovery, derive proposal, lifecycle transitions, refresh proposal with preview, and divergence forwarding.
- [ ] Implement IPC schemas/services and candidate/preview job executors.
- [ ] Add a static-render UI test asserting profile constraints, status badge, affected source range, and refresh review controls; implement panel flows for transcript/candidate derivation, profile selection, approval/status, and refresh review.
- [ ] Run app unit tests and the relevant Playwright workspace spec.

### Task 6: Wire AC-008 into the M3 partial gate and traceability

**Files:**
- Modify: `scripts/gate.mjs`
- Modify: `scripts/gate.test.mjs`
- Modify: `docs/traceability.md`

- [ ] Add a gate test requiring FR-800 partial, FR-801/802/805/807 implemented, and AC-008 implemented with evidence, and assert M3 runs the partial command set plus `test:ac -- m3`.
- [ ] Run `node --test scripts/gate.test.mjs` and confirm M3 is rejected before implementation.
- [ ] Implement `M3_PARTIAL_COMMANDS`, traceability validation, report text, and `m3` argument handling; update the six traceability rows with exact test evidence and the real-model dogfood limitation.
- [ ] Rerun the gate unit test and `node scripts/gate.mjs m3 -- --skip-dogfood`.

### Task 7: Complete verification and review

**Files:** all task-owned paths above.

- [ ] Run `pnpm -r typecheck && pnpm -r lint && pnpm fixtures && pnpm exec vitest run && node scripts/check-conventions.mjs` and retain the exit status/output summary.
- [ ] Run `pnpm exec vitest run --project golden`, `pnpm --filter @guyditor/app build`, and `pnpm test:e2e`.
- [ ] Run M0, M1, M2, and M3 gates with the requested dogfood flags.
- [ ] Inspect `git diff --check`, `git status --short`, and the complete task diff; do not stage or commit.
- [ ] Re-read Part 11 and AC-008, map every in-scope clause to code/tests, and report any residual limitation explicitly.
