# Selected Deliverable Workspace Context Design

- **Status:** Approved
- **Date:** 2026-07-26
- **Branch:** `fix/selected-deliverable-context`
- **Related steering:** `docs/steering/selected-deliverable-context.md`

## Purpose

Guyditor already persists independent long-form and short deliverables, but the
renderer does not have one editor-wide deliverable context. Publish follows
`selectedDeliverableId`, while Preview, Timeline, Transcript, Graphics, B-roll, and
several inspectors continue to resolve `settings.primaryDeliverable`. Selecting a
short therefore does not make that short editable.

This change makes one active deliverable drive every editing and review surface. The
selection remains active across workflow phases, is restored when the project is
reopened, and travels with a copied or restored project.

## Goals

- Use one active deliverable across Status, Publish, Preview, Timeline, Transcript
  and Captions, Graphics, B-roll, PiP, Key Inspector, Restyle, and related editing
  actions.
- Persist the last active deliverable as project-portable workspace state.
- Autosave a distribution switch without creating a project revision, transaction,
  undo entry, staleness event, or render-input change.
- Reset sequence-specific navigation and selections when the active deliverable
  changes.
- Preserve primary-deliverable semantics for operations that inherently originate
  from the canonical long-form edit, including deriving a new short.
- Remain backward compatible with existing projects.

## Non-goals

- Persist arbitrary view state such as every playhead, timeline zoom, panel layout,
  or selected entity.
- Change canonical deliverable, sequence, caption, revision, or render schemas.
- Change how shorts are derived, refreshed, approved, or exported.
- Add multi-window conflict resolution beyond deterministic last-successful-write
  behavior.
- Address script reconciliation, stock search, progressive caption reveal, or the
  other independent review findings.

## Storage architecture

The project root gains one optional non-editorial document beside
`episode.guyditor.yaml`:

```yaml
format: guyditor.workspace/v1
activeDeliverableId: dlv_aaaaaaaaaa
```

The schema is closed: `format` and `activeDeliverableId` are required, and unknown
fields are rejected. The document contains no project path, timestamps, render
inputs, or volatile entity selections.

A main-process workspace-state service owns parsing, validation, fallback resolution,
and atomic temporary-file-plus-rename publication. The renderer never reads or writes
the filesystem directly.

The `ProjectStore` IPC surface gains:

- `getWorkspaceState`, returning the resolved workspace state and an optional
  non-fatal warning.
- `setActiveDeliverable`, validating that the requested deliverable exists before
  atomically saving and returning the new workspace state.

Project creation initializes the document with the new project's primary
deliverable. An older project without the document opens normally and resolves to
its primary deliverable.

The workspace document is excluded from:

- canonical project serialization and validation;
- history revisions and transaction journals;
- undo and redo;
- deliverable staleness;
- render locks, cache keys, export reports, and reproducibility inputs.

Storage accounting, backup collection, restore verification, and project-copy
workflows include the document as non-editorial project state.

## Renderer context

A shared pure resolver accepts a project snapshot and selected deliverable ID:

1. Return the selected deliverable when it still exists.
2. Otherwise return `settings.primaryDeliverable`.
3. If the primary reference is invalid, surface the existing project-invariant
   failure rather than guessing another deliverable.

All editing and review panels use this resolver instead of implementing their own
primary-deliverable lookup. The derivation source picker and other explicitly
master-origin operations continue to resolve `settings.primaryDeliverable`.

One centralized activation action replaces direct calls to
`selectDeliverable`. It:

- stops playback;
- selects the requested deliverable;
- resets the playhead and timeline scroll to frame zero;
- clears selected clip, layer, word, annotation, and transcript range;
- retains panel layout and timeline zoom;
- requests `setActiveDeliverable` through IPC;
- keeps the in-memory selection but shows a clear warning if persistence fails.

Every entry point that changes deliverable context, including Status cards, the
Publish selector, and proposal evidence navigation, uses this action.

## Open, refresh, and switch flow

### Opening or creating a project

1. Main opens the canonical project.
2. Renderer obtains the project snapshot and workspace state.
3. The stored ID is resolved against current deliverables.
4. Selection and navigation stores are initialized before the workspace is shown.
5. A non-fatal workspace warning is shown after fallback when the document was
   invalid.

### Refreshing the current project

Refreshing after a canonical revision keeps the current active deliverable when it
still exists. It does not reload an older selection from disk or reset navigation.
If the active deliverable was removed, the renderer falls back to primary, clears
invalid navigation state, and saves the corrected active ID.

### Switching distributions

The UI applies the reset and context switch immediately, then persists it. A failed
save does not send the creator back to the previous distribution or discard current
work; it produces an actionable autosave warning and the next explicit switch retries
publication.

## Compatibility and failure behavior

- Missing document: silently use primary.
- Invalid YAML or closed-schema violation: use primary and return a warning.
- Unsupported `format`: use primary and return a warning.
- Unknown or deleted deliverable ID: use primary and return a warning.
- Corrupt document: preserve its bytes until the creator explicitly selects a
  distribution; that successful selection replaces it atomically.
- Save failure: retain the active in-memory context and report that workspace
  preference autosave failed.
- Crash during save: atomic rename leaves either the previous complete document or
  the new complete document.
- Multiple external writers: last successful atomic write wins.

None of these workspace-state failures may prevent opening or editing the canonical
project.

## Panel behavior

The active context must control:

- Preview aspect, active clip, duration, caption frame, graphic frame, framing, PiP,
  keying, and annotation canvas.
- Timeline sequence, layers, clips, waveforms, seams, playhead, and edit targets.
- Transcript caption track, range-operation target sequence/layer, and caption
  correction calls.
- Graphics anchors, placement, editing, and freeze-to-clip targets.
- B-roll candidate placement targets.
- PiP, Key Inspector, and Restyle edit and preview targets.
- Publish metadata, output set, and batch-selection context.
- Status selection and proposal evidence navigation.

Creating a new derivative remains anchored to the primary long-form deliverable and
does not derive a short from whichever short happens to be active.

## Verification and acceptance

### Unit and integration coverage

- Parse and validate valid workspace documents.
- Resolve missing documents to primary without warning.
- Resolve corrupt, unsupported, and unknown-ID documents to primary with a warning.
- Atomically persist an existing deliverable ID and reject an unknown ID.
- Include `workspace.guyditor.yaml` in storage accounting, backup, restore, and
  project-copy verification.
- Resolve active deliverables and primary fallback through one shared pure helper.
- Reset playback, playhead, scroll, and sequence-specific selections on activation.
- Keep canonical revision and transaction history byte-identical across a
  distribution switch.
- Retain primary-source behavior in short derivation tests.

### Electron regression coverage

An end-to-end fixture contains visibly distinct long-form and short sequences,
profiles, clips, and caption tracks. The test:

1. Selects the short through Status or Publish.
2. Changes workflow phases.
3. Observes a portrait preview, the short sequence clips, and the short caption track.
4. Performs representative Graphics or B-roll placement and verifies the operation
   targets the short sequence.
5. Closes the application.
6. Reopens the same project with a fresh application user-data directory.
7. Observes that the short is still active.
8. Verifies the canonical revision and transaction journal did not change because of
   either selection.

### Completion gate

Run targeted workspace-state and renderer tests first, then package typecheck and
lint, the complete unit suite, and the packaged Electron E2E suite. No success claim
is made if active-deliverable behavior is only unit-tested or if the existing
derivation workflow regresses.
