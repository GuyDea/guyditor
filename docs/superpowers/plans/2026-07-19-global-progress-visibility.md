# Global Progress Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The creator explicitly requires inline execution on `impl/m2-priority-b`, with no worktree and no commits.

**Goal:** Implement Amendment 002 / FR-907 as one dependency-aware JobQueue overview shared by core, IPC, MCP, and the persistent workspace progress UI.

**Architecture:** Persist job dependency IDs as nullable JSON and make scheduling eligibility a database-backed dependency decision. `JobQueue.overview()` combines one job query with injected creator-wait sources, returning typed running, queued-chain, failed-retryable, creator, external, aggregate, and idle fields; the app supplies proposals, blocking annotations, and CostMeter confirmations, while the gateway calls the same queue method. A focused React title-bar component re-queries that overview after every droppable job/proposal/annotation event, ignores stale responses, and uses a bounded poll so process-local confirmation tokens also stay live.

**Tech Stack:** TypeScript strict, Node `DatabaseSync`, Electron typed IPC, MCP SDK + Zod, React 18, Zustand, Vitest, Playwright.

---

### Task 1: Persist and schedule dependency chains

**Files:**
- Modify: `packages/core/src/jobs/types.ts`
- Modify: `packages/core/src/jobs/queue.ts`
- Test: `packages/core/src/jobs/queue.test.ts`

- [x] **Step 1: Write failing dependency and migration tests**

Add tests that enqueue `ingest → proxy → transcribe`, assert only `ingest` starts, release each executor in turn, and assert FIFO dependency order. Add failure/cancellation propagation assertions for `E_JOB_DEPENDENCY_FAILED` with `retry: "safe"`; retrying either the root or failed leaf must re-queue the failed/cancelled ancestors and dependency-failed descendants. Create a legacy SQLite file with the pre-amendment `jobs` table, open it, and assert existing rows read with `dependsOn: []` and `PRAGMA table_info(jobs)` contains nullable `dependsOn`.

- [x] **Step 2: Run the focused tests and observe the missing API/migration failures**

Run: `pnpm exec vitest run packages/core/src/jobs/queue.test.ts`

Expected: FAIL because `EnqueueJobInput` does not accept `dependsOn`, persisted rows do not expose it, the scheduler ignores dependencies, and the legacy table is not altered.

- [x] **Step 3: Add the typed column and scheduler semantics**

Extend the public types with `dependsOn?: string[]` on enqueue and `dependsOn: string[]` on records/status. Add `dependsOn TEXT CHECK(dependsOn IS NULL OR json_valid(dependsOn))` to new databases plus a guarded `ALTER TABLE jobs ADD COLUMN dependsOn TEXT` migration. Validate dependency IDs, existence, and uniqueness at enqueue. Resolve queued jobs only when every direct dependency is `done`; atomically fail blocked descendants when any dependency is `failed` or `cancelled`, using:

```ts
makeGuyditorError("E_JOB_DEPENDENCY_FAILED", message, {
  affected: [job.jobId, ...failedDependencyIds],
  retry: "safe",
  suggestion: "Retry this job to re-queue its dependency chain.",
})
```

Implement retry as a transaction over the selected job's failed/cancelled ancestors and all downstream jobs failed specifically by `E_JOB_DEPENDENCY_FAILED`, preserving completed ancestors and emitting a `job.state` event for every re-queued record.

- [x] **Step 4: Run the focused tests green**

Run: `pnpm exec vitest run packages/core/src/jobs/queue.test.ts`

Expected: PASS.

### Task 2: Build the single overview query and CostMeter source

**Files:**
- Modify: `packages/core/src/jobs/types.ts`
- Modify: `packages/core/src/jobs/queue.ts`
- Test: `packages/core/src/jobs/queue.test.ts`
- Modify: `packages/agent/src/cost-meter.ts`
- Test: `packages/agent/src/cost-meter.test.ts`

