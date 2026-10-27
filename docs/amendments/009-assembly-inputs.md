---
status: accepted        # implemented on feat/assembly-inputs 2026-10-27
affects: ["Part 3 (FR-005)", "Part 9 (external calls, cost, audit)", "Amendment 008 (AI assembly)"]
brd_ids: [FR-005, NFR-006, NFR-007]
author: Claude Sonnet 5.5, from creator requirements 2026-10-27
date: 2026-10-27
---

# Amendment 009 — Assembly inputs and local-CLI providers

## Problem

The assembly assistant only saw the transcript and one script. Creators have other
context (outlines, screenshots, PDFs) and already pay for `claude` / `codex` logins
they would rather use than manage an API key.

## Change

Context files can be attached to an assembly session (labels `F1…`; text inline,
images and PDFs as native inputs, anything else listed by name; size caps; a Script
dropdown; inputs read-only after Analyze). Each provider can be connected via an API
key or the creator's local CLI (`claude` / `codex`), confined to the session's context
directory, with a Check button; CLI cost is recorded as reported. The per-model rate
table is removed from the AI settings UI; `ai.rates` stays in `settings.json` and the
built-in rates still drive the pre-send cost gate.

- Design: [`docs/superpowers/specs/2026-10-27-assembly-inputs-design.md`](../superpowers/specs/2026-10-27-assembly-inputs-design.md)
- Plan: [`docs/superpowers/plans/2026-10-27-assembly-inputs.md`](../superpowers/plans/2026-10-27-assembly-inputs.md)
- Creator-facing description: MANUAL.md, "Assemble a rough cut (AI)".
- CLI dogfood: [`docs/dogfood/2026-10-27-assembly-cli.md`](../dogfood/2026-10-27-assembly-cli.md)

## New persisted names

- Context file copies at `sidecars/context/<asb_id>/<label>-<name>`.
- In `guyditor.assembly/v1`, amended in place (no migration): `inputs.files`,
  `inputs.script`, `inputs.nextFileLabel`, `settings.transport`. Sessions written before
  this change are skipped by the session list.
- Settings `ai.transport`, stored per provider (`{ anthropic, openai }`, each API key or
  CLI), and `ai.cli` (the `claude` / `codex` paths).
- Audit providers `claude-cli` and `codex-cli`.

## Known limitations

- No CLI streaming; replies arrive whole.
- Codex receives PDFs by file path, not as native attachments.
- Cancelling a turn does not kill a running CLI child; it stops at the 300 s timeout.
- The pre-send cost estimate for CLI turns is $0, because the CLI reports cost only afterwards.
- Real CLI runs are not covered by automated tests (dogfood pending).
- Codex's read confinement to the context directory (`--sandbox read-only -C`) is
  unverified until the dogfood confinement check runs.

## Migration

None.
