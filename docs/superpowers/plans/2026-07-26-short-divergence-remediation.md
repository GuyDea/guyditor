# Active-short divergence remediation

**Goal:** Every edit that changes a short must succeed with an accurate, durable
divergence class, while review, analysis, planning, and editing-control operations
must not create false divergences or trigger side effects before validation.

**Architecture:** A browser-safe derivative policy assigns every semantic operation
one of `content`, `non-editorial`, or `baseline`, plus a target resolver. The
operation engine validates the complete batch before dispatch, then retains its
post-apply scope check for generated entities. Renderer and service callers use
target-aware helpers so global/shared content is classified from the shorts it
actually affects rather than from the currently visible deliverable alone.

## Classification contract

| Intent | Divergence |
| --- | --- |
| Trim, split, join, remove, transcript range cut | `cuts` |
| Clip reorder | `order` |
| Gaps and overlaps | `pacing` |
| Caption track, style, breaks, emphasis, cue timing | `captions` |
| Crop, PiP placement, composition arrangement | `framing` |
| Graphics, visual layers, PiP chrome/motion, keying, matte acceptance, B-roll placement, accepted restyle pixels | `graphics` |
| Gain, fades, routing, channel mapping, loudness, ducking, audio layers, pickup audio | `audio` |

The new `audio` member is added to the closed schema/API set. The journal keeps its
existing one-class-per-transaction contract. A restyle acceptance uses its dominant
`graphics` intent even if its mechanical inverse also contains a seam punch-in.
Mixed bulk jump-cut proposals must be split by class instead of receiving an
arbitrary label.

These remain deliberately unclassified:

- annotations and annotation lifecycle (except conversion to a rendered overlay);
- layer lock/unlock;
- PiP avoid-region marking and avoidance preview;
- key QC, matte candidate generation, and diagnostic rendering;
- template installation/review;
- deliverable lifecycle, refresh baseline, and publish metadata/files;
- restyle plan and seam-treatment planning before pixels are accepted;
- canonical transcript word correction, navigation, and filler detection.

## Slice 1 — core policy and preflight

- Add `audio` to core types/schema and all IPC, store, and agent validators. Add a
  drift test so consumer enums cannot silently diverge.
- Add exhaustive derivative-impact/target policy for the operation catalog.
- Resolve short scope from actual sequence, clip, layer, caption, deliverable, and
  placed-item applicability.
- Preflight unknown/missing classification across the entire batch before any
  dispatcher callback or proposal persistence. Keep the post-apply check for new
  items/layers.
- Prove non-editorial operations do not require or record divergence; prove a batch
  containing analysis plus an unclassified short edit invokes no callback.

Commit: `feat(core): classify derivative audio and operation impact`

## Slice 2 — renderer callers

- Add a browser-safe target-aware helper.
- Classify Timeline, Transcript/Captions, Audio, PiP, Key, and Preview direct edits
  according to the table above.
- Preserve `undefined` for long-form-only and non-editorial operations.
- Test the same action against long-form, short-owned, and global/shared targets.

Commit: `fix(editor): classify active short edits`

## Slice 3 — services and proposals

- Classify accepted B-roll, accepted restyle results, neural matte acceptance,
  short template freeze, and jump-cut proposals.
- Keep restyle planning/baseline operations unclassified.
- Preserve proposal divergence through acceptance, supersede, and rebase.
- Perform file/job preflight before rendering, copying, chmod, or enqueueing.

Commit: `fix(services): preserve short edit divergence`

## Slice 4 — acceptance and verification

- Extend the packaged active-deliverable journey with representative short cuts,
  captions, audio/visual framing, and non-editorial review/analysis assertions.
- Verify transaction classes link to the selected short and non-editorial actions
  do not add divergence records.
- Run package typechecks/lint, unit tests, production build, targeted Electron, then
  the complete repository and packaged Electron suites.

Commit: `test(app): cover short edit divergence workflow`