- [x] **Step 1: Write failing overview and confirmation tests**

Inject one ready proposal, one `VAL-400` annotation warning, and one cost confirmation; enqueue a running job at progress `0.5` with ETA `9` plus a queued dependency job without ETA. Assert the overview shape is:

```ts
{
  running: JobStatus[],
  queued: Array<JobStatus & { dependencyChain: JobDependencyNode[] }>,
  retryable: JobStatus[],
  waitingOnCreator: { proposals: CreatorProposalWait[]; annotations: CreatorAnnotationWait[]; confirmations: CreatorConfirmationWait[] },
  waitingOnExternal: ExternalProviderWait[],
  aggregateFraction: number,
  idle: boolean,
}
```

Assert ETA-known jobs use ETA as cost weight, ETA-unknown jobs use weight `1`, an empty active set has aggregate `1`, and `idle` is true only when all four groups and the failed-retryable set are empty. Assert CostMeter warning preflights appear in `outstandingConfirmations(projectId)` and recording the matching task clears them.

- [x] **Step 2: Run focused tests red**

Run: `pnpm exec vitest run packages/core/src/jobs/queue.test.ts packages/agent/src/cost-meter.test.ts`

Expected: FAIL because `overview()` and outstanding confirmation tracking do not exist.

- [x] **Step 3: Implement overview sources and aggregate math**

Add optional async `overviewSources` callbacks to `JobQueueOptions`, resolve recursive dependency nodes from the active-job rows, and query sources concurrently. Calculate:

```ts
const weight = job.etaSeconds !== undefined && job.etaSeconds > 0
  ? job.etaSeconds
  : 1;
aggregateFraction = active.length === 0
  ? 1
  : sum(active.map(job => job.progress * weight(job))) / sum(active.map(weight));
```

Keep `waitingOnExternal` typed and empty until adapters register a source. Track CostMeter warning results by confirmation token in memory with project/task/estimate/message/created time, expose cloned outstanding records, and clear the matching task when actual cost is recorded.

- [x] **Step 4: Run focused tests green**

Run: `pnpm exec vitest run packages/core/src/jobs/queue.test.ts packages/agent/src/cost-meter.test.ts`

Expected: PASS.

### Task 3: Retrofit ingest and expose IPC/MCP parity

**Files:**
- Modify: `packages/media/src/ingest.ts`
- Test: `packages/media/src/ingest.test.ts`
- Modify: `packages/app/src/shared/ipc.ts`
- Modify: `packages/app/src/main/surfaces.ts`
- Modify: `packages/app/src/main/service-host.ts`
- Test: `packages/app/src/main/surfaces.test.ts`
- Test: `packages/app/src/main/service-host.test.ts`
- Modify: `packages/agent/src/gateway.ts`
- Modify: `packages/agent/src/gateway.test.ts`
- Modify: `packages/agent/test/stub-director/index.ts`
- Modify: `packages/app/e2e/ac/ac004.spec.ts`

- [x] **Step 1: Write failing media, IPC, and gateway tests**

Assert proxy/peaks/transcribe follow-ups each persist `dependsOn: [ingestJobId]`. Assert the JobQueue manifest contains `overview` with empty params and `budgetMs: 20`, the window service returns all creator-wait groups, and MCP lists/calls `progress_overview` with the identical result.

- [x] **Step 2: Run the focused tests red**

Run: `pnpm exec vitest run packages/media/src/ingest.test.ts packages/app/src/main/surfaces.test.ts packages/app/src/main/service-host.test.ts packages/agent/src/gateway.test.ts`

Expected: FAIL on missing dependency metadata, IPC method, and MCP tool.

- [x] **Step 3: Wire the shared query**

