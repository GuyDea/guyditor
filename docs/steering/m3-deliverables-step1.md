# M3 deliverables step 1

Date: 2026-07-22

## Decision

Implement Part 11's deliverable lifecycle as accepted project operations while keeping
resolution-heavy work in `@guyditor/deliver`:

- `@guyditor/core` owns the strongly typed persisted deliverable shape, operation
  schemas/catalog entries, lifecycle mutations, derivative divergence enforcement,
  dependency maintenance, and the synchronous accepted-transaction staleness hook.
- `@guyditor/deliver` owns the complete `guyditor-profile/v1` schema and loader,
  profile override resolution, manual-selection resolution, short-candidate scoring
  and cache records, and refresh-proposal construction.
- `@guyditor/agent` exposes candidate discovery as a read/derive gateway tool. The
  deterministic hook/coherence/payoff signals are executable in CI; a real director's
  rubric judgment remains dogfood evidence.
- The app main process composes transcript sidecars with the deliver service and
  exposes list/derive/approve/status/refresh/profile/candidate methods. The renderer
  keeps only selection and review state.

The profile loader resolves exact pins in project, user, then built-in roots. It
deep-merges object overrides, replaces arrays and scalar values, then validates the
resolved document against the same JSON Schema. `youtube-longform@1.0.0` remains at
1.0.0 because Part 11 explicitly defines every shipped built-in as 1.0.0; the prior
minimal file was an implementation scaffold, not a released profile revision.

## Derivation and provenance

Every manual source form resolves to ordered `SourceRangeRef` values before the
`deliverable.derive` proposal is created. Acceptance creates a new sequence, a
sequence-bound video layer, derivative clips, and a short deliverable with one
dependency per non-local clip. Derived clips copy source asset/range references and
never reference the long-form sequence.

Ordinary edits remain the derivative vocabulary. Transactions that touch a short's
sequence, layers, or caption track require one closed-set `DivergenceClass`; accepted
transaction IDs accumulate per class. Split and trim operations update dependency
provenance, while derivative-only inserted clips carry `origin: local` and do not
participate in source staleness.

## Staleness and refresh

A single half-open exact-frame/word-range intersection module powers both short
dependencies and restyle chunks. The operation engine expands accepted long-form
clip/word/beat/asset changes against approved or in-review short dependencies, adds
one transaction-specific stale reason, and never modifies derivative clips, captions,
framing, publish references, or exported files. Repeated non-overlapping edits do not
append another stale reason.

Refresh is a proposal. It re-resolves surviving word anchors, narrows or flags deleted
entries, preserves local clips and accepted derivative edits, attaches a semantic
diff and affected-range preview job, and changes stale to in-review only when accepted.
Approval is a separate consequential operation that records the result revision.

Restyle chunk staleness uses the same intersection primitive and change-set expansion;
its sidecar-specific stale/review writes remain in `ProjectStore`, where atomic sidecar
publication already lives.

## Error and review behavior

- Missing exact profile pins return `E_PROFILE_NOT_FOUND` with no retry.
- Invalid profile documents or overrides return `E_PROFILE_INVALID`.
- Direct acceptance of proposal-only derive/refresh operations returns
  `E_OP_PROPOSAL_REQUIRED`.
- Invalid lifecycle transitions return `E_DELIVERABLE_STATUS`.
- Derivative edits without a divergence classification return
  `E_DIVERGENCE_REQUIRED`.
- Refresh rejection leaves the accepted stale deliverable unchanged.

## Verification boundary

This step automates AC-008, profile/schema behavior, selection resolution, candidate
heuristics, divergence journal tracking, randomized overlap correctness, refresh
proposal preview/diff availability, UI stale explanation rendering, and approved-file
hash invariance. FR-800 remains partial because final export-path completion belongs
to later M3 work; FR-803/804/806/808/809+ stay out of scope.
