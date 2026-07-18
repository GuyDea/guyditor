---
status: accepted        # proposed | accepted | rejected — accepted 2026-07-18 by the project owner (conversation)
affects: ["BRD §13 (FR-600..606)", "BRD §10 (FR-311)", "BRD §19 (NFR-006)", "Part 7 §7.8–7.10", "Part 5 §5.3 (operation catalog)", "Part 11 (staleness)"]
brd_ids: [FR-603, FR-604, FR-605, FR-311, NFR-006]
author: Claude Fable 5 (coordinator), from creator requirements 2026-07-18
date: 2026-07-18
---

# Amendment 001 — Segmented AI restyling of primary footage with seam concealment

## Problem

The creator's workflow includes: shoot one long take → agent builds a condensed cut →
apply a generative video-to-video effect (e.g. Kling) to that footage. Video-to-video
providers cap input/output segments at ~10 seconds. The BRD covers generative **B-roll**
(FR-603..606: new footage from prompts) but not **restyling of primary footage**, and it
has no concept of provider-imposed segmentation. Chunking the edit into ≤10s provider
calls creates seams that did not exist in the source take; the creator wants those seams
hidden behind branded infographic/animation interstitials or punch-in alternation, with
playback resuming exactly where the previous chunk left off.

## Proposed change

### New BRD requirements (§13)

- **FR-607 — Primary-footage restyle adapters.** Video-to-video transformation of
  accepted timeline footage through provider adapters (the FR-604 interface extended
  with a `restyle` capability class alongside `generate`). Each adapter declares
  constraints: max segment duration, resolution/fps limits, cost per second. First
  concrete adapter: **Kling (direct API)**. Adapter calls are consent-gated external
  transfers (NFR-001/002) and budget-checked with a mandatory pre-flight total-cost
  estimate for the whole plan (NFR-006) — segmented restyling multiplies per-call costs.
- **FR-608 — Restyle segmentation planning.** Given a target range (or the whole
  deliverable) and an adapter's constraints, the system computes a segmentation plan:
  chunks ≤ the provider cap, boundaries snapped to word/beat boundaries and low-motion
  frames where possible, each chunk anchored semantically (FR-102/204). The plan is a
  reviewable proposal (FR-105) before any external call. Per-deliverable **coverage
  mode**: `selected-segments` (creator/agent marks passages) or `full` — chosen per
  episode.
- **FR-609 — Seam concealment.** Every planned seam gets a concealment treatment from
  a creator-approved set: (a) **infographic interstitial** — a parameterized template
  graphic (FR-600) fully covering the seam for a configurable 0.5–2 s, content resuming
  at the exact next source frame; (b) **punch-in alternation** — the FR-311 mechanism
  applied at restyle seams. Treatments are per-seam overridable and previewable
  (FR-903). Transition-preset seams are explicitly out of scope for v1 (creator
  decision 2026-07-18).
- **Provenance and staleness.** Restyled chunks are frozen generated assets (business
  rule 8, FR-605 provenance: prompt/settings/model/seed/source-range) referencing their
  source range. If an accepted edit changes footage under a restyled chunk, the chunk
  goes stale per the FR-807 mechanism (never silently regenerated, FR-1002).

### Spec changes

- Part 7 §7.8: add `restyle(segment, params)` to the adapter interface + constraint
  declaration (`maxSegmentSeconds`, `maxResolution`, `costPerSecond`); §7.9: concrete
  `adp_` Kling adapter; §7.10: provenance for restyled segments includes source asset +
  range.
- Part 5 §5.3: new operations `restyle.plan.create`, `restyle.segment.approve`,
  `seam.treatment.set` (risk: consequential; proposals only).
- Part 11: restyled-chunk staleness entries in the dependency model.
- Part 9: pre-flight plan-level cost estimate surfaced before the first external call.

## Migration

None — additive. `guyditor/v1` gains optional fields only (restyle plans live in a new
sidecar `guyditor.restyle/v1`; frozen chunks are ordinary generated assets).

## Alternatives considered

- **Treat restyled chunks as B-roll under FR-603 unchanged** — rejected: loses the
  source-range linkage needed for staleness and seam planning.
- **Provider-side stitching (upload full video)** — rejected: providers cap duration;
  stitching control and seam art direction must stay local.
- **Transition presets as a third seam treatment** — deferred by creator decision
  2026-07-18; the FR-609 set is extensible later.
- **Higgsfield-first adapter** — deferred: Kling direct API first (creator decision);
  Higgsfield becomes a second adapter behind the same interface.

## Implementation timing

After M1 (transcript + proposal infrastructure are prerequisites for segmentation
boundaries and the plan-review flow). Target: alongside M2's FR-311/FR-600 work, since
seam concealment reuses both.
