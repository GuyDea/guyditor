---
status: accepted        # accepted 2026-07-19 — creator requirement stated in conversation
affects: ["BRD §16 (FR-900)", "BRD §20 (NFR-100)", "Part 1 §1.7", "Part 10 §10.1"]
brd_ids: [FR-900, NFR-100, FR-1003]
author: Claude Fable 5 (coordinator), from creator requirements 2026-07-19
date: 2026-07-19
---

# Amendment 002 — Global progress visibility ("what are we waiting on?")

## Problem

NFR-100 makes expensive work visible as background jobs, and the workspace shows a job
list — but there is no single place that answers, at any moment, "what is the system
waiting on right now, and what is waiting on *me*?" The creator requires: track the
progress of every action, with one global progress indicator that expands on click into
the exact set of processes and pending edits currently being waited on.

## Proposed change

### New requirement FR-907 — Global progress and waiting-on view

1. **Global indicator.** The workspace MUST show a persistent, always-visible aggregate
   progress indicator (weighted by job cost estimate; indeterminate segments allowed)
   covering every active and queued `JobQueue` job in the open project.
2. **Waiting-on drill-down.** Activating the indicator MUST open a view listing, grouped
   and live-updating:
   - **Running jobs** — title, kind, per-job progress, ETA, cancel/retry controls
     (existing FR-1003 surface).
   - **Queued jobs with their dependency chains** — e.g. `transcribe` shown as blocked
     on `ingest` for the same asset. `JobQueue` gains explicit chain metadata
     (`dependsOn: jobId[]`) instead of implicit enqueue ordering.
   - **Waiting on the creator** — open proposals awaiting review, unresolved
     render-blocking annotations, and budget-confirmation prompts (NFR-006 tokens).
     This class is visually distinct: the system is not working, it is waiting for a
     decision.
   - **Waiting on external providers** — in-flight adapter calls (restyle/B-roll
     generations, amendment 001) with provider name, elapsed time, and spend so far.
3. **Empty state.** When nothing is pending, the indicator states so explicitly
   ("idle — no background work, nothing awaiting review").
4. **Queryability.** The aggregate is a single IPC/MCP query (`JobQueue.overview`) so
   the agent can answer "what are we waiting on" in conversation with the same data the
   UI shows (FR-901 single-surface rule).

### Spec changes

- Part 1 §1.7: add the overview query + chain metadata to the JobQueue contract.
- Part 10 §10.1: add the global indicator to the panel inventory with test IDs.
- Part 11/Part 7 (later): provider calls and derivative refreshes register in the
  waiting-on view when those features land.

## Migration

None — additive. `jobs.sqlite` gains a `dependsOn` column (nullable; existing rows
unaffected).

## Alternatives considered

- Toast/notification stream only — rejected: answers "what just happened," not "what
  are we waiting on."
- Per-panel spinners only — rejected: no global answer; the creator's stated need is a
  single point of truth.

## Implementation timing

First task of the M2 campaign, so all subsequent M2/M3 features (captions, keying,
generation calls) surface through it from day one.
