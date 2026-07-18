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
| FR-001 | Part 3 | todo | | |
| FR-002 | Part 3 | todo | | |
| FR-003 | Part 3 | todo | | |
| FR-004 | Part 3 | todo | | |
| FR-005 | Part 3 | todo | | |
| FR-006 | Part 3 | todo | | |
| FR-007 | Part 3 | todo | | |
| FR-008 | Part 3 | todo | | |
| FR-009 | Part 3 | todo | | |
| FR-010 | Part 3 | todo | | |
| FR-011 | Part 3 | todo | | |
| FR-100 | Part 2 | partial | `packages/core/src/project/project.test.ts`; `packages/core/src/project/project.prop.test.ts` | Master model, closed JSON Schema, semantic validation, and canonical YAML complete; ProjectStore load/save remains. |
| FR-101 | Part 2 | implemented | `packages/core/src/project/derive.test.ts`; `packages/core/src/project/derive.prop.test.ts`; `packages/core/src/operations/operations.prop.test.ts`; `packages/core/src/project/project.prop.test.ts` | Exact derived timeline positions and stable canonicalization complete; P-T5 and P-D1 cover prefix sums and entity-local stored diffs. |
| FR-102 | Part 2 | partial | `packages/core/src/time/time.test.ts`; `packages/core/src/time/time.prop.test.ts`; `packages/core/src/project/project.test.ts` | Exact rational time model and anchor string/schema validation complete; anchor resolution remains. |
| FR-103 | Part 2 | todo | | |
| FR-104 | Part 5 | partial | `packages/core/src/store/store.test.ts`; `packages/core/src/operations/engine.test.ts` | Canonical transaction journal and crash-reconcilable commit algorithm complete; proposal linkage remains. |
| FR-105 | Part 5 | todo | | |
| FR-106 | Part 2 | todo | | |
| FR-107 | Part 2 | todo | | |
| FR-108 | Part 2 | todo | | |
| FR-200 | Part 4 | todo | | |
| FR-201 | Part 4 | todo | | |
| FR-202 | Part 4 | todo | | |
| FR-203 | Part 4 | todo | | |
| FR-204 | Part 4 | todo | | |
| FR-205 | Part 4 | todo | | |
| FR-206 | Part 4 | todo | | |
| FR-207 | Part 4 | todo | | |
| FR-208 | Part 4 | todo | | |
| FR-300 | Part 5 | todo | | |
| FR-301 | Part 5 | partial | `packages/core/src/operations/engine.test.ts`; `packages/core/src/operations/operations.prop.test.ts` | `clip.trim`, `clip.split`, and `clip.join` implemented; remaining timeline operation catalog is pending. |
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
| FR-400 | Part 8 | todo | | |
| FR-401 | Part 8 | todo | | |
| FR-402 | Part 8 | todo | | |
| FR-403 | Part 8 | todo | | |
| FR-404 | Part 8 | todo | | |
| FR-405 | Part 8 | todo | | |
| FR-406 | Part 8 | todo | | |
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
| FR-904 | Part 5 | partial | `packages/core/src/operations/engine.test.ts`; `packages/core/src/store/store.test.ts` | Applied operations and journal records carry inverse metadata; undo-stack orchestration remains UI work. |
| FR-905 | Part 2 | todo | | |
| FR-906 | Part 10 | todo | | |
| FR-1000 | Part 12 | partial | `packages/render/src/graph.test.ts`; `packages/render/src/filtergraph.test.ts`; `packages/render/src/videozero.test.ts`; `scripts/video-zero.mjs` | M0 local-only subset: one sequence-bound video layer; cuts, exact trims, `gapBefore` as black+silence, speed effects, same-clip audio/silence concat, and H.264/AAC MP4 export through `RenderService` + `JobQueue`. Package-local lint forbids HTTP/socket imports and `fetch`; non-file FFmpeg paths are rejected. Transitions, overlaps, multi-layer/items composition, keying, transforms, captions/overlays, freeze, proposals, and proxy quality return `E_RENDER_UNSUPPORTED` with the owning spec part. |
| FR-1001 | Part 12 | todo | | |
| FR-1002 | Part 12 | partial | `packages/render/src/graph.test.ts`; `packages/render/src/videozero.test.ts` | Render graphs embed the minimal pinned toolchain manifest (FFmpeg/ffprobe versions and binary hashes, render package version, OS, encoder threads); exports verify recorded asset/sidecar hashes and tests assert exact stream properties and duration. Full functional-equivalence analysis remains Part 12 work. |
| FR-1003 | Part 12 | partial | `packages/core/src/jobs/queue.test.ts` | Persistent queue, cancellation, retry, progress, and concurrency library complete; main-process/IPC bridging and the UI job panel remain. |
| FR-1004 | Part 12 | todo | | |
| FR-1005 | Part 12 | partial | `packages/render/src/videozero.test.ts`; `scripts/video-zero.mjs` | Minimal adjacent export report records accepted revision, deliverable/variant, profile hash, toolchain, per-source and sidecar SHA-256, resolved encode settings, validation/warnings, and output SHA-256/bytes/stream duration. Deliverable-directory copies, loudness measurements, and cache accounting remain. |
| FR-1100 | Part 3 | partial | `packages/media/src/binaries.test.ts`; `packages/media/src/probe.test.ts` | FFmpeg/ffprobe resolution, execution, and probe-to-Asset format metadata plumbing are covered; ingest, proxies, tier classification, and the full format matrix remain. |
| FR-1101 | Part 4 | todo | | |
| FR-1102 | Part 12 | todo | | |
| FR-1103 | Part 3 | todo | | |
| NFR-001 | Part 9 | todo | | |
| NFR-002 | Part 9 | todo | | |
| NFR-003 | Part 9 | todo | | |
| NFR-004 | Part 7 | todo | | |
| NFR-005 | Part 3 | todo | | |
| NFR-006 | Part 9 | todo | | |
| NFR-007 | Part 9 | todo | | |
| NFR-100 | Part 1 | todo | | |
| NFR-101 | Part 1 | todo | | |
| NFR-102 | Part 13 | todo | | |
| NFR-103 | Part 12 | partial | `packages/core/src/jobs/queue.test.ts` | Startup recovery safely fails interrupted jobs with retry metadata; render/analysis integration and partial-artifact cleanup remain. |
| NFR-104 | Part 12 | todo | | |
| NFR-105 | Part 1 | todo | | |
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
