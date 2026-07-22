# M3 publish packaging

Date: 2026-07-22

## Decision

Complete Part 11 through three focused boundaries:

- `@guyditor/deliver` owns deterministic publish documents, Unicode-aware profile
  validation, chapter and transcript derivation, cover ranking, upload-kit assembly,
  and batch orchestration.
- `@guyditor/render` owns file-producing media work: burned and clean variants,
  canonical subtitle sidecars, candidate-frame extraction, thumbnail composition,
  output-set reports, and pre-export visual/audio checks.
- `@guyditor/core` persists only reviewable publish lifecycle state and applies
  creator operations. Accepted timeline or transcript edits mark approved derived
  publish artifacts stale without rewriting their files.

The application composes these services for IPC. The agent gateway receives an
injected metadata drafter so its tool calls and the creator UI share the exact same
deterministic drafting path.

## Files and atomicity

Publish source files live below `publish/<deliverableId>/`; rendered output sets live
below `exports/<deliverableId>/`; upload kits live below
`exports/kits/<deliverableId>/<profile>@<version>/`. Every multi-file publication is
written in a sibling temporary directory and renamed only after validation succeeds.
Kit manifests contain relative paths and SHA-256/byte records for every copied file.

## Job topology

Each output set has burned and clean render jobs followed by one dependent finalizer
that extracts cover candidates and writes the consolidated report. A batch queues one
leaf chain per independently valid deliverable and one terminal-dependency parent.
The parent records every item state/error after all leaves finish. Retrying a batch
creates work only for failed items. Job overview exposes those chains unchanged.

## Publish lifecycle

`deliverable.metadata.set`, `deliverable.publish.approve`, and
`deliverable.thumbnail.select` are accepted operations. Metadata and chapter content
are mirrored in creator-editable YAML/text files with hashes in `publishFiles`.
Approved metadata becomes stale when transcript content changes. Approved chapters
become stale on timeline-shifting changes; their prior `chapters.txt` stays byte
identical and the project stores the warning/diff evidence used by the UI and kit
validator.

## Validation

Metadata limits count Unicode code points. Caption overflow and safe-area exclusions
are one `VAL-401` check with strict intersections failing and non-strict intersections
warning. Output profile settings and loudness use resolved profile values. Kit build
reruns export and metadata validation and refuses to create a destination directory
unless every required input passes.

## UI direction

The publish panel extends Guyditor's compact graphite editor. Its signature is a
per-deliverable release ledger: four terse rows for media, copy, chapters, and art,
each carrying status, validation counts, and its direct action. Amber remains the
action color, cyan identifies generated artifacts, red is reserved for stale/invalid
states, and the existing system/serif/monospace roles remain unchanged.

## Verification boundary

AC-007 covers three real vertical output sets and shared word ordinals; its real-model
coherence judgment remains dogfood. AC-011 covers long-form and short upload kits,
the deliberate metadata-overflow failure, and a 30-frame opening trim that preserves
the approved chapter text while surfacing stale state. The M3 gate enforces all
FR-800..813 and AC-007/008/011 rows as implemented and runs the full §14.8 command
matrix; only the explicit dogfood switch may skip the real-episode obligation.