Pass the running ingest job ID into follow-up enqueueing. Add `dependsOn` to public IPC job status and the typed overview interfaces. Configure `JobQueue.open` in `WindowServiceHost` with callbacks that return active ready proposals, blocking open/reopened annotations as `VAL-400` warnings, and `CostMeter.outstandingConfirmations(projectId)`. Add `overview: () => project.jobs.overview()` to the JobQueue IPC service and register `progress_overview` in `AgentGateway` against its supplied JobQueue overview dependency.

- [x] **Step 4: Run the focused tests green**

Run: `pnpm exec vitest run packages/media/src/ingest.test.ts packages/app/src/main/surfaces.test.ts packages/app/src/main/service-host.test.ts packages/agent/src/gateway.test.ts`

Expected: PASS.

### Task 4: Add the persistent progress control and popover

**Files:**
- Create: `packages/app/src/renderer/GlobalProgress.tsx`
- Modify: `packages/app/src/renderer/App.tsx`
- Modify: `packages/app/src/renderer/styles.css`
- Modify: `packages/app/src/renderer/state/jobs.ts`
- Test: `packages/app/src/renderer/state/workspace.test.ts`

- [x] **Step 1: Write failing renderer-store tests**

Extend the job store test to assert overview replacement and event-driven refresh state. Assert idle text derives from `idle`, waiting count sums the three creator arrays, and job actions update through a subsequent overview replacement rather than trusting events as durable state.

- [x] **Step 2: Run renderer tests red**

Run: `pnpm exec vitest run packages/app/src/renderer/state/workspace.test.ts`

Expected: FAIL because the store has no overview mirror.

- [x] **Step 3: Implement the title-bar control**

Create `GlobalProgress` with stable IDs `global-progress`, `global-progress-fill`, `global-progress-waiting-count`, and `global-progress-popover`. Show percentage/active count during work, “Waiting on you” as an amber badge, and exact idle copy from the amendment. Render four live groups; show recursive dependency labels; expose cancel/retry buttons; focus/expand proposal rows; select/focus/seek annotations. In `App`, call `JobQueue.overview` after `job.state`, `job.progress`, `proposal.updated`, and `annotation.updated`, satisfying droppable-event re-query behavior.

- [x] **Step 4: Run renderer tests and app typecheck**

Run: `pnpm exec vitest run packages/app/src/renderer/state/workspace.test.ts && pnpm --filter @guyditor/app typecheck`

Expected: PASS.

### Task 5: Prove the end-to-end behavior and traceability

**Files:**
- Modify: `packages/app/e2e/workspace.spec.ts`
- Modify: `packages/app/e2e/helpers/workspace-project.ts`
- Modify: `docs/traceability.md`

- [x] **Step 1: Add the Amendment 002 e2e scenarios**

Add Playwright coverage that starts an ingest, opens the global popover, observes proxy queued with ingest in its dependency chain, then waits for the idle copy. Add a ready-proposal fixture assertion for the waiting badge and jump action. Seed a cancellable unsupported queued job in the project queue and cancel it from the popover, asserting its persisted state becomes `cancelled` without fixed sleeps.

- [x] **Step 2: Run the focused e2e red/green loop**

Run: `pnpm --filter @guyditor/app build && pnpm test:e2e`

Expected before implementation completion: FAIL on missing global selectors; expected after completion: PASS.

- [x] **Step 3: Update traceability**

Add FR-907 owned by “Amendment 002 / Part 10”, status `implemented`, with core/media/agent/app unit and app e2e evidence. Expand FR-1003 to record explicit dependency chains, propagation/retry semantics, the shared overview, IPC/MCP parity, and global cancel/retry UI.

- [x] **Step 4: Run all required verification**

Run exactly:

```sh
pnpm -r typecheck && pnpm -r lint && pnpm exec vitest run && node scripts/check-conventions.mjs
pnpm --filter @guyditor/app build && pnpm test:e2e
node scripts/gate.mjs m0 && node scripts/gate.mjs m1 -- --skip-dogfood
```

Expected: all commands exit `0` with no failed test files/specs/gates.
