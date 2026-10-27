---
status: accepted        # implemented on feat/ai-assembly 2026-10-27
affects: ["Part 3 (FR-005)", "Part 9 (external calls, cost, audit)", "Amendment 005 (workflow phase tabs)"]
brd_ids: [FR-005, NFR-006, NFR-007]
author: Claude Sonnet 5.5, from creator requirements 2026-10-27
date: 2026-10-27
---

# Amendment 008 — AI-assisted rough-cut assembly

## Problem

Raw footage with many retakes had to be assembled by hand. Creators want a first-draft
cut that follows their retake conventions, asks when unsure, and stays reviewable.

## Change

An **Assemble** panel (Cut tab right-top, Ingest tab right-bottom) runs an
analyze → conversation → plan → proposal flow. Design and plan:

- Design: [`docs/superpowers/specs/2026-10-27-ai-assembly-design.md`](../superpowers/specs/2026-10-27-ai-assembly-design.md)
- Plan: [`docs/superpowers/plans/2026-10-27-ai-assembly.md`](../superpowers/plans/2026-10-27-ai-assembly.md)
- Creator-facing description: MANUAL.md, "Assemble a rough cut (AI)".

Only the evidence text and conversation are sent to the provider; `network.externalCalls`
(`allow|ask|block`) is honoured; every call is cost-metered and audited
(`external.call` + `cost.charge`); keys live in the OS-encrypted store.

## New persisted names

- Sidecar `guyditor.assembly/v1` at `sidecars/assembly/<asb_id>.json`; script copy at
  `sidecars/scripts/<asb_id>.script.md`.
- Id prefix **`asb`** (`asb_` + 10 base32 characters).
- Settings key `ai` in `settings.json`: `provider` (`anthropic|openai`), `model`,
  `effort`, `tightening` (`ask|gentle|off`, default `ask`), `rates` (per-model $/M tokens).
  Existing keys reused: `network.externalCalls`, `budgets.*`.
- Env var `GUYDITOR_ASSEMBLY_STUB=1` selects the deterministic stub provider (tests).
- Filler rule set `GENTLE_FILLER_RULE_SET` for post-assembly tightening.

## Known limitations

- Single camera only; the model is not told about separate audio recordings.
- Prepare waits for in-flight transcription but does not start it (import does).
- Real-provider calls were not exercised by automated tests (stub only).
- Review markers and the gentle-tightening proposal are created when the assembly proposal is accepted, not at Create proposal.
- The conversation stops after 12 assistant replies; if still a question there is no plan and the creator must Start over.
- Assembly proposals are born stale; each accept needs one rebase ("Rebase + accept").

## Migration

None: new sidecar kind and a new `ai` settings block with defaults.
