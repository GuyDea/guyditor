# BRD traceability

| BRD ID | Owning part | Status | Test evidence | Notes |
|---|---|---|---|---|
| BR-001 | Part 0 | todo | | |
| BR-002 | Part 9 | todo | | |
| BR-003 | Part 9 | todo | | |
| BR-004 | Part 9 | todo | | |
| BR-005 | Part 0 | todo | | |
| BR-006 | Part 0 | todo | | |
| BR-007 | Part 9 | todo | | |
| BR-008 | Part 14 | todo | | |
| FR-001 | Part 3 | implemented | `packages/core/src/store/create-project.test.ts`; `packages/core/src/store/store.test.ts` | Request-based `ProjectStore.createProject` enforces empty/new, non-nested, non-cache locations; loads a versioned primary profile; records skill/watch-folder pins; scaffolds canonical/operational directories; and writes creation transaction 1 with `rev_00001` snapshot, lock, journal, and HEAD. |
| FR-002 | Part 3 | implemented | `packages/media/src/ingest.test.ts`; `packages/media/src/probe.test.ts`; `packages/core/src/operations/asset.test.ts` | Batch `MediaEngine.ingest` runs through `JobQueue`, validates sources, hashes and probes concurrently, classifies and registers assets through one `asset.ingest` transaction, deduplicates known paths, protects in-use removals, and queues configurable follow-up records. |
| FR-003 | Part 3 | implemented | `packages/media/src/commands.test.ts`; `packages/media/src/proxy.test.ts`; `packages/media/src/peaks.test.ts`; `packages/media/src/cache.test.ts` | `proxy.generate` and `MediaEngine.ensureProxy` implement the hashed edit-proxy ladder, five-check staleness contract, deduplicated jobs, atomic media/metadata publication, and small-image exemption. `peaks.generate` streams mono 48 kHz s16le into fixed int8 tiers. Cache use scans and missing-proxy projections are available through `MediaEngine.estimateCacheUse`. |
| FR-004 | Part 3 | partial | `workers/mlworker/tests/test_worker_protocol.py`; `packages/media/src/mlworker/mlworker.contract.test.ts` | The local mlworker now exposes a VAD analysis primitive with speech/silence intervals; fixture-grounded contracts hold all three synthetic silence boundaries within 150 ms. Asset analysis persistence and silence-driven edit features remain. |
| FR-005 | Part 3 | todo | | |
| FR-006 | Part 3 | todo | | |
| FR-007 | Part 3 | todo | | |
| FR-008 | Part 3 | todo | | |
| FR-009 | Part 3 | todo | | |
| FR-010 | Part 3 | todo | | |
| FR-011 | Part 3 | todo | | |
| FR-100 | Part 2 | partial | `packages/core/src/project/project.test.ts`; `packages/core/src/project/project.prop.test.ts` | Master model, closed JSON Schema, semantic validation, and canonical YAML complete; ProjectStore load/save remains. |
| FR-101 | Part 2 | implemented | `packages/core/src/project/derive.test.ts`; `packages/core/src/project/derive.prop.test.ts`; `packages/core/src/operations/operations.prop.test.ts`; `packages/core/src/project/project.prop.test.ts` | Exact derived timeline positions and stable canonicalization complete; P-T5 and P-D1 cover prefix sums and entity-local stored diffs. |
| FR-102 | Part 2 | implemented | `packages/core/src/time/time.test.ts`; `packages/core/src/time/time.prop.test.ts`; `packages/core/src/anchors/parser.test.ts`; `packages/core/src/anchors/resolver.test.ts`; `packages/core/src/anchors/engine.test.ts`; `packages/transcript/src/anchor-lookup.test.ts`; `packages/transcript/src/word-identity.prop.test.ts` | The complete semantic-anchor grammar has structured parsing and exact resolution for timeline, clip, word, beat, and annotation callback forms. Word tombstones reuse the transcript fallback, duplicated footage is deterministic, offsets never clamp, ranges validate at resolution, and accepted transactions journal/persist resolved-to-orphaned transitions repairable through `anchor.rebind`. |
| FR-103 | Part 2 | todo | | |
| FR-104 | Part 5 | implemented | `packages/core/src/store/store.test.ts`; `packages/core/src/operations/engine.test.ts`; `packages/core/src/proposals/proposal.test.ts` | Canonical transaction journal, crash-reconcilable commit algorithm, accepted-proposal linkage through `acceptance.proposal`, and journal-driven proposal finalization recovery are implemented. |
| FR-105 | Part 5 | implemented | `packages/core/src/proposals/proposal.test.ts`; `packages/core/src/operations/diff.test.ts` | Full persisted draft-to-ready proposal lifecycle is implemented with accepted-state isolation, immutable ready operations, stale-base refusal, supersession, rejection/withdrawal archives, semantic diffs, reason gates, risk escalation, internal-only proposal commits, and injected agent-only low-risk auto-accept policy enforcement. |
| FR-106 | Part 2 | todo | | |
| FR-107 | Part 2 | todo | | |
| FR-108 | Part 2 | partial | `packages/core/src/store/history.test.ts`; `packages/core/src/operations/diff.test.ts` | Engine-synchronized forward revision restore with target-lock inputs, sidecar restoration/hash re-registration, lineal journal summaries, move-aware structural stable-ID comparison, and representative changed-range selection are implemented. Before/after visual preview rendering remains for Parts 10/12. |
| FR-200 | Part 4 | implemented | `workers/mlworker/tests/test_worker_protocol.py`; `packages/media/src/mlworker/mlworker.contract.test.ts`; `packages/media/src/mlworker/executors.test.ts`; `packages/transcript/src/sidecar.test.ts`; `packages/transcript/src/engine.test.ts` | `TranscriptEngine.createFromTranscription` consumes local mlworker results, separates punctuation from bare tokens, converts boundary timestamps to exact native-rate sample time, allocates project-global word IDs, and writes/registers the canonical `guyditor.transcript/v1` sidecar with its SHA-256 and provenance in one accepted transaction. |
| FR-201 | Part 4 | implemented | `workers/mlworker/tests/test_worker_protocol.py`; `packages/media/src/mlworker/executors.test.ts`; `packages/media/src/mlworker/mlworker.contract.test.ts`; `packages/transcript/src/realign.test.ts` | The CPU-only worker advertises `torchaudio-wav2vec2-ctc-forced-align` with its installed torchaudio version and runs `wav2vec2-base-960h` CTC alignment with progress, cancellation, model-cache, interpolation, and dependency/disable gating. `transcript.realign` scopes by asset/word range, uses the queued `align` executor, and commits explicit native-sample timing/provenance updates without changing ordinals. Following §4.2, aligned CTC output is accepted at score ≥ 0.35; post-transcription auto-enqueue occurs when any ASR word confidence is strictly below 0.35, and never applies the result outside the operation. |
| FR-202 | Part 4 | todo | | |
| FR-203 | Part 4 | implemented | `packages/transcript/src/corrections.test.ts`; `packages/core/src/operations/engine.test.ts` | The core catalog validates and dispatches all direct §4.7 correction operations at low risk: correct, replace, insert, delete, retime, segment split/merge, and speaker assignment by segment or word range. Text/punctuation/speaker/segmentation edits preserve word timing; only explicit retime mutates it. Forced `transcript.realign` and reconciliation application remain with their explicitly out-of-scope subsystems. |
| FR-204 | Part 4 | implemented | `packages/transcript/src/word-identity.prop.test.ts`; `packages/transcript/src/lookup.test.ts`; `packages/transcript/src/anchor-lookup.test.ts`; `packages/transcript/src/engine.test.ts` | P-W1 through P-W4 run with fast-check at 500 cases each: ordinals never renumber/reuse, allocation is monotonic from `nextWordOrdinal`, surviving words and their semantic anchors retain exact source intervals through transcript edits plus clip split/join/trim sequences, and canonical one-record-per-line JSON remains source-time sorted with ≤ k+1 line churn. Lookup follows `replacedBy` chains and applies deterministic same-segment 2000 ms fallback. P-W5 is skipped here because it requires caption cue compilation (later caption task). |
| FR-205 | Part 4 | todo | | |
| FR-206 | Part 4 | todo | | |
| FR-207 | Part 4 | todo | | |
| FR-208 | Part 4 | todo | | |
| FR-300 | Part 5 | todo | | |
| FR-301 | Part 5 | partial | `packages/core/src/operations/engine.test.ts`; `packages/core/src/operations/operations.prop.test.ts`; `packages/core/src/anchors/engine.test.ts` | `clip.trim`, `clip.split`, and `clip.join` are implemented, and `OperationEngine.resolveNavigation` now resolves frame, timecode, clip-edge, word, annotation, and beat targets to `{ sequenceId, frame: FrameTime }`; the remaining timeline operation catalog is pending. |
| FR-302 | Part 5 | todo | | |
| FR-303 | Part 5 | todo | | |
| FR-304 | Part 5 | todo | | |
| FR-305 | Part 5 | todo | | |
| FR-306 | Part 6 | todo | | |
| FR-307 | Part 6 | todo | | |
| FR-308 | Part 5 | todo | | |
| FR-309 | Part 5 | todo | | |
| FR-310 | Part 5 | todo | | |
| FR-311 | Part 5 | todo | | |
| FR-400 | Part 8 | partial | `packages/transcript/src/annotation-context.test.ts` | The data-side settled-frame contract is represented by exact timeline/source frame extraction requests in annotation context packages. Preview seeking, scrubbing, and rendered frame verification remain UI/media work. |
| FR-401 | Part 8 | implemented | `packages/core/src/annotations/sidecar.test.ts`; `packages/core/src/annotations/service.test.ts` | `guyditor.annotations/v1` stores all eight modeled shapes (including geometry-free time range), structured anchors, author/lifecycle history, source projection, orphan and conversion provenance; closed validation and canonical sidecar round trips are implemented. |
| FR-402 | Part 8 | implemented | `packages/core/src/anchors/resolver.test.ts`; `packages/core/src/anchors/engine.test.ts`; `packages/core/src/annotations/service.test.ts`; `packages/transcript/src/anchor-lookup.test.ts` | Annotation clip/word/object/beat/timeline anchors resolve through the task-13 registry callback; `ann:` now resolves live annotation records, while accepted edits atomically stamp and journal newly orphaned annotations and clear recovered/re-anchored orphans. |
| FR-403 | Part 8 | implemented | `packages/core/src/annotations/coordinates.test.ts`; `packages/core/src/annotations/sidecar.test.ts` | Canvas coordinates normalize each axis independently, scalar sizes use canvas height, spatial decimals canonicalize to six places, freehand RDP uses epsilon 0.002 with a 512-point cap, and cross-aspect contain mapping reports approximate placement. |
| FR-404 | Part 8 | implemented | `packages/core/src/annotations/service.test.ts` | Review annotations remain sidecar-only and become renderable only through normal-risk `annotation.convert`; built-in template mapping, source-projection transfer, annotation provenance, atomic addressing/resolution, and frozen-SVG freehand conversion are implemented. |
| FR-405 | Part 8 | partial | `packages/transcript/src/annotation-context.test.ts` | `buildAnnotationContext` assembles the normative manifest, exact clean/marked/nearby proxy frame-extraction requests, transcript window, clip window, annotation, and visible-layer metadata. PNG/MP4/audio rendering and Agent Gateway serialization remain Parts 10/12/9. |
| FR-406 | Part 8 | implemented | `packages/core/src/annotations/service.test.ts` | All lifecycle operations and legal transitions are enforced, ready proposals derive `addressed`, and accepted transactions resolve every `addresses` annotation atomically with `resolvedBy` and an `annotation.resolve` journal operation. |
| FR-500 | Part 6 | todo | | |
| FR-501 | Part 6 | todo | | |
| FR-502 | Part 6 | todo | | |
| FR-503 | Part 6 | todo | | |
| FR-504 | Part 6 | todo | | |
| FR-505 | Part 6 | todo | | |
| FR-506 | Part 6 | todo | | |
| FR-507 | Part 6 | todo | | |
| FR-508 | Part 6 | todo | | |
| FR-509 | Part 6 | todo | | |
| FR-510 | Part 6 | todo | | |
| FR-511 | Part 6 | todo | | |
| FR-600 | Part 7 | todo | | |
| FR-601 | Part 7 | todo | | |
| FR-602 | Part 7 | todo | | |
| FR-603 | Part 7 | todo | | |
| FR-604 | Part 7 | todo | | |
| FR-605 | Part 7 | todo | | |
| FR-606 | Part 7 | todo | | |
| FR-700 | Part 9 | todo | | |
| FR-701 | Part 9 | todo | | |
| FR-702 | Part 9 | todo | | |
| FR-703 | Part 9 | todo | | |
| FR-704 | Part 9 | todo | | |
| FR-705 | Part 9 | todo | | |
| FR-800 | Part 11 | todo | | |
| FR-801 | Part 11 | todo | | |
| FR-802 | Part 11 | todo | | |
| FR-803 | Part 11 | todo | | |
| FR-804 | Part 11 | todo | | |
| FR-805 | Part 11 | todo | | |
| FR-806 | Part 11 | todo | | |
| FR-807 | Part 11 | todo | | |
| FR-808 | Part 11 | todo | | |
| FR-809 | Part 11 | todo | | |
| FR-810 | Part 11 | todo | | |
| FR-811 | Part 11 | todo | | |
| FR-812 | Part 11 | todo | | |
| FR-813 | Part 11 | todo | | |
| FR-900 | Part 10 | todo | | |
| FR-901 | Part 5 | todo | | |
| FR-902 | Part 10 | todo | | |
| FR-903 | Part 10 | todo | | |
| FR-904 | Part 5 | implemented | `packages/core/src/operations/undo.test.ts`; `packages/core/src/proposals/proposal.test.ts`; `packages/core/src/operations/engine.test.ts`; `packages/core/src/store/store.test.ts` | Session-scoped core undo/redo executes stored inverses/original operations as new forward transactions with `undoOf`/`redoOf`, preserves generated stable IDs, invalidates stale stack entries, supports conflict-checked historical revert, and keeps proposal rejection/acceptance outside the UI undo stack. UI command wiring remains Part 10 work. |
| FR-905 | Part 2 | todo | | |
| FR-906 | Part 10 | partial | `packages/media/src/peaks.test.ts` | `guyditor.peaks/v1` cache production is implemented with the three fixed zoom tiers and fixture-grounded silence coverage; timeline waveform rendering, metering, and UI controls remain Part 10 work. |
| FR-1000 | Part 12 | partial | `packages/render/src/graph.test.ts`; `packages/render/src/filtergraph.test.ts`; `packages/render/src/videozero.test.ts`; `scripts/video-zero.mjs` | M0 local-only subset: one sequence-bound video layer; cuts, exact trims, `gapBefore` as black+silence, speed effects, same-clip audio/silence concat, and H.264/AAC MP4 export through `RenderService` + `JobQueue`. Package-local lint forbids HTTP/socket imports and `fetch`; non-file FFmpeg paths are rejected. Transitions, overlaps, multi-layer/items composition, keying, transforms, captions/overlays, freeze, proposals, and proxy quality return `E_RENDER_UNSUPPORTED` with the owning spec part. |
| FR-1001 | Part 12 | todo | | |
| FR-1002 | Part 12 | partial | `packages/render/src/graph.test.ts`; `packages/render/src/videozero.test.ts` | Render graphs embed the minimal pinned toolchain manifest (FFmpeg/ffprobe versions and binary hashes, render package version, OS, encoder threads); exports verify recorded asset/sidecar hashes and tests assert exact stream properties and duration. Full functional-equivalence analysis remains Part 12 work. |
| FR-1003 | Part 12 | partial | `packages/core/src/jobs/queue.test.ts` | Persistent queue, cancellation, retry, progress, and concurrency library complete; main-process/IPC bridging and the UI job panel remain. |
| FR-1004 | Part 12 | todo | | |
| FR-1005 | Part 12 | partial | `packages/render/src/videozero.test.ts`; `scripts/video-zero.mjs` | Minimal adjacent export report records accepted revision, deliverable/variant, profile hash, toolchain, per-source and sidecar SHA-256, resolved encode settings, validation/warnings, and output SHA-256/bytes/stream duration. Deliverable-directory copies, loudness measurements, and cache accounting remain. |
| FR-1100 | Part 3 | partial | `packages/media/src/binaries.test.ts`; `packages/media/src/probe.test.ts`; `packages/media/src/ingest.test.ts` | FFmpeg/ffprobe plumbing and the Tier-1/2/3 ingest table/classifier are implemented; Tier-3 registers as `other` with a best-effort warning. Proxy/transcode behavior and broad golden coverage remain. |
| FR-1101 | Part 4 | todo | | |
| FR-1102 | Part 12 | todo | | |
| FR-1103 | Part 3 | partial | `packages/media/src/ingest.test.ts`; `packages/core/src/store/create-project.test.ts` | Originals remain ordinary path-referenced files and ingest preserves source bytes/mtime; broader interchange/export guarantees land in later parts. |
| NFR-001 | Part 9 | todo | | |
| NFR-002 | Part 9 | todo | | |
| NFR-003 | Part 9 | todo | | |
| NFR-004 | Part 7 | todo | | |
| NFR-005 | Part 3 | partial | `packages/media/src/ingest.test.ts` | Ingest records a streaming 4 MiB-chunk SHA-256 and has a source write-guard regression test; ongoing quick/full verification and export-time integrity enforcement remain. |
| NFR-006 | Part 9 | todo | | |
| NFR-007 | Part 9 | todo | | |
| NFR-100 | Part 1 | todo | | |
| NFR-101 | Part 1 | partial | `workers/mlworker/tests/test_worker_protocol.py`; `packages/media/src/mlworker/mlworker.contract.test.ts`; `packages/media/src/mlworker/supervisor.test.ts` | Startup capabilities reflect importable engines and `GUYDITOR_ML_DISABLE`; omitted capabilities do not prevent startup. Supervision degrades to `E_MLWORKER_DOWN` after three failures with actionable repair guidance. The wider application degradation matrix remains. |
| NFR-102 | Part 13 | partial | `packages/media/src/cache.test.ts`; `packages/media/src/proxy.test.ts` | Proxy/peaks cache byte accounting, per-asset proxy projections, disposable hash-keyed paths, and atomic partial-file safety are implemented. Storage preflight, the full category accountant, cleanup planning/execution, and cleanup UI remain Part 13 work. |
| NFR-103 | Part 12 | partial | `packages/core/src/jobs/queue.test.ts` | Startup recovery safely fails interrupted jobs with retry metadata; render/analysis integration and partial-artifact cleanup remain. |
| NFR-104 | Part 12 | todo | | |
| NFR-105 | Part 1 | partial | `packages/media/src/mlworker/supervisor.test.ts`; `packages/media/src/mlworker/executors.test.ts`; `packages/media/src/mlworker/mlworker.contract.test.ts` | A typed JSON-RPC supervisor/task-runner boundary isolates media jobs from faster-whisper and VAD engine internals. The public `TranscriptionEngine`/`TranscriptEngine` layer and additional provider boundaries remain. |
| NFR-106 | Part 13 | todo | | |
| NFR-107 | Part 13 | todo | | |
| NFR-108 | Part 13 | todo | | |
| NFR-109 | Part 13 | todo | | |
| AC-001 | Part 14 | todo | | Required bars, greenscreen, screencast, still, and speech-like media fixtures are generated; the project template and AC suite remain. |
| AC-002 | Part 14 | todo | | |
| AC-003 | Part 14 | todo | | Exact 2,800-word/20-minute transcript and speech-like audio fixtures are generated; caption compilation, exports, and golden/drift assertions remain. |
| AC-004 | Part 14 | todo | | |
| AC-005 | Part 14 | todo | | Greenscreen, bars, and still fixtures with machine-readable keying/path ground truth are generated; composite implementation and goldens remain. |
| AC-006 | Part 14 | todo | | Greenscreen, screencast, and exact transcript fixtures are generated; PiP implementation, project template, and AC suite remain. |
| AC-007 | Part 14 | todo | | |
| AC-008 | Part 14 | todo | | |
| AC-009 | Part 14 | todo | | Deterministic generated media/sidecar infrastructure and content hashes are available; revision rebuild and render determinism harnesses remain. |
| AC-010 | Part 14 | todo | | |
| AC-011 | Part 14 | todo | | |
| AC-012 | Part 14 | todo | | |
