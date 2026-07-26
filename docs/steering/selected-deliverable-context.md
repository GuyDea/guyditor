# Steering Decision: Project-portable active deliverable context

- **Status:** Accepted
- **Date:** 2026-07-26
- **Owners:** Guyditor
- **Related:** `docs/superpowers/specs/2026-07-26-selected-deliverable-context-design.md`

## Context

Guyditor persists independent deliverables, but only Publish follows the renderer's
selected deliverable. Editing panels continue to target the canonical primary
deliverable, so a selected short cannot be edited as an independent distribution.
The creator also requires the last active distribution to autosave with the project
and reopen on another installation.

## Constraints

- Canonical edits must remain declarative, revisioned, reproducible, and renderable.
- Merely changing which distribution is visible must not create history, undo,
  staleness, or render churn.
- Existing projects must open without migration.
- Renderer filesystem access remains prohibited.
- Deriving a new short must continue to originate from the canonical primary
  deliverable.

## Decision

Store the active deliverable in a strict, optional
`workspace.guyditor.yaml` document at the project root. A main-process service owns
validation and atomic persistence through `ProjectStore` IPC methods. The renderer
uses one centralized active-deliverable resolver and activation action across all
editing and review panels.

On activation, stop playback, reset the playhead and timeline scroll, and clear
sequence-specific selections. Persist immediately. On missing, invalid, or stale
workspace state, fall back to the primary deliverable without blocking the project.

## Alternatives

### Canonical `episode.guyditor.yaml` field

Rejected because a view switch would either create meaningless canonical revisions or
bypass the store's history and reproducibility invariants.

### Renderer `localStorage`

Rejected because it is tied to one application installation and does not travel with
a copied or restored project.

### Session-only selection

Rejected because reopening the project would lose the creator's active distribution.

## Consequences

- Distribution selection becomes project-portable without changing render inputs.
- A second small project-root document becomes load-bearing for workspace
  convenience, so backup, restore, and storage accounting must include it.
- Corrupt workspace state can be ignored safely because canonical edits remain in
  `episode.guyditor.yaml` and registered sidecars.
- Concurrent external writers use last-successful-write semantics.

## Boundaries / Interfaces

- App main owns workspace-state IO.
- `ProjectStore` IPC exposes read and active-deliverable write methods.
- Renderer state owns the live selection and navigation reset.
- Core project schemas, operation catalogs, history, deliverable staleness, and
  render packages remain unchanged.

## Data / Migrations

The new `guyditor.workspace/v1` document requires `format` and
`activeDeliverableId` and rejects unknown fields. It is created for new projects and
on the first explicit selection in older projects. No canonical project migration is
required.

## Security / Scale

The main process resolves the workspace path under the already-open project root and
validates the ID against that project's deliverables. The document is tiny and writes
only on explicit distribution switches, so no debounce or background queue is
required.

## Verification / Rollout

Unit tests cover parsing, validation, atomic persistence, fallback, and backup. A
packaged Electron regression test proves that selecting a short changes every editor
surface, survives a fresh-profile restart, and does not alter canonical revision or
history. Removing the workspace document rolls behavior back to primary-deliverable
fallback without affecting the edit.

## Follow-ups

Persistence of per-deliverable playhead, zoom, and entity selections is intentionally
deferred until creator use demonstrates a need.
