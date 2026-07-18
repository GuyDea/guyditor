# Guyditor Implementation Specification

**Version:** 1.0 (draft)
**Date:** 2026-07-17

> **Note:** `BUSINESS-REQUIREMENTS.md` (Draft v2) is the authoritative source for business scope. This document is the authoritative source for technical design.

This document is written to be executed by any capable engineer or AI coding model.

## Table of Contents

- Part 0 — Scope, architecture decisions, and binding conventions
- Part 1 — Architecture and runtime
- Part 2 — Canonical project format and versioning
- Part 3 — Media engine, ingest, and capture integration
- Part 4 — Transcription, word alignment, and captions
- Part 5 — Editing operations, proposals, and semantic diffs
- Part 6 — Composition, keying, and picture-in-picture
- Part 7 — Graphics, motion templates, and B-roll adapters
- Part 8 — Frame-accurate review and annotations
- Part 9 — Agent gateway, skills, audit, and cost
- Part 10 — UI application
- Part 11 — Deliverables, shorts, and publish kits
- Part 12 — Rendering, export, validation, and interchange
- Part 13 — Backup, archival, migration, and storage
- Part 14 — Testing, milestones, and implementer workflow

---

## Part 0 — Scope, architecture decisions, and binding conventions

### 0.1 Purpose and audience

This document is the implementation specification for **Guyditor**, the agent-native, local-first video-editing platform defined by `BUSINESS-REQUIREMENTS.md` (Draft v2, 2026-07-17, referred to below as **the BRD**). It is written to be executed by any capable engineer or AI coding model without access to prior conversations. Every part is self-contained: terms are defined before use, file paths and interface names are exact, and each part ends with a traceability table mapping BRD requirement IDs (BR-*, FR-*, NFR-*, AC-*, business rules) to the sections that implement them.

Normative language follows RFC 2119: **MUST**, **MUST NOT**, **SHOULD**, **MAY**. Anything marked as an Architecture Decision (**AD-xxx**) is binding; an implementer who believes an AD is wrong must record a proposed amendment rather than silently deviate.

### 0.2 Architecture decisions

- **AD-001 — Desktop shell: Electron.** Guyditor is a desktop application built on Electron (pinned major version, currently 31+), Node.js 22+, TypeScript 5.x in strict mode. Rationale: single-language stack for UI and services, mature media-UI ecosystem, lowest implementation bar for AI implementers. Tauri was considered and rejected for v1 (Rust raises the contribution bar; no blocking capability gap).
- **AD-002 — UI: React 18 + Zustand.** The renderer uses React with Zustand stores. All project mutations flow through the `OperationEngine` (AD-009); UI state stores hold only view state (selection, zoom, panel layout), never project truth.
- **AD-003 — ML sidecar: Python worker.** A bundled Python 3.11+ worker (`workers/mlworker`) provides transcription (faster-whisper), forced alignment (WhisperX-style CTC alignment), voice-activity and silence detection, scene detection (PySceneDetect), face/subject tracking (mediapipe), and optional neural matting (RobustVideoMatting). It communicates with the main process over JSON-RPC 2.0 on stdio. Each capability is a named task type; the worker advertises its capabilities at startup so missing optional dependencies degrade gracefully (NFR-101).
- **AD-004 — Media engine: bundled FFmpeg.** Pinned FFmpeg + ffprobe binaries are bundled per platform and invoked as child processes. All command lines are produced by a single command-compiler module (`@guyditor/media`), never assembled ad hoc at call sites. ffprobe JSON output is the sole source of technical metadata.
- **AD-005 — Preview: per-layer proxies + WebGL compositor.** Interactive preview composites per-layer proxy media live in the renderer using WebGL, driven by `requestVideoFrameCallback` for frame accuracy. High-quality preview (FR-902) renders the affected segment through the final-render path (AD-006) into a cached MP4. Both paths compile from the same canonical composition model — there is no separate preview data model.
- **AD-006 — Final render: compiled FFmpeg filtergraph + deterministic overlay renderer.** Final and high-quality renders compile the canonical project into an FFmpeg filtergraph. Captions, titles, callouts, and template graphics are rendered by the deterministic TypeScript overlay renderer (same code as preview) into transparent overlay assets that FFmpeg composites. A generative video model is never used to render text (FR-602). Remotion MAY later replace the internal template renderer behind the same interface; Remotion state is always compiled from the canonical project (BRD §26).
- **AD-007 — Project = directory.** A project is an ordinary directory. Canonical master file: `episode.guyditor.yaml` with `format: guyditor/v1`. Sidecars live in `sidecars/`, referenced by relative path + SHA-256. Derived artifacts live in `.guyditor/cache/` (disposable, never load-bearing). Source media MAY live inside or outside the project directory; assets record both a relative-if-possible path and integrity hash.
- **AD-008 — Revisions: append-only transaction journal.** Accepted edits are recorded in `history/transactions.jsonl` (one JSON object per accepted transaction, FR-104) plus a snapshot of the master file per accepted revision under `history/revisions/`. The layout is Git-friendly (FR-106) but Guyditor MUST function without Git installed. Proposals live in `proposals/` until accepted or rejected and never touch accepted state (FR-105).
- **AD-009 — One editing API for UI and agents.** All mutations are semantic operations executed by the `OperationEngine` in the main process. The UI calls it over typed IPC; agents call it through the **Agent Gateway**, an MCP (Model Context Protocol) server exposing the same operations plus query/render/annotation tools. Choosing MCP makes Guyditor drivable by any MCP-capable frontier model (Claude, Codex-class models, etc.), satisfying BR-002/BR-003 without per-vendor director adapters. Outbound provider adapters (B-roll generation, specialist critic, synthetic voice) are separate and pluggable (FR-604, NFR-105).
- **AD-010 — Jobs: persistent SQLite-backed queue.** Long-running work (proxies, analysis, transcription, renders, exports, backups) runs through `JobQueue`, persisted in `.guyditor/jobs.sqlite`, resumable after crash (NFR-103), visible in the UI (NFR-100), cancellable and retryable (FR-1003).
- **AD-011 — Secrets: OS keychain.** Provider credentials are stored via Electron `safeStorage`/OS keychain, keyed by adapter ID. Secrets MUST NOT appear in project files, logs, exports, or backups (NFR-003, NFR-108).
- **AD-012 — Audit and cost: append-only session logs.** Every agent session writes `~/.guyditor/audit/<session-id>.jsonl` recording instructions, tool calls, proposals and their outcomes, and every external call with provider, data classes sent, token/unit counts, cost, and outcome (NFR-006, NFR-007). The `CostMeter` aggregates spend per task/episode/lifetime and enforces creator budgets before expensive operations start.
- **AD-013 — Determinism rules.** Renders MUST be reproducible (FR-1002): pinned tool versions recorded per render, no wall-clock or RNG input to render paths, cache keys derived from content hashes + operation parameters + tool versions. Nondeterministic external generations are frozen as assets before acceptance (business rule 8).
- **AD-014 — Testing stack.** Vitest for unit/property tests, Playwright for UI flows, golden-file render tests compared by perceptual hash with explicit tolerances, plus fixture media generated by script (no large binaries in the repo).

### 0.3 Repository layout (monorepo, pnpm workspaces)

```
guyditor/
  package.json                 # pnpm workspace root
  BUSINESS-REQUIREMENTS.md     # the BRD (authoritative business scope)
  IMPLEMENTATION-SPEC.md       # this document
  packages/
    core/        # @guyditor/core        project model, schema, operations, transactions, diffs, validation
    media/       # @guyditor/media       ffmpeg/ffprobe wrappers, ingest, proxies, hashing, analysis orchestration
    transcript/  # @guyditor/transcript  transcription, alignment, word identity, captions, subtitle IO
    compositor/  # @guyditor/compositor  layer model, keying, PiP, transforms, keyframes, responsive layout solving
    render/      # @guyditor/render      filtergraph compiler, overlay renderer, render cache, export validation
    agent/       # @guyditor/agent       MCP gateway, skills, provider adapters, audit log, cost meter
    deliver/     # @guyditor/deliver     deliverables, platform profiles, shorts, publish kits, staleness tracking
    app/         # @guyditor/app         Electron main + React renderer (UI)
  workers/
    mlworker/    # Python sidecar (transcribe, align, vad, scenes, tracking, matting)
  profiles/      # versioned built-in platform profiles (youtube-longform, youtube-shorts, tiktok, instagram-reels)
  docs/
```

### 0.4 Canonical names registry (authors MUST use these exact names)

**Services (main process):** `ProjectStore`, `OperationEngine`, `MediaEngine`, `TranscriptEngine`, `CompositorModel`, `RenderService`, `JobQueue`, `AgentGateway`, `AuditLog`, `CostMeter`, `BackupService`, `DeliverableService`, `AnnotationService`, `SkillRegistry`, `AdapterRegistry`, `CaptureWatcher`.

**ID conventions.** All IDs are immutable once assigned. Prefixed, lowercase, 10 random base32 chars unless stated: assets `ast_`, clips `clp_`, sequences `seq_`, layers `lyr_`, transitions `trn_`, captions tracks `cts_`, annotations `ann_`, deliverables `dlv_`, presets `pre_`, templates `tpl_`, skills `skl_`, beats `beat_`, markers `mrk_`, takes `tak_`, sessions `ses_`, jobs `job_`, transactions `txn_`, proposals `prp_`, adapters `adp_`. **Transcript words** use `w` + zero-padded 6-digit ordinal assigned once at canonical transcript creation (`w000042`); corrections and edits never renumber existing words; inserted words take the next unused ordinal (FR-204). **Revisions** are `rev_` + zero-padded 5-digit counter (`rev_00017`).

**Time model (binding, detailed in Part 2).** Source time is stored as integer frame counts at the owning asset's native frame rate, serialized as `{ frames: <int>, fps: "<num>/<den>" }`; audio-only assets use `{ samples: <int>, rate: <int> }`. Timeline positions are **derived** from sequence order and durations (FR-101); only explicit gaps and overlaps are stored. All arithmetic is exact rational — floating-point time is forbidden in the project model. Semantic anchors (`word:w000042`, `beat:beat_x`, `clip:clp_x@{frames}`) are preferred over raw times wherever the BRD allows (FR-102).

**Operation grammar.** Semantic operations are named `<noun>.<verb>` with dot-scoped nouns, e.g. `clip.trim`, `clip.split`, `clip.move`, `layer.add`, `transition.set`, `caption.style.set`, `transcript.word.correct`, `annotation.resolve`, `deliverable.derive`. Every operation has a JSON Schema for its parameters, a human-readable summary template (business rule 6), inverse metadata for undo (FR-904), and a declared risk class (`low`/`normal`/`consequential`) for the low-risk automation policy (business rule 5). Part 5 owns the catalog.

**Errors and jobs.** All service calls return either a result or a structured error `{ code, message, affected: [ids], acceptedStateChanged: boolean, retry: 'safe'|'unsafe'|'none', suggestion?: string }` (NFR-104). Error `code` values follow one binding grammar in every part: `E_` + SCREAMING_SNAKE (e.g. `E_MLWORKER_DOWN`, `E_ASSET_MISSING`); no other code format is permitted, and one condition has exactly one code across parts (enforced by `check:conventions`, Part 14). Jobs report `{ jobId, kind, state: queued|running|done|failed|cancelled, progress: 0..1, error? }`.

### 0.5 Part map of this specification

| Part | Title | Owns (primary BRD coverage) |
|---|---|---|
| 0 | This part | BR-001..008 framing, §26 constraints |
| 1 | Architecture and runtime | processes, IPC, packaging, hardware adaptation (NFR-100/101/105) |
| 2 | Canonical project format | FR-100..108, FR-905, business rules 1–4, R-002, R-007 |
| 3 | Media engine and ingest | FR-001..011, FR-1100, FR-1103, NFR-005, NFR-102 (estimation) |
| 4 | Transcription and captions | FR-200..208, FR-1101 |
| 5 | Editing operations and proposals | FR-300..311, FR-104/105 semantics, FR-901, FR-904 |
| 6 | Composition and keying | FR-500..511, FR-306/307, R-003, R-004 |
| 7 | Graphics, templates, B-roll adapters | FR-600..606, NFR-004, R-005 |
| 8 | Review and annotations | FR-400..406 |
| 9 | Agent integration, skills, audit, cost | BR-002..004, BR-007, FR-005 (drafting), FR-700..705, FR-405, NFR-001..003, NFR-006/007, rules 5/6/11/12, R-001 |
| 10 | UI application | FR-900..906, FR-902..904 |
| 11 | Deliverables and publish kits | FR-800..813 |
| 12 | Rendering, export, interchange | FR-1000..1005, FR-1102, NFR-103/104 |
| 13 | Backup, archival, migration, storage | NFR-102, NFR-106..109, R-006, R-009 |
| 14 | Testing, milestones, implementer workflow | AC-001..012, BRD §23/§24, BR-008 |

### 0.6 Milestones

Milestones map to BRD §24 priorities: **M0** repo scaffold + core schema + OperationEngine skeleton; **M1** = Priority A (end-to-end foundation, AC-001/002/004 partial); **M2** = Priority B (presentation workflow, AC-003/005/006); **M3** = Priority C (multi-format publishing, AC-007/008/011); **M4** = Priority D (editorial leverage) plus AC-009/010/012 hardening. Part 14 defines exit criteria per milestone. Per BR-008, every milestone ends with producing a real video using only shipped functionality.

---

## Part 1 — Architecture and runtime

This part defines Guyditor's process model, IPC contract, startup, hardware adaptation, packaging, user-level file layout, logging, crash recovery, and responsiveness rules. It implements the runtime consequences of AD-001..AD-006, AD-009..AD-012 and owns BR-001, BR-002, BR-003, BR-005, BR-008, NFR-100, NFR-101, and NFR-105. Canonical service names, ID prefixes, the time model, the operation grammar, and the error envelope are taken verbatim from Part 0 §0.4.

### 1.1 Process model

Guyditor runs as five kinds of OS processes:

| Process | Runtime | Count | Responsibility |
|---|---|---|---|
| **Main** | Electron main (Node 22, TS strict) | 1 | Hosts every Part 0 service (`ProjectStore`, `OperationEngine`, `MediaEngine`, `TranscriptEngine`, `CompositorModel`, `RenderService`, `JobQueue`, `AgentGateway`, `AuditLog`, `CostMeter`, `BackupService`, `DeliverableService`, `AnnotationService`, `SkillRegistry`, `AdapterRegistry`, `CaptureWatcher`). Sole writer of canonical project state (see 1.10). Spawns and supervises all children. |
| **Renderer** | Chromium, sandboxed | 1 per window | React 18 + Zustand UI (AD-002), WebGL proxy compositor (AD-005). `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. No filesystem, no network (see 1.8), no project truth — only view state. Talks to main exclusively via the typed IPC contract (1.3). |
| **jobhost pool** | Electron `utilityProcess` | `min(4, ceil(cores/2))`, setting-overridable | CPU-heavy Node work that must not block main: SHA-256 hashing, waveform extraction, overlay rasterization, sidecar parsing, thumbnail generation. Stateless executors; `JobQueue` (scheduling, persistence, AD-010) stays in main. |
| **FFmpeg / ffprobe** | Bundled native binaries (AD-004) | Per invocation | All decode/encode/probe work, spawned only by `@guyditor/media`'s command compiler in main. Never awaited on an interactive UI path (1.7). |
| **mlworker** | Bundled Python 3.11 (AD-003) | 1 (default; `mlworker.maxProcesses` may raise it) | Transcription, forced alignment, VAD/silence, scene detection, subject tracking, neural matting. JSON-RPC 2.0 on stdio; lifecycle in 1.2. |

One project is open per `BrowserWindow`; main tracks the window→project association, so IPC envelopes carry no project field. A second window opens a second project against the same main-process services.

The `AgentGateway` (AD-009) also runs in main. It exposes the MCP server on a loopback streamable-HTTP endpoint (`127.0.0.1`, ephemeral port) protected by a random 256-bit bearer token. Endpoint and token are written to `~/.guyditor/state/gateway.json` with mode `0600` at startup. A tiny packaged stdio binary, `guyditor-mcp`, reads that file and proxies stdio↔HTTP so any MCP-capable client (Claude, Codex-class CLIs, desktop agents) can attach with zero configuration. This is the **only** agent surface: directors invoke semantic tools, never simulated input (BR-002).

### 1.2 mlworker lifecycle and supervision

The mlworker is spawned as `<resources>/python/bin/python -m mlworker --stdio` with `cwd` = the bundled `workers/mlworker` directory and a clean environment (no user site-packages, `PYTHONNOUSERSITE=1`).

**Protocol.** JSON-RPC 2.0, newline-delimited JSON on stdout/stdin; stderr is captured line-by-line into the mlworker log (1.12). Methods are the task types `transcribe`, `align`, `vad`, `scenes`, `track`, `matte` (parameter schemas owned by Parts 3, 4, 6). Notifications: `mlworker.hello` (worker→main, once), `$/progress` (worker→main), `$/cancel` (main→worker).

```json
{"jsonrpc":"2.0","method":"mlworker.hello","params":{
  "protocol":1,"workerVersion":"1.0.0","python":"3.11.9",
  "device":{"type":"cuda","name":"NVIDIA GeForce RTX 3060","vramMb":12288},
  "capabilities":[
    {"task":"transcribe","engine":"faster-whisper","engineVersion":"1.1.0","models":["tiny","small","medium","large-v3"]},
    {"task":"align","engine":"ctc-forced-align","engineVersion":"3.1.2"},
    {"task":"vad","engine":"silero-vad","engineVersion":"5.1"},
    {"task":"scenes","engine":"pyscenedetect","engineVersion":"0.6.4"},
    {"task":"track","engine":"mediapipe","engineVersion":"0.10.14"},
    {"task":"matte","engine":"rvm","engineVersion":"1.0.0"}
  ]}}
```

```json
{"jsonrpc":"2.0","id":17,"method":"transcribe","params":{"taskId":"job_a1b2c3d4e5","audioPath":"/abs/audio.wav","model":"large-v3","language":"auto","wordTimestamps":true}}
{"jsonrpc":"2.0","method":"$/progress","params":{"taskId":"job_a1b2c3d4e5","progress":0.42,"stage":"decode"}}
```

Missing optional Python dependencies simply omit the capability from `hello`; the degradation matrix (1.6) governs what the app does about it (NFR-101).

**Supervision algorithm** (`MlworkerSupervisor`, part of `MediaEngine`'s process management):

1. Spawn the worker; start a 15 s handshake timer. If `mlworker.hello` does not arrive in time, kill and count a failure.
2. While idle, send `ping` every 10 s. While a task runs, any `$/progress` counts as liveness. No liveness signal for 120 s → the worker is hung: `SIGKILL`, count a failure, fail the in-flight job with `retry: 'safe'`.
3. On exit (crash or kill): fail any in-flight job with `retry: 'safe'`, then restart with exponential backoff 1 s → 5 s → 25 s.
4. Three consecutive failures without an intervening completed task within 10 minutes → mark the mlworker `unavailable`, stop restarting, emit a `mlworker.state` event, and reject subsequent ML jobs with error code `E_MLWORKER_DOWN` (envelope per Part 0 §0.4) whose `suggestion` names the repair actions (restart worker from Settings, safe mode, reinstall).
5. A successful task completion resets the failure counter. The user can force a restart from Settings at any time.
6. Cancellation: send `$/cancel {taskId}`; if the worker has not acknowledged (by aborting the request with a JSON-RPC error `code: -32800`) within 5 s, `SIGKILL` and restart per step 3.

One task is in flight per worker process; GPU-heavy tasks are additionally serialized against high-quality preview renders when VRAM is scarce (1.6).

### 1.3 Typed IPC contract (renderer ↔ main)

Two channels only. Requests use `ipcRenderer.invoke('gd:rpc', req)`; server-push events arrive on `'gd:evt'`. All shapes live in `@guyditor/app` `src/shared/ipc.ts` and are the single source of typing for both sides.

```ts
// src/shared/ipc.ts  (all exported)
export interface GuyditorError {              // Part 0 §0.4 envelope, verbatim
  code: string;                               // "E_" + SCREAMING_SNAKE, e.g. "E_MLWORKER_DOWN"
  message: string;
  affected: string[];                         // Part 0 prefixed IDs
  acceptedStateChanged: boolean;
  retry: 'safe' | 'unsafe' | 'none';
  suggestion?: string;
}

export type ServiceName =
  | 'ProjectStore' | 'OperationEngine' | 'MediaEngine' | 'TranscriptEngine'
  | 'CompositorModel' | 'RenderService' | 'JobQueue' | 'AgentGateway'
  | 'AuditLog' | 'CostMeter' | 'BackupService' | 'DeliverableService'
  | 'AnnotationService' | 'SkillRegistry' | 'AdapterRegistry' | 'CaptureWatcher';

export interface IpcRequest {
  v: 1;
  requestId: string;        // "req_" + 10 base32 chars; ephemeral, never persisted
  service: ServiceName;
  method: string;           // camelCase method on the service's IpcSurface
  params: unknown;          // validated against the method's JSON Schema in main
}

export type IpcResponse<T = unknown> =
  | { v: 1; requestId: string; ok: true;  result: T }
  | { v: 1; requestId: string; ok: false; error: GuyditorError };

export interface JobStatus {                  // superset of Part 0's job shape
  jobId: string; kind: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;                           // 0..1
  error?: GuyditorError;
  title: string;                              // human-readable, for the job panel
  cancellable: boolean;
  createdAt: string; startedAt?: string; finishedAt?: string; // ISO 8601 UTC
  etaSeconds?: number;
}

export type GdEvent =
  | { kind: 'job.state';          seq: number; job: JobStatus }
  | { kind: 'job.progress';       seq: number; jobId: string; progress: number; etaSeconds?: number }
  | { kind: 'project.revision';   seq: number; revision: string }        // "rev_00017"
  | { kind: 'proposal.updated';   seq: number; proposalId: string }      // "prp_..."
  | { kind: 'annotation.updated'; seq: number; annotationId: string }
  | { kind: 'watcher.ingested';   seq: number; assetIds: string[] }
  | { kind: 'mlworker.state';     seq: number; state: 'starting'|'ready'|'restarting'|'unavailable' }
  | { kind: 'capability.changed'; seq: number; report: CapabilityReport }
  | { kind: 'perf.budget.exceeded'; seq: number; budget: string; observedMs: number };
```

Rules:

1. Every service that is renderer-callable exports an `IpcSurface` manifest `{ service, methods: { [name]: { paramsSchema, resultSchema, budgetMs } } }`. The preload script exposes a generated, fully typed facade `window.guyditor: GuyditorApi` (`call(service, method, params)` + `on(kind, handler)`); nothing else crosses the context bridge.
2. Main validates `params` against `paramsSchema` before dispatch; failure returns `E_IPC_SCHEMA` with `retry: 'none'`.
3. Events are broadcast to the owning window, carry a per-window monotonic `seq`, and are droppable: every event's full state is re-queryable (e.g. `JobQueue.list`), so a missed event never corrupts UI state. `job.progress` is throttled to ≤ 10 events/s per job.
4. The `AgentGateway` MCP tools call the same service methods with the same schemas (AD-009); an operation performed in the UI and one proposed by an agent are byte-identical `OperationEngine` inputs (FR-901).

### 1.4 Application startup sequence

1. `app.requestSingleInstanceLock()`; if denied, forward `argv` (deep links, project paths) to the first instance and exit.
2. Initialize logging (1.12); write `app.start` with app version and runtime-manifest hash (1.15).
3. Load `~/.guyditor/settings.json`. On parse failure: rename to `settings.json.bad-<timestamp>`, continue with defaults, queue a warning notification.
4. Check the crash marker `~/.guyditor/state/crash.marker`. Present → set `recoveryNeeded = true` and increment the crash-loop counter; then (re)write the marker. Two consecutive startup crashes → start in **safe mode** (software rendering, mlworker not auto-started, capability probe forced).
5. Load `~/.guyditor/state/capabilities.json`. If its fingerprint (OS build, GPU device IDs, driver versions, ffmpeg build hash, app version) matches and it is < 30 days old, use it; otherwise schedule a background re-probe (1.5) and use conservative software-only capabilities until it completes.
6. Construct app-scoped services in dependency order: `AuditLog`, `CostMeter`, `AdapterRegistry`, `SkillRegistry`, `MediaEngine`, `TranscriptEngine`, `RenderService`, `AnnotationService`, `DeliverableService`, `BackupService`, `CaptureWatcher` (idle until a project opens).
7. Spawn the jobhost pool.
8. Spawn the mlworker (asynchronous; never blocks window creation).
9. Start the `AgentGateway`; write `~/.guyditor/state/gateway.json` (0600).
10. Create the `BrowserWindow` (restored geometry from `window-state.json`), show on `ready-to-show`. **Budget: steps 1–10 complete and window interactive in ≤ 3 s** on the reference workstation (1.7), excluding the background probe and mlworker warmup.
11. If `settings.general.reopenLastProject` (default `true`): `ProjectStore.open(path)` — parse master file + transaction journal, attach `JobQueue` to `<project>/.guyditor/jobs.sqlite`, run the job recovery scan (1.13) when `recoveryNeeded`, resume the project's watch folders. **Budget: open-to-interactive-timeline ≤ 5 s** for a 1-hour episode with warm proxies.
12. When the capability probe completes, emit `capability.changed`; `JobQueue` re-plans encoder/device selection for still-queued jobs.
13. On clean quit: flush logs and audit, close jobs.sqlite, delete `crash.marker`, reset the crash-loop counter.

### 1.5 Hardware capability detection

Probing is a background job (`kind: "probe.capabilities"`). Algorithm:

1. **CPU/RAM:** `os.cpus()` (count, model), `os.totalmem()`.
2. **GPU inventory:** Electron `app.getGPUInfo('complete')` → vendor/device/driver; on Linux additionally parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` when present; on macOS VRAM is taken as unified-memory budget.
3. **Accel APIs:** run `ffmpeg -hide_banner -hwaccels`; record the list.
4. **Encoder inventory:** run `ffmpeg -hide_banner -encoders`; intersect with the candidate set `h264_nvenc, hevc_nvenc, h264_qsv, hevc_qsv, h264_amf, hevc_amf, h264_videotoolbox, hevc_videotoolbox, h264_vaapi, hevc_vaapi, libx264, libx265`.
5. **Functional verification** (listing an encoder is not proof it works): for each candidate, run a 10 s-timeout test encode `ffmpeg -f lavfi -i testsrc2=duration=0.5:size=1280x720:rate=30 -c:v <enc> -f null -` (VAAPI adds `-vaapi_device /dev/dri/renderD128 -vf format=nv12,hwupload`). Exit 0 → `verified: true`.
6. **Decode accel verification:** generate a 0.5 s H.264 clip with libx264 into the scratch cache, then attempt `-hwaccel <api>` decode of it; record verified decode APIs.
7. **Disk headroom:** `statfs` on the volume holding `~/.guyditor` and, per open project, the project volume.
8. **ML device:** taken from the mlworker `hello` (`cuda` | `mps` | `cpu`, VRAM).
9. **WebGL2:** reported by the renderer once at first window load.
10. Write the report + fingerprint to `~/.guyditor/state/capabilities.json`; emit `capability.changed`.

```ts
export interface CapabilityReport {
  fingerprint: string;                 // hash of OS build, GPU ids, drivers, ffmpeg build, app version
  probedAt: string;                    // ISO 8601 UTC
  cpu: { cores: number; model: string };
  memoryMb: number;
  gpus: { vendor: string; model: string; vramMb: number | null; driver: string }[];
  hwaccels: string[];                                    // from -hwaccels
  encoders: { name: string; verified: boolean }[];       // step 5
  decodeAccels: { api: string; verified: boolean }[];    // step 6
  ml: { device: 'cuda' | 'mps' | 'cpu'; vramMb: number | null;
        capabilities: string[] };                        // task types from hello
  webgl2: boolean;
  disk: { path: string; freeBytes: number; totalBytes: number }[];
}
```

**Encoder selection.** `@guyditor/media` picks encoders from a per-platform preference order filtered by `verified: true` — macOS: `videotoolbox → libx264/x265`; Windows: `nvenc → qsv → amf → libx264/x265`; Linux: `nvenc → vaapi → qsv → libx264/x265`. Hardware encoders are the default for **proxies and previews** (throughput). **Final exports default to software `libx264`/`libx265`** for cross-machine reproducibility (AD-013, FR-1002); the creator MAY opt a deliverable into hardware final encode, and the chosen encoder is always recorded in the export report (FR-1005).

### 1.6 Degradation matrix (NFR-101)

Every probed capability maps to a supported fallback or an explicit warning — never an unexplained failure. Warnings surface as non-modal notices and as `suggestion` text in job errors (NFR-104).

| Probed capability | Preferred path | Degraded path | User-facing behavior |
|---|---|---|---|
| HW H.264/HEVC encoder | HW encode for proxies/previews | `libx264`/`libx265` software encode | One-time notice; job panel shows longer ETAs; export report records actual encoder |
| HW decode accel | HW decode for preview/analysis | Software decode; if sustained proxy playback drops below 24 fps, `MediaEngine` selects the next-lower proxy tier (tier ladder defined in Part 3) | Notice on first fallback |
| GPU ML device (`cuda`/`mps`) | Whisper default model `large-v3`; GPU matting/tracking | CPU inference; default transcription model drops to `small` (creator may still pick larger); matting permitted with an explicit ">10× real time expected" warning | Warning with ETA multiplier before job start |
| mlworker process (Python runtime broken) | All ML task types | None — ML jobs rejected with `E_MLWORKER_DOWN`; ingest, editing, compositing, and rendering remain fully functional | Persistent banner with repair suggestions |
| Individual mlworker capability missing (e.g. `matte` deps absent) | That task type | Feature hidden/disabled with explicit "capability not installed" state | Inline capability warning where the feature is invoked |
| WebGL2 | Multi-layer live compositor preview | Canvas2D single-layer preview; keying/PiP judged via high-quality preview renders (AD-005 render path still works) | Explicit capability warning at startup |
| VRAM < 4 GB | Concurrent GPU ML + GPU preview | ML jobs pause during playback; matting falls back to CPU | Notice |
| RAM < 8 GB | Default job concurrency | `jobs.maxConcurrent = 1`; analysis runs chunked | Warning at startup |
| Free disk < 25 GB (cache volume) | Normal operation | Normal operation + cleanup suggestion (NFR-102 tooling, Part 13) | Warning |
| Free disk < 10 GB | Proxy/render/export jobs run | Jobs that write large artifacts refuse to start (`E_DISK_FULL`, `retry: 'safe'` after cleanup); editing and saving continue | Actionable error naming the volume and the cleanup path |
| Below reference workstation overall | — | Everything runs on software paths | Startup notice: "below reference hardware; background jobs will be slower" |

### 1.7 Responsiveness budgets and background work (NFR-100)

**Reference workstation** (budgets are measured against it, Part 14 automates the measurement): 8-core CPU, 16 GB RAM, mid-range GPU of RTX 3060 / Apple M1 Pro class, NVMe SSD.

| Interaction | Budget |
|---|---|
| Timeline interaction (select, drag, trim gesture) — input to paint | ≤ 50 ms; sustained drags ≥ 30 fps |
| Scrub to arbitrary frame on proxies | ≤ 100 ms p95 (warm proxy), ≤ 250 ms p99 cold seek |
| Transcript word selection / caret movement | ≤ 50 ms |
| Annotation create / draw stroke echo | ≤ 50 ms |
| Undo / redo | ≤ 100 ms |
| Semantic operation round trip (IPC → `OperationEngine` → store event) | ≤ 150 ms p95 |
| Proxy playback, 3 video layers + captions | ≥ 24 fps sustained |
| Master-file save (async, atomic) | ≤ 500 ms; never blocks input |
| App cold start to interactive window | ≤ 3 s |
| Project open to interactive timeline (1 h episode, warm proxies) | ≤ 5 s |

Enforcement rules:

1. The renderer never performs filesystem, ffmpeg, or ML work; it composites already-decoded proxy frames (AD-005) and issues IPC.
2. A main-process IPC handler MUST either complete within its manifest `budgetMs` (default 20 ms of main-thread CPU) or enqueue a `JobQueue` job / delegate to a jobhost and return a `jobId` immediately. Spawning ffmpeg or an ML task inside a handler the UI synchronously awaits for an interactive gesture is forbidden.
3. Everything expensive — proxy generation, analysis, transcription, alignment, keying previews, renders, exports, backups, capability probes — is a visible `JobQueue` job: it appears in the deliverable/render-status panel (FR-900) with `title`, `progress`, `etaSeconds`, cancel/retry controls, and completion/failure toasts. Jobs never open modal dialogs and never lock the timeline.
4. Both processes instrument budgets with `performance.mark`/`measure`; a violation emits `perf.budget.exceeded` (1.3) and a `warn` log record. Playwright perf smoke tests in CI fail on p95 regressions (AD-014, Part 14).

### 1.8 Local-first boundary and network egress control (BR-001)

Guyditor is local-first by construction, not by policy text:

1. **Renderer:** no network. The window's `session` registers a `WebRequest` blocker that rejects all outbound requests except `devtools://` in dev builds. UI assets are bundled; no CDN fonts, no telemetry.
2. **Main:** all outbound network I/O goes through one module, `NetGate` (in `@guyditor/agent`). Direct `fetch`/`net` use elsewhere is lint-forbidden (`no-restricted-imports` + a CI grep). `NetGate.request()` requires: the calling adapter ID (`adp_…`) or the reserved caller `system.modelDownload`, the declared data classes being sent (`DataClass[]`, per NFR-001 — the closed enum `metadata | prompt | transcript | frames | audio | video` is defined here and used verbatim by Parts 7, 8, and 9; an empty list declares a call carrying no project data, e.g. `system.modelDownload`), and a cost estimate. It consults `settings.network.externalCalls` (`'allow' | 'ask' | 'block'`, default `'ask'`), enforces `CostMeter` budgets, writes every actual call to the `AuditLog` (AD-012), and annotates the UI: any command that would leave the machine is marked with an explicit "sends <data classes> to <provider>" badge before it runs.
3. `externalCalls: 'block'` MUST leave every local capability working: ingest, proxies, transcription, alignment, editing, compositing, rendering, export (NFR-002). The only non-adapter network operation is `system.modelDownload` — first-use download of ML model weights into `~/.guyditor/models/` with SHA-256 verification (1.15); it downloads only, uploads nothing, and is disclosed and confirmable like any adapter call.
4. FFmpeg is invoked with network protocols disabled (`-protocol_whitelist file,pipe,crypto` on inputs derived from project assets); the mlworker runs with `HF_HUB_OFFLINE=1` and resolves models exclusively from `~/.guyditor/models/`.

### 1.9 Director attachment and provider independence (BR-002, BR-003)

The **director** — the frontier model doing reasoning and planning — is an external MCP client, not a bundled dependency. Consequences:

1. Any MCP-capable model can direct Guyditor by connecting `guyditor-mcp` (1.1). Example client config (works for Claude Code, Codex-class CLIs, and desktop agents):

```json
{ "mcpServers": { "guyditor": { "command": "guyditor-mcp" } } }
```

2. The `AgentGateway` exposes tools that wrap the same `IpcSurface` methods and semantic operations the UI uses (tool catalog in Part 9); the director manipulates the project only through them (BR-002). Sessions are authenticated with the gateway token, given a `ses_` ID, and fully audited (AD-012).
3. The project format contains no vendor fields. Model and skill versions recorded in transactions (FR-104) are *provenance*, never runtime dependencies: a project edited with one director opens and renders identically without it (BR-003).
4. Bounded external services (B-roll generation, specialist critic, synthetic voice) are `AdapterRegistry` adapters discovered from `~/.guyditor/adapters/<adapterId>/manifest.json` (interface and manifest schema in Part 9; runtime placement: in-process in main behind the adapter interface, all egress via `NetGate`). Which director or adapters the creator uses is user-level configuration (`settings.json`), never project state.

### 1.10 Runtime enforcement of the declarative source of truth (BR-005)

The master file and its sidecars are authoritative; everything else is disposable. The runtime enforces this, it does not merely document it:

1. **Single writer.** Only `ProjectStore` writes `episode.guyditor.yaml`, `sidecars/`, `history/`, and `proposals/` (formats in Part 2), always atomically (write temp → `fsync` → rename).
2. **PathPolicy.** All main-process file writes pass through a `PathPolicy` guard classifying the target as `canonical` (ProjectStore-only), `derived` (`<project>/.guyditor/cache/`, `jobs.sqlite`), `export` (deliverable outputs), or `userConfig` (`~/.guyditor/`). A service writing outside its class is a programming error that throws `E_PATH_POLICY` and is caught by tests (Part 14).
3. **Cache disposability invariant.** Deleting `<project>/.guyditor/` in its entirety MUST lose nothing but time: proxies, waveforms, analysis, render caches, and job state are all regenerable from canonical state + source media. This is a tested invariant, and it is what makes cache cleanup (NFR-102, Part 13) safe.
4. The renderer holds no project truth (1.1), so no UI state can silently diverge from the master file; the UI re-derives its view from `ProjectStore` query results after every `project.revision` event.

### 1.11 Extensibility boundaries (NFR-105)

Every pluggable concern crosses a named, documented seam. Adding an implementation never changes project semantics or the schema of `episode.guyditor.yaml`.

| Seam | Interface (owner part) | Registration | v1 implementation |
|---|---|---|---|
| Transcription engine | `TranscriptionEngine` (Part 4) | mlworker task type + `hello` capability | faster-whisper |
| Forced alignment | `AlignmentEngine` (Part 4) | mlworker task type | CTC forced alignment |
| Analysis tools (VAD, scenes, tracking) | `AnalysisTool` (Part 3) | mlworker task type | silero-vad, PySceneDetect, mediapipe |
| Matting | `MattingEngine` (Part 6) | mlworker task type | chroma key (FFmpeg) + RVM |
| Render backend | `RenderBackend` (Part 12) | build-time module behind `RenderService` | FFmpeg filtergraph compiler |
| Overlay/template renderer | `OverlayRenderer` (Part 12) | build-time module | deterministic TS renderer (Remotion MAY replace it, AD-006) |
| Model providers / B-roll / critic / voice | `ProviderAdapter` (Part 9) | `~/.guyditor/adapters/<id>/manifest.json` | one working generation path (FR-604) |
| Director | MCP client (Part 9) | external, via `guyditor-mcp` | any MCP-capable frontier model |
| Exporters / platform profiles | `PlatformProfile` (Part 11) | `profiles/` (built-in) + `~/.guyditor/profiles/` (user) | youtube-longform, youtube-shorts, tiktok, instagram-reels |
| Timeline interchange | `InterchangeExporter` (Part 12) | build-time module | OpenTimelineIO export |

New mlworker-side engines are added by shipping a new task type and advertising it in `hello`; the app discovers them at handshake, so the extension mechanism is the same one the degradation matrix already handles.

### 1.12 User-level file layout and settings

```
~/.guyditor/
  settings.json            # UserSettings (below), schema-versioned
  state/                   # app-managed runtime state
    capabilities.json      #   CapabilityReport + fingerprint (1.5)
    gateway.json           #   MCP endpoint + bearer token, mode 0600 (1.1)
    window-state.json      #   window geometry per project
    ui-state.json          #   workspace panel layout per project (Part 10 §10.2, D10-02)
    recent-projects.json
    crash.marker           #   present while running; leftover ⇒ unclean exit
  audit/                   # <session-id>.jsonl agent audit logs (AD-012, Part 9)
  logs/                    # guyditor-YYYYMMDD.jsonl, mlworker-YYYYMMDD.jsonl (1.13)
  adapters/                # <adapterId>/manifest.json + config — no secrets (AD-011)
  skills/                  # global reusable skills (skl_*, Part 9)
  presets/                 # global presets (pre_*, Parts 5/6)
  templates/               # creator template library (<tpl_id>/<version>/, Part 7 §7.2)
  profiles/                # user platform-profile overrides (Part 11)
  models/                  # downloaded ML weights, content-addressed, SHA-256 verified
```

Secrets never appear anywhere in this tree; they live in the OS keychain keyed by adapter ID (AD-011). `audit/`, `logs/`, `state/`, and `models/` are excluded from backups' load-bearing set except `audit/` when audit retention demands it (Part 13).

```ts
export interface UserSettings {
  schema: 1;
  general: { locale: string; theme: 'system' | 'light' | 'dark'; reopenLastProject: boolean };
  network: { externalCalls: 'allow' | 'ask' | 'block' };        // default 'ask' (1.8)
  performance: {
    maxConcurrentJobs: number | 'auto';                          // 'auto' = min(4, ceil(cores/2))
    jobhostPoolSize: number | 'auto';
    preferHardwareEncode: boolean;                               // proxies/previews, default true
    hardwareFinalEncode: boolean;                                // default false (1.5)
  };
  mlworker: { autoStart: boolean; maxProcesses: number; defaultTranscriptionModel: 'auto' | string };
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; retentionDays: number };  // default 'info', 30
  audit: { retentionDays: number };                              // NFR-007; default 365
  budgets: { task:       { warnUsd: number | null; capUsd: number | null };
             episode:    { warnUsd: number | null; capUsd: number | null };
             cumulative: { warnUsd: number | null; capUsd: number | null } };
                                                                 // = BudgetConfig (Part 9 §9.12); enforced by CostMeter
  dataBoundaries?: unknown;                                      // data-boundary policy block — schema owned by Part 9 §9.9
}
```

Unknown keys are preserved on write; missing keys take defaults. There is **no telemetry setting because there is no telemetry** — nothing is ever phoned home (BR-001).

### 1.13 Structured logging

All processes log JSONL, one record per line, to `~/.guyditor/logs/guyditor-YYYYMMDD.jsonl` (mlworker stderr wrapped into `mlworker-YYYYMMDD.jsonl`). Rotation is daily; files older than `logging.retentionDays` are deleted at startup.

```ts
export interface LogRecord {
  ts: string;                 // ISO 8601 UTC, millisecond precision
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;              // service or subsystem, e.g. "MediaEngine", "mlworker"
  event: string;              // dot-scoped, e.g. "job.failed", "probe.encoder.verified"
  msg: string;                // human-readable
  data?: Record<string, unknown>;
  jobId?: string; sessionId?: string; txnId?: string; requestId?: string;  // correlation
}
```

Redaction rules (enforced by the logger, tested in Part 14): secrets and keychain material never (AD-011, NFR-003 — render logs included); media content and frame data never; prompt/response text belongs to the `AuditLog`, not the app log; absolute file paths are allowed. Renderer logs forward to main over a dedicated `gd:log` channel so a renderer crash cannot lose its final records. Errors returned to callers are logged once, at the boundary that created them, with their full envelope.

### 1.14 Crash recovery

1. **Detection.** `crash.marker` present at startup (1.4 step 4) ⇒ the previous run ended uncleanly.
2. **Accepted state is safe by construction.** Master-file writes are atomic and the transaction journal is append-only (AD-008, Part 2); a torn final journal line is detected by per-line parse and truncated with a `warn` record. A crash can therefore lose at most an unsaved *proposal draft*, never an accepted revision (NFR-103).
3. **Job recovery scan** (on project open when recovery is needed): every job in state `running` in `jobs.sqlite` is marked `failed` with `retry: 'safe'` and its partial outputs in `.guyditor/cache/` are deleted (they are keyed by content hash, so partial files are simply absent from the cache index). Jobs whose kind is flagged idempotent (proxies, analysis, transcription, alignment, waveforms, probes) are automatically re-queued; renders and exports are surfaced in the job panel for one-click manual retry (FR-1003).
4. **Renderer crash** (`render-process-gone`): main logs the reason, reloads the window, and restores view state from `window-state.json`; project state lives in main and is unaffected.
5. **mlworker crash:** handled by supervision (1.2); the owning job fails `retry: 'safe'`.
6. **Crash loop:** two consecutive startup crashes ⇒ safe mode (1.4) with a visible explanation and a "report/inspect logs" affordance.

### 1.15 Packaging and distribution

**Builder:** electron-builder. Targets — macOS: `dmg` + `zip` for `arm64` and `x64`, hardened runtime, signed with a Developer ID certificate and notarized via `notarytool`; Windows: NSIS `x64`, Authenticode-signed (EV or Azure Trusted Signing); Linux: `AppImage` + `deb` `x64`. Unsigned local dev builds are permitted and clearly labeled.

**Bundled runtimes** (in `resources/`, per platform/arch):

- `resources/bin/` — pinned static FFmpeg + ffprobe builds (single pinned upstream version across all platforms, e.g. FFmpeg 7.1.x; exact build hash recorded).
- `resources/python/` — python-build-standalone CPython 3.11.x plus the mlworker's locked site-packages (hash-pinned lockfile; installed at build time, nothing downloaded at install or first run).
- `resources/mcp/guyditor-mcp` — the stdio proxy binary (1.1), also symlinked onto PATH by installers where the platform allows.
- `resources/runtime-manifest.json` — exact versions and SHA-256 hashes of every bundled tool. `RenderService` copies this into every export report (FR-1005) and it participates in render cache keys (AD-013).

```json
{
  "app": "1.0.0",
  "ffmpeg": { "version": "7.1.1", "sha256": "…" },
  "ffprobe": { "version": "7.1.1", "sha256": "…" },
  "python": { "version": "3.11.9", "sha256": "…" },
  "mlworker": { "version": "1.0.0", "lockfileSha256": "…" }
}
```

**ML model weights are not bundled** (multi-GB): they are fetched on first use into `~/.guyditor/models/` through `system.modelDownload` (1.8) with checksum verification and a size prompt. **Updates:** v1 performs update checks only on explicit user request (Settings → "Check for updates"); there is no silent auto-update and no background update traffic.

### 1.16 Development runtime and dogfooding (BR-008)

1. `pnpm dev` runs the *complete* application — same services, same bundled binary versions (fetched once into a git-ignored `vendor/` by `pnpm fetch-runtime`, verified against `runtime-manifest.json`), no mock services. Dev mode differs from release only by devtools, source maps, and signing.
2. There are no release-build feature flags: anything present in a milestone build is usable end-to-end, because each milestone exits by producing a real video with only shipped functionality (Part 0 §0.6, Part 14).
3. The structured logs (1.13), audit logs, job history, and `perf.budget.exceeded` events are the dogfooding feedback channel: they stay on the creator's machine and are readable with ordinary text tools, so real-production friction is diagnosable without any telemetry pipeline.
4. Fixture media for tests is script-generated (AD-014), but Part 14's milestone exit criteria require the *real-episode* run — the architecture supports this by making dev and release runtime-identical.

### Part 1 requirements coverage

| BRD ID | Implemented by |
|---|---|
| BR-001 | 1.8 (NetGate, renderer network block, offline ML, disclosure badges), 1.12 (no telemetry), 1.15 (local bundled runtimes; model download as the sole disclosed non-adapter network op) |
| BR-002 | 1.1 (AgentGateway placement, `guyditor-mcp`), 1.9 (director as MCP client using semantic tools, never UI simulation), 1.3 rule 4 |
| BR-003 | 1.9 (vendor-free project format, provenance-not-dependency rule, adapter registry), 1.11 (ProviderAdapter/director seams) |
| BR-005 | 1.10 (single-writer ProjectStore, PathPolicy classes, cache-disposability invariant, renderer holds no truth) |
| BR-008 | 1.16 (runtime-identical dev builds, no release feature flags, local feedback channels), 1.13 |
| NFR-100 | 1.7 (budget table, enforcement rules, visible background jobs), 1.3 rule 3 (event throttling), 1.4 (startup/open budgets), 1.1 (process isolation of heavy work) |
| NFR-101 | 1.5 (probe algorithm, `CapabilityReport`, verified encoder selection), 1.6 (degradation matrix), 1.2 (capability advertisement and graceful ML degradation) |
| NFR-105 | 1.11 (seam table and registration mechanisms), 1.2 (mlworker task-type extension surface), 1.9 point 4 |

Secondary contributions: NFR-103/NFR-104 (1.13, 1.14 — crash safety and actionable errors at the runtime layer; primary owner Part 12), NFR-003 (1.12, 1.13 — keychain-only secrets and log redaction; primary owner Part 9), NFR-001/NFR-002 (1.8 — data-class declaration and `externalCalls: 'block'`; primary owner Part 9).

---

## Part 2 — Canonical project format and versioning

This part defines the canonical, declarative project format (`guyditor/v1`), its time model, semantic anchors, sidecar registry, transaction journal, proposal lifecycle, revision history, canonical serialization, and Git integration. It is implemented in `@guyditor/core` and consumed by every other package. All names, ID prefixes, and layout rules below conform to Part 0 (AD-007, AD-008, §0.4); Part 5 owns the operation catalog that mutates this model, Part 3 owns ingest, Part 4 owns transcript internals.

### 2.1 Project directory layout

A project is an ordinary directory (AD-007). `ProjectStore` recognizes a directory as a project by the presence of `episode.guyditor.yaml`.

```
<project>/
  episode.guyditor.yaml      # canonical master file (this part) — accepted state ONLY
  sidecars/                  # referenced data files, registered in the master (2.8)
  proposals/                 # open proposals; never part of accepted state (2.10)
  history/                   # transaction journal, revision snapshots, locks (2.9, 2.11)
    transactions.jsonl
    revisions/               # rev_00001.yaml + rev_00001.lock.json per accepted revision
    proposals/               # resolved (accepted/rejected) proposal archives
    HEAD                     # single line: current accepted revision id, e.g. rev_00021
  media/                     # default ingest destination (sources MAY live elsewhere)
    generated/               # frozen generated assets, read-only from acceptance (Part 7 §7.10)
  presets/                   # pinned snapshots of presets used by this project (2.12)
  skills/                    # pinned snapshots of skill versions used by this project (2.12)
  .guyditor/
    cache/                   # disposable derived artifacts (proxies, previews, render cache)
    jobs.sqlite              # JobQueue persistence (AD-010)
  .gitignore                 # written at project creation (2.14)
```

Load-bearing state (business rule 2, NFR-106): the master file, `sidecars/`, `history/`, `proposals/`, `presets/`, `skills/`, and source media. Everything under `.guyditor/` is disposable and MUST be reconstructible from load-bearing state. No Guyditor operation ever writes into a source media file (business rule 1); assets are referenced by path + SHA-256 only.

### 2.2 Time model and rational arithmetic

Implements FR-102 with the Part 0 binding serialization. Three distinct time domains exist and MUST NOT be mixed implicitly:

- **Source time** — a position/duration inside one original asset, in that asset's native units.
- **Timeline time** — a position in an assembled sequence, in the owning sequence's timeline rate. Timeline positions are *derived*, never stored per clip (2.7).
- **Semantic anchors** — references to words, beats, or clip-relative events (2.3), preferred wherever the BRD allows.

```typescript
/** Exact rational, serialized as the string "<num>/<den>", den > 0, normalized (gcd = 1). */
export type Rational = string;                      // e.g. "30000/1001", "25/1"

export interface FrameTime  { frames: number; fps: Rational; }   // video/source & timeline positions and durations
export interface SampleTime { samples: number; rate: number; }   // audio-only assets
export type TimeValue = FrameTime | SampleTime;
```

Binding arithmetic rules:

1. `frames`, `samples`, and rational numerators/denominators are integers within ±2^53−1; implementations MUST use exact integer math (BigInt where products may overflow). IEEE floating point is forbidden in the project model, in serialization, and in all comparisons.
2. Absolute time of `FrameTime` is the exact rational `frames × den/num` seconds. Comparison and addition of times at different rates is done by cross-multiplication over a common rational base — never by converting to float seconds.
3. Converting a time to a different frame rate happens only at explicit conversion points (timeline derivation 2.7, render compilation Part 12, caption export Part 4). When the exact result is not an integer frame at the target rate, round to the nearest frame; exact ties round toward the earlier frame. Every API performing lossy conversion MUST expose the pre-rounding rational.
4. Durations are non-negative. Source ranges are half-open `[in, out)`: `out.frames > in.frames`, both at the asset's native `fps` (or `SampleTime` for audio-only assets).
5. The timeline rate is `settings.timeline.fps`; per-sequence overrides are not allowed in `guyditor/v1`.

### 2.3 Semantic anchor grammar and resolution

Anchors implement FR-102's third domain and are the required addressing mode for captions, graphics, annotations, beats, deliverable ranges, and keyframes (FR-204, FR-402, FR-601 in later parts). An anchor is a single-line string:

```
anchor          := word-anchor | beat-anchor | clip-anchor | ann-anchor | timeline-anchor
word-anchor     := "word:" word-id [edge] [offset]   ; word:w000042 | word:w000042#end | word:w000042+12
beat-anchor     := "beat:" beat-id [offset]          ; beat:beat_hk3m2p6qa4
clip-anchor     := "clip:" clip-id "@" int [offset]  ; clip:clp_a4b2c3d4e5@36
ann-anchor      := "ann:" ann-id                     ; ann:ann_k7m2q9d4tp — resolves through the annotation's own anchor
timeline-anchor := "timeline:" (seq-id "@" int       ; timeline:seq_shrt4d5e6f@4302 (frames at that sequence's timeline rate)
                              | int "@" rational)    ; timeline:4302@30000/1001 (scope sequence implied by context)
edge            := "#start" | "#end"                 ; word anchors only; default #start
offset          := ("+" | "-") int                   ; frames at the timeline rate
word-id         := "w" 6*DIGIT ;  rational := int "/" int
```

Semantics: `word:` resolves to the timeline frame where the word's aligned start — or aligned end, with the `#end` edge — plays back (canonical transcript sidecars, Part 4). `beat:` resolves through the beat's own anchor (beats MUST NOT anchor to other beats — depth 1). `clip:` means *N source frames after the clip's current source in-point*, at the source asset's native rate; it survives moves, reordering, and edits to other clips. `ann:` resolves through the referenced annotation's anchor via `AnnotationService` (used by Part 7 graphics; an orphaned annotation orphans the `ann:` anchor). `timeline:` is the fallback of last resort (FR-402) and is invalidated by any upstream duration change; the sequence-qualified form fixes the scope explicitly. `AnchorRange` is `{ start: anchor, end: anchor }` with `end` resolving strictly after `start`. This string grammar governs anchors stored in the master file; annotation *records* in the annotations sidecar serialize structured anchor objects (including an `object`/track anchor kind and per-kind offset rates) per Part 8 §8.3.

```typescript
export type SemanticAnchor = string;                 // validated against the grammar above
export interface AnchorRange { start: SemanticAnchor; end: SemanticAnchor; }
export interface AnchorResolution {
  status: 'resolved' | 'orphaned';
  timeline?: FrameTime;                              // present when resolved
  approximate?: boolean;                             // true when resolved via the Part 4 §4.5 rule 6 fallback
  source?: { assetId: string; time: FrameTime };     // present for word/clip anchors
  reason?: 'word-deleted' | 'word-not-in-edit' | 'beat-orphaned' | 'clip-deleted'
         | 'ann-orphaned' | 'offset-out-of-range' | 'beyond-timeline';
  lastResolved?: { timeline: FrameTime; revision: string;
                   context?: { wordsBefore: string[]; wordsAfter: string[] } };
}
```

**Anchor resolution algorithm** (binding; `resolveAnchor(project, anchor, scope)` in `@guyditor/core`; `scope` is a sequence ID, defaulting to the sequence of the primary long-form deliverable):

1. Parse against the grammar. Syntax failure → structured error `E_ANCHOR_SYNTAX` (Part 0 error envelope), not an orphan.
2. `timeline:` — convert to the timeline rate (rule 2.2-3). If the frame exceeds the derived scope duration → `orphaned/beyond-timeline`; else resolved.
3. `clip:` — look up the clip ID in the scope. Missing → `orphaned/clip-deleted`. If `@N` (plus source-converted offset) falls outside the clip's current `[in, out)` source range → `orphaned/offset-out-of-range`. Else timeline position = derived clip start (2.7) + N converted to timeline rate.
4. `word:` — look up the word ID across the canonical transcript sidecars (ordinals are project-global, Part 4 D4-1). A tombstoned word is handled per Part 4 §4.5 rule 6 — never orphaned immediately: follow `replacedBy` transitively to the first active descendant; failing that, fall back to the nearest active word in the same segment whose midpoint lies within 2000 ms and set `approximate: true`; only when both fail → `orphaned/word-deleted`. The resolved word has a source interval on a source asset (use the `#end` edge time when requested); collect scope clips referencing that asset whose source range contains the word's start; if none → `orphaned/word-not-in-edit`; if several (duplicated footage), pick the clip earliest in derived timeline order (deterministic). Timeline position = clip start + (word start − clip in) converted to timeline rate.
5. `beat:` — resolve the beat's stored anchor by steps 2–4; orphaned beat → `orphaned/beat-orphaned`. `ann:` — resolve the annotation's stored anchor per Part 8 §8.5.3; unresolvable → `orphaned/ann-orphaned`.
6. Apply the `offset` (timeline frames) to a resolved position; clamp is forbidden — out of scope duration → `orphaned/beyond-timeline`.

**Orphaned-anchor handling (binding).** The system MUST NEVER silently rebind or guess. When an accepted transaction causes any anchor to transition resolved → orphaned, the `OperationEngine`: (a) records the anchor and owner object ID in the transaction's `orphanedAnchors` (2.9); (b) writes `lastResolved` (final resolved timeline position, revision, and up to 5 neighboring word texts for `word:` anchors) onto the owning object's stored anchor metadata; (c) surfaces the orphan in the proposal diff before acceptance so the creator sees it (FR-105, business rule 6). Orphans appear in `project.validate` output and block final export as an FR-1004 validation item until resolved via the `anchor.rebind` operation (Part 5) or explicit dismissal. Deliverables, captions, and graphics with orphaned anchors are excluded from rendering, never rendered at a guessed position.

### 2.4 Master file model (FR-100)

Root TypeScript model, exported from `@guyditor/core`. Canonical key order in the YAML equals declaration order below (2.13). This part extends the Part 0 §0.4 prefix registry with two prefixes, same format (prefix + 10 random lowercase base32 chars): projects `prj_`, clip effects `fx_`.

```typescript
export interface GuyditorProject {
  format: 'guyditor/v1';
  revision: string;                     // rev_00021 — current accepted revision (mirrors history/HEAD)
  project: { id: string; name: string; created: string /* ISO-8601 UTC */; };
  settings: ProjectSettings;
  transcript: { nextWordOrdinal: number };  // project-global word-ordinal counter (Part 4 D4-1)
  assets: Asset[];
  beats: Beat[];
  sequences: Sequence[];
  layers: Layer[];
  captions: CaptionTrack[];
  annotations: AnnotationIndex;         // sidecar reference + state counts; records live in the sidecar (Part 8 §8.1)
  deliverables: Deliverable[];
  templates?: Record<string, { version: string; contentHash: string }>;  // tpl_ pin table (Part 7 §7.4)
  avoidRegions?: unknown[];             // AvoidRegion[] from `region.mark` — schema owned by Part 6 §6.12
  watchFolders?: unknown[];             // WatchFolderConfig[] — schema owned by Part 3 §3.10
  presets: PresetPin[];
  skills: SkillPin[];
  sidecars: SidecarRef[];
}
export interface ProjectSettings {
  timeline: { fps: Rational; width: number; height: number };
  audio: { sampleRate: number; channels: number };
  primaryDeliverable: string;           // dlv_ id of the long-form master
  automation?: unknown;                 // creator automation policy — schema owned by Part 9 §9.3
}
export interface Asset {                // = Part 3 §3.3 AssetRecord; Part 3 owns ingest semantics
  id: string;                           // ast_
  kind: 'video' | 'audio' | 'image' | 'animation' | 'subtitle' | 'generated' | 'other';
  path: string;                         // relative to project dir when possible, else absolute
  knownPaths?: string[];                // alternates observed (duplicates, relinks — Part 3)
  sha256: string;
  bytes?: number;
  container?: string;                   // ffprobe format_name
  probe: { duration?: TimeValue; width?: number; height?: number; fps?: Rational;
           audio?: { rate: number; channels: number }; capturedAt?: string };
  video?: { codec: string; width: number; height: number; fps: Rational; pixFmt: string;
            hasAlpha: boolean; rotation: 0 | 90 | 180 | 270; colorSpace?: string; bitrate?: number };
  audio?: Array<{ index: number; codec: string; sampleRate: number; channels: number;
                  layout: string; bitrate?: number }>;
  image?: { width: number; height: number; hasAlpha: boolean };
  captureTime?: { value: string /* ISO 8601 */; source: 'container' | 'file-mtime' };
  timecode?: { start: string; fps: Rational };
  session?: string;                     // ses_ capture session (Part 3 §3.10)
  takes?: string[];                     // tak_ (Part 3 §3.11)
  markers?: string[];                   // mrk_ (Part 3 §3.11)
  analyses?: Record<string, unknown>;   // kind → AnalysisRef (Part 3 §3.5; see 2.8)
  sync?: unknown;                       // SyncDecision, on the dependent asset (Part 3 §3.9)
  integrity?: 'ok' | 'missing' | 'mismatch';      // Part 3 §3.14
  ingest?: { at: string; ffprobeVersion: string;
             via: 'manual' | 'watch' | 'pickup' | 'agent' | 'generated' };
  provenance?: { sidecar: string };     // registry name (2.8) of the asset's guyditor.provenance/v1 sidecar
                                        // — required when kind === 'generated' (FR-605, Part 7 §7.10)
  rights?: { source: string; license: string; restrictions?: string };
}
export interface Beat { id: string /* beat_ */; name: string; anchor: SemanticAnchor;
  chapter?: { title: string }; }        // chapter derivation input (Part 11 §11.11)
export interface Sequence { id: string /* seq_ */; name: string; clips: Clip[];
  audio?: { targetLufs: number; truePeakDb: number }; }  // master loudness target (Part 5 §5.3 sequence.audio.master.set)
export interface Clip {
  id: string;                           // clp_
  asset: string;                        // ast_ — every media range refers to a source (business rule 3)
  source: { in: FrameTime; out: FrameTime };   // half-open, asset-native rate
  gapBefore?: FrameTime;                // explicit gap, timeline rate (2.7)
  overlapPrevious?: FrameTime;          // explicit overlap, timeline rate; exclusive with incoming transition
  transitionAfter?: Transition;         // boundary to the NEXT clip; moves with this clip in diffs
  effects?: Effect[];
  audio?: { gainDb?: number; fadeIn?: FrameTime; fadeOut?: FrameTime; mute?: boolean;
            offset?: SampleTime;                       // clip.audio.offset.set (Part 5)
            channels?: 'left' | 'right' | 'mix' | number[];  // clip.audio.channels.set (Part 5)
            chain?: unknown };                         // AudioChain — schema owned by Part 5 §5.8
  loop?: { enabled: boolean; crossfade?: FrameTime };  // clip.loop.set (Part 5 §5.3)
  anchor?: SemanticAnchor;              // clip.anchor.set — semantic start anchor (Part 5 §5.9)
  punchIn?: { level: number; anchor: { x: number; y: number } | 'face-track' };  // clip.punchin.set (Part 5)
}
export interface Transition { id: string /* trn_ */; preset: string /* pre_ or built-in name */;
                              duration: FrameTime; params?: Record<string, unknown>;
                              intent?: string; }       // free-text purpose (FR-310, Part 5 §5.10)
export interface Effect { id: string; kind: string;   // 'speed' | 'freeze' | 'transform' | 'color' | ... (Part 5/6)
                          params: Record<string, unknown>; }   // e.g. speed: { rate: "3/2" } — Rational, never float
export interface Layer {
  id: string;                           // lyr_
  kind: 'video' | 'image' | 'animation' | 'text' | 'caption' | 'matte' | 'adjustment'
      | 'audio' | 'music' | 'ambience' | 'sfx';       // audio role kinds per Part 5 §5.9
  name: string; order: number;          // z/mix order, higher renders above (FR-500)
  enabled: boolean; locked: boolean;
  opacity?: number;                     // 0..1, default 1; multiplied after per-clip opacity (Part 6)
  blend?: string;                       // BlendMode — closed enum owned by Part 6 §6.2; default 'normal'
  transform?: unknown;                  // Transform2D layer default — schema owned by Part 6 §6.2
  matte?: { layerId: string; source: 'alpha' | 'luma'; invert?: boolean };   // Part 6 §6.2
  pip?: unknown;                        // PipConfig — schema owned by Part 6 §6.8
  adjustment?: unknown;                 // ColorCorrection, kind 'adjustment' only (Part 6 §6.2)
  ducking?: unknown;                    // DuckingConfig — schema owned by Part 5 §5.9
  sequence?: string;                    // seq_ — sequential content: positions derived (2.7)
  items?: PlacedItem[];                 // anchored content: overlays, music, graphics
}
export interface PlacedItem { id: string /* clp_, or gfx_ for template-backed graphics (Part 7) */;
  asset?: string; template?: string /* tpl_ — version from the templates pin table */;
  at: SemanticAnchor; duration: FrameTime | { until: SemanticAnchor } | 'intrinsic';
  source?: { in: FrameTime; out: FrameTime }; effects?: Effect[];
  params?: Record<string, unknown>;     // template params, validated per Part 7 §7.2
  seed?: number;                        // uint32, assigned once; drives the template rng (Part 7 §7.3)
  layout?: Record<string, unknown>; }   // PiP constraints etc. — schema owned by Part 6
export interface CaptionTrack {         // = Part 4 §4.8 CaptionTrack; Part 4 owns caption semantics
  id: string;                           // cts_
  name: string;
  sourceLayerIds: string[];             // speech-bearing layers captioned by this track
  preset: { presetId: string /* pre_ */; version: number };   // pinned (FR-705)
  styleOverrides?: Record<string, unknown>;   // Partial<CaptionStyle> (Part 4 §4.8)
  breakOverrides?: unknown[];           // CueBreakOverride[], word-ID anchored (Part 4 §4.9)
  emphasisOverrides?: { wordId: string; emphasis: boolean }[];
  timingOffsets?: { firstWordId: string; startMs?: number; endMs?: number }[];
  enabled: boolean;
}
export interface AnnotationIndex {      // records live in sidecars/annotations.yaml (Part 8 §8.1)
  sidecar: string;                      // registry name of the annotations sidecar
  summary: { open: number; resolved: number; rejected: number; reopened: number };
}
export interface Deliverable {          // = Part 11 §11.1 Deliverable; Part 11 owns deliverable semantics
  id: string;                           // dlv_
  kind: 'longform' | 'short';
  name: string;
  profile: string;                      // '<profileId>@<semver>', e.g. 'youtube-shorts@1.0.0' (business rule 11)
  profileOverrides?: Record<string, unknown>;  // deep-merge patch over the profile
  sequenceId: string;                   // seq_ — shorts own an independent sequence (FR-802)
  captionsTrackId?: string;             // cts_ derivative caption track (Part 11 §11.5)
  status: 'draft' | 'in-review' | 'approved' | 'stale';
  approvedRevision?: string;            // rev_ at approval; staleness input (FR-807, Part 11)
  dependencies?: unknown[];             // DependencyEntry[] — shorts only (Part 11 §11.8)
  divergences?: { class: string; transactionIds: string[] }[];  // business rule 9 (Part 11 §11.3)
  staleReasons?: unknown[];             // StaleReason[] while status === 'stale' (Part 11 §11.1)
  publishFiles?: { path: string; sha256: string }[];            // publish/<dlvId>/... incl. metadata.yaml (Part 11 §11.10)
}
export interface PresetPin { id: string /* pre_ */; name: string;
  kind: 'caption'|'transition'|'look'|'motion'|'layout'|'graphic';
  version: number; path: string /* presets/<pre_id>@<version>.yaml snapshot */; sha256: string; }
export interface SkillPin  { id: string /* skl_ */; name: string;
  version: string;                      // immutable semver, e.g. "1.3.0" (Part 9 §9.5)
  path: string;                         // skills/<name>/<version>/ snapshot dir
  contentHash: string; }                // sha256 over skill.yaml + SKILL.md + examples manifest
```

Fields whose sub-schemas are owned by later parts (`automation`, `chain`, `ducking`, `pip`, `dependencies`, …) are still enumerated here and in the 2.5 schema — the schema stays closed (`additionalProperties: false`); the owning part supplies the `$defs` entry.

### 2.5 JSON-Schema outline for `guyditor/v1`

`@guyditor/core` ships `schema/guyditor-v1.schema.json` (draft 2020-12), the normative validation artifact; `ProjectStore` validates on every load and before every write. Outline:

```json
{ "$id": "https://guyditor.dev/schema/guyditor-v1.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object", "additionalProperties": false,
  "required": ["format", "revision", "project", "settings", "transcript", "assets", "beats", "sequences",
               "layers", "captions", "annotations", "deliverables", "presets", "skills", "sidecars"],
  "properties": {
    "format":   { "const": "guyditor/v1" },
    "revision": { "pattern": "^rev_[0-9]{5}$" },
    "...":      "one property per GuyditorProject field, referencing $defs" },
  "$defs": { "rational":  { "pattern": "^[0-9]+/[1-9][0-9]*$" },
             "frameTime": { "required": ["frames", "fps"], "note": "frames: integer >= 0" },
             "anchor":    { "pattern": "^(ann:ann_[a-z2-7]{10}|(word:w[0-9]{6}(#(start|end))?|beat:beat_[a-z2-7]{10}|clip:clp_[a-z2-7]{10}@[0-9]+|timeline:(seq_[a-z2-7]{10}@[0-9]+|[0-9]+@[0-9]+/[1-9][0-9]*))([+-][0-9]+)?)$" },
             "id":        { "pattern": "^(ast|clp|seq|lyr|trn|cts|ann|dlv|pre|tpl|skl|beat|mrk|tak|fx|prj|job|adp|gfx|ses|msk|kfr|avr)_[a-z2-7]{10}$" },
             "sha256":    { "pattern": "^[0-9a-f]{64}$" },
             "asset|clip|layer|placedItem|transition|effect|captionTrack|annotationIndex|beat|deliverable|presetPin|skillPin|sidecarRef": "object defs mirroring 2.4, all additionalProperties:false" } }
```

Schema-level invariants beyond shape (enforced by `project.validate` in `@guyditor/core`): all ID references resolve; IDs unique; `source.in < source.out`; `overlapPrevious` never on the first clip and never combined with an incoming `transitionAfter` (2.7); every `kind: 'generated'` asset has `provenance` (business rule 8); the `annotations.sidecar` registry name exists in `sidecars` (Part 8 §8.1); word IDs match `^w[0-9]{6}$` and are never renumbered (§0.4).

### 2.6 Annotated example `episode.guyditor.yaml`

Exercises every FR-100 bullet. Comments and compact flow style are used here for readability; the canonical serializer emits no comments and applies the exact style rules of 2.13.

```yaml
format: guyditor/v1
revision: rev_00021
project: { id: prj_ep4rust7ab, name: "EP-014 Rust borrow checker", created: "2026-07-12T09:14:03Z" }
settings:                                    # ---- project settings ----
  timeline: { fps: 30000/1001, width: 3840, height: 2160 }
  audio: { sampleRate: 48000, channels: 2 }
  primaryDeliverable: dlv_lf7h2n6s4d
assets:                                      # ---- assets, immutable IDs (business rules 1, 3) ----
  - { id: ast_camera4a2b, kind: video, path: media/cam-a/EP014_A_take3.mov,
      sha256: 7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069,
      probe: { duration: { frames: 41890, fps: 30000/1001 }, width: 3840, height: 2160, fps: 30000/1001,
               audio: { rate: 48000, channels: 2 }, capturedAt: "2026-07-11T14:02:11Z" } }
  - { id: ast_scrn5e6f7g, kind: video, path: media/screen/EP014_screen.mkv,
      sha256: 2c624232cdd221771294dfbb310aca000a0df6ac8b66b696d90ef06fdefb64a3,
      probe: { duration: { frames: 54000, fps: 60/1 }, width: 2560, height: 1440, fps: 60/1 } }
  - { id: ast_music6h7j2, kind: audio, path: media/music/calm-loop.flac,
      sha256: 19581e27de7ced00ff1ce50b2047e7a567c76b1cbaebabe5ef03f7c3017bb5b7,
      probe: { duration: { samples: 8640000, rate: 48000 }, audio: { rate: 48000, channels: 2 } },
      rights: { source: "artlist.io", license: "Artlist Unlimited 2026" } }
  - { id: ast_broll3k4l5, kind: generated, path: media/generated/ast_broll3k4l5.mp4,   # frozen generated B-roll (rule 8, FR-605)
      sha256: 4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a,
      provenance: { sidecar: provenance-broll } }         # full record in the provenance sidecar (Part 7 §7.10)
beats:                                       # ---- named story beats (anchor targets) ----
  - { id: beat_hk3m2p6qa4, name: hook, anchor: "word:w000012" }
  - { id: beat_dm4n5q7rb2, name: demo, anchor: "clip:clp_scr2n3m4o5@0" }
sequences:                                   # ---- ordered sequences with source ranges ----
  - id: seq_main4a2b3c
    name: main
    clips:                                   # timeline positions DERIVED from order (FR-101)
      - { id: clp_hook6x5y7z, asset: ast_camera4a2b,
          source: { in: { frames: 1204, fps: 30000/1001 }, out: { frames: 3421, fps: 30000/1001 } },
          transitionAfter: { id: trn_xf2g3h4j5k, preset: pre_smoothcut2, duration: { frames: 6, fps: 30000/1001 } } }   # boundary transition
      - { id: clp_scr2n3m4o5, asset: ast_scrn5e6f7g,
          source: { in: { frames: 600, fps: 60/1 }, out: { frames: 9000, fps: 60/1 } },
          effects: [ { id: fx_spd6a2b3c4, kind: speed, params: { rate: 5/4 } } ] }    # exact rational speed-up
      - { id: clp_body7q6r5s, asset: ast_camera4a2b,
          source: { in: { frames: 9800, fps: 30000/1001 }, out: { frames: 22004, fps: 30000/1001 } },
          gapBefore: { frames: 15, fps: 30000/1001 },                                 # explicit gap (2.7)
          audio: { gainDb: -1, fadeIn: { frames: 4, fps: 30000/1001 } } }
  - id: seq_shrt4d5e6f                       # independent short-form edit (FR-802, Part 11)
    name: short-hook
    clips:
      - { id: clp_sh6t2u3v4w, asset: ast_camera4a2b,
          source: { in: { frames: 1204, fps: 30000/1001 }, out: { frames: 2010, fps: 30000/1001 } } }
layers:                                      # ---- audio and video layers ----
  - { id: lyr_base5a4b2c, kind: video, name: main-video, order: 0,
      enabled: true, locked: false, sequence: seq_main4a2b3c }
  - { id: lyr_broll3d4e5, kind: video, name: b-roll, order: 10, enabled: true, locked: false,
      items: [ { id: clp_brol6g7h2m, asset: ast_broll3k4l5, at: "word:w000231",   # anchor-placed, not order-derived
                 duration: { frames: 240, fps: 30000/1001 },
                 source: { in: { frames: 0, fps: 24/1 }, out: { frames: 192, fps: 24/1 } } } ] }
  - { id: lyr_music6j7k2, kind: audio, name: music, order: 0, enabled: true, locked: false,
      items: [ { id: clp_mus7m2n3p4, asset: ast_music6h7j2, at: "beat:beat_hk3m2p6qa4",
                 duration: { until: "beat:beat_dm4n5q7rb2" } } ] }
captions:                                    # ---- caption tracks: pinned preset + sparse overrides (Part 4 §4.8) ----
  - { id: cts_main2q3r4s, name: main-captions, sourceLayerIds: [lyr_base5a4b2c],
      preset: { presetId: pre_capstyle77, version: 7 },          # versioned caption preset pin
      styleOverrides: { wordsPerLine: 5 }, enabled: true }
annotations:                                 # ---- sidecar reference + state summary; records live in the sidecar (Part 8 §8.1) ----
  sidecar: annotations
  summary: { open: 1, resolved: 1, rejected: 0, reopened: 0 }
deliverables:                                # ---- long-form and short-form deliverables (Part 11 §11.1) ----
  - { id: dlv_lf7h2n6s4d, kind: longform, name: episode, profile: youtube-longform@1.0.0,
      sequenceId: seq_main4a2b3c, status: approved, approvedRevision: rev_00019 }
  - { id: dlv_sh3c7k4m6t, kind: short, name: hook-short, profile: tiktok@1.0.0,
      sequenceId: seq_shrt4d5e6f, status: stale, approvedRevision: rev_00017,
      dependencies: [ { derivativeClipId: clp_sh6t2u3v4w,
                        source: { assetId: ast_camera4a2b,
                                  range: { start: { frames: 1204, fps: 30000/1001 }, end: { frames: 2010, fps: 30000/1001 } },
                                  words: { from: w000012, to: w000094 },
                                  longformClipId: clp_hook6x5y7z } } ] }
presets:                                     # ---- preset pins: version + snapshot hash ----
  - { id: pre_capstyle77, name: brand-captions, kind: caption, version: 7, path: presets/pre_capstyle77@7.yaml,
      sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 }
  - { id: pre_smoothcut2, name: smooth-cut, kind: transition, version: 1, path: presets/pre_smoothcut2@1.yaml,
      sha256: 60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752 }
skills:                                      # ---- skill version pins (FR-705, Part 9 §9.5) ----
  - { id: skl_pacing24ab, name: pacing-preferences, version: "1.3.0", path: skills/pacing-preferences/1.3.0/,
      contentHash: fd61a03af4f77d870fc21e05e7e80678095c92d808cfb3b5c279ee04c74aca13 }
sidecars:                                    # ---- sidecar registry: schema id + integrity hash ----
  - { name: transcript-cam-a, path: sidecars/transcripts/ast_camera4a2b.transcript.json,
      schema: guyditor.transcript/v1,
      sha256: a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3,
      generatedBy: { tool: mlworker/faster-whisper, version: "1.1.0", job: job_w2rd5al4gn },
      inputs: [ { asset: ast_camera4a2b, sha256: 7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069 } ] }
  - { name: annotations, path: sidecars/annotations.yaml, schema: guyditor.annotations/v1,
      sha256: 6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b, inputs: [] }
  - { name: provenance-broll, path: sidecars/provenance/ast_broll3k4l5.provenance.json,
      schema: guyditor.provenance/v1,
      sha256: ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d,
      generatedBy: { tool: guyditor/generation, version: "1.0.0", job: job_gen8b4c2xq },
      inputs: [ { asset: ast_broll3k4l5, sha256: 4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a } ] }
  - { name: analysis-cam-a-shots, path: sidecars/analysis/ast_camera4a2b.scene.shots.json,
      schema: guyditor.analysis/v1,
      sha256: d4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35,
      generatedBy: { tool: mlworker/scenedetect, version: "0.6.4", job: job_ana6ys4s22 },
      inputs: [ { asset: ast_camera4a2b, sha256: 7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069 } ] }
```

### 2.7 Derived timeline positions, gaps, and overlaps (FR-101, R-002)

Clip start times are never stored for sequence clips; they are derived so that trimming one clip changes exactly one YAML block, not every downstream timestamp (AC-002). `deriveTimeline(project, sequenceId): TimelineDerivation` (exported by `@guyditor/core`) computes `{ clipId, start: FrameTime, duration: FrameTime }[]`:

1. Let `t = 0/1` seconds (rational), `R = settings.timeline.fps`.
2. For each clip `c` in `sequence.clips` order:
   a. Effective source duration `d_src = c.source.out − c.source.in` (asset rate).
   b. Apply retiming effects in order: a `speed` effect with `rate: p/q` scales duration by `q/p`; a `freeze` effect adds its `hold` duration. Result `d` is exact rational seconds.
   c. Boundary adjustment: if `c.gapBefore` is set, `t += gapBefore`. If the *previous* clip has `transitionAfter` with duration `D`, then `t −= D` (the transition consumes an overlap of `D`). Else if `c.overlapPrevious` is set, `t −= overlapPrevious`. Exactly one of {incoming transition, `overlapPrevious`} may apply per boundary; both present is a validation error. `gapBefore` combined with either is also an error. Resulting `t < 0` is a validation error.
   d. `start(c) = t` rounded to a frame at `R` per rule 2.2-3 (the rational is kept for chaining — rounding applies only to the reported `FrameTime`, so error never accumulates: AC-003 "no cumulative drift").
   e. `t += d`.
3. Sequence duration = final `t`. Anchored layers (`items`) do not participate; each item's position comes from resolving `at` (2.3), and its end from `duration` (fixed) or `until` (anchor).

Consequences: reordering clips is a pure list move; an inserted clip shifts derived times without touching any stored value; explicit `gapBefore`/`overlapPrevious`/transitions are the only stored boundary state. This is the format half of R-002; 2.13 supplies the serialization half.

### 2.8 Sidecar registry and staleness (FR-103, business rule 4)

Large or machine-oriented data (per-word timing, annotation geometry, analysis results, take metadata, alignment confidence) lives in `sidecars/` and MUST be registered in the master's `sidecars` list:

```typescript
export interface SidecarRef {
  name: string;                          // unique registry key referenced by other sections
  path: string;                          // relative, always under sidecars/
  schema: string;                        // "guyditor.<kind>/v<int>" — versioned sidecar schema id
  sha256: string;                        // hash of the sidecar file content
  generatedBy?: { tool: string; version: string; job?: string };
  inputs: { asset?: string; sidecar?: string; sha256: string }[];  // what produced it
}
```

Reserved `guyditor/v1` sidecar schema IDs (naming convention `guyditor.<kind>/v<int>`, binding on every part) and their canonical paths: `guyditor.transcript/v1` — `sidecars/transcripts/<assetId>.transcript.json` (canonical per-word timing, Part 4 §4.4; SRT/VTT are never canonical, FR-207); `guyditor.reconciliation/v1` — `sidecars/transcripts/<assetId>.reconciliation.json` (script reconciliation report, Part 4 §4.6); `guyditor.annotations/v1` — `sidecars/annotations.yaml` (Part 8 §8.1); `guyditor.analysis/v1` — `sidecars/analysis/<astId>.<kind>.json` (common analysis envelope, Part 3 §3.5; also `sidecars/analysis/<clipId>.keyqc.json` via `guyditor.keyqc/v1`, Part 6 §6.6); `guyditor.take-markers/v1` — `sidecars/takes/<astId>.takes.json` (Part 3 §3.11); `guyditor.capture/v1` — `sidecars/analysis/<astId>.capture.json` (capture-guidance warnings, Part 6 §6.7); `guyditor.provenance/v1` — `sidecars/provenance/<astId>.provenance.json` (generation provenance, Part 7 §7.10); `guyditor.framing/v1` — `sidecars/framing/<dlvId>.framing.json` (vertical-recomposition framing decisions, Part 11 §11.4). New sidecar kinds require a schema shipped in `@guyditor/core` `schema/sidecars/`.

**Staleness/integrity detection** (run by `ProjectStore` on open, by `project.validate`, and by export validation FR-1004):

1. For each `SidecarRef`: hash the file at `path`. Missing file → error `E_SIDECAR_MISSING`. Hash ≠ `sha256` → `E_SIDECAR_MODIFIED` (external edit or corruption; NFR-005) — the creator must re-accept (which re-records the hash via a transaction) or restore the file.
2. For each entry in `inputs`: compare the recorded `sha256` with the referenced asset's current file hash (or referenced sidecar's registered hash). Mismatch → sidecar state `stale` (`E_SIDECAR_STALE`, warning class): content is intact but its inputs changed; the fix is regeneration via the owning job, then a transaction updating the registry entry.
3. Any accepted transaction that rewrites a sidecar MUST update `sha256` (and `inputs`) in the same transaction, so master + sidecars are always mutually consistent at every recorded revision.

### 2.9 Transaction records (FR-104)

Accepted edits append exactly one JSON object (one line, canonical JSON: sorted keys, no whitespace) to `history/transactions.jsonl`. The journal is append-only (AD-008); nothing ever rewrites past lines.

```typescript
export interface TransactionRecord {
  id: string;                            // txn_
  baseRevision: string;                  // rev_ the ops were applied to
  resultRevision: string;                // rev_ produced (base counter + 1)
  operations: SemanticOperation[];       // ordered; grammar per Part 0 §0.4, catalog per Part 5
  instruction: { kind: 'user-text' | 'annotation' | 'ui-direct' | 'skill-policy';
                 text?: string; annotation?: string /* ann_ */ };
  actor: { kind: 'human' | 'agent' | 'tool'; id: string;    // user id | ses_ session | service name
           model?: string };             // e.g. "claude-fable-5" when kind === 'agent'
  versions: { app: string; schema: 'guyditor/v1';
              skills: { id: string; version: string }[];   // semver skill pins (Part 9 §9.5)
              presets: { id: string; version: number }[];
              tools: { name: string; version: string }[] }; // ffmpeg, mlworker models, etc.
  acceptance: { status: 'accepted' | 'auto-accepted-low-risk';   // business rule 5
                by: string; at: string /* ISO-8601 UTC */;
                proposal?: string /* prp_ when accepted from a proposal */ };
  reason?: string;                       // concise explanation (business rule 6, FR-704)
  orphanedAnchors: { owner: string; anchor: SemanticAnchor }[];  // per 2.3
  addresses: string[];                   // ann_ ids this edit addressed (FR-406, Part 8 §8.8.3)
  divergence?: string;                   // DivergenceClass — required on derivative-scoped transactions (Part 11 §11.3)
  undoOf?: string; redoOf?: string;      // txn_ — set on undo/redo transactions (Part 5 §5.13)
}
export interface SemanticOperation {
  op: string;                            // "<noun>.<verb>", e.g. "clip.trim"
  params: Record<string, unknown>;       // validated against the op's JSON Schema (Part 5)
  summary: string;                       // rendered human summary, e.g. "Trim clp_hook6x5y7z tail by 30 frames"
  inverse?: { op: string; params: Record<string, unknown> };   // undo metadata (FR-904)
}
```

Commit algorithm (executed atomically by `OperationEngine` + `ProjectStore`): (1) verify `baseRevision === history/HEAD`; (2) apply ops to the in-memory model; (3) validate (2.5 invariants, sidecar consistency 2.8); (4) canonicalize (2.13) and write master to a temp file, fsync, rename over `episode.guyditor.yaml`; (5) copy the new master to `history/revisions/rev_NNNNN.yaml` and write `rev_NNNNN.lock.json` (2.12); (6) append the transaction line; (7) update `history/HEAD`. A crash between steps leaves either the old accepted state fully intact or the new one fully recorded; on open, `ProjectStore` reconciles by trusting the journal + HEAD and re-deriving step 4/5 artifacts if missing (NFR-103).

### 2.10 Proposals: proposed vs. accepted state (FR-105)

Agent edits (and consequential automated edits) are proposals until explicitly accepted (business rule 5). A proposal never touches accepted files.

```
proposals/prp_ab42cd34ef/
  proposal.json          # Proposal record below
  master.proposed.yaml   # full canonical master as it would be after acceptance
  diff.patch             # unified text diff accepted → proposed (informational, regenerable)
  assessment.json        # optional attached subjective assessment (Part 9 §9.6)
  previews/              # preview media for review (disposable but kept until resolution)
```

This `Proposal` record is the single normative proposal schema; Part 5 §5.12 owns the lifecycle and the sub-schemas `ProposalReason`, `AppliedOperation`, `SemanticDiff`, and `ContinuityWarning`:

```typescript
export interface Proposal {
  id: string;                            // prp_
  baseRevision: string;
  status: 'draft' | 'ready' | 'accepted' | 'rejected' | 'superseded' | 'withdrawn';
  operations: SemanticOperation[];
  instruction: TransactionRecord['instruction'];
  actor: TransactionRecord['actor'];
  sessionId?: string;                    // ses_ audit-log linkage (Part 9)
  reason: unknown;                       // ProposalReason — required for agent proposals (business rule 6, Part 5 §5.12)
  riskClass: 'low' | 'normal' | 'consequential';
  addresses: string[];                   // ann_ ids this proposal addresses (FR-406, Part 8 §8.8.3)
  applied?: unknown[];                   // AppliedOperation[] — dry-run result, present from 'ready' (Part 5 §5.2)
  diff?: unknown;                        // SemanticDiff (Part 5 §5.12)
  warnings?: unknown[];                  // ContinuityWarning[] (Part 5 §5.7)
  previewJobId?: string;                 // job_ rendering affected ranges
  staleBase?: boolean;                   // accepted state moved past baseRevision
  supersededBy?: string;                 // prp_
  orphanedAnchors: { owner: string; anchor: SemanticAnchor }[]; // computed at proposal time (2.3)
  createdAt: string; resolvedAt?: string; resolvedBy?: string;
  resultTransaction?: string;            // txn_ when accepted
}
```

Lifecycle (numbered, binding):

1. **Create.** The agent (via `AgentGateway`) or a low-trust automation path submits operations; `OperationEngine` applies them to a copy of the accepted model, validates, computes orphaned anchors, writes the proposal directory. Status is `draft` while operations are being assembled and `ready` once the dry-run has filled `applied`/`diff`/`riskClass`/`warnings` (Part 5 §5.12). Accepted state is untouched.
2. **Review.** UI shows semantic summaries, `diff.patch`, previews, orphan warnings (FR-903, Part 10). The creator may request revision → agent submits a replacement proposal; the old one becomes `superseded`.
3. **Accept.** Acceptance re-checks the base (Part 5 §5.12 step 4 owns these executable semantics): if `baseRevision !== HEAD`, the proposal is stamped `staleBase: true` and acceptance is refused with `E_PROPOSAL_STALE` — stale operations are never re-applied onto a moved HEAD; the author rebases by submitting a superseding proposal against the current revision. If the base matches, run the 2.9 commit algorithm with `acceptance.proposal` set. On success the proposal directory moves to `history/proposals/`.
4. **Reject / withdraw.** Status recorded, directory moved to `history/proposals/`, accepted revision unchanged — bit-for-bit.
5. Only `riskClass: 'low'` operations may bypass review under a creator-configured policy, and they still produce full transactions with `acceptance.status: 'auto-accepted-low-risk'` (business rule 5).

### 2.11 History, restore, and two-revision comparison (FR-108)

Every accepted revision is fully materialized: `history/revisions/rev_NNNNN.yaml` (canonical master snapshot) + `rev_NNNNN.lock.json`. Sidecar contents at a revision are recoverable because every sidecar rewrite is itself transacted with hashes (2.8) and sidecar files are Git-tracked text (2.14); without Git, `ProjectStore` additionally snapshots any rewritten sidecar to `history/revisions/rev_NNNNN.sidecars/<name>` before overwriting (only on change, so cost is proportional to edits).

**Restore algorithm** (`project.restore` operation): restoring `rev_00015` when HEAD is `rev_00021` never rewrites history; it (1) loads the `rev_00015` snapshot and its sidecar set, (2) creates a normal transaction `rev_00021 → rev_00022` whose resulting master equals the snapshot (with `revision:` updated) and whose operations are the single op `project.restore { target: "rev_00015" }`, (3) restores sidecar contents and re-registers hashes. Reproducibility inputs (FR-107) come from the target's lock file.

**Comparison** (`compareRevisions(a, b): RevisionComparison`):

1. **Semantic summary.** If `a..b` is a lineal journal range, the summary is the ordered list of transactions with their operation `summary` strings, grouped by affected object ID, plus instruction/actor/reason per transaction. Otherwise (across restores, or arbitrary pairs) compute a structural diff by stable ID: objects present in one revision only → added/removed; matching IDs → per-field semantic deltas rendered through the same summary templates ("clp_body7q6r5s: source.out −30 frames"). Stable IDs guarantee the diff never degrades into positional noise (FR-101, AC-002).
2. **Representative previews.** (a) Compute changed timeline ranges: for each affected clip/item/caption/transition, the union of its derived timeline extent in `a` and in `b`; merge ranges closer than 2 s. (b) Order ranges by a significance score = range duration × (1 + number of affected objects); keep the top 6 (configurable). (c) For each kept range, pick the midpoint frame, plus first and last frames when the range exceeds 5 s. (d) Render each picked point in both revisions through the proxy preview path (AD-005) at matching semantic positions (anchor-resolved where possible, derived timeline time otherwise) into `.guyditor/cache/compare/<a>_<b>/`, yielding before/after pairs; a point unresolvable in one revision yields a one-sided preview labeled added/removed.

```typescript
export interface RevisionComparison {
  a: string; b: string; lineal: boolean;
  summary: { objectId?: string; text: string; transaction?: string }[];
  previews: { range: { start: FrameTime; end: FrameTime }; framePairs:
              { at: FrameTime; aImage?: string; bImage?: string }[] }[];
}
```

### 2.12 Reproducibility lock files (FR-107, R-007)

`history/revisions/rev_NNNNN.lock.json` freezes everything needed to rebuild the revision (AC-009), written at commit time (2.9 step 5):

```typescript
export interface RevisionLock {
  revision: string;
  masterSha256: string;                                  // hash of the canonical snapshot
  assets: { id: string; path: string; sha256: string }[];      // includes frozen generated assets
  sidecars: { name: string; schema: string; sha256: string }[];
  presets: { id: string; version: number; sha256: string }[];  // snapshot files under presets/
  skills: { id: string; version: string; contentHash: string }[];  // semver pins; snapshot dirs skills/<name>/<version>/ (Part 9 §9.5)
  profiles: { id: string; version: string }[];                 // platform-profile pins '<profileId>@<semver>' (Part 11 §11.6)
  tools: { name: string; version: string }[];                  // app, ffmpeg, mlworker + model ids
}
```

Rules: preset and skill bodies are snapshotted into `presets/` and `skills/` inside the project the first time a version is pinned, so later evolution of the global `SkillRegistry` library never changes an approved project (FR-705, business rule 11); generated media is referenced as a frozen asset with hash and provenance, never regenerated at render time (business rule 8, FR-1002); no reproducibility input may live only in application memory, chat history, or caches (R-007). Rebuild = restore snapshot + verify every lock hash + render with the locked tool versions (Part 12).

### 2.13 YAML canonicalization for stable diffs (R-002)

`canonicalizeYaml(project): string` in `@guyditor/core` is the only writer of master files, snapshots, proposal masters, and preset snapshots. Binding rules:

1. UTF-8 without BOM, LF line endings, exactly one trailing newline, Unicode NFC.
2. YAML 1.2; 2-space indentation; block style for all mappings and sequences, **except** objects whose serialized form fits on one line AND are leaf-like (`FrameTime`, `SampleTime`, `Rational`-bearing ranges, and any object ≤ 120 characters with no nested list) which serialize as single-line flow mappings — keeping one edit to one line.
3. No automatic line wrapping (infinite width): a value never rewraps because a sibling changed.
4. Key order: the canonical declaration order of 2.4 per object type. (The schema is closed — `additionalProperties: false`, 2.5 — so unrecognized keys cannot appear in a valid file; a hand edit introducing one fails validation on load rather than being reordered.)
5. Strings: plain scalars when round-trip-safe under the YAML 1.2 core schema; otherwise double-quoted with minimal escaping; multiline text uses literal block `|`. ISO-8601 timestamps are always double-quoted. `Rational` values are emitted as plain scalars (`30000/1001` is not number-like under the core schema); any string that would parse as a number, boolean, or null is quoted.
6. Integers plain decimal; no floats exist in the model; booleans `true`/`false`; optional absent fields are omitted entirely (never `null`).
7. No YAML anchors/aliases/tags/directives; the serializer emits no comments. Hand edits (FR-905) are honored on load (schema-validated), but the next accepted transaction re-canonicalizes and drops comments — documented behavior.
8. List order is preserved where semantic (`sequences[].clips`, `layers` by declaration, `operations`); registry-like lists (`assets`, `beats`, `captions`, `deliverables`, `presets`, `skills`, `sidecars`) are sorted by `id` (or `name` for sidecars) so insertion position never churns diffs.
9. Idempotence and determinism: `canonicalize(parse(canonicalize(x))) === canonicalize(x)`, and equal models yield byte-identical output — enforced by property tests (AD-014).

Transaction lines (2.9) use canonical JSON: UTF-8, sorted keys at every level, no insignificant whitespace, one object per line.

### 2.14 Git integration and text accessibility (FR-106, FR-905)

Guyditor MUST be fully functional without Git installed (AD-008): the journal + snapshots of 2.9/2.11 are the primary history mechanism and depend on nothing external. Git integration is additive:

1. At project creation, `ProjectStore` writes `.gitignore` containing `.guyditor/`, `proposals/*/previews/`, and `media/` (media ignored by default — binary sources are referenced, not committed, per FR-106; the creator may edit this to opt media in, with git-lfs recommended in docs).
2. If `<project>/.git` exists and system `git` is on PATH, the optional **auto-commit** setting (default on when a repo is detected) commits after each accepted transaction: `git add -A && git commit` with message `"<first op summary> [<txn_id>] (<base>→<result>)"`. Failures are reported as warnings (Part 0 error envelope, `retry: 'safe'`) and never block the transaction — Git state may lag; Guyditor history cannot.
3. Guyditor never runs destructive Git commands (no reset/rebase/force); restore is expressed as a forward commit (2.11).
4. Everything load-bearing is line-oriented text (canonical YAML, canonical JSON/JSONL), so `git diff`, `grep`, and any editor suffice to inspect the master file, sidecar registry, proposals, and semantic history without the UI (FR-905, AC-002). The docs ship a one-page "reading a Guyditor project with a text editor" guide covering exactly these files.

### Part 2 requirements coverage

| BRD ID | Implementing subsection(s) |
|---|---|
| FR-100 | 2.4 (model), 2.5 (schema), 2.6 (complete annotated example) |
| FR-101 | 2.7 (derived positions, gaps, overlaps), 2.13 rule 8, 2.11 step 1 (ID-based diffs) |
| FR-102 | 2.2 (source vs timeline time, rational rules), 2.3 (semantic anchors) |
| FR-103 | 2.8 (sidecar registry, schema IDs, hashes, staleness) |
| FR-104 | 2.9 (TransactionRecord, commit algorithm) |
| FR-105 | 2.10 (proposal lifecycle, accepted state isolation) |
| FR-106 | 2.14 (Git-friendly text, works without Git, binaries referenced), 2.13 (stable serialization) |
| FR-107 | 2.12 (RevisionLock, pinned snapshots, frozen generated assets) |
| FR-108 | 2.11 (restore algorithm, semantic summary + representative previews) |
| FR-905 | 2.13 rule 7 (hand-editable), 2.14 point 4 (text-tool inspectability) |
| Business rule 1 | 2.1 (sources immutable, referenced by hash), 2.6 assets |
| Business rule 2 | 2.1 (load-bearing vs disposable), 2.4 (master is truth; caches under `.guyditor/`) |
| Business rule 3 | 2.4 `Clip.asset` + `source` required, 2.5 invariants |
| Business rule 4 | 2.8 (`SidecarRef.schema` + `sha256` mandatory) |
| R-002 | 2.7 (no cascading timestamps), 2.13 (canonical serialization), 2.3/2.4 (stable IDs, anchors), 2.8 (dense data in sidecars) |
| R-007 | 2.12 (locks, versions, hashes; no hidden state), 2.9 `versions` field, 2.8 step 3 |

---

## Part 3 — Media engine, ingest, and capture integration

### 3.1 Scope, ownership, and terms

This part specifies `@guyditor/media` (`packages/media/`) and its main-process services `MediaEngine` and `CaptureWatcher`, plus the parts of `workers/mlworker` they orchestrate. It owns: project creation (FR-001), ingest (FR-002), proxies and waveform peaks (FR-003), media analysis orchestration (FR-004), the draft-generation inputs contract (FR-005), relinking (FR-007), A/V synchronization (FR-008), watch folders and the capture-integration contract (FR-009), take-marker import (FR-010), pickup recording (FR-011), the format support matrix (FR-1100), no-lock-in guarantees (FR-1103), and integrity verification (NFR-005).

Terms used below: an **asset** is a registered piece of source media identified by an `ast_` ID (Part 0 §0.4); an **original** is the file an asset points at, which Guyditor MUST never modify or delete (business rule 1); a **derived artifact** is anything regenerable from originals + project state (proxies, peaks, analysis output); a **sidecar** is a schema-versioned, hashed text file referenced from the master file (FR-103); a **take** (`tak_`) is a contiguous attempt at a piece of content within an asset; a **marker** (`mrk_`) is a point or range note attached to an asset at a source time.

All state mutations in this part are semantic operations executed through the `OperationEngine` (AD-009) so they share the transaction journal (AD-008) with every other interaction mode. Part 3 defines these media-owned operations (parameter schemas live in the Part 5 catalog): `asset.ingest`, `asset.relink`, `asset.verify`, `asset.sync.set`, `asset.markers.attach`, `asset.takes.set`. All are risk class `low` (metadata-only, never editorial) and therefore auto-acceptable under business rule 5 — except `asset.relink` with a non-hash match, which is `normal` and always requires explicit confirmation (§3.8).

Derived-data placement (binding within this spec):

| Data | Location | Class |
|---|---|---|
| Machine analysis results (§3.5) | `sidecars/analysis/<astId>.<kind>.json` | Derived sidecar: schema-versioned, hashed, registered in the master's `sidecars` list (Part 2 §2.8) and indexed from the asset record with `derived: true`; regenerable, but retained so agent decisions stay evidence-traceable |
| Imported take markers / notes (§3.11) | `sidecars/takes/<astId>.takes.json` | Load-bearing sidecar (not regenerable — created at capture time) |
| Proxies, image previews (§3.4) | `.guyditor/cache/proxies/` | Disposable cache; never referenced from the master file |
| Waveform peaks (§3.4) | `.guyditor/cache/peaks/` | Disposable cache |

### 3.2 Project creation (FR-001)

Project creation is a `ProjectStore` responsibility; `MediaEngine` participates by validating the storage location and registering optional watch folders. Flow (UI wizard in Part 10; also exposed as the Agent Gateway tool `project_create`, Part 9 §9.2):

1. Creator picks a directory (must be empty, or a new subdirectory is created). Reject locations inside another project or inside any `.guyditor/cache/`.
2. Creator picks the **primary output format**: a versioned platform profile ID from `profiles/` (default `youtube-longform@1.0.0`, Part 11 §11.6), which fixes default project resolution and frame rate (overridable per deliverable, Part 11).
3. Creator optionally associates skills and brand profiles: `skl_` references with pinned versions from the `SkillRegistry` (FR-705; skill semantics in Part 9).
4. Creator optionally configures watch folders (§3.10) and a default media location (`media/` inside the project, or an external directory).
5. `ProjectStore` scaffolds the directory and writes the initial master file and `.gitignore` (ignoring `.guyditor/`):

```
<project>/
  episode.guyditor.yaml      # format: guyditor/v1 (schema: Part 2)
  sidecars/                  #   analysis/  takes/  transcripts/ ...
  history/                   # transactions.jsonl + revisions/   (AD-008)
  proposals/                 # pending agent proposals           (AD-008)
  media/                     # optional; originals may live anywhere (AD-007)
    pickups/                 # captured pickup recordings (§3.12)
  .guyditor/                 # cache/  jobs.sqlite  (disposable/operational)
```

Initial master-file content written by creation (Part 2 §2.4 structure; abbreviated — creation also writes `revision`, the empty registry lists, and the primary long-form deliverable with its sequence):

```yaml
format: guyditor/v1
project: { id: prj_ep12hook4a, name: "Episode 12 — Hooks", created: "2026-07-17T09:30:00Z" }
settings:
  timeline: { fps: 30000/1001, width: 3840, height: 2160 }   # defaults from the chosen profile (step 2)
  audio: { sampleRate: 48000, channels: 2 }
  primaryDeliverable: dlv_lf2q8m4x7c       # kind: longform, profile: youtube-longform@1.0.0 (Part 11 §11.1)
watchFolders:
  - { path: "/captures/guyditor-inbox", convention: guyditor, autoIngest: true,
      autoJobs: { proxy: true, analysis: true, transcription: true } }
skills:
  - { id: skl_b4x9k2m7pq, name: brand-voice, version: "2.0.0", path: skills/brand-voice/2.0.0/,
      contentHash: "9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca7" }   # pinned brand skill (Part 9 §9.5)
```

### 3.3 Ingest pipeline (FR-002, NFR-005)

Ingest accepts video, audio, still images, screen recordings, animations, subtitle files, and generated media. It runs as a `JobQueue` job (`kind: "ingest"`) so large batches are visible background work (NFR-100). Entry points: file picker / drag-drop (Part 10), `CaptureWatcher` (§3.10), pickup capture (§3.12), frozen generated assets (Part 7), and the Agent Gateway.

Algorithm — `MediaEngine.ingest(req)`:

1. Resolve the absolute path; verify the file is readable and non-empty. Reject paths inside any `.guyditor/cache/` (`code: E_MEDIA_INGEST_INVALID_SOURCE`).
2. In parallel: (a) compute a **streaming SHA-256** over the file in 4 MiB chunks (never loading the file into memory); (b) run bundled ffprobe (AD-004): `ffprobe -v error -print_format json -show_format -show_streams -show_chapters <file>`. ffprobe JSON is the sole source of technical metadata. Probe failure → `E_MEDIA_PROBE_FAILED` with `retry: 'safe'`; the file is not registered.
3. **Duplicate check:** if an existing asset has the same SHA-256, do not create a new asset; append the path to that asset's `knownPaths` and return the existing `ast_` ID.
4. Assign a new asset ID: `ast_` + 10 random base32 chars (Part 0 §0.4).
5. Classify `kind`: `video` (has video stream that is not a single attached picture), `audio` (audio only), `image` (single frame), `animation` (image-sequence containers, GIF/animated-WebP, alpha-bearing motion assets), `subtitle` (SRT/VTT — handed to Part 4 for import; still registered as an asset), `generated` (media produced by Part 7 adapters and frozen at ingest — always carries `provenance` per FR-605), `other` (Tier-3 best effort, §3.13).
6. Extract capture time in priority order: container tag `creation_time` → QuickTime `com.apple.quicktime.creationdate` → filesystem mtime. Record which source was used and a confidence tier (`container` / `file-mtime`). Extract start timecode from any `tmcd` stream or `timecode` tag if present.
7. Build the `AssetRecord` (below) and commit it via the `asset.ingest` operation (one transaction per batch, listing every ingested asset).
8. Enqueue chained follow-up jobs, deduplicated per asset: `proxy.generate`, `peaks.generate` (audio-bearing assets), the project's configured `analysis.*` set (§3.5), and `transcribe` (Part 4) for speech-bearing assets. Chained jobs run at background priority; ingest itself never blocks on them.

Originals are never modified: ingest opens sources read-only, writes nothing next to them, and never remuxes, re-tags, or "repairs" a source file (see the write-guard, §3.14).

```ts
// @guyditor/media — persisted into the master file's assets section.
// AssetRecord IS the Part 2 §2.4 `Asset` interface — one normative schema, no divergent copy.
export type AssetRecord = Asset;       // re-exported from @guyditor/core (Part 2 §2.4)
```

Fields filled by ingest: `id` (step 4), `kind` (step 5), `path`/`knownPaths` (steps 1/3), `sha256`/`bytes`/`container` (step 2), `probe` + the per-kind `video`/`audio`/`image` stream details (ffprobe, step 2), `captureTime`/`timecode` (step 6), `session`/`takes`/`markers` (§3.10/§3.11), `analyses` (kind → `AnalysisRef`, §3.5), `sync` (§3.9), `integrity: 'ok'` (§3.14), and `ingest: { at, ffprobeVersion, via }`. `provenance` is set for `kind: 'generated'` (Part 7 §7.10) and `rights` when known (NFR-004).

### 3.4 Proxies, audio proxies, and waveform peaks (FR-003)

Proxies are disposable cache keyed by source hash — they are **not** recorded in the master file, keeping diffs clean (FR-101) and cache cleanup trivially safe (NFR-102). Cache layout: `.guyditor/cache/proxies/<astId>.<hash8>.<tier>.<ext>` plus `<same>.meta.json`, where `hash8` is the first 8 hex chars of the source SHA-256.

**Proxy ladder (one `edit` tier; high-quality preview is the render path per AD-005, FR-902):**

| Source | Proxy | Encoder settings |
|---|---|---|
| Video (opaque) | `edit`: H.264 MP4, longest edge scaled to 960 (never upscaled; even dimensions), native fps preserved | `libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -g <round(fps)> -sc_threshold 0 -movflags +faststart`; audio `aac 128k, 48 kHz stereo` |
| Video with alpha (ProRes 4444, VP9/WebM alpha) | `edit`: VP9 WebM preserving alpha, longest edge 960 | `libvpx-vp9 -crf 32 -b:v 0 -pix_fmt yuva420p -row-mt 1` |
| Audio-only | `edit`: AAC `.m4a` 128k 48 kHz stereo | `aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart` |
| Image > 2048 px | `edit`: JPEG q85 (PNG if alpha), longest edge 2048 | `scale` filter only |

Example compiled command (all commands come from the `@guyditor/media` command compiler, AD-004):

```
ffmpeg -i src.mkv -vf "scale='min(960,iw)':-2" -c:v libx264 -preset veryfast -crf 23 \
  -pix_fmt yuv420p -g 30 -sc_threshold 0 -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -movflags +faststart .guyditor/cache/proxies/ast_x.1a2b3c4d.edit.mp4
```

The 1-second GOP (`-g <fps>`, `sc_threshold 0`) guarantees responsive scrubbing; `+faststart` guarantees the moov atom precedes media data so the renderer can begin playback before the file is fully read.

**Waveform peaks** (consumed by the Part 10 timeline per FR-906 and by §3.9): for every audio-bearing asset, `peaks.generate` decodes a mono 48 kHz stream (`ffmpeg -i src -ac 1 -ar 48000 -f s16le -`) and computes per-bucket min/max scaled to signed 8-bit, at three fixed zoom tiers. File: `.guyditor/cache/peaks/<astId>.<hash8>.peaks.json`:

```json
{
  "format": "guyditor.peaks/v1",
  "assetId": "ast_k3m9x2c7pq",
  "sourceHash": "sha256:…",
  "sampleRate": 48000,
  "tiers": [
    { "samplesPerPeak": 960,   "data": [-12, 14, -30, 31] },
    { "samplesPerPeak": 9600,  "data": [-30, 31] },
    { "samplesPerPeak": 48000, "data": [-30, 31] }
  ]
}
```

`data` is a flat interleaved `[min0, max0, min1, max1, …]` array, values in −127..127. Tier 1 (50 peaks/s) serves word-level zoom; coarser tiers serve overview rendering without client-side reduction.

**Staleness detection** — `MediaEngine.ensureProxy(assetId, tier)` runs on project open, before any preview use, and after relink; a proxy is **stale** if any check fails, and a deduplicated `proxy.generate` job (idempotent per `(assetId, tier)`) is enqueued:

1. Proxy file exists and is non-empty.
2. `.meta.json` exists and parses: `{ assetId, sourceHash, tier, profileVersion, ffmpegVersion, createdAt, durationFrames }`.
3. `meta.sourceHash` equals the asset's current hash (catches relinked/replaced sources).
4. `meta.profileVersion` equals the compiled-in `PROXY_PROFILE_VERSION` (bumped when encoder settings change).
5. Duration sanity: proxy duration within 2 frames of the source duration (catches truncated encodes after a crash, NFR-103).

Interrupted generation writes to `<target>.part` and renames atomically on success, so a crash never leaves a plausible-looking half proxy. **Storage estimation (NFR-102 share):** `MediaEngine.estimateCacheUse()` reports per-class byte totals (proxies, peaks, previews) and per-asset projected proxy size (`bitrate × duration` heuristic) so Part 13's cleanup UI can show cost before generation and reclaim safely.

### 3.5 Analysis orchestration (FR-004)

`MediaEngine.runAnalysis(assetId, kind, params?)` schedules `analysis.<kind>` jobs. Runners: the Python `mlworker` sidecar over JSON-RPC (AD-003) for ML tasks, and FFmpeg filters driven by `@guyditor/media` for signal-level checks. The worker advertises capabilities at startup; missing optional capabilities degrade to a clear capability warning (NFR-101), never a silent skip.

| Kind | Runner | Tool | Output `data` |
|---|---|---|---|
| `speech.vad` | mlworker | Silero VAD | speech/silence segments `{ start, end, kind: 'speech'|'silence' }` in source frames |
| `scene.shots` | mlworker | PySceneDetect `ContentDetector` | shot boundaries (frame numbers) + per-shot mean luma/motion stats |
| `subject.track` | mlworker | mediapipe face + pose | sampled (every N frames, default N = 3) normalized boxes `{ frame, boxes: [{ kind: 'face'|'body'|'object'|'screen-region', trackId, x, y, w, h, conf }] }` — `trackId` stable per subject within the asset, `screen-region` = detected UI/diagram area, coordinates normalized 0..1 (consistent with FR-403). This is the **single** tracking sidecar (`sidecars/analysis/<astId>.subject.track.json`): Part 6 §6.12 and Part 11 §11.4 read this exact file |
| `tech.video` | @guyditor/media | ffmpeg `blackdetect`, `freezedetect`, decode-error counters | issue list `{ type: 'black'|'freeze'|'decode-error', start, end }` |
| `tech.audio` | @guyditor/media | ffmpeg `ebur128`, `astats` | integrated/short-term LUFS, true peak, clipping ranges, dropout (digital-silence) ranges |

Every result is written as a **derived analysis sidecar** `sidecars/analysis/<astId>.<kind>.json` in a common envelope, registered in the master's top-level `sidecars` list (Part 2 §2.8, like every file under `sidecars/`) and additionally indexed from the asset record's `analyses` map (kind → `AnalysisRef`) for per-asset lookup:

```ts
export interface AnalysisSidecar<T = unknown> {
  format: 'guyditor.analysis/v1';
  kind: string;                        // e.g. "speech.vad"
  assetId: string;
  sourceHash: string;                  // hash the analysis was computed against
  params: Record<string, unknown>;     // exact parameters used
  toolVersions: Record<string, string>;// e.g. { mlworker: "1.4.0", pyscenedetect: "0.6.4" }
  createdAt: string;
  data: T;                             // kind-specific payload, times in source frames/samples
}

export interface AnalysisRef {
  path: string;                        // sidecars/analysis/ast_x.speech.vad.json
  schema: string;                      // "guyditor.analysis/v1"
  hash: string;                        // sha256 of the sidecar file (FR-103, business rule 4)
  derived: true;                       // regenerable — backup may classify accordingly (Part 13)
}
```

**Regenerability invariant (FR-004):** accepted edits reference assets, source frames, and word IDs — never analysis rows. Re-running an analysis overwrites the sidecar and updates the `AnalysisRef` hash via a `low`-risk transaction; the accepted edit is untouched. A sidecar whose `sourceHash` no longer matches its asset is stale and is re-queued exactly like a stale proxy. Consumers: pause/filler assistance and take comparison (Part 5, FR-303/304), jump-cut and reframing work (Parts 6/11), draft generation (§3.6).

### 3.6 Draft-generation inputs contract (FR-005)

Draft generation itself — planning, take selection, assembly, proposal packaging — is Part 9 (agent) producing Part 5 operations. Part 3 and Part 4 own the **inputs contract**: the complete, structured evidence package the Agent Gateway hands the director model. `MediaEngine.getDraftInputs(constraints)` assembles it, delegating transcript fields to `TranscriptEngine`:

```ts
export interface DraftGenerationInputs {
  project: { fps: string; resolution: { w: number; h: number }; primaryProfile: string };
  constraints: DraftConstraints;
  assets: AssetSummary[];              // every ingested asset, or the creator's selection
  transcripts: TranscriptRef[];        // per speech asset: sidecar path + word-ID range + language + confidence (Part 4)
  takes: TakeRecord[];                 // §3.11 — boundaries, quality flags, noted mistakes
  markers: MarkerRecord[];             // §3.11 — including spoken markers
  analyses: AnalysisRef[];             // §3.5 — VAD, shots, tracking, technical issues
  script?: { path: string; hash: string };  // creator-supplied script sidecar, if any (FR-202, Part 4)
  skills: Array<{ id: string; version: string }>; // pinned editorial skills, semver (Part 9 §9.5)
}

export interface DraftConstraints {              // every field optional; creator-set (FR-005)
  targetDuration?: { min?: number; max?: number; unit: 'seconds' };
  audience?: string;
  platformProfile?: string;            // profile pin, e.g. "youtube-longform@1.0.0" (Part 11 §11.6)
  editorialStyle?: string[];           // skl_ IDs to weight
  requiredContent?: Array<{ kind: 'wordRange' | 'take' | 'asset' | 'beat'; ref: string }>;
  excludedContent?: Array<{ kind: 'wordRange' | 'take' | 'asset'; ref: string }>;
}

export interface AssetSummary {        // compact per-asset view (no media bytes)
  id: string; kind: AssetRecord['kind']; path: string;
  duration?: AssetRecord['probe']['duration'];
  video?: Pick<NonNullable<AssetRecord['video']>, 'width' | 'height' | 'fps' | 'hasAlpha'>;
  session?: string; takes: string[]; markers: string[];
  analyses: string[];                  // available analysis kinds
}
```

The gateway exposes this as a query tool (tool naming and media-excerpt fetching, e.g. proxy frame grabs for FR-405-style context, are Part 9). The contract guarantees: no draft is generated from raw media alone — takes, markers, analyses, and transcripts are always offered so proposals can cite evidence (FR-704), and `constraints` is the single place creator constraints enter (FR-005).

### 3.7 Shared-model contract for the four interaction modes (FR-006)

FR-006 is satisfied jointly; this section states the binding contract. All four modes mutate the project **only** through `OperationEngine` semantic operations (AD-009) against the single canonical model (Part 2), sharing one transaction journal, one undo/proposal mechanism, and one diff renderer:

- **Direct timeline operations** — Part 5 catalog invoked from the Part 10 timeline UI over typed IPC.
- **Transcript selection and text operations** — Part 4 word identity + Part 5 transcript-anchored operations, Part 10 transcript editor.
- **Frame annotations** — Part 8 `AnnotationService`; agent responses to annotations flow through Part 9 into Part 5 operations.
- **Natural-language instructions** — Part 9 Agent Gateway emitting the same Part 5 operations as proposals (FR-105).

Part 3's obligations under this contract: every media-side mutation (§3.1 operation list) goes through the same engine, so an ingest, relink, sync decision, or marker attachment appears in the same journal, diffs, and audit trail as an editorial cut — no side-channel media database exists (also FR-1103). Media state that operations reference (asset IDs, source frame counts, word IDs) is mode-agnostic: an edit made in any mode remains valid and inspectable in all others.

### 3.8 Missing-media relinking (FR-007)

**Detection.** On project open and before render validation (Part 12), every asset gets a quick check (§3.14). A missing path sets `integrity: 'missing'`; a present-but-changed file sets `'mismatch'`. Either state preserves the edit fully — clips referencing the asset render placeholder slates in preview and block final export via FR-1004 validation, but no project state is altered (`acceptedStateChanged: false`, code `E_ASSET_MISSING` / `E_ASSET_HASH_MISMATCH`, `suggestion:` the relink flow).

**Candidate discovery.** `MediaEngine.findRelinkCandidates(assetId, roots)` walks creator-chosen directories (plus the asset's `knownPaths` parents and configured watch folders) and scores each file:

1. **Hash pass:** hash files whose size matches exactly (cheap pre-filter), then any remaining files under a configurable count cap. A SHA-256 match scores **1.0** and short-circuits.
2. **Metadata pass** for non-hash candidates, additive weights: basename exact match 0.25; byte size exact 0.20; duration within ±1 frame 0.20; codec + dimensions + fps all equal 0.15; capture time within ±2 s 0.10; container equal 0.05; relative-path suffix similarity 0.05.
3. Rank candidates; show those scoring ≥ 0.70 prominently, the rest collapsed.

**Acceptance rules — a mismatch is never accepted silently:**

- **Hash match (1.0):** bit-identical file. `asset.relink` MAY auto-apply (risk `low`) with a non-blocking notice; the record's `path` updates and the old path joins `knownPaths`.
- **Any non-hash match:** requires an explicit confirmation dialog listing matched and mismatched fields side by side (e.g. "duration equal; codec differs: prores → h264"). On confirmation, `asset.relink` (risk `normal`) records `{ matchBasis: 'metadata-confirmed', score, fieldDiff, previousHash }`, updates the asset's `sha256` to the new file's hash, and marks all derived artifacts and analysis sidecars stale (§3.4/§3.5). The transaction preserves the old hash, so the decision is fully traceable and reversible (FR-108).
- The agent may *propose* a relink but can never confirm a non-hash match itself; confirmation is a creator-only action (BR-004).

Archived-media restore (NFR-107, Part 13) reuses this exact flow: restored files re-verify by hash before the asset returns to `integrity: 'ok'`.

### 3.9 Audio/video synchronization (FR-008)

Separately recorded audio (e.g. a lav mic WAV) is synchronized to a reference video asset. The decision is stored on the **dependent** (audio) asset's record — no new ID type is introduced:

```ts
export interface SyncDecision {
  referenceAssetId: string;            // ast_… of the video the offset is relative to
  method: 'timecode' | 'waveform' | 'manual';
  offset: { samples: number; rate: number };   // positive = dependent starts later (Part 0 time model)
  confidence?: number;                 // waveform only: dominant-peak ratio
  drift?: { framesPerMinute: number; corrected: false };  // §step 6; v1 warns, never auto-corrects
  evidence: Record<string, unknown>;   // method-specific: timecode strings, correlation windows, manual sample pair
  decidedBy: 'system' | 'creator' | 'agent';
  decidedAt: string;
}
```

Committing it is the `asset.sync.set` operation, so the original tracks stay untouched and the decision — who made it, from what evidence, replacing what — lives in the transaction journal (traceability requirement of FR-008). Part 5 clip placement consumes the offset when the two assets are used together.

Algorithm — `MediaEngine.computeSyncOffset(refAssetId, depAssetId, opts)` (a `sync.compute` job returning a proposal, never auto-committing when confidence is low):

1. **Timecode path:** if both assets carry start timecode at compatible rates, or both have container capture times, compute the offset directly; `method: 'timecode'`, `evidence` records both timecode strings. Capture-time-only offsets (second precision) are treated as a coarse prior for step 4's search window, not a final answer.
2. **Decode** both to mono 16 kHz float PCM via ffmpeg (`-ac 1 -ar 16000 -f f32le -`), streaming; band-pass 300–3400 Hz (biquad) to emphasize speech and reject rumble/hiss.
3. Take an analysis window: the first 60 s of the dependent track containing speech (per its `speech.vad` sidecar if present, else highest-energy 60 s).
4. Cross-correlate against the reference within a search range of ±120 s (or the step 1 prior ± 5 s) using FFT-based GCC-PHAT (phase transform weighting sharpens the peak against reverb and codec coloration).
5. Offset = argmax lag. Confidence = dominant peak height ÷ second-highest peak outside ±50 ms of the dominant one. Confidence ≥ 2.0 → proposable; < 2.0 → `E_SYNC_LOW_CONFIDENCE` error (`retry: 'safe'`, `suggestion:` manual sync point), never silently applied.
6. **Drift check:** repeat steps 3–5 on the final 60 s. If |offset_head − offset_tail| exceeds 0.5 frames per minute of separation, record `drift` and surface a sample-rate-mismatch warning; v1 records and warns only (correction via retiming is Part 5/12 work).
7. Convert the winning lag to samples at the dependent asset's native rate; return a `SyncDecision` draft for creator/agent acceptance via `asset.sync.set`.

**Manual sync point:** the Part 10 UI lets the creator mark one event (a clap, a spike) on each waveform (peaks from §3.4 for coarse placement, sample-accurate scrub for fine); the offset is the difference of the two marks, `method: 'manual'`, `evidence: { refFrame, depSample }`.

### 3.10 Watch folders and the capture-integration contract (FR-009)

Guyditor integrates with external recording tools via a **documented contract** — no in-app A-roll recording in v1. The contract ships as `docs/capture-integration.md` and comprises: (a) recommended capture settings per source type, (b) the session/file naming convention, (c) the take-marker file formats (§3.11), and (d) watch-folder behavior. It is usable with OBS and camera-card copies with zero custom code.

**Naming convention (`convention: guyditor`).** Session directory: `<YYYYMMDD>-<HHMM>_<session-slug>/` (e.g. `20260717-0930_ep12-hooks/`). Files inside: `<role>[-<label>]_t<NN>[_<PP>].<ext>` where `role ∈ { cam, screen, mic, aux }`, `NN` is the two-digit take number, optional `PP` a part number for split recordings — e.g. `cam-a_t03.mkv`, `mic-lav_t03.wav`, `screen_t03_01.mkv`. Parsing yields a `ses_` capture session, source role, and take index, which ingest stamps into `AssetRecord.session` and seeds `tak_` records. When `_tNN` is absent (plain OBS output), takes are inferred from capture-time order within the session. Files matching nothing fall into a per-day `unsorted` session and are still ingested — the convention adds metadata, never gates ingest (`E_CAPTURE_CONVENTION_UNMATCHED` is a warning, not an error).

**Recommended OBS settings (documented, not enforced):** record to MKV (crash-safe; remuxing is unnecessary — Guyditor ingests MKV directly and never rewrites originals); encoder NVENC/AMF/VideoToolbox CQP 16–20 or x264 CRF 16–18; native resolution and frame rate; keyframe interval 2 s; BT.709; audio 48 kHz, separate tracks per source (Track 1 program mix, Track 2 mic, Track 3 desktop), PCM if disk allows else AAC 320k; Filename Formatting `%CCYY%MM%DD-%hh%mm%ss`; recording path set to a Guyditor watch folder. Green-screen capture guidance (lighting, distance, motion blur) is FR-505, Part 6.

**Watch folders.** `CaptureWatcher` uses chokidar:

```ts
export interface WatchFolderConfig {
  path: string;
  convention: 'guyditor' | 'flat';     // 'flat': every media file, session inferred per day
  ignore?: string[];                   // globs; defaults ignore hidden files, *.part, *.tmp
  autoIngest: boolean;                 // default true
  autoJobs: { proxy: boolean; analysis: boolean; transcription: boolean };  // default all true
}
```

1. Watch with `awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 }` so in-progress recordings (OBS writes MKV continuously) are not ingested early; after chokidar fires, confirm the size is still unchanged 3 s later before proceeding (long recordings can plateau briefly).
2. On startup, reconcile: scan the folder and ingest any file not already registered (dedup by hash in §3.3 step 3 makes this idempotent after crashes, NFR-103).
3. For each stable new file: parse the naming convention → enqueue `ingest` with session/take metadata → chained `proxy.generate`, `peaks.generate`, configured `analysis.*`, and `transcribe` per `autoJobs` — all visible in the `JobQueue` panel (FR-009's "visible background work").
4. A take-marker file appearing in a session directory triggers §3.11 import against that session's assets.

Camera-card copies satisfy the contract by copying the card into a session directory inside a watch folder; verified offload tooling remains deferred (BRD §6.3).

### 3.11 Record-time take markers (FR-010)

Three intake paths produce structured take metadata; all are attached via `asset.markers.attach` / `asset.takes.set` operations and stored in the load-bearing sidecar `sidecars/takes/<astId>.takes.json` (`format: guyditor.take-markers/v1`, Part 2 §2.8), referenced with hash from the asset record.

**1. JSON marker files** — written by hotkey tools, stream decks, or capture scripts, placed in the session directory as `markers.json` or `<mediafile>.markers.json`. This is the **intake** format (`guyditor.take-markers-intake/v1`), produced by third-party tools and deliberately distinct from the persisted sidecar schema: intake files may use float seconds and wall-clock timestamps; the project sidecar never does.

```json
{
  "format": "guyditor.take-markers-intake/v1",
  "session": "ep12-hooks",
  "clock": "recording",
  "markers": [
    { "at": 12.400, "type": "take-start", "take": 3 },
    { "at": 95.100, "type": "mistake", "note": "said 2019, meant 2016" },
    { "at": 141.000, "type": "take-end", "take": 3, "quality": "good" }
  ]
}
```

`clock: 'recording'` means `at` is seconds from recording start of the matched file; `clock: 'utc'` means `at` is an ISO 8601 timestamp matched to assets via capture time (§3.3 step 6), which lets one wall-clock hotkey log annotate several simultaneously recorded files. `type ∈ { take-start, take-end, good, bad, mistake, note, chapter }`; `quality ∈ { good, bad, flubbed }`.

**2. Timestamped notes** — a plain-text `notes.txt` in the session directory, one line per event: `HH:MM:SS[.mmm] <FLAG> <free text>` with `FLAG ∈ { TAKE <n>, GOOD, BAD, FLUB, NOTE, MARK }`, e.g. `00:01:35.2 FLUB said 2019, meant 2016`. Timestamps are recording-relative; the parser converts lines to the JSON form above.

**3. Spoken markers** — a post-transcription hook: after Part 4 produces the canonical transcript, `TranscriptEngine` runs a configurable phrase matcher (defaults: "marker", "cut that", "again", "take \<number\>", "that was good/bad"; the set is editable via an editorial skill, FR-700) and emits candidate markers anchored to word IDs (`anchor: "word:w000412"`). These are attached with `detected: true` as `low`-risk metadata the creator can dismiss; they never trigger edits by themselves.

Resulting records, persisted in the `guyditor.take-markers/v1` sidecar (Part 2 §2.8). All intake times — float seconds (`clock: 'recording'`), UTC timestamps (`clock: 'utc'`), and `notes.txt` timestamps — are converted at import to integer source frames at the asset's native rate (rounding per Part 2 §2.2 rule 3, ties toward the earlier frame); the float-seconds intake form is never stored in load-bearing project state (Part 0 time model):

```ts
export interface TakeRecord {
  id: string;                          // tak_…
  assetId: string;
  index: number;                       // take number within the session
  range: { start: number; end: number; fps: string };   // source frames
  quality: 'good' | 'bad' | 'flubbed' | 'unrated';
  notes: string[];
  sourceMarkerIds: string[];           // mrk_… that produced/bound this take
}

export interface MarkerRecord {
  id: string;                          // mrk_…
  assetId: string;
  at: { frame: number; fps: string } | { start: number; end: number; fps: string };
  type: 'take-start' | 'take-end' | 'good' | 'bad' | 'mistake' | 'note' | 'chapter' | 'spoken';
  note?: string;
  anchor?: string;                     // semantic anchor, e.g. "word:w000412"
  detected?: boolean;                  // true for spoken-marker candidates
  source: 'json' | 'notes' | 'spoken';
}
```

Take metadata feeds `DraftGenerationInputs` (§3.6) and take comparison (FR-304, Part 5).

### 3.12 Pickup recording and flubbed-line repair (FR-011)

The guided pickup flow repairs a misspoken word, number, or name without leaving Guyditor. Trigger points: a `mistake`/`FLUB` marker, a transcript selection, or an annotation. Orchestration is `MediaEngine` + Part 10 UI; alignment is Part 4; the splice is Part 5.

1. Creator selects the flawed words (word-ID range, e.g. `w000410–w000413`); the system shows the surrounding sentence as a teleprompter card with the target words highlighted, and plays the original phrasing on request so delivery, pace, and tone can be matched.
2. **Capture path:** `getUserMedia` in the renderer (audio; optional camera preview for posture/mic-distance matching), `MediaRecorder` preferring `audio/webm;codecs=pcm` at 48 kHz, falling back to Opus 128k where PCM is unsupported. The UI prompts for ~1 s of room tone before and after the line (FR-305 ambience matching, consumed by Part 5). The recording is written to `<project>/media/pickups/<YYYYMMDD-HHMMSS>_<slug>.webm` and from that moment is an ordinary **immutable original**.
3. **Import path:** alternatively, the creator records on their normal rig; the file arrives via file picker or a watch-folder session with role `mic` — the flow is identical from step 4.
4. The file is ingested through the full §3.3 pipeline (`via: 'pickup'`): `ast_` ID, hash, probe, proxy, peaks.
5. **Hand-off to Part 4:** `TranscriptEngine` transcribes the pickup and force-aligns it against the target phrase (FR-200/FR-201), returning per-word timing within the pickup asset and a match confidence; a failed or low-confidence alignment is surfaced for review (FR-208), never spliced blind.
6. **Hand-off to Part 5:** the `pickup.splice` operation (Part 5 catalog) replaces the flawed word range with the pickup range under the FR-305 audio-continuity rules (crossfades at zero-crossings, room-tone fill, clipped-phoneme checks), updating word timing and captions via Part 4. The splice is a normal reviewable proposal with preview and semantic diff (FR-105); the original take remains intact and recoverable.
7. Provenance: the new clip references the pickup asset; the transaction records the repaired word IDs and the triggering marker/annotation. Synthetic-voice correction is a later, consent-gated provider adapter (Part 7/9) and is out of v1 scope per FR-011.

### 3.13 Format support matrix (FR-1100) and no-lock-in guarantees (FR-1103)

Support is probe-driven and tiered. Anything the bundled FFmpeg fully decodes is at least Tier 2; nothing is rejected merely for being unlisted.

| Tier | Meaning |
|---|---|
| 1 | Ingest + proxy + direct use in final render, covered by golden-file tests (AD-014) |
| 2 | Ingest + proxy; final render transcodes through an intermediate — fully supported, marginally slower |
| 3 | Best-effort: probe succeeded partially; ingest proceeds with warning `E_MEDIA_UNSUPPORTED_BESTEFFORT` listing what may not work |

| Category | Tier 1 | Tier 2 |
|---|---|---|
| Containers | MP4/MOV, MKV, WebM, WAV, MP3, M4A, FLAC container | MXF, AVI, MTS/M2TS (camera formats) |
| Video codecs | H.264, HEVC, ProRes (incl. 4444 alpha), VP9 (incl. alpha) | AV1, DNxHD/DNxHR, MJPEG |
| Audio codecs | AAC, PCM (16/24/32-bit), Opus, MP3, FLAC | Vorbis, ALAC |
| Images | PNG, JPEG, WebP | TIFF, HEIC (where OS codecs permit), BMP |
| Animations | GIF, animated WebP, ProRes 4444 / WebM alpha | image sequences (`%04d` patterns) |
| Subtitles (import; Part 4 owns semantics) | SRT, VTT | — |

Outputs produced: MP4 (H.264/AAC) deliverables and proxies, optional ProRes MOV masters, WAV audio exports, PNG/JPEG stills and thumbnails, SRT/VTT sidecars (Part 4), plain-text exports (Part 11) — all standard, tool-agnostic formats (BRD FR-1100 "accept and produce common formats via a mature media engine", AD-004).

**No-lock-in guarantees (FR-1103), binding on every part:**

1. Originals remain ordinary files at their recorded paths; Guyditor never imports them into a database, renames them, or alters a byte (§3.14).
2. All project truth is human-readable text: YAML master, JSON/JSONL sidecars and journal (AD-007/AD-008) — inspectable with ordinary tools (FR-905).
3. Proxies are standard faststart MP4/WebM playable in any player; deleting `.guyditor/cache/` loses only regenerable artifacts. `.guyditor/jobs.sqlite` is operational queue state only (AD-010) — its loss cancels pending jobs, never project truth.
4. Final outputs are ordinary MP4/MOV/WAV files; subtitle sidecars are standard SRT/VTT; interchange export exists per FR-1102 (Part 12).

### 3.14 Integrity verification and media safety (NFR-005)

**Verification levels.** `MediaEngine.verify(assetId, level)`:

- `quick` — file exists, byte size matches, mtime unchanged since last verify. Runs for every asset on project open and before preview sessions; cheap enough to be routine.
- `full` — streaming SHA-256 compared to `AssetRecord.sha256`. Runs: on demand; when `quick` finds a changed mtime with matching size; before final export as an FR-1004 validation input (Part 12); before/after backup and archival transfers (Part 13, NFR-106/107); after every relink (§3.8).

A failed check sets `integrity: 'missing' | 'mismatch'` via `asset.verify` (recorded, so corruption discovery is itself traceable) and raises the Part 0 error envelope: `{ code: 'E_ASSET_HASH_MISMATCH', affected: ['ast_…'], acceptedStateChanged: false, retry: 'none', suggestion: 'Relink or restore this asset (§3.8)' }`. Detection never mutates edits — unintended replacement or corruption is surfaced, and export is blocked until resolved.

**Never-delete / never-modify guarantee.** The `@guyditor/media` command compiler (AD-004) is the only producer of ffmpeg/ffprobe command lines and enforces a **write-guard**: every output path is checked against the registry of all known original paths (all assets' `path` + `knownPaths`, across open projects); a collision aborts compilation with `E_MEDIA_WRITE_GUARD_VIOLATION`. All generated output goes to `.guyditor/cache/`, `sidecars/`, or explicitly chosen export destinations — never adjacent to or over a source file. Cache cleanup (Part 13) operates only on `.guyditor/cache/` by construction. These invariants are unit-tested, including the adversarial case of an export destination deliberately pointed at a source file (the guard wins; the export errors).

**Sidecar integrity.** Every referenced sidecar carries its SHA-256 in the master file (business rule 4); `ProjectStore` validation re-hashes on open, so silent sidecar edits or corruption are detected exactly like media corruption, with `code: 'E_SIDECAR_MODIFIED'` and a diff-friendly pointer to the offending file.

**Media error codes registered by this part:** `E_MEDIA_INGEST_INVALID_SOURCE`, `E_MEDIA_PROBE_FAILED`, `E_ASSET_MISSING`, `E_ASSET_HASH_MISMATCH`, `E_SIDECAR_MODIFIED`, `E_PROXY_STALE` (informational), `E_SYNC_LOW_CONFIDENCE`, `E_CAPTURE_CONVENTION_UNMATCHED` (warning), `E_MEDIA_UNSUPPORTED_BESTEFFORT` (warning), `E_MEDIA_WRITE_GUARD_VIOLATION`.

### Part 3 requirements coverage

| BRD ID | Implemented in |
|---|---|
| FR-001 | §3.2 |
| FR-002 | §3.3 (pipeline, ast_ IDs, hashing, metadata record), §3.14 (originals never modified) |
| FR-003 | §3.4 (proxy ladder, encoder settings, audio proxy, peaks, staleness/regeneration) |
| FR-004 | §3.5 (analysis kinds, runners, derived sidecars, regenerability invariant) |
| FR-005 | §3.6 (inputs contract + constraints; drafting itself in Part 9) |
| FR-006 | §3.7 (joint contract with Parts 5, 8, 9, 10) |
| FR-007 | §3.8 (detection, candidate scoring hash-then-metadata, confirmation rules) |
| FR-008 | §3.9 (timecode, GCC-PHAT cross-correlation, manual point, traceable SyncDecision) |
| FR-009 | §3.10 (naming convention, OBS settings, CaptureWatcher, automatic jobs) |
| FR-010 | §3.11 (JSON marker spec, notes format, spoken-marker hook, TakeRecord/MarkerRecord) |
| FR-011 | §3.12 (guided capture/import, Part 4 align + Part 5 splice hand-offs) |
| FR-1100 | §3.13 (tiered format matrix, probe-driven acceptance, outputs) |
| FR-1103 | §3.13 (no-lock-in guarantees), §3.14 (write-guard) |
| NFR-005 | §3.14 (verification levels, write-guard, sidecar hashes), §3.3 (ingest hashing) |
| NFR-102 (estimation share) | §3.4 (cache classes, estimateCacheUse; cleanup itself in Part 13) |

---

## Part 4 — Transcription, word alignment, and captions

### 4.1 Scope, terms, and files

This part specifies the transcription and caption subsystem implemented in `packages/transcript` (`@guyditor/transcript`) and exposed to the rest of the application through the canonical main-process service **`TranscriptEngine`** (Part 0 §0.4). It owns BRD requirements FR-200 through FR-208 and FR-1101.

Terms used throughout this part:

- **Raw transcript** — the direct output of the speech-recognition engine, before word-ID assignment. Disposable.
- **Canonical transcript** — the per-asset sidecar defined in §4.4. Words carry stable IDs (FR-204) and canonical per-word timing (FR-201). This is project truth; SRT/VTT are never canonical (FR-207).
- **Forced alignment** — a second pass that aligns known text tokens against audio with a CTC acoustic model (WhisperX-style), producing tighter word boundaries than ASR decoding timestamps.
- **Word instance** — one occurrence of a transcript word on a sequence timeline. Because clips can duplicate source ranges, one word ID may have zero, one, or many instances (§4.12).
- **Cue** — a group of words displayed together as one caption (one or more lines). Cues are *derived*, never hand-authored records (§4.8).

Files owned by this part (all under the project directory, AD-007):

```
sidecars/transcripts/<assetId>.transcript.json        # canonical transcript sidecar (§4.4)
sidecars/transcripts/<assetId>.reconciliation.json    # script reconciliation report (§4.6)
presets/<pre_id>@<version>.yaml                       # immutable caption-preset version snapshot (§4.8; path per Part 2 §2.4 PresetPin)
.guyditor/cache/audio/<assetId>.16k.wav               # ASR extract (disposable)
.guyditor/cache/captions/                             # compiled cue/render caches (disposable)
```

Every sidecar is referenced from the master file by relative path + SHA-256 and schema string (FR-103, business rule 4); every mutation in this part flows through the `OperationEngine` as a semantic operation (AD-009) and updates the recorded sidecar hash in the same transaction.

**Decision (D4-1): word ordinals are project-global.** Part 0 fixes word IDs as `w` + zero-padded 6-digit ordinal. Because semantic anchors use the unqualified form `word:w000042`, ordinals are allocated from a single project-wide counter (`transcript.nextWordOrdinal` in the master file), serialized through `ProjectStore`, so a word ID is unique across all assets in the project. Segment IDs use new prefix `seg_` and speakers `spk_`, both following Part 0's default ID rule (lowercase prefix + 10 random base32 chars).

**Decision (D4-2): word timing lives in audio-sample time.** Word and segment boundaries are stored as `{ samples: <int>, rate: <int> }` at the owning asset's **native** audio sample rate (Part 0 time model, audio form). This is exact and finer than video frames. Conversion to the asset's video-frame domain, when needed, is exact rational: `startFrame = floor(samples · fpsNum / (rate · fpsDen))`, `endFrame = ceil(samples · fpsNum / (rate · fpsDen))`, so a word covers every frame it touches. Floating-point time is forbidden (Part 0).

### 4.2 TranscriptionEngine interface (FR-200, FR-201, NFR-105)

`TranscriptionEngine` is the pluggable engine boundary consumed by the `TranscriptEngine` service (NFR-105: engines evolve without changing project semantics). The default implementation, `FasterWhisperEngine`, delegates to the Python `workers/mlworker` sidecar (AD-003) over JSON-RPC 2.0 on stdio.

```ts
// @guyditor/transcript — public engine boundary
export interface SampleTime { samples: number; rate: number }        // exact, integer samples

export interface TranscriptionCapabilities {
  languages: string[] | "auto";     // ISO 639-1 codes the engine detects/accepts
  models: string[];                 // e.g. ["tiny","base","small","medium","large-v3"]
  wordTimestamps: boolean;          // must be true for a default engine
  forcedAlignment: boolean;         // supports align(); false → §4.4 alignment="asr" only
  gpu: boolean;                     // reported for NFR-101 path selection
}

export interface TranscribeRequest {
  audioPath: string;                // 16 kHz mono WAV extract (see pipeline step 2)
  model: string;                    // default "large-v3", overridable per NFR-101 detection
  language: string | null;          // null → auto-detect (FR-200)
  vadFilter: boolean;               // default true
  initialPrompt: string | null;     // optional domain vocabulary priming
}

export interface RawWord    { text: string; start: SampleTime; end: SampleTime; probability: number }
export interface RawSegment { index: number; start: SampleTime; end: SampleTime; text: string;
                              avgLogprob: number; noSpeechProb: number; words: RawWord[] }
export interface RawTranscript {
  language: string; languageProbability: number;
  segments: RawSegment[];
  engine: { name: string; version: string; model: string };
}

export interface AlignRequest {
  audioPath: string; language: string;
  segments: { index: number; start: SampleTime; end: SampleTime; tokens: string[] }[];
}
export interface AlignedToken {
  segmentIndex: number; tokenIndex: number;
  start: SampleTime; end: SampleTime;
  score: number;                    // 0..1 CTC confidence
  aligned: boolean;                 // false → timing interpolated by the worker
}
export interface AlignResult { tokens: AlignedToken[]; engine: { name: string; version: string; model: string } }

export interface TranscriptionEngine {
  readonly id: string;              // adapter id, e.g. "faster-whisper"
  capabilities(): Promise<TranscriptionCapabilities>;
  transcribe(req: TranscribeRequest, signal: AbortSignal,
             onProgress: (p: number) => void): Promise<RawTranscript>;
  align(req: AlignRequest, signal: AbortSignal,
        onProgress: (p: number) => void): Promise<AlignResult>;
}
```

**Transcription pipeline** (job kind `transcribe`, run through `JobQueue`, AD-010; auto-enqueued on ingest per FR-009 or run on demand):

1. `MediaEngine` (Part 3) extracts the asset's selected audio stream to `.guyditor/cache/audio/<assetId>.16k.wav` (16 kHz mono PCM, no offset — a pure resample, so sample positions rescale exactly).
2. `transcribe` mlworker task (§4.3) returns a `RawTranscript` with per-word ASR timestamps (FR-200: local by default; language + probability preserved).
3. `align` mlworker task runs on the same audio with the bare word tokens of each segment (punctuation stripped). This forced-alignment pass is the **canonical timing source** (FR-201). Per token: if `aligned` and `score ≥ 0.35`, use CTC timing (`alignment: "ctc"`); else fall back to the ASR timestamp (`alignment: "asr"`); if the worker interpolated, mark `alignment: "interpolated"`.
4. `TranscriptEngine` rescales all times from rate 16000 to the asset's native audio rate (`samplesNative = round(samples16k · rateNative / 16000)`), attaches punctuation (D4-4, §4.4), allocates global word ordinals in temporal order (D4-1), and writes the canonical sidecar (§4.4).
5. A `transcript.create` transaction records the sidecar path, SHA-256, engine/model versions, and job ID (FR-104, R-007). Re-running transcription on an asset that already has a canonical transcript is a **proposal** (FR-105) — it never silently replaces word IDs; accepted re-transcription tombstones all prior words (§4.5) and allocates fresh ordinals.

If no engine reports `forcedAlignment` (degraded install, NFR-101), step 3 is skipped, every word is `alignment: "asr"`, and the sidecar's `provenance.alignment` is `null`; the UI surfaces a capability warning.

### 4.3 mlworker task schemas (AD-003)

Exact JSON-RPC 2.0 messages, on the Part 1 §1.2 wire protocol (methods are the task types; notifications `$/progress` and `$/cancel`). All times crossing the worker boundary are `{ samples, rate }` at the analysis rate (16000).

```json
{ "jsonrpc": "2.0", "id": 41, "method": "transcribe",
  "params": { "taskId": "job_9f3k2m8p1q",
    "audioPath": "/abs/path/.guyditor/cache/audio/ast_k3j5m7p9r2.16k.wav",
    "model": "large-v3", "computeType": "auto", "language": null,
    "vadFilter": true, "wordTimestamps": true,
    "beamSize": 5, "temperature": 0.0,
    "conditionOnPreviousText": false, "initialPrompt": null } }
```

```json
{ "jsonrpc": "2.0", "id": 41, "result": {
    "language": "en", "languageProbability": 0.997,
    "duration": { "samples": 46080000, "rate": 16000 },
    "segments": [ { "index": 0,
        "start": { "samples": 4160, "rate": 16000 }, "end": { "samples": 71680, "rate": 16000 },
        "text": "We ship the parser today.", "avgLogprob": -0.21, "noSpeechProb": 0.01,
        "words": [ { "text": "We", "start": { "samples": 4160, "rate": 16000 },
                     "end": { "samples": 7200, "rate": 16000 }, "probability": 0.94 } ] } ],
    "engine": { "name": "faster-whisper", "version": "1.0.3", "model": "large-v3" } } }
```

```json
{ "jsonrpc": "2.0", "id": 42, "method": "align",
  "params": { "taskId": "job_2r7t9w4x6z",
    "audioPath": "/abs/path/.guyditor/cache/audio/ast_k3j5m7p9r2.16k.wav",
    "language": "en", "model": "wav2vec2-base-960h",
    "segments": [ { "index": 0, "start": { "samples": 4160, "rate": 16000 },
                    "end": { "samples": 71680, "rate": 16000 },
                    "tokens": ["We", "ship", "the", "parser", "today"] } ] } }
```

```json
{ "jsonrpc": "2.0", "id": 42, "result": {
    "tokens": [ { "segmentIndex": 0, "tokenIndex": 0,
                  "start": { "samples": 4480, "rate": 16000 }, "end": { "samples": 6880, "rate": 16000 },
                  "score": 0.91, "aligned": true } ],
    "engine": { "name": "ctc-forced-align", "version": "0.4.1", "model": "wav2vec2-base-960h" } } }
```

Progress notification: `{ "jsonrpc": "2.0", "method": "$/progress", "params": { "taskId": "job_…", "progress": 0.42 } }`; cancellation via `$/cancel { taskId }` (Part 1 §1.2). Worker errors use JSON-RPC error objects; `TranscriptEngine` maps them into the Part 0 error envelope (e.g. `{ code: "E_TRANSCRIBE_ENGINE_FAILED", affected: ["ast_…"], acceptedStateChanged: false, retry: "safe" }`).

### 4.4 Canonical transcript sidecar (FR-200, FR-201)

Schema `guyditor.transcript/v1`, one file per transcribed asset. **Decision (D4-4):** `text` holds the bare spoken token; punctuation is stored in `punctBefore`/`punctAfter` so alignment, script diffing, and export can treat tokens and presentation independently. Display form = `punctBefore + text + punctAfter`.

```json
{
  "schema": "guyditor.transcript/v1",
  "assetId": "ast_k3j5m7p9r2",
  "audio": { "rate": 48000, "channels": 2, "streamIndex": 1 },
  "language": "en",
  "languageProbability": 0.997,
  "provenance": {
    "engine": { "name": "faster-whisper", "version": "1.0.3", "model": "large-v3" },
    "alignment": { "name": "ctc-forced-align", "version": "0.4.1", "model": "wav2vec2-base-960h" },
    "createdAt": "2026-07-17T14:03:22Z", "jobId": "job_9f3k2m8p1q"
  },
  "speakers": [ { "id": "spk_b7c2d9e4f1", "label": "Guy" } ],
  "segments": [
    { "id": "seg_a1b2c3d4e5", "speaker": "spk_b7c2d9e4f1", "language": null,
      "start": { "samples": 12480, "rate": 48000 }, "end": { "samples": 215040, "rate": 48000 },
      "words": ["w000001", "w000002", "w000003", "w000004", "w000005"] }
  ],
  "words": {
    "w000001": { "text": "We", "punctBefore": "", "punctAfter": "",
      "start": { "samples": 13440, "rate": 48000 }, "end": { "samples": 20640, "rate": 48000 },
      "confidence": 0.94, "alignment": "ctc", "state": "active", "origin": "asr" },
    "w000005": { "text": "today", "punctBefore": "", "punctAfter": ".",
      "start": { "samples": 188160, "rate": 48000 }, "end": { "samples": 211200, "rate": 48000 },
      "confidence": 0.88, "alignment": "ctc", "state": "active", "origin": "asr" }
  }
}
```

Field semantics: `confidence` is ASR probability × alignment score where both exist, else the surviving one, `null` for imported words (§4.11). `alignment ∈ "ctc" | "asr" | "interpolated" | "manual" | "imported"`. `origin ∈ "asr" | "correction" | "script" | "pickup" | "import"`. `state ∈ "active" | "deleted"`; deleted words additionally carry `replacedBy?: string[]` (§4.5). Segment `language` overrides the file-level language when non-null (mixed-language recordings). Temporal order is defined by segment order and each segment's `words` array — **not** by ordinal order, which insertion can interleave. Pickup recordings (FR-011) are separate assets with their own sidecars; their word ordinals come from the same global counter.

### 4.5 Word identity rules (FR-204)

1. **Assigned once.** Ordinals are allocated in temporal order at canonical-transcript creation from the project-global counter (D4-1). An ID, once assigned, refers to that word forever.
2. **Never renumbered.** No operation ever changes an existing word's ID or reuses a retired ID, including segment splits/merges, corrections, reconciliation, or re-transcription.
3. **Insertion.** An inserted word takes the next unused global ordinal, regardless of temporal position; it is placed at the correct position in its segment's `words` array. Anchor consumers must therefore order by array position, never by ordinal.
4. **Deletion tombstones.** Deleting a word sets `state: "deleted"` and keeps the record (text, timing, provenance) forever. Tombstones keep anchors resolvable and make history reproducible (FR-107). Transcript deletion removes the word from corrected text and captions only — removing the *audio* is a clip edit (Part 5), never a transcript operation.
5. **Splits and merges.** A correction that changes token count (e.g. "gonna" → "going" + "to") tombstones the originals with `replacedBy: [newIds]`, allocates fresh ordinals for replacements, and partitions the original time span across replacements proportionally to character count (marked `alignment: "interpolated"` until realigned or retimed). A 1:1 correction keeps the same ID (rule for §4.7).
6. **Anchor resolution.** Anything anchored to `word:wNNNNNN` (clips, captions, graphics Part 7, annotations Part 8, shorts Part 11) resolves: active word → itself; tombstone → follow `replacedBy` transitively to the first active descendant; no descendant → the nearest active word in the same segment whose midpoint lies within 2000 ms, flagged `approximate`; otherwise the anchor is **orphaned** and surfaced through §4.12 diagnostics. Orphaned anchors are never silently dropped.

### 4.6 Script reconciliation (FR-202)

When a source script exists (imported as an `ast_` text asset), `TranscriptEngine.reconcile(assetId, scriptAssetId)` compares script and observed transcript **without ever blindly replacing observed words**. Output is a report sidecar (`guyditor.reconciliation/v1`) reviewed by the creator; only their per-hunk decisions mutate the transcript.

Algorithm RECONCILE:

1. Tokenize the script into tokens with sentence/paragraph indices. Take the observed side as all active words in temporal order.
2. Normalize both token streams for comparison only: Unicode NFC, casefold, strip punctuation, collapse whitespace, apply a per-language equivalence table (digits ↔ number words, common contractions). Original forms are retained.
3. Compute a token-level minimal diff (Myers O(ND)) over the normalized streams; merge adjacent non-equal runs into hunks `{ scriptTokens[], observedWordIds[] }`.
4. Classify each hunk into a **deviation class**:
   - `restart` — observed-only hunk whose tokens equal a prefix (length ≥ 2, or ≥ 1 with a following filler) of the immediately following matched run: the speaker began again. Also matched when the hunk itself contains an internal repeated n-gram (n ≥ 2) ending at the hunk boundary.
   - `filler` — observed-only hunk whose tokens all appear in the per-language filler lexicon ("um", "uh", "like", "you know", …).
   - `error` — substitution hunk where normalized Levenshtein similarity between script and observed hunk text ≥ 0.5, or both sides ≤ 3 tokens: likely misreading or ASR error.
   - `improvisation` — insertion or substitution not matching the above: intentional new content.
   - `omission` — script-only hunk: content never spoken.
5. Write `sidecars/transcripts/<assetId>.reconciliation.json`: ordered hunks with class, script text, `observedWordIds`, similarity score, and a `decision` field initialized to `"pending"`.
6. **Creator choice flow.** The UI presents hunks grouped by class with audio playback per hunk. Per hunk (or bulk per class) the creator chooses: `keep-observed` (default; transcript untouched), `use-script` (rewrite observed word text to script wording via §4.7 correction semantics — 1:1 where token counts match, split/merge otherwise; `origin: "script"`; **timing is never changed by reconciliation**), or `mark-for-edit` (attach take metadata so restarts/errors become cut candidates for FR-303/FR-304 — no transcript change).
7. Decisions are applied atomically by operation `transcript.reconcile.apply { assetId, decisions: [{hunkIndex, decision}] }`, one transaction. Undecided hunks remain `pending` and are reported (not blocking) by export validation.

### 4.7 Transcript correction operations (FR-203)

All corrections are semantic operations (Part 0 grammar; registered in the Part 5 catalog, risk class `low` unless noted). The invariant of FR-203: **text, punctuation, speaker, and segmentation edits never change timing or audio linkage; timing changes happen only through the explicit retime/realign operations.**

| Operation | Parameters | Effect |
|---|---|---|
| `transcript.word.correct` | `{ wordId, text?, punctBefore?, punctAfter? }` | 1:1 edit; ID, timing, confidence, linkage preserved; `origin` → `"correction"` |
| `transcript.word.replace` | `{ wordIds: [..], tokens: [..] }` | split/merge per §4.5 rule 5 |
| `transcript.word.insert` | `{ segmentId, afterWordId \| null, tokens: [..] }` | new ordinals; timing interpolated inside the neighbor gap, `alignment: "interpolated"` |
| `transcript.word.delete` | `{ wordIds: [..] }` | tombstones (§4.5 rule 4) |
| `transcript.word.retime` | `{ wordId, start?, end? }` (SampleTime) | **the only word-timing mutation**; `alignment` → `"manual"`; validated: `start < end`, inside segment audio, no reordering against neighbors |
| `transcript.segment.split` | `{ segmentId, beforeWordId }` | new `seg_` ID for the tail; word timing untouched |
| `transcript.segment.merge` | `{ segmentIds: [..] }` | adjacent segments only; surviving ID = first |
| `transcript.speaker.assign` | `{ speakerId, segmentIds?, wordRange? }` | speaker attribution; creates `spk_` entries as needed |
| `transcript.realign` | `{ assetId, wordRange? }` (risk `normal`) | re-runs the §4.3 `align` task for a range; resulting timing changes are a reviewable proposal diff (FR-105), never auto-applied |
| `transcript.reconcile.apply` | §4.6 step 7 | applies reviewed reconciliation decisions |

Each accepted operation rewrites the sidecar deterministically (stable key order, LF, UTF-8) and updates its hash in the master file within the same transaction, keeping diffs small and readable (FR-101, R-002).

### 4.8 Caption model and versioned presets (FR-205)

A **caption track** (`cts_`) lives on a sequence (long-form or derivative) in the master file. It selects which layers' speech it captions, pins a style preset, and stores only sparse creator overrides — cues themselves are derived (D4-10) so timeline edits never require rewriting caption data (FR-101, FR-208).

```ts
export interface CaptionTrack {
  id: string;                                  // cts_…
  name: string;
  sourceLayerIds: string[];                    // speech-bearing layers captioned by this track
  preset: { presetId: string; version: number };  // pinned (FR-705)
  styleOverrides: Partial<CaptionStyle>;       // per-track deltas over the preset
  breakOverrides: CueBreakOverride[];          // sparse, word-ID anchored (§4.9 step 3e)
  emphasisOverrides: { wordId: string; emphasis: boolean }[];
  timingOffsets: { firstWordId: string; startMs?: number; endMs?: number }[]; // per-cue nudges (FR-206)
  enabled: boolean;
}
export interface CueBreakOverride { afterWordId: string; kind: "line" | "cue" | "join" }

export interface CaptionStyle {
  typeface: { family: string; fontAssetId: string; fallbackAssetIds: string[] }; // fonts are hashed assets
  sizePct: number;                 // line height as % of output frame height (resolution-independent, D4-9)
  weight: 100|200|300|400|500|600|700|800|900;
  italic: boolean;
  letterSpacingPct: number;        // of em
  lineSpacing: number;             // multiplier
  color: string;                   // #RRGGBBAA
  outline: { color: string; widthPct: number } | null;
  shadow: { color: string; dxPct: number; dyPct: number; blurPct: number } | null;
  background: { color: string; padXPct: number; padYPct: number; radiusPct: number;
                scope: "word" | "line" | "block" } | null;
  transform: "none" | "upper" | "lower" | "title";
  wordsPerLine: number;            // max words per line (FR-205)
  maxLines: 1 | 2 | 3;
  maxWidthPct: number;             // of safe-area width (FR-205 max line width)
  placement: { anchor: "top" | "middle" | "bottom"; offsetYPct: number;
               align: "left" | "center" | "right" };
  safeArea: "platform" | "none";   // "platform" → insets from the deliverable's platform profile (Part 11)
  highlight: { mode: "per-word" | "per-line" | "none";     // FR-205 per-word / phrase display
               style: "color" | "scale" | "weight" | "underline" | "background";
               color?: string; scale?: number; weight?: number;
               pastWords: "keep" | "dim"; dimOpacity?: number;
               maxGapMs: number; holdMs: number; leadInMs: number };
  emphasisStyle: { style: "color" | "scale" | "weight" | "underline"; color?: string;
                   scale?: number; weight?: number };      // for manually emphasized words
  cueGapMs: number;                // §4.9 step 2 threshold (default 800)
  maxCueDurationMs: number;        // default 7000
  speakerStyles: Record<string, Partial<CaptionStyle>>;    // spk_… → deltas (FR-205 speaker-aware)
}
```

**Presets** (`pre_` IDs, FR-205 "reusable and versioned", FR-705): one immutable YAML file per version. The global library lives under `~/.guyditor/presets/captions/`; the first time a version is pinned by a project it is snapshotted as `presets/<pre_id>@<version>.yaml` inside the project (the Part 2 §2.4 `PresetPin` path convention, D4-8). Editing a preset writes version N+1; existing tracks keep their pinned version until explicitly upgraded (a `normal`-risk operation `caption.preset.upgrade`).

```yaml
format: guyditor.caption-preset/v1
presetId: pre_7h2k9m4p6r
name: brand-shorts-bold
version: 3
style:            # full CaptionStyle object
  sizePct: 5.2
  wordsPerLine: 4
  maxLines: 2
  # …
```

Track-level operations: `caption.track.add`, `caption.track.set` (sourceLayers/preset/enabled), `caption.style.set` (styleOverrides), `caption.break.set` / `caption.break.clear` (breakOverrides), `caption.word.emphasis.set`, `caption.cue.retime` (timingOffsets), `caption.preset.upgrade`.

### 4.9 Deterministic line breaking and highlight timing (FR-205)

Cue generation is a pure function of (word instances from §4.12, resolved `CaptionStyle`, safe-area rect, output dimensions/fps). Text measurement uses the overlay renderer's bundled shaper with the preset's bundled font assets; system font substitution is forbidden in measurement (D4-13), so preview, final render, and any machine produce identical breaks (AD-013).

Algorithm LINEBREAK:

1. Input: the track's word instances in timeline order (active words only), resolved style `S` (preset ⊕ track overrides ⊕ speaker deltas), safe-area rect from the deliverable's platform profile, output `width × height @ fps`.
2. **Cue segmentation.** Start a new cue at instance `i` when any holds: (a) `i` is first; (b) a `breakOverrides` entry `{afterWordId: word(i−1), kind:"cue"}` exists; (c) speaker changes; (d) `word(i−1)` ends a segment *and* has sentence-final `punctAfter` (`.`, `!`, `?`); (e) timeline gap from `end(i−1)` to `start(i)` > `S.cueGapMs`; (f) the words of the current cue no longer fit `S.maxLines` lines under step 3; (g) cue duration would exceed `S.maxCueDurationMs`. A `kind:"join"` override suppresses (d) and (e) at that boundary.
3. **Line filling** inside each cue: (a) `availableWidth = safeWidth × S.maxWidthPct/100`; (b) greedy: append the next word to the current line while the line's word count < `S.wordsPerLine` **and** shaped width of `line + " " + word` (at `S.sizePct × height`, with transform applied) ≤ `availableWidth`; otherwise open a new line; (c) a word wider than `availableWidth` alone gets its own line, flagged `overflow` for FR-1004 validation; (d) balance pass, back to front: while the last line has exactly 1 word and the previous line has ≥ 3 and the moved word still fits, move the previous line's last word down; (e) apply `kind:"line"` break overrides last — they force a break after the named word and win over (b)–(d).
4. **Cue timing.** `cueStart = start(firstInstance) − S.highlight.leadInMs`, clamped to max(previous cue end, containing clip start); `cueEnd = end(lastInstance) + S.highlight.holdMs`, clamped to next cue start; then apply the track's `timingOffsets` entry for the cue, if any, re-clamped. Cues never overlap within a track.
5. Output: `CaptionCue[]`, each keyed by its first word instance (`{ firstWordId, clipId }`) — cues carry no IDs of their own (D4-3); overrides re-anchor by word ID across regeneration.

Algorithm HIGHLIGHT (per-word highlight timing derivation):

1. For instance `k` in a cue: highlight interval starts at `start(k)` and ends at `start(k+1)` if `k+1` is in the same cue and the gap `start(k+1) − end(k)` ≤ `S.highlight.maxGapMs`; otherwise it ends at `end(k) + min(gap, S.highlight.holdMs)` (last word: clamped to cue end).
2. Convert to output frames with exact rational arithmetic: `frame = floor(t × fps)`. Adjacent-clamp so intervals never overlap: if `floor(start(k+1)×fps) < endFrame(k)`, the boundary frame belongs to word `k+1` (later word wins). Guarantee: at most one `current` word per track per output frame.
3. Words before the current word render state `past` (styled per `S.highlight.pastWords`), after it `future`. `mode:"per-line"` highlights the whole active line over the same interval union; `mode:"none"` renders all words in base style (phrase-by-phrase display).

### 4.10 Frame-accurate preview and correction contract (FR-206)

The contract between `@guyditor/transcript` and the overlay renderer (`@guyditor/render`, AD-006) is the compiled, immutable `CaptionRenderModel`:

```ts
export interface CaptionRenderModel {
  trackId: string;
  outputs: { width: number; height: number; fps: string };   // "num/den"
  cues: CaptionCue[];                                        // §4.9, with per-word frame intervals
  captionsAtFrame(frame: number): CaptionFrameSpec;          // pure, O(log cues)
}
export interface CaptionFrameSpec {
  cues: { firstWordId: string; box: NormRect;                // normalized 0..1 coords
          lines: { box: NormRect;
                   words: { wordId: string; displayText: string;
                            state: "past" | "current" | "future";
                            emphasized: boolean; box: NormRect }[] }[] }[];
  styleResolved: CaptionStyle;
}
export interface NormRect { x: number; y: number; w: number; h: number }
```

Frame accuracy is by construction: the WebGL preview compositor (AD-005) and the final overlay renderer (AD-006) call the **same** `captionsAtFrame` on the **same** model — there is no separate preview caption path, so what the creator sees at frame *n* is what renders at frame *n*.

Correction round trip:

1. Creator pauses on an exact frame (FR-400); the preview queries `captionsAtFrame(frame)` and hit-tests word boxes, so clicking a rendered word yields its `wordId`.
2. The creator edits text (`transcript.word.correct`), timing (`transcript.word.retime` / `caption.cue.retime`), line breaks (`caption.break.set`), or emphasis (`caption.word.emphasis.set`).
3. On acceptance, §4.12 SYNC and §4.9 LINEBREAK/HIGHLIGHT rerun (cached per D4-11), a new `CaptionRenderModel` is compiled, and the same frame re-renders — the creator verifies the correction without leaving the frame.
4. Render-blocking caption problems (overflow flags, orphaned overrides, ambiguous ranges) feed export validation (FR-1004).

### 4.11 SRT/VTT import and export (FR-207, FR-1101)

**Export** derives sidecar subtitle files from the cue model of a deliverable's caption track (every applicable deliverable also offers burned-in and clean video variants — render paths in Parts 11/12; this section owns the text formats).

```ts
export interface SubtitleExportOptions {
  format: "srt" | "vtt";
  vttWordTimestamps: boolean;   // VTT only: emit <00:00:01.500> karaoke timestamps per word
  vttPositioning: boolean;      // VTT only: map placement to line/position/align cue settings
  includeSpeakerLabels: boolean; // prefix "GUY: " from spk_ labels
}
```

Mapping rules: cue text = display forms joined by spaces, line structure preserved; times rounded half-even to whole milliseconds (SRT `HH:MM:SS,mmm`, VTT `HH:MM:SS.mmm`); after rounding, a cue's start is clamped to ≥ previous cue's end (SRT players tolerate overlap poorly). SRT gets 1-based sequential indices. VTT with `vttWordTimestamps` interleaves per-word timestamps from HIGHLIGHT intervals; with `vttPositioning`, `placement.anchor/offsetYPct` → `line:` percentage, `align` → `align:`.

**What is lossy and why (FR-207, FR-1101):** SRT loses per-word timing, all styling, word IDs, speaker structure, emphasis, and safe-area semantics — it is plain text with millisecond cue times. VTT can carry word timestamps and rough positioning but still loses: sample-accurate timing (ms rounding), word identity and tombstone history (FR-204), style presets and their versions, speaker-aware styling, highlight style, emphasis semantics, and the derived-cue relationship to the timeline. Therefore **SRT/VTT are export/import surfaces only and never the canonical source of word highlighting or captions** (FR-207); the canonical transcript sidecar (§4.4) plus caption tracks (§4.8) remain authoritative, satisfying FR-1101's "preserve richer internal word timing and style separately".

**Import** (`TranscriptEngine.importSubtitles(path)`): the file is ingested as a subtitle asset (`ast_`, FR-002). Parsing produces a transcript-shaped sidecar: each cue becomes a segment; cue text splits on whitespace into words; per-word timing is interpolated across the cue interval proportional to character count, marked `alignment: "imported"`, `origin: "import"`, `confidence: null`. Imported timing is **not canonical**: word IDs are allocated (so anchoring works immediately), but any caption track built on an imported sidecar is flagged `provisional` until the creator runs `transcript.realign` against the actual audio, which upgrades word timings via the §4.3 `align` task and clears the flag. VTT word timestamps, when present, seed the initial timing instead of interpolation but are still marked `imported`.

### 4.12 Synchronization through edits (FR-208)

Word instances are **always recomputed from clip source ranges — never incrementally offset** — so cumulative drift is impossible by construction (AC-003). The map is rebuilt after every accepted transaction and speculatively for proposal previews.

```ts
export type RationalSec = { num: number; den: number };  // exact rational seconds (Part 2 time model)

export interface WordInstance {
  wordId: string; clipId: string; layerId: string;
  start: RationalSec; end: RationalSec;   // timeline time, exact rational seconds
  truncated: boolean;                     // word partially cut by clip boundary
}
export interface WordTimelineMap {
  sequenceId: string;
  instances: WordInstance[];              // sorted by start, then layer order
  diagnostics: SyncDiagnostics;
}
export interface SyncDiagnostics {
  clippedWords: { wordId: string; clipId: string; coverage: number }[];  // excluded partials
  ambiguousRanges: { start: RationalSec; end: RationalSec; layerIds: string[] }[];
  orphanedAnchors: { anchor: string; owner: string; reason: "deleted" | "unmapped" | "approximate" }[];
}
```

Algorithm SYNC (recompute word-to-timeline mapping):

1. For the target sequence, enumerate all enabled clips on the caption track's `sourceLayerIds` in timeline order, and derive each clip's timeline interval from sequence order, durations, gaps, and overlaps (Part 2 time model — positions are derived, not stored).
2. For each such clip, load the canonical transcript sidecar of its asset (skip assets without one). All arithmetic below is exact rational seconds: word times `samples/rate`, clip ranges `frames·den/num`.
3. For each active word `w` with source interval `[ws, we)`, compute its overlap with the clip's source range `[cin, cout)`.
4. Classify: full containment → mapped; partial overlap with `coverage = overlap/(we−ws) ≥ 0.5` **and** overlap ≥ one output frame → mapped with `truncated: true`, source interval clamped to the clip range; otherwise excluded and recorded in `diagnostics.clippedWords` (D4-11).
5. Map source to timeline: `start = clipTimelineStart + retime(ws − cin)` where `retime` applies the clip's speed exactly — constant speed `s` (rational): divide by `s`; keyframed retiming curves (FR-306, defined piecewise-rational in Parts 5/6): evaluate the curve's exact time integral. Word order within a clip is always preserved; a retime that cannot preserve caption sync (unsupported curve) must mark the clip's range in `ambiguousRanges` instead of guessing (FR-306).
6. Emit one `WordInstance` per (word, clip) pair — duplicated ranges, freeze-adjacent splits, and short-form derivatives legitimately yield multiple instances of one word ID; each derivative sequence gets its own `WordTimelineMap` (FR-804 reuses canonical timing this way).
7. **Ambiguity surfacing:** where instances from clips on *different* audible layers overlap in timeline time with non-identical word sequences, add the overlap to `ambiguousRanges` — the track captions only its `sourceLayerIds`, but audible uncaptioned speech is a review warning, not a silent choice.
8. **Orphan surfacing:** resolve every word-ID anchor owned by the sequence (caption overrides §4.8, plus registered consumers: graphics anchors Part 7, annotations Part 8, beats/chapters Part 11) through §4.5 rule 6 against the new map. Anchors resolving to tombstones without active descendants, to words with zero instances, or only approximately are listed in `orphanedAnchors` with owner and reason. Nothing is auto-deleted.
9. Rerun LINEBREAK + HIGHLIGHT (§4.9) from the new map; re-anchor `breakOverrides`/`timingOffsets` by word ID; overrides whose word is unmapped join `orphanedAnchors`.
10. Publish the map: keyed in `.guyditor/cache/captions/` by (revision, sequence ID, sidecar hashes, preset versions) per AD-013; diagnostics surface in the review panel immediately and in export validation (FR-1004 stale/caption checks). Complexity is O(W + C log C) per sequence and runs synchronously within the acceptance flow (NFR-100 budget: < 50 ms for 10k words).

Because trimming, splitting, rearranging, speed changes, and short-form extraction (FR-208's enumerated edits) all reduce to changed clip source ranges, orders, or retime parameters, SYNC handles all of them through the same steps; there is no per-edit special casing to drift out of agreement.

### Part 4 requirements coverage

| BRD ID | Implemented in |
|---|---|
| FR-200 | §4.2 (pipeline, engine interface), §4.3 (transcribe task), §4.4 (language/confidence fields) |
| FR-201 | §4.2 (alignment pass, canonical timing), §4.3 (align task), §4.4 (per-word timing), §4.1 D4-2 |
| FR-202 | §4.6 (RECONCILE algorithm, deviation classes, creator choice flow, `transcript.reconcile.apply`) |
| FR-203 | §4.7 (correction operations; timing only via `transcript.word.retime` / `transcript.realign`) |
| FR-204 | §4.5 (identity rules), §4.1 D4-1 (global ordinals), §4.4 (`state`/`replacedBy`), §4.12 step 8 |
| FR-205 | §4.8 (`CaptionStyle`, tracks, versioned presets), §4.9 (LINEBREAK, HIGHLIGHT) |
| FR-206 | §4.10 (`CaptionRenderModel` contract, correction round trip), §4.9 step 5 (stable override anchors) |
| FR-207 | §4.11 (export mapping, lossiness, non-canonical rule), §4.4 (canonical sidecar) |
| FR-208 | §4.12 (SYNC algorithm, ambiguity and orphan surfacing, drift-free recompute) |
| FR-1101 | §4.11 (import as provisional asset, realign promotion; richer timing/style preserved in §4.4/§4.8) |

---

## Part 5 — Editing operations, proposals, and semantic diffs

### 5.1 Scope and definitions

This part specifies the semantic editing layer of Guyditor: the `OperationEngine` (Part 0, AD-009), the complete catalog of semantic operations, the assistance features that generate operations (pause/filler removal, take comparison, jump-cut concealment), the audio-continuity guards that constrain them, the proposal lifecycle, semantic diffs, and undo/redo. It implements FR-300..FR-311, FR-901, FR-904, and business rules 5 and 6, and defines the executable semantics of FR-104/FR-105 (storage format is owned by Part 2).

Terms used below:

- **Operation** — a named, schema-validated semantic mutation of the project model, e.g. `clip.trim` (Part 0 operation grammar: `<noun>.<verb>`, dot-scoped nouns).
- **Batch** — an ordered list of operations applied atomically against one base revision. A batch either fully applies or fully fails.
- **Transaction** (`txn_`) — an accepted batch recorded in the append-only journal (AD-008; serialization in Part 2, FR-104).
- **Proposal** (`prp_`) — a batch plus reason, diff, preview, and risk metadata held in `proposals/` until accepted, rejected, or superseded (FR-105).
- **Accepted revision** (`rev_NNNNN`) — the creator-approved project state; proposals never modify it.
- **Risk class** — `low` | `normal` | `consequential`, declared per operation, powering the low-risk automation policy (business rule 5).

All time values use the Part 0 time model: `{ frames: <int>, fps: "<num>/<den>" }` for video-rate quantities, `{ samples: <int>, rate: <int> }` for audio-sample quantities. Floating-point time is forbidden.

### 5.2 OperationEngine pipeline (FR-901, FR-300)

`OperationEngine` lives in `@guyditor/core` and runs in the Electron main process. It is the **only** code path that mutates project state. The UI calls it over typed IPC; agents call the identical surface through the `AgentGateway` MCP tools (AD-009). An operation performed by dragging in the timeline serializes to exactly the same `OperationInput` an agent would send, satisfying FR-901. The custom timeline (FR-300, UI in Part 10) is a client of this catalog plus the navigation resolver below; the completeness criterion for FR-300 is that every editing step of AC-001..AC-011 is expressible as catalog operations.

```ts
// @guyditor/core — src/operations/types.ts (all exported)
export type RiskClass = 'low' | 'normal' | 'consequential';
export type CaptionImpact = 'none' | 'shift' | 'retime' | 'realign';

export interface OperationInput {
  op: string;                          // catalog name, e.g. "clip.trim"
  params: Record<string, unknown>;     // validated against the op's JSON Schema
}

export interface OperationContext {
  baseRevision: string;                // rev_ the batch targets
  origin: 'ui' | 'agent' | 'system';
  sessionId?: string;                  // ses_ for agent origin (audit linkage, Part 9)
  proposalId?: string;                 // prp_ when executing inside a proposal
  dryRun: boolean;                     // true = validate + summarize + diff only
}

export interface ValidationIssue {
  code: string;                        // e.g. "E_OP_RANGE_OUT_OF_BOUNDS"
  severity: 'error' | 'warning';
  message: string;
  path?: string;                       // JSON pointer into params
  affected: string[];                  // project IDs involved
}

export interface ContinuityWarning {                       // FR-305, §5.7
  code: 'clipped-phoneme-risk' | 'ambience-jump' | 'click-risk'
      | 'jump-cut' | 'caption-realign-required';
  severity: 'info' | 'warning';
  boundary: { beforeClip?: string; afterClip?: string };   // clp_ ids
  evidence: string;                    // human-readable measurement summary
  suggestion?: string;
  autoFix?: OperationInput;            // optional one-click remediation
}

export interface AppliedOperation {
  op: string;
  params: Record<string, unknown>;
  summary: string;                     // rendered summary template (business rule 6)
  inverse: OperationInput[];           // ops that restore the prior state (FR-904)
  captionImpact: CaptionImpact;        // §5.4
  warnings: ContinuityWarning[];
  affected: string[];                  // ids created/modified/removed
}

export interface OperationBatchResult {
  base: string;                        // rev_
  applied: AppliedOperation[];
  riskClass: RiskClass;                // batch risk after escalation rules (§5.12)
  diff: SemanticDiff;                  // §5.12
  transactionId?: string;              // txn_ when committed (not dryRun/proposal)
}
```

Failures return the Part 0 error envelope `{ code, message, affected, acceptedStateChanged, retry, suggestion? }`; a failed batch always reports `acceptedStateChanged: false`.

**Pipeline** — `OperationEngine.execute(batch: OperationInput[], ctx: OperationContext)`:

1. **Base check.** Reject with `E_OP_STALE_BASE` if `ctx.baseRevision` is not the current accepted revision (proposal execution re-checks at accept time, §5.12).
2. **Schema validation.** Validate each `params` against the op's JSON Schema (draft 2020-12) at `packages/core/src/operations/schemas/<op>.json`. Unknown op names fail with `E_OP_UNKNOWN`.
3. **Semantic validation.** Run the op's `validate(model, params)`: referenced IDs exist; source ranges lie within asset bounds; target layer is not locked (`E_OP_LAYER_LOCKED` enforces FR-301 locking); asset kinds match the op.
4. **Apply.** Apply each op in order to an immutable working copy of the project model (structural sharing; accepted state is never mutated in place). Each op returns the new model, its inverse operations, and affected IDs.
5. **Guards.** Run audio-continuity guards (§5.7) on every audio cut boundary the batch created or moved, and compute `captionImpact` per op (§5.4). Attach warnings; warnings never block application, but `severity: 'warning'` items propagate to proposal review and export validation (Part 12, FR-1004).
6. **Summaries.** Render each op's summary template (§5.3) with humanized references: `{clip}` → asset display name + `clp_` id; `{wordRange}` → quoted transcript excerpt (first/last words, ≤ 8 words with ellipsis) + word IDs; `{delta}` → signed frames plus seconds at the clip's fps.
7. **Risk.** Batch risk = max of member op risk classes, then escalation rules (§5.12).
8. **Diff.** Build the `SemanticDiff` from the applied ops and model delta (never from YAML text comparison).
9. **Commit.** If `dryRun`, stop and return. If `ctx.origin === 'ui'` (direct action), hand the batch to `ProjectStore` to write the transaction and revision snapshot (format: Part 2) and push an undo entry (§5.13). If `ctx.origin === 'agent'`, the engine refuses direct commit — agent batches must arrive via the proposal path (§5.12) or the automation policy (business rule 5).

**Navigation resolver (FR-300, FR-301).** Read-only query on the same IPC/MCP surface: `OperationEngine.resolveNavigation(target: NavigationTarget): TimelinePosition` where `NavigationTarget` is a discriminated union over `{ kind: 'frame', frames, fps }`, `{ kind: 'timecode', tc }`, `{ kind: 'clip', clipId, edge }`, `{ kind: 'word', wordId }`, `{ kind: 'annotation', annotationId }`, `{ kind: 'beat', beatId }`. It resolves through the derived timeline (Part 2) to an exact timeline frame, giving frame, time, clip, transcript-word, annotation, and story-beat navigation to both UI and agent.

### 5.3 Operation catalog

Every operation below has: a JSON Schema at `packages/core/src/operations/schemas/<op>.json`, a summary template, declared inverse metadata, a static risk class, and a `captionImpact` default. Parameter lists are condensed; ID params use the Part 0 prefixes and base32 pattern (e.g. `^clp_[a-z2-7]{10}$`). Reference schema, in full, for `clip.trim`:

```json
{
  "$id": "guyditor:op/clip.trim",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["clipId", "edge", "delta"],
  "additionalProperties": false,
  "properties": {
    "clipId": { "type": "string", "pattern": "^clp_[a-z2-7]{10}$" },
    "edge":   { "enum": ["head", "tail"] },
    "delta":  { "type": "object", "required": ["frames", "fps"],
                "properties": { "frames": { "type": "integer" },
                                "fps": { "type": "string", "pattern": "^[0-9]+/[0-9]+$" } },
                "additionalProperties": false },
    "snapPolicy": { "enum": ["none", "zero-crossing", "word-boundary"],
                    "default": "zero-crossing" }
  }
}
```

**Timeline operations (FR-301).** Selection is renderer view state (AD-002), never an operation.

| Operation | Key params | Summary template | Inverse | Risk |
|---|---|---|---|---|
| `clip.trim` | clipId, edge, delta, snapPolicy | "Trim {edge} of {clip} by {delta}" | `clip.trim` negated | normal |
| `clip.split` | clipId, at (clip-relative frames \| `word:wNNNNNN`) | "Split {clip} at {at}" | `clip.join` | normal |
| `clip.join` | clipIds (adjacent, same source, contiguous source time) | "Join {n} clips of {asset}" | `clip.split` | normal |
| `clip.remove` | clipId, closeGap | "Remove {clip} ({duration})" | `clip.insert` (captured payload) | normal |
| `clip.insert` | sequenceId, index, source {assetId, in, out}, layerId | "Insert {asset} range at position {index}" | `clip.remove` | normal |
| `clip.move` | clipId, toSequenceId?, toLayerId?, toIndex | "Move {clip} to {dest}" | `clip.move` back | normal |
| `clip.duplicate` | clipId, toIndex | "Duplicate {clip}" | `clip.remove` | normal |
| `clip.gap.set` | clipId, leadingGap | "Set gap before {clip} to {gap}" | prior value | normal |
| `clip.overlap.set` | clipId, overlapWithPrevious | "Overlap {clip} with previous by {t}" | prior value | normal |
| `layer.add` | kind (video\|image\|animation\|text\|caption\|matte\|adjustment\|audio\|music\|ambience\|sfx), name, index | "Add {kind} layer '{name}'" | `layer.remove` | normal |
| `layer.remove` | layerId | "Remove layer '{name}' ({n} clips)" | `layer.add` + restore payload | consequential if non-empty, else low |
| `layer.reorder` | layerId, toIndex | "Move layer '{name}' to position {i}" | back | low |
| `layer.enable` / `layer.disable` | layerId | "Enable/Disable layer '{name}'" | opposite op | low |
| `layer.lock` / `layer.unlock` | layerId | "Lock/Unlock layer '{name}'" | opposite op | low |
| `clip.audio.gain.set` | clipId, gainDb | "Set {clip} gain to {gainDb} dB" | prior value | low |
| `clip.audio.fade.set` | clipId, fadeIn {t, curve}, fadeOut {t, curve} | "Set audio fades on {clip}" | prior value | low |

**Transitions (FR-310).**

| Operation | Key params | Summary template | Inverse | Risk |
|---|---|---|---|---|
| `transition.set` | boundary {beforeClipId, afterClipId}, kind (cut\|crossfade\|audio-crossfade\|preset), presetId?, duration, intent? | "Set {kind} ({duration}) between {a} and {b}" | prior transition or `transition.remove` | normal |
| `transition.remove` | transitionId | "Remove {kind} between {a} and {b}" | `transition.set` prior | normal |

`intent` is a free-text purpose string persisted in the master file so transition intent stays visible (FR-310). When `ctx.origin === 'agent'` and `kind !== 'preset'` (or `presetId` is not in the creator-approved preset set from `SkillRegistry`), the batch risk escalates to `consequential` — agents prefer restrained creator-approved presets unless explicitly instructed (FR-310).

**Transcript-based editing (FR-302).** Word ranges are inclusive `{ fromWord, toWord }` word IDs; the engine maps them to source ranges via the canonical per-word timing (Part 4) and preserves source traceability on every produced clip.

| Operation | Key params | Summary template | Inverse | Risk |
|---|---|---|---|---|
| `transcript.range.remove` | wordRange, paddingMs (default 120), snapPolicy | "Remove {wordRange} ({duration})" | restore ops (captured clips/splits) | normal |
| `transcript.range.retain` | scope (sequenceId), wordRanges[] | "Retain only {n} passages ({duration}) in {sequence}" | restore ops | consequential |
| `transcript.range.createClip` | wordRange, targetLayerId, targetIndex | "Create clip from {wordRange}" | `clip.remove` | normal |
| `transcript.range.shortCandidate` | wordRange, title? | "Mark {wordRange} as short-form candidate" | remove candidate record | low |

`transcript.range.shortCandidate` creates a deliverable candidate (`dlv_`, Part 11) without touching the timeline. `transcript.range.remove` compiles to `clip.split` + `clip.remove` primitives internally but is recorded as the single semantic op (its `summary`/`inverse` cover the whole compile), keeping diffs semantic (BR-006).

**Transforms and retiming (FR-306).** Static clip-level values; keyframed movement and responsive layout are Part 6.

| Operation | Key params | Summary template | Inverse | Risk | CaptionImpact |
|---|---|---|---|---|---|
| `clip.transform.set` | clipId, crop {l,t,r,b: 0..1}, scale, position {x,y: normalized}, rotationDeg, opacity | "Transform {clip}: {changedFields}" | prior values | normal | none |
| `clip.speed.set` | clipId, speed "num/den", preservePitch (default true) | "Set {clip} speed to {speed}×" | prior value | normal | retime |
| `clip.freeze.insert` | clipId, at, duration | "Freeze {clip} at {at} for {duration}" | remove freeze | normal | shift |
| `clip.fade.set` | clipId, videoFadeIn {t}, videoFadeOut {t} | "Set video fades on {clip}" | prior | low | none |

**Image finishing (FR-307).** All corrections are non-destructive render parameters; source media is never modified (business rule 1).

| Operation | Key params | Summary template | Inverse | Risk |
|---|---|---|---|---|
| `clip.color.set` | clipId, exposureEv, contrast, whiteBalance {tempK, tint}, saturation | "Adjust color on {clip}: {changedFields}" | prior values | low |
| `clip.look.apply` | clipId \| layerId, presetId (pre_), presetVersion | "Apply look '{preset}' v{ver} to {target}" | prior look or none | low |
| `clip.color.match` | clipId, referenceClipId | "Match {clip} color to {reference}" | prior values | normal |

`clip.color.match` computes concrete `clip.color.set` values from a deterministic histogram/white-point analysis at apply time and **stores the resolved values** in the transaction, so the result is reproducible without re-analysis (AD-013). Looks are versioned presets (FR-705); the applied version is pinned.

**Audio post (FR-308)** — chain semantics in §5.8.

| Operation | Key params | Summary template | Inverse | Risk |
|---|---|---|---|---|
| `clip.audio.offset.set` | clipId, offset {samples, rate} | "Shift {clip} audio by {offset}" | prior value | normal |
| `clip.audio.channels.set` | clipId, mapping (left\|right\|mix\|explicit map) | "Use {mapping} channel(s) on {clip}" | prior value | low |
| `clip.audio.chain.set` | clipId \| layerId, chain (AudioChain, §5.8) | "Set audio chain on {target}: {enabledNodes}" | prior chain | normal |
| `sequence.audio.master.set` | sequenceId, targetLufs, truePeakDb | "Set master loudness target {lufs} LUFS / {tp} dBTP" | prior values | normal |

**Music, ambience, effects (FR-309)** — ducking algorithm in §5.9.

| Operation | Key params | Summary template | Inverse | Risk |
|---|---|---|---|---|
| `clip.loop.set` | clipId, loop, loopCrossfade {t} | "Loop {clip} with {t} crossfade" | prior | low |
| `clip.anchor.set` | clipId, anchor (`word:wNNNNNN` \| `beat:beat_x` \| `clip:clp_x@{frames}`) | "Anchor {clip} start to {anchor}" | prior anchor | normal |
| `layer.ducking.set` | layerId, config (DuckingConfig, §5.9) | "Set ducking on '{layer}': {duckDb} dB under speech" | prior config | low |
| `layer.ducking.override` | layerId, points[] {at, gainDb} | "Add {n} manual ducking points on '{layer}'" | prior points | low |

**Takes and concealment (FR-304, FR-311).**

| Operation | Key params | Summary template | Inverse | Risk |
|---|---|---|---|---|
| `take.select` | comparisonId (tkc_), takeId (tak_) | "Use take {take} for {slot} — was {previous}" | prior selection | normal |
| `clip.punchin.set` | clipId, level (scale ≥ 1.0), anchor {x,y normalized} \| 'face-track' | "Punch in {clip} to {level}×" | prior level | normal |
| `clip.source.switch` | clipId, toAssetId (synchronized angle), offsetPolicy: 'sync-group' | "Switch {clip} to angle {asset}" | prior source | normal |

**Anchors, pickups, and system operations.** Operations referenced by other parts, registered here so every cross-referenced op has a catalog row:

| Operation | Key params | Summary template | Inverse | Risk |
|---|---|---|---|---|
| `anchor.rebind` | owner (object id), anchorPath (JSON pointer to the anchor field on the owner), newAnchor | "Rebind anchor on {owner} to {anchor}" | prior anchor (incl. its `lastResolved` metadata) | normal |
| `pickup.splice` | wordRange {fromWord, toWord}, pickupAssetId, pickupRange {in, out} (SampleTime), roomTonePaddingMs (default 120) | "Replace {wordRange} with pickup {asset}" | restore ops (captured clips + caption/transcript state) | normal |
| `asset.ingest` | assets[] (AssetRecord fields: path, sha256, probe, …, Part 3 §3.3) | "Ingest {n} asset(s)" | deregister the asset entries (files untouched, rule 1) | low |
| `asset.relink` | assetId, newPath, matchBasis ('hash' \| 'metadata-confirmed'), score?, fieldDiff?, previousHash? | "Relink {asset} to {path} ({matchBasis})" | restore prior path + sha256 | low when matchBasis = 'hash', else normal (§3.8) |
| `asset.verify` | assetId, integrity ('ok' \| 'missing' \| 'mismatch') | "Record integrity '{integrity}' for {asset}" | prior integrity value | low |
| `asset.sync.set` | assetId, sync (SyncDecision, Part 3 §3.9) | "Set A/V sync offset on {asset}" | prior SyncDecision | low |
| `asset.markers.attach` | assetId, sidecar {path, sha256} | "Attach {n} markers to {asset}" | prior takes-sidecar registry entry | low |
| `asset.takes.set` | assetId, sidecar {path, sha256} | "Set take metadata for {asset}" | prior takes-sidecar registry entry | low |
| `transcript.create` | assetId, sidecar {path, sha256}, engine {name, version, model}, alignment {name, version, model} \| null, jobId | "Register canonical transcript for {asset}" | deregister the sidecar entry (file retained) | low |
| `project.restore` | target (rev_) | "Restore project to {target}" | `project.restore` to the pre-restore revision | consequential |

`anchor.rebind` is the sole repair path for orphaned anchors (Part 2 §2.3 orphan handling). `pickup.splice` implements the FR-011 splice (Part 3 §3.12 step 6) and is always proposal-gated; its guards are §5.7. The `asset.*` rows are the Part 3 §3.1 media operations — this table is their parameter registry; behavioral semantics live in Part 3 (§3.3 ingest, §3.8 relink, §3.9 sync, §3.11 markers/takes, §3.14 verify). `transcript.create` is recorded by Part 4 §4.2 step 5 at canonical-transcript creation (initial transcription is `low`; *re*-transcription of an already-transcribed asset is a proposal per Part 4). `project.restore` is the forward-only restore of Part 2 §2.11.

### 5.4 Caption synchronization obligations (FR-306, FR-208)

Every operation declares a `CaptionImpact`; the engine recomputes derived caption timing (compiled by Part 4 from word anchors) before the batch result is returned:

1. `none` — no timeline/audio timing change; captions untouched.
2. `shift` — timeline content reordered, inserted, or removed with word anchors intact (trim, split, move, remove, freeze, transcript ops). Because captions anchor to word IDs and word timing is stored in **source time** (FR-204, Part 0 time model), the timeline mapping is recomputed automatically from the derived timeline; no sidecar change occurs.
3. `retime` — `clip.speed.set`. Word display times within the clip scale by the inverse speed factor (exact rational arithmetic); source-time word timing is unchanged. If `speed > 2/1` or `< 1/2`, or `preservePitch` is false, the engine additionally emits `caption-realign-required` (per-word highlighting readability and audible-word alignment are no longer guaranteed).
4. `realign` — any cut or trim whose resulting boundary lands **inside** a word's source-time span (word start < cut < word end). The affected word IDs are flagged `timingSuspect: true` via a Part 4 sidecar update instruction attached to the transaction, and a `caption-realign-required` warning is surfaced for review. The edit still applies; the flag blocks final export until reviewed (Part 12, FR-1004 "stale transcripts or sidecars").

### 5.5 Pause and filler assistance (FR-303)

Detection is a `JobQueue` job (`assist.fillers.detect`, callable from the UI and, as gateway tool `assist_fillers_detect`, by the agent — Part 9 §9.2). It never mutates the project; it produces candidates that compile into a proposal (§5.12) — **review-first, always**.

**Inputs** (all read via `ProjectStore` sidecar references; producing parts noted):

- Voice-activity/silence intervals per asset (Part 3 analysis sidecar): `{ start, end (samples/rate), kind: 'speech'|'silence', rmsDb }`.
- Canonical per-word transcript with confidences (Part 4).
- Per-language disfluency lexicon bundled in `@guyditor/core` (`src/assist/fillers/lexicon.<lang>.json`): words/phrases tagged `filler` ("um", "uh", "you know"), `discourse` ("so", "like" — context-dependent).
- Repeated-phrase detector: sliding 8-word window, ≥ 3-word verbatim n-gram repeated within 15 s.
- False-start detector: a segment whose trailing tokens (≥ 2) match the leading tokens of the next segment, with an intervening pause ≥ 250 ms or a word cut off mid-syllable (word confidence < 0.5 and duration < 60 % of that word's median duration elsewhere).

**Rule schema** — `FillerRuleSet`, stored in editorial skills (FR-700, wiring in Part 9) and overridable per run:

```yaml
fillerRules:
  version: 1
  pauses:
    minRemovableMs: 700          # never touch shorter pauses
    keepAtSentenceBoundaryMs: 1200   # boundary pauses under this are kept
    retainMs: 200                # pause length left in place of a removed pause
  fillers:
    remove: ["um", "uh", "erm"]
    review: ["like", "you know", "so"]   # candidate only, never in auto batch
    keep: []
  repeats: { enabled: true, minWords: 3 }
  falseStarts: { enabled: true }
  limits:
    maxDensityPerMinute: 12      # more candidates/min → flag section for manual review
    protectAnnotatedRanges: true # skip ranges under open annotations (ann_)
    protectBeats: ["dramatic-pause"]   # beat tags exempt from pause removal
  padding: { cutPaddingMs: 120 }
```

**Candidate generation algorithm:**

1. Map VAD silence intervals and lexicon/repeat/false-start matches to word-range candidates in source time.
2. Drop candidates inside protected ranges (open annotations, protected beat tags, locked layers).
3. For each pause candidate, classify context: sentence-internal (no terminal punctuation on the preceding word) vs boundary; apply the corresponding threshold; plan retention of `retainMs` of natural pause.
4. For each candidate, pre-run the continuity guards (§5.7) on the hypothetical cut points; record resulting warnings on the candidate.
5. Emit `FillerCandidate[]`: `{ id, kind: 'pause'|'filler'|'repeat'|'false-start', wordRange?, sourceRange, rule, evidence, warnings, defaultSelected }` — `defaultSelected` is true only for `remove`-list fillers and pauses with zero warnings.
6. If density exceeds `maxDensityPerMinute` in any 60 s window, mark that window `reviewRequired` and set `defaultSelected: false` throughout it.

**Review-first flow:** the UI presents candidates as an audition checklist (play-through skipping selected candidates). The confirmed subset compiles into one proposal whose operations are `transcript.range.remove` (word-bounded candidates) and `clip.trim`/`clip.split`+`clip.remove` (pure-pause candidates), each carrying the triggering rule as evidence. Because these ops are `normal` risk, they are never auto-accepted under any automation policy (§5.12); a batch removing > 30 s total escalates to `consequential`.

### 5.6 Take comparison (FR-304)

`assist.takes.compare` (job; gateway tool `assist_takes_compare`, Part 9 §9.2) builds a **comparison record** with ID prefix `tkc_` (new prefix defined by this part), persisted at `sidecars/takes/<tkc_id>.json` and hash-referenced from the master file (business rule 4).

```ts
export interface TakeComparison {
  id: string;                          // tkc_
  slot: { beatId?: string; scriptSection?: string; wordRange?: { fromWord: string; toWord: string } };
  candidates: TakeCandidate[];
  recommendation?: {
    takeId: string;
    reasons: { criterion: string; detail: string; evidence: string }[]; // each tied to a rubric + measurable evidence
    confidence: 'low' | 'medium' | 'high';
  };
  selectedTakeId?: string;             // set by take.select
  createdAt: string;                   // ISO 8601 UTC
}
export interface TakeCandidate {
  takeId: string;                      // tak_ (take metadata from FR-010, Part 3)
  assetId: string;
  sourceRange: { in: SourceTime; out: SourceTime };
  transcriptText: string;
  scriptMatch?: { score: number; deviations: string[] };      // vs FR-202 script if present
  delivery: { wordsPerMinute: number; fillerCount: number; pauseRatio: number;
              energyVariance: number; restartCount: number };  // from Part 3/4 analysis
  technical: { audioClippingPct: number; noiseFloorDb: number;
               focusScore?: number; exposureScore?: number; framingScore?: number };
  preference: { score: number; rubricId: string; rubricVersion: string };  // FR-700/702 via SkillRegistry
  markers: { qualityFlags: string[]; notes: string[] };        // record-time markers, FR-010
}
```

The recommendation is advisory (BR-004, business rule 12): every reason names its criterion and points at inspectable evidence (a source range, a metric value, a marker). Choosing a take is the `take.select` operation; **rejected takes are retained** — their assets, take metadata, and the comparison record remain in the project, and the comparison ID is recorded on the accepting transaction so alternatives stay reachable (FR-304). Side-by-side playback of candidates uses the comparison workflow of Part 10 (FR-903).

### 5.7 Audio continuity guards (FR-305)

Guards run in pipeline step 5 on every audio cut boundary a batch creates or moves. Inputs: decoded PCM around the boundary (via `MediaEngine`, 500 ms each side), VAD intervals, and per-word timing.

1. **Zero-crossing snap.** If the op's `snapPolicy` is `zero-crossing` (default), search ±10 ms around the requested cut for the nearest sample where the waveform crosses zero with matching slope sign on both sides of the joint. Move the cut there (exact sample arithmetic; the stored operation records the snapped value). Skip the snap if it would move the cut across a word start/end. If no acceptable crossing exists and the instantaneous level at the cut exceeds −30 dBFS, emit `click-risk` with `autoFix` = `clip.audio.fade.set` micro-fade (3 ms).
2. **Clipped-phoneme heuristic.** Emit `clipped-phoneme-risk` when (a) the cut lies inside a word's source-time span, or (b) within 40 ms after a word end or before a word start, or (c) RMS in the 20 ms window at the cut exceeds the local noise floor (5th-percentile RMS of the surrounding 2 s) by more than 12 dB while VAD reports speech. Evidence includes the word text and margin measured.
3. **Ambience-jump detection.** Compare the 300 ms windows on each side of the joint: integrated loudness delta > 4 LU, or noise-floor mismatch > 6 dB, or spectral-centroid ratio outside [0.7, 1.4] → emit `ambience-jump` with `autoFix` = `transition.set { kind: 'audio-crossfade', duration: 80 ms }`; suggestion text also offers a room-tone patch (room-tone assets, Part 3).
4. **Jump-cut check (video).** When both sides of a boundary are the same source asset, the skipped source time is between 1 frame and 10 s, and the punch-in level is identical on both sides, emit `jump-cut` (severity `info`) linking to §5.11 concealment.

**Warning surface:** warnings attach to `AppliedOperation.warnings`, appear inline in proposal review (§5.12) and on the timeline boundary markers (Part 10), and aggregate into export validation (Part 12). Guards warn and offer fixes; they never silently modify audio beyond the declared zero-crossing snap, which is itself recorded in the stored parameters. This satisfies FR-305's "warn when a clean edit cannot be made automatically".

### 5.8 Audio post-production chain (FR-308)

Each clip (and each audio layer, applied after its clips' chains) owns an `AudioChain` with a **fixed node order**; every node is individually adjustable and bypassable (`enabled: false`), satisfying "adjustable and bypassable":

```ts
export interface AudioChain {
  nodes: AudioChainNode[];   // always serialized in canonical order below
}
export type AudioChainNode =
  | { type: 'channelSelect';  enabled: boolean; mapping: 'left'|'right'|'mix'|number[] }
  | { type: 'noiseReduction'; enabled: boolean; strengthDb: number }          // ffmpeg afftdn
  | { type: 'gain';           enabled: boolean; gainDb: number }              // volume
  | { type: 'eq';             enabled: boolean; bands: { freqHz: number; gainDb: number; q: number }[] } // firequalizer
  | { type: 'compression';    enabled: boolean; thresholdDb: number; ratio: number;
      attackMs: number; releaseMs: number; makeupDb: number }                 // acompressor
  | { type: 'limiting';       enabled: boolean; ceilingDb: number };          // alimiter
```

Canonical order: `channelSelect → noiseReduction → gain → eq → compression → limiting`. Clip fades (`clip.audio.fade.set`) apply at the clip edges outside the chain. **Loudness normalization** (`loudnorm`, two-pass) runs last, at the deliverable master stage after mixing and ducking, targeting `sequence.audio.master.set` values or the platform profile's loudness/true-peak targets (FR-805, Part 11) — normalizing per-clip and then again at master would double-process. Sync correction is `clip.audio.offset.set` (§5.3). Any automated "clean up my audio" assistance writes **explicit node values** through `clip.audio.chain.set`, so the result is inspectable, adjustable, and reproducible (AD-013) rather than a hidden preset.

### 5.9 Music, ambience, and automatic ducking (FR-309)

Music, room tone, ambience, and sound effects live on dedicated audio layers (`layer.add` kinds `music`/`ambience`/`sfx`), with looping (`clip.loop.set`), fades, and semantic timing anchors (`clip.anchor.set` — a music cue anchored to `word:w000318` survives upstream re-edits, FR-204).

```ts
export interface DuckingConfig {
  enabled: boolean;
  mode: 'auto' | 'manual';
  duckDb: number;        // default -12
  attackMs: number;      // default 150 (ramp down before speech)
  releaseMs: number;     // default 400 (ramp up after speech)
  holdMs: number;        // default 250 (stay ducked after speech ends)
  minGapMs: number;      // default 700 (ignore speech gaps shorter than this)
}
```

**Automatic ducking algorithm** (runs at compile time in `@guyditor/render`; the envelope is a derived artifact, recomputed per render — the project stores only the config and manual overrides, per BR-005):

1. Collect VAD speech intervals from every enabled speech-carrying layer (video/audio layers whose clips have transcripts), mapped from source time to timeline time through the derived timeline.
2. Merge intervals separated by less than `minGapMs`.
3. Extend each merged interval: start − `attackMs`, end + `holdMs`.
4. Emit a gain envelope for the ducked layer: `duckDb` inside intervals, 0 dB outside, with linear-in-dB ramps of `attackMs` down and `releaseMs` up; clamp overlapping ramps to the lower gain.
5. Merge manual override points (`layer.ducking.override`); where a manual point's ±`releaseMs` neighborhood overlaps the automatic envelope, the manual value wins.
6. Compile to FFmpeg `volume` automation in the filtergraph (Part 12); the preview compositor applies the same envelope for audible parity (AD-005), and the meters of FR-906 (Part 10) display it for verification.

### 5.10 Transition control (FR-310)

Transitions are first-class objects (`trn_`) between two clip boundaries with `kind`, `duration`, optional `presetId` (versioned visual-transition presets, `pre_`, defined with the template system in Part 7), and `intent` — all serialized in the master file so duration and purpose are readable in diffs and text tools (FR-905). Supported kinds: hard `cut` (default, zero-duration), `crossfade`, `audio-crossfade` (audio-only overlap for continuity fixes, §5.7), and `preset`. The agent-restraint rule of §5.3 (non-approved-preset transitions from agent origin escalate to `consequential`) implements "prefer restrained creator-approved presets unless instructed otherwise".

### 5.11 Jump-cut concealment (FR-311)

`assist.jumpcuts.conceal` (job; gateway tool `assist_jumpcuts_conceal`, Part 9 §9.2) remediates the cut density created by §5.5. It is **always proposal-gated** — its output is a proposal; it has no direct-apply path.

```ts
export interface JumpCutConcealmentConfig {   // stored in editorial skills (FR-700, Part 9)
  zoomLevels: number[];        // default [1.0, 1.12, 1.25]; ascending, first must be 1.0
  minPunchDurationFrames: { frames: number; fps: string };  // default 1 s at sequence fps
  anchor: 'face-track' | 'center';
  maxSourceGapSec: number;     // default 10 — larger skips are scene changes, not jump cuts
  preferAngleSwitch: boolean;  // default true when synchronized angles exist
  smoothCutPresetId: string;   // default "pre_smoothcut_v1" (3-frame optical-flow-free blend, Part 7)
}
```

**Punch-in alternation algorithm** (single high-resolution source):

1. Collect boundaries flagged `jump-cut` by §5.7 within the requested scope; group consecutive boundaries on the same source into **runs**.
2. Feasibility per clip: compute the maximum usable zoom `zMax = sourceHeight / targetDeliverableHeight` (from asset metadata and the primary deliverable profile). Discard zoom levels above `zMax`.
3. Assign levels along each run: start from the clip's current punch level (1.0 if none); at each cut, switch to an **adjacent** level in `zoomLevels` (in → out → in …). Never keep the same level across a cut in a run; never skip more than one level per cut; a segment shorter than `minPunchDurationFrames` keeps its predecessor's level and is handled by rule 5 instead.
4. Anchoring: with `anchor: 'face-track'`, center the punched crop on the smoothed face-bounding-box center from the tracking sidecar (Part 3), clamped so the crop stays inside the source frame; without a usable track, fall back to `center` only if framing is static (face-box variance below threshold across the run).
5. **Decline conditions** — the algorithm emits no punch-in op for a boundary when: only one feasible zoom level exists (`zMax < zoomLevels[1]`); no face track and framing varies; the segment is shorter than `minPunchDurationFrames`; or the clip already carries a manual `clip.transform.set`. For declined boundaries it instead proposes the **smooth-cut preset** (`transition.set` with `smoothCutPresetId`), or, when the source belongs to a synchronization group with alternate angles (FR-008, Part 3) and `preferAngleSwitch` is true, **angle switching** via `clip.source.switch` alternating between synchronized sources.
6. Emit one proposal containing the resulting `clip.punchin.set` / `transition.set` / `clip.source.switch` ops, each with a reason citing cut density and boundary evidence. If every boundary in scope is declined, the tool returns a report explaining why and proposes nothing.

### 5.12 Proposal lifecycle and semantic diffs (FR-105, business rules 5 and 6)

A proposal is persisted as the Part 2 §2.10 proposal directory `proposals/<prp_id>/` (`proposal.json` — the single normative `Proposal` record defined in Part 2 §2.10, `master.proposed.yaml`, `diff.patch`, optional `assessment.json`, `previews/`); Part 2 validates it as part of project loading. States: `draft → ready → accepted | rejected | superseded | withdrawn` (the record's `status` field; `resultTransaction` holds the `txn_` once accepted). This part owns the lifecycle below and the sub-schemas the record references:

```ts
export interface ProposalReason {
  text: string;                        // one concise sentence (FR-704)
  sources: { kind: 'instruction' | 'annotation' | 'skill-rule' | 'media-evidence';
             ref: string }[];          // ann_/skl_ ids, instruction excerpt, evidence pointer
}
```

**Lifecycle:**

1. **Draft.** The author (agent via `AgentGateway`, or the assistance tools of §5.5/§5.6/§5.11) assembles `operations` against the current accepted revision.
2. **Ready.** The engine dry-runs the batch (pipeline §5.2, `dryRun: true`), filling `applied`, `diff`, `riskClass`, `warnings`, and queues a preview `JobQueue` job that renders the affected timeline ranges (selective render, Part 12) for before/after comparison (FR-903). **Rule 6 gate:** an agent-origin proposal with `riskClass` `normal` or `consequential` and an empty `reason` is refused promotion with `E_OP_REASON_REQUIRED` — every meaningful agent edit ships with a reason and a diff.
3. **Review.** The creator inspects preview + semantic diff + warnings in the proposed-change panel (Part 10). The accepted revision is untouched throughout (FR-105).
4. **Accept.** The engine re-checks `baseRevision` against the current accepted revision; if stale, it sets `staleBase` and declines (the author may rebase, producing a superseding proposal). Otherwise it re-executes the batch for real, `ProjectStore` writes the transaction and revision snapshot (serialization, actor, versions, and acceptance metadata per Part 2 / FR-104), and the proposal records `resultTransaction`. Annotations listed in `addresses` advance their lifecycle (Part 8 §8.8.3, FR-406).
5. **Reject / withdraw.** Status becomes `rejected` (creator decision) or `withdrawn` (the author retracts it via `proposal_withdraw`, Part 9 §9.2); the proposal directory is retained for audit (and mirrored to the session audit log, Part 9); accepted state is byte-identical to before.
6. **Revise.** Creator feedback or direct parameter editing in the UI (an agent proposal is adjustable in the UI — FR-901) produces a **new** proposal referencing the old one, which becomes `superseded` with `supersededBy` set. Proposals are never edited in place once `ready`.

**Semantic diff** — computed from applied operations and the model delta, never from text comparison of the YAML:

```ts
export interface SemanticDiff {
  base: string;                        // rev_
  entries: SemanticDiffEntry[];        // ordered as applied
  stats: {
    durationDelta: { frames: number; fps: string };
    clipsAdded: number; clipsRemoved: number; clipsModified: number;
    affectedLayers: string[];          // lyr_
    affectedWordRanges: { fromWord: string; toWord: string }[];
    affectedDeliverables: string[];    // dlv_ whose source ranges intersect (feeds FR-807 staleness, Part 11)
  };
}
export interface SemanticDiffEntry {
  summary: string;                     // e.g. "Trim head of clp_ab3k9x2mnp by 30 frames (1.25 s)"
  op: string;
  anchors: string[];                   // semantic anchors for click-to-navigate
  before?: unknown; after?: unknown;   // changed values only, for expandable detail
}
```

The same structure renders in the UI diff panel, exports as plain text, and backs revision comparison (FR-108, Part 2).

**Risk classes and the automation policy (business rule 5).** Batch risk = max member risk, escalated to `consequential` when: the batch modifies or removes more than 20 clips; removes more than 30 s of total timeline duration; removes a non-empty layer; or (agent origin) uses a non-approved transition (§5.3). The creator-configured policy lives in the master file under `settings.automation` — one schema, owned by Part 9 §9.3 (`enabled`, `maxRisk: low` — the only legal value, `allowedOperations`, `maxOpsPerProposal`, `maxAutoAcceptsPerSession`, `notify`); serialization by Part 2.

When enabled, an agent proposal whose batch risk is `low` (and, if `allowedOperations` is non-empty, whose every op is listed, within the policy's per-proposal and per-session caps) is accepted automatically: the full lifecycle still runs, the transaction records `acceptance.status: 'auto-accepted-low-risk'` (Part 2 §2.9, the sole auto-acceptance marker) and the proposal records `resolvedBy: 'auto'`, the proposal directory is retained, the event appears in the review feed (Part 10) and audit log (Part 9), and the stored inverse makes it individually revertible. Everything else waits for the creator — agent changes are proposals until explicitly accepted or accepted under this policy, exactly as business rule 5 states.

### 5.13 Undo, redo, and rejection (FR-904)

Undo/redo is a session-scoped service inside `OperationEngine`, in-memory only (cleared on project open); durable reversibility comes from the journal's stored inverses.

1. **Direct UI actions** commit immediately as transactions (pipeline step 9) and push `{ transactionId, inverse: OperationInput[], redo: OperationInput[] }` onto the undo stack.
2. **Undo** pops the stack and executes the inverse ops as a new transaction annotated `undoOf: <txn_>`; the journal stays append-only (AD-008) — history is never rewritten. The entry moves to the redo stack; **redo** replays the original ops as a transaction annotated `redoOf`.
3. Undo requires its target transaction to be the head revision. If another transaction (e.g. an accepted proposal) has landed since, the stack entry is invalidated and the UI offers **revert** instead: any historical transaction can be reverted by applying its stored inverse as a fresh transaction, with the engine validating that the inverse still applies cleanly (conflicts return `E_OP_REVERT_CONFLICT` and suggest revision restore, Part 2 / FR-108).
4. **Proposals never enter the undo stack.** Accept/reject/revise are lifecycle actions: rejection leaves the accepted revision byte-identical (FR-105), and an accepted proposal is unwound via revert of its transaction, not via UI undo. This keeps "undo" (my direct manipulation) and "reject/revert" (agent work) semantically distinct, as FR-904 requires, and no path can corrupt the accepted revision: every state change, in either direction, is itself a validated forward transaction.

### Part 5 requirements coverage

| BRD ID | Implemented in |
|---|---|
| FR-300 | 5.2 (engine + navigation resolver, completeness criterion), 5.3 |
| FR-301 | 5.3 (timeline operations table), 5.2 (navigation resolver, lock enforcement) |
| FR-302 | 5.3 (transcript-based editing table) |
| FR-303 | 5.5 |
| FR-304 | 5.6, 5.3 (`take.select`) |
| FR-305 | 5.7, 5.2 (pipeline step 5) |
| FR-306 | 5.3 (transforms/retiming table), 5.4 |
| FR-307 | 5.3 (image finishing table) |
| FR-308 | 5.8, 5.3 (audio post table) |
| FR-309 | 5.9, 5.3 (music/ambience table) |
| FR-310 | 5.10, 5.3 (transitions table) |
| FR-311 | 5.11, 5.7 (jump-cut detection), 5.3 (`clip.punchin.set`, `clip.source.switch`) |
| FR-901 | 5.2 (single OperationEngine surface), 5.12 (proposals adjustable in UI) |
| FR-904 | 5.13, 5.12 (accept/reject/revise) |
| Business rule 5 | 5.12 (risk classes, escalation, automation policy), 5.3 (per-op risk column) |
| Business rule 6 | 5.12 (reason gate, semantic diff), 5.2 (summary templates), 5.3 (summary column) |

---

## Part 6 — Composition, keying, and picture-in-picture

### 6.1 Scope, terms, and owned operations

This part specifies the visual composition system implemented in `packages/compositor` (`@guyditor/compositor`) and exposed at runtime by the `CompositorModel` service in the Electron main process. It owns: the layer model (FR-500), presenter arrangements (FR-501), chroma keying (FR-502), neural matting (FR-503), key quality control (FR-504), capture guidance (FR-505), the picture-in-picture (PiP) primitive (FR-506), placement constraints and their solver (FR-507), motion presets (FR-508), semantic keyframes (FR-509), collision avoidance (FR-510), and responsive per-aspect overrides (FR-511). It also carries the composition-side portions of clip transforms (FR-306) and image finishing (FR-307).

Terms: a **composition** is the visual layer stack of one sequence (`seq_`). A **matte** is a grayscale alpha image or image sequence. **Normalized coordinates** are `x, y, w, h ∈ [0..1]`, origin top-left, `x/w` relative to composition width, `y/h` relative to composition height (aligned with FR-403). All durations in this part are integer frames at the owning sequence's frame rate; source positions use the Part 0 time model. Both render paths — the WebGL preview compositor (AD-005) and the FFmpeg filtergraph compiled by `@guyditor/render` (AD-006, Part 12) — compile from the schemas in this part; there is no separate preview model.

Operations owned by this part, registered in the Part 5 catalog with JSON Schemas, summary templates, inverse metadata, and risk class per Part 0 §0.4:

| Operation | Effect | Risk |
|---|---|---|
| `layer.add` / `layer.remove` / `layer.reorder` | manage the ordered layer stack — owned and risk-classed by Part 5 §5.3 (`layer.add` normal; `layer.remove` consequential if non-empty, else low; `layer.reorder` low); listed here for scope only | per Part 5 §5.3 |
| `layer.set` | patch `opacity`, `blend`, `name` (the `enabled`/`locked` toggles are Part 5 §5.3's `layer.enable`/`layer.disable`/`layer.lock`/`layer.unlock`) | low |
| `layer.transform.set` | set the layer-default `Transform2D` (per-clip static transforms are Part 5 §5.3 `clip.transform.set`) | normal |
| `layer.matte.set` | attach/detach a matte-layer reference | normal |
| `clip.key.set` / `clip.key.mask.set` | edit `KeySettings` / garbage-holdout masks | normal |
| `key.matte.generate` | queue mlworker neural-matte job (candidate output; frozen as an asset at acceptance, §6.5) | low |
| `key.qc.run` | queue key-QC analysis job (sidecar output only) | low |
| `composition.arrange` | instantiate a presenter arrangement (§6.3) | normal |
| `pip.style.set` / `pip.place` | edit `PipStyle` / `PlacementConstraints` | normal |
| `pip.keyframe.add` / `pip.keyframe.remove` | edit semantic keyframes | normal |
| `pip.preset.apply` | attach a motion preset at an anchor | normal |
| `pip.avoid.solve` | run collision solver; output is a proposal `prp_` | low |
| `region.mark` | record a marked avoid region (optionally from `ann_`) | low |

Failures use the Part 0 error envelope; this part defines codes `E_OP_LAYER_LOCKED`, `E_PIP_CONSTRAINT`, `E_KEY_UNSUPPORTED_COLOR`, `E_MATTE_CAPABILITY_MISSING` (mlworker lacks matting; `retry: 'none'`, `suggestion` names the missing optional dependency per AD-003/NFR-101).

New ID prefixes introduced by this part (Part 0 registry extension): key/garbage masks `msk_`, PiP keyframes `kfr_`, avoid regions `avr_`. Same format: prefix + 10 random base32 chars.

### 6.2 Layer model (FR-500, FR-306, FR-307)

The normative `Layer` schema is Part 2 §2.4: the project owns a single `layers: Layer[]` array; z/mix order is each layer's `order` field (higher renders above, FR-500), and rendering proceeds in ascending `order`. A layer's content is either `sequence` (a `seq_` reference — ordered clips whose positions are derived, Part 2 §2.7) or anchored `items: PlacedItem[]`, never both. This part owns the composition semantics and the sub-schemas `BlendMode`, `Transform2D`, `PipConfig` (§6.8), and `ColorCorrection` that Part 2 references:

```ts
export type LayerKind = Layer['kind'];   // Part 2 §2.4 closed enum: 'video' | 'image' | 'animation'
                                         // | 'text' | 'caption' | 'matte' | 'adjustment'
                                         // | 'audio' | 'music' | 'ambience' | 'sfx'
                                         // (audio role kinds per Part 5 §5.9)

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken'
  | 'lighten' | 'addition' | 'subtract' | 'difference';

export interface Transform2D {
  anchor: { x: number; y: number };     // 0..1 within the layer's own box
  position: { x: number; y: number };   // normalized composition coords of the anchor
  scale: { x: number; y: number };      // 1.0 = source size mapped per placement/fit
  rotationDeg: number;                  // clockwise
  crop?: { x: number; y: number; w: number; h: number }; // normalized source rect
}

export interface ColorCorrection {                       // FR-307 subset
  exposure: number;      // stops, -4..4
  contrast: number;      // 0..2, 1 = neutral
  temperatureK?: number; // white balance target
  tint?: number;         // -1..1
  saturation: number;    // 0..2, 1 = neutral
}
```

Semantics (over the Part 2 §2.4 `Layer` fields):

1. `matte` references another layer **by ID**, never by adjacency (stable diffs, R-002). The referenced matte layer is not rendered directly; its luma or alpha multiplies the referencing layer's alpha.
2. An `adjustment` layer applies its `ColorCorrection` to the composite of all enabled layers below it; it holds no clips. `ColorCorrection` also appears in clip effect stacks (Part 5) and in `KeySettings.postColor` — one schema, three attachment points, all applied by the shared implementation.
3. The nine `BlendMode` values are exactly those implementable identically by FFmpeg `blend=all_mode=<mode>` and by the WebGL compositor's blend shader; no other modes are permitted in `guyditor/v1`.
4. `caption` layers are rendered by the Part 4 caption engine through the deterministic overlay renderer (AD-006); `text`/`animation` layers by Part 7 templates. Composition treats all of them as alpha-bearing image streams.
5. Defaults when absent: `opacity` 1 (multiplied after per-clip opacity), `blend` `'normal'`, identity `transform` (per-clip transforms compose on top). `blend` is ignored for the audio role kinds; disabled layers are skipped by both render paths; `locked` layers reject mutations with `E_OP_LAYER_LOCKED`. `pip` applies to video/image/animation layers only; `adjustment` to kind `'adjustment'` only.

### 6.3 Presenter composition arrangements (FR-501)

Arrangements are built-in versioned presets (`pre_`, `version` integer) that instantiate a role-mapped layer stack. Built-ins shipped in `@guyditor/compositor`:

| Arrangement name | Stack (bottom → top) | Roles |
|---|---|---|
| `presenter_over_background` | background, presenter | background, presenter |
| `presenter_over_screen` | screen recording, presenter (PiP) | screen, presenter |
| `presenter_front_of_animation` | animation, presenter | animation, presenter |
| `presenter_sandwich` | background, presenter, foreground graphic | background, presenter, foreground |
| `presenter_side_by_side` | background, content (left slot), presenter (right slot) | background, content, presenter |

```ts
export interface PresenterArrangement {
  id: string;                       // pre_
  version: number;
  name: string;                     // table above, or creator-defined
  roles: Array<{
    role: string;                   // 'presenter' | 'background' | ...
    kind: LayerKind;
    defaultPlacement?: PlacementConstraints;  // §6.9
    defaultKey?: boolean;           // presenter role defaults to keying enabled
    defaultStyle?: PipStyle;        // §6.8
  }>;
}
```

`composition.arrange` takes `{ sequenceId, arrangementRef, assignments: Record<role, assetId | layerId>, at?: SemanticAnchor }`, creates or rebinds the layers, and records one transaction whose summary template reads e.g. *"Arranged presenter_over_screen: presenter=ast_…, screen=ast_…"*. Arrangements are templates, not live constraints: after instantiation the layers are ordinary layers.

### 6.4 Chroma-key pipeline (FR-502)

Keying attaches per clip (different clips on one layer may need different keys); `layer.set` MAY store a layer-level `KeySettings` default that clips inherit.

```ts
export interface KeySettings {
  schema: 'guyditor/key@1';
  mode: 'off' | 'chroma' | 'neural';
  chroma?: ChromaKeyParams;
  neural?: NeuralMatteParams;       // §6.5
  masks: KeyMask[];                 // applied in both modes
  postColor?: ColorCorrection;      // applied after keying, foreground only
}

export interface ChromaKeyParams {
  keyColor: string;                 // '#RRGGBB'
  tolerance: number;                // 0..1
  softness: number;                 // 0..1
  preBlur: number;                  // 0..4, chroma-plane blur sigma on key branch only
  edge: { erodePx: number; featherPx: number };   // at source resolution
  spill: { mode: 'off' | 'despill' | 'average'; strength: number }; // 0..1
}

export interface KeyMask {
  id: string;                       // msk_
  role: 'garbage' | 'holdout';      // garbage forces transparent, holdout forces opaque
  shape: 'rect' | 'ellipse' | 'polygon';
  points: Array<{ x: number; y: number }>;  // normalized source coords
  featherPx: number;
  frames?: { from: number; to: number };    // clip-relative source frames; omit = whole clip
}
```

**Normative alpha formula.** Let `(Cb, Cr)` be the pixel and `(Cbk, Crk)` the key color, all in `[0..1]` BT.709. With `d = sqrt((Cb−Cbk)² + (Cr−Crk)²) / sqrt(2)`, `similarity = 0.01 + 0.39·tolerance`, `blendW = 0.4·softness`:

```
alpha = 0                              if d < similarity
alpha = (d − similarity) / blendW      if similarity ≤ d < similarity + blendW
alpha = 1                              otherwise
```

FFmpeg's `chromakey` filter implements this formula; the WebGL preview shader MUST implement it verbatim so preview and final render agree.

**Filtergraph compilation algorithm** (executed by `@guyditor/render`'s compiler using fragments emitted by `CompositorModel.compileKey(clipId)`):

1. Rasterize all `KeyMask`s through the deterministic overlay renderer into grayscale mask assets in `.guyditor/cache/masks/` (white = pass for garbage, white = force-opaque for holdout), cache-keyed by mask JSON + source dimensions (AD-013). Static masks become PNG; masks with `frames` become gray FFV1/MKV.
2. `split` the source into a sharp branch and a key branch.
3. Key branch: `format=yuva444p`; if `preBlur > 0`, `gblur=sigma=<preBlur>:planes=0x6` (chroma planes only).
4. `chromakey=color=0x<RRGGBB>:similarity=<0.01+0.39·tolerance>:blend=<0.4·softness>`, then `alphaextract`.
5. Edge refinement on the alpha stream: `erosion` repeated `erodePx` times; then `gblur=sigma=<0.5·featherPx>` if `featherPx > 0`.
6. Masks: for each garbage mask `[alpha][mask]blend=all_mode=multiply`; for each holdout mask `[alpha][mask]blend=all_mode=lighten`.
7. `alphamerge` the processed alpha onto the sharp branch (`format=yuva444p` first).
8. Spill suppression: mode `despill` (key colors whose dominant channel is green or blue) → `despill=type=<green|blue>:mix=<strength>:expand=<0.5·strength>`. Mode `average` (any dominant channel `k`) → `geq` clamping `k' = min(k, avg2 + (1−strength)·max(0, k − avg2))` where `avg2` is the mean of the other two channels; e.g. for green: `geq=r='r(X,Y)':b='b(X,Y)':a='alpha(X,Y)':g='min(g(X,Y),(r(X,Y)+b(X,Y))/2+(1-0.6)*max(0,g(X,Y)-(r(X,Y)+b(X,Y))/2))'`. A key color with no dominant channel and mode `despill` fails with `E_KEY_UNSUPPORTED_COLOR` suggesting mode `average`.
9. `postColor`: `eq=contrast=<c>:brightness=<from exposure>:saturation=<s>` plus `colortemperature=temperature=<K>` when set.
10. Emit the labeled stream `[keyed_<clipId>]` for the Part 12 graph.

Worked example — `keyColor #1FBF3A, tolerance 0.35, softness 0.12, preBlur 1.5, erodePx 1, featherPx 2, spill despill 0.6, postColor saturation 1.05`, one static garbage mask as input `2:v`:

```
[0:v]split=2[sharp][kb];
[kb]format=yuva444p,gblur=sigma=1.5:planes=0x6,
    chromakey=color=0x1FBF3A:similarity=0.1465:blend=0.048,alphaextract[a0];
[a0]erosion,gblur=sigma=1.0[a1];
[2:v]format=gray[gm];
[a1][gm]blend=all_mode=multiply[a2];
[sharp]format=yuva444p[s0];
[s0][a2]alphamerge[f0];
[f0]despill=type=green:mix=0.60:expand=0.30[f1];
[f1]eq=saturation=1.05[keyed_clp_x]
```

**Preview parity.** The WebGL compositor implements steps 3–9 in one fragment shader pass (blur/erode as separable kernel passes) using the same formulas. Golden-fixture tests (AD-014) render fixture frames through both paths; per-pixel alpha difference MUST be ≤ 2/255 for ≥ 99% of pixels, else CI fails.

### 6.5 Neural matting path (FR-503)

When chroma keying is insufficient (`mode: 'neural'`), matting runs in `workers/mlworker` (AD-003) as task type `matte` (engine `rvm` — RobustVideoMatting, per the Part 1 §1.2 `hello` capability list); absence yields `E_MATTE_CAPABILITY_MISSING`.

```ts
export interface NeuralMatteParams {
  model: 'rvm_mobilenetv3' | 'rvm_resnet50';
  matteAssetId?: string;            // ast_ of the frozen matte, set at acceptance (freezing rule below)
  downsampleRatio: number;          // 0.1..1, default 0.25 for 4K, 0.5 for 1080p
  stabilization: {
    enabled: boolean;               // default true
    alphaMin: number;               // default 0.35
    motionGain: number;             // default 4.0
    minSpeckleArea: number;         // fraction of frame, default 1e-5
  };
}
```

JSON-RPC request (envelope per Part 1 / AD-003):

```json
{ "jsonrpc": "2.0", "id": 41, "method": "matte", "params": {
  "taskId": "job_m4t8k2j5n7",
  "input": { "path": "media/presenter_a.mov", "frames": { "from": 0, "to": 1799 }, "fps": "30000/1001" },
  "params": { "model": "rvm_mobilenetv3", "downsampleRatio": 0.25,
              "stabilization": { "enabled": true, "alphaMin": 0.35, "motionGain": 4.0, "minSpeckleArea": 1e-5 } },
  "output": { "dir": ".guyditor/cache/mattes/", "format": "ffv1-gray-mkv" } } }
```

Output is a grayscale FFV1 MKV alpha sequence in `.guyditor/cache/mattes/`, cache-keyed by source content hash + params + model version (AD-013) — a **pre-acceptance candidate** artifact (freezing rule below). At render time the compiler substitutes steps 3–5 of §6.4 with `[matte]format=gray[a0]` + `alphamerge`; masks, spill suppression, and `postColor` still apply. Jobs run through `JobQueue` (`kind: 'matte'`), progress-reported and cancellable (FR-1003, NFR-100).

**Matte freezing (binding; aligns with Part 12 §12.5 frozen generations).** Neural inference is not bit-reproducible across GPU/driver/model builds, so a matte an accepted clip depends on MUST NOT remain disposable cache. While `mode: 'neural'` is only being auditioned (previews, pending proposals), matte output lives in `.guyditor/cache/mattes/` as above. When the transaction that makes an accepted clip depend on a neural matte is accepted (`clip.key.set` with `mode: 'neural'`, directly or inside a proposal), the engine freezes the candidate matte as an ordinary hashed asset: the MKV is copied to `<project>/assets/mattes/<ast_id>.mkv` (read-only), registered as an asset with `kind: 'generated'` and provenance recording `{ sourceAssetId, sourceSha256, model, params, mlworkerVersion }` (business rule 8, Part 2 §2.5 invariant), and the clip's `KeySettings.neural` records the resulting `matteAssetId`. Part 12's `KeyNodeParams.matteAssetId` references this frozen asset; final render never invokes the matting engine (FR-1002, AD-013), and cache cleanup (Part 13) can never delete a load-bearing matte. Re-running `key.matte.generate` after acceptance produces a new candidate and, on acceptance, a new frozen asset — never an in-place overwrite.

**Temporal stabilization algorithm** (mlworker post-pass; reduces edge shimmer and frame-to-frame transparency flicker):

1. Run RVM inference strictly sequentially within each shot (its recurrent states provide first-order temporal coherence); reset recurrent state at shot boundaries taken from the scene-detection sidecar (Part 3).
2. For each frame `t > 0`, compute motion map `m(x,y)` = mean absolute luma difference between source frames `t` and `t−1` over a 5×5 window, normalized to `[0..1]`.
3. Blend: `out_t = w·raw_t + (1−w)·out_{t−1}` with `w = clamp(alphaMin + motionGain·m, alphaMin, 1)`. Static pixels are smoothed hard; moving pixels track the current frame, avoiding ghosting.
4. Morphological cleanup: remove connected alpha components (foreground or hole) smaller than `minSpeckleArea` × frame area.

### 6.6 Key quality control (FR-504)

**Diagnostic backgrounds.** The preview compositor exposes `diagnosticBackground: 'none' | 'black' | 'white' | 'saturated' | 'checkerboard'` (saturated default `#FF00FF`, configurable; checkerboard 32-px tiles `#666666`/`#999999`). Selecting one replaces every layer below the inspected keyed layer. The equivalent high-quality render is job kind `render.diagnostic` (Part 12), which substitutes a `color=` source or a looped overlay-renderer checkerboard PNG. Available from the key-inspection panel per FR-902/AC-005.

**Automated defect heuristics.** `key.qc.run` queues mlworker task `keyqc.analyze` against the keyed alpha (chroma or neural). Sampling: every 12th frame plus 5 consecutive frames after each shot boundary; per sampled frame, with edge band `E` = pixels where `0.05 < alpha < 0.95`, dilated 2 px:

1. **haloScore** — composite over mid-gray; mean over `E` of `max(0, 1 − D/Dref)` where `D` is the §6.4 chroma distance to the key color and `Dref = similarity + blendW`. Warn > 0.25.
2. **spillScore** — over opaque pixels (`alpha > 0.95`): fraction with hue within ±20° of key hue and saturation > 0.25. Warn > 0.05.
3. **holeCount / holeArea** — connected components with `alpha < 0.5` fully enclosed by the largest foreground component; count components ≥ 1e-4 of frame area, sum their area fraction. Warn on any.
4. **edgeChatter** — mean `|alpha_t − alpha_{t−1}|` over `E`, restricted to pixels whose source motion map (§6.5 step 2) is < 0.05, so genuine movement is not counted. Warn > 0.04.
5. **detailLoss** — `1 − (high-frequency energy of alpha in E) / (high-frequency energy of source luma in E)`, clamped to `[0..1]` (3×3 Laplacian energy). Warn > 0.6 (hair/fine detail destroyed).

```ts
export interface KeyQcMetrics {
  frame: number;         // clip-relative source frame
  haloScore: number; spillScore: number;
  holeCount: number; holeArea: number;
  edgeChatter: number; detailLoss: number;
}
export interface KeyQcReport {
  schema: 'guyditor.keyqc/v1';
  clipId: string; assetId: string;
  keyParamsHash: string;            // SHA-256 of the KeySettings JSON evaluated
  sampledFrames: number[];
  metrics: KeyQcMetrics[];
  warnings: Array<{ code: 'halo'|'spill'|'holes'|'edge_chatter'|'detail_loss';
                    frames: number[]; peak: number; message: string }>;
}
```

The report is written to `sidecars/analysis/<clipId>.keyqc.json` — a derived, regenerable analysis sidecar (FR-004), schema-versioned and hashed (business rule 4). Warnings surface in the key-inspection panel and feed export validation (FR-1004 "known compositing errors"): a render-blocking severity applies when any warning's `peak` exceeds 2× its threshold and the creator has not dismissed it.

### 6.7 Capture guidance (FR-505)

During ingest analysis (Part 3), a quick probe classifies an asset as key-intended when ≥ 30% of sampled frame area lies within `Dref` of a common green/blue key color. For such assets, mlworker task `capture.analyze` computes:

| Warning code | Metric and default threshold |
|---|---|
| `uneven_backdrop` | std of luma > 0.08 or std of hue > 6° within the detected backdrop region |
| `underexposed_subject` | median foreground luma < 0.25 |
| `motion_blur` | on frames with global motion above median, mean gradient magnitude along the subject edge < 0.5× the static-frame baseline |
| `compression_artifacts` | 8×8 block-boundary gradient ratio > 1.3, or encoded bitrate < 0.04 bits/pixel/frame |
| `subject_too_close` | ingest-time spillScore (§6.6.2 with auto-estimated key color) > 0.08 |
| `key_color_wardrobe` | > 2% of foreground pixels within `Dref` of the key color |

```ts
export interface CaptureGuidanceWarning {
  code: 'uneven_backdrop' | 'underexposed_subject' | 'motion_blur'
      | 'compression_artifacts' | 'subject_too_close' | 'key_color_wardrobe';
  severity: 'info' | 'warning';
  evidence: { frames: number[]; metric: number; threshold: number };
  remediation: string;   // human guidance, e.g. "Move ~0.5 m further from the screen"
}
```

Warnings are stored in `sidecars/analysis/<assetId>.capture.json` (`guyditor.capture/v1`) and surfaced immediately at ingest and again in the key-inspection panel, so capture problems are caught before a full session is recorded badly (R-003). The capture-integration contract (FR-009, Part 3) references these codes in its recommended-settings documentation.

### 6.8 Picture-in-picture primitive (FR-506)

PiP is a property block on any `video`/`image`/`animation` layer — a general primitive, not an effect instance:

```ts
export interface ShapeMask {
  shape: 'none' | 'rect' | 'rounded' | 'circle' | 'ellipse';
  cornerRadius?: number;    // 'rounded': 0..0.5, fraction of the shorter box side
  featherPx?: number;
}
export interface PipStyle {
  mask: ShapeMask;
  border?: { widthPx: number; color: string; opacity: number };
  shadow?: { dx: number; dy: number; blurPx: number; color: string; opacity: number };
  background?: { color?: string; blurSigma?: number; padPx?: number };
  deviceFrame?: { templateId: string; params?: Record<string, unknown> }; // tpl_, Part 7
}
export interface PipConfig {
  style: PipStyle;
  placement: ResponsivePlacement;   // §6.9, §6.13
  keyframes: PipKeyframe[];         // §6.11
  avoid?: AvoidSolverConfig;        // §6.12
}
```

Coverage of the FR-506 list: transparent presenter cutouts and full-body layouts = keyed layer with `mask.shape: 'none'`; webcam bubbles = `circle`/`ellipse`; rounded/rect frames = `rounded`/`rect` + `border`; device/monitor frames = `deviceFrame` referencing a Part 7 template whose manifest declares a `pip_frame` slot (content rect, corner radius, and overlay chrome). Backgrounds pad the box behind transparent or letterboxed content.

Rendering: in preview, mask/border/shadow are one SDF fragment shader. For final render, the deterministic overlay renderer rasterizes the *chrome* (shadow, background, border, device frame) as transparent PNG(s) and the *mask* as a gray PNG at target resolution, cache-keyed by style JSON + solved box (AD-013); the compiler emits `shadow PNG overlay → [pip][maskPng]alphamerge-after-multiply → overlay at solved position → chrome PNG overlay`. This keeps FFmpeg free of fragile per-style `geq` expressions.

### 6.9 Placement constraint grammar and solver (FR-507)

Human-readable constraints are the canonical placement representation; solved pixel rects are always derived, never stored (FR-101 spirit, resolution independence).

```
placement    ::= "anchor" ":" anchor-name { constraint }
anchor-name  ::= "top_left" | "top" | "top_right" | "left" | "center"
               | "right" | "bottom_left" | "bottom" | "bottom_right"
constraint   ::= key ":" value
key          ::= "width" | "height" | "margin" | "margin_x" | "margin_y"
               | "offset_x" | "offset_y" | "aspect" | "fit"
value        ::= percent | ratio | fit-mode
percent      ::= number "%"                 ; e.g. "24%"
ratio        ::= integer ":" integer        ; aspect only, e.g. "16:9"
fit-mode     ::= "contain" | "cover" | "stretch"
```

```ts
export type AnchorName = 'top_left'|'top'|'top_right'|'left'|'center'
                       | 'right'|'bottom_left'|'bottom'|'bottom_right';
export interface PlacementConstraints {
  anchor: AnchorName;
  width?: string; height?: string;          // percents
  margin?: string; margin_x?: string; margin_y?: string;
  offset_x?: string; offset_y?: string;
  aspect?: string;                          // 'W:H'; default: source aspect after crop
  fit?: 'contain' | 'cover' | 'stretch';    // default 'contain'
}
export function solvePlacement(
  c: PlacementConstraints, compW: number, compH: number,
): { x: number; y: number; w: number; h: number };     // normalized rect
```

**Percentage bases** (decision, CSS-precedent): `width`, `margin*`, `offset_x` resolve against composition **width**; `height`, `offset_y` against composition **height**. `margin` sets both `margin_x` and `margin_y` from width, so `margin: 4%` gives equal pixel margins on every side at any aspect.

**Solver algorithm:**

1. Parse and validate against the grammar; any unknown key or malformed value fails with `E_PIP_CONSTRAINT` (envelope lists the offending token in `message`, `retry: 'none'`).
2. Resolve target aspect `A`: explicit `aspect`, else the source aspect after `Transform2D.crop`.
3. Resolve size: `width` only → `W = pct·compW`, `H = W/A`. `height` only → `H = pct·compH`, `W = H·A`. Both → treat as a bounding box and apply `fit` (`contain` letterboxes inside, `cover` fills and center-crops, `stretch` distorts). Neither → `width` defaults to `100%` for a fullscreen box with `fit: contain`.
4. Resolve margins/offsets per the percentage bases above.
5. Position from anchor: horizontal — left-family anchors give `x = margin_x`; center-family `x = (compW − W)/2`; right-family `x = compW − W − margin_x`; vertical symmetric with `margin_y`. Add `offset_x`/`offset_y`.
6. Return the normalized rect. At render time Part 12 converts to output pixels, rounding position to the nearest integer and size to the nearest even integer (chroma subsampling); the preview compositor uses the unrounded rect.

**Drag round-trip.** Dragging/resizing in the preview (FR-507, AC-006) writes constraints back, never raw rects: the UI snaps to the nearest anchor whose implied margins are within 1.5% of composition width; if within tolerance it emits `anchor + margin`, otherwise it keeps the nearest anchor and adds `offset_x`/`offset_y`. The `pip.place` transaction summary renders the human string, e.g. *"Place presenter bottom_right, width 24%, margin 4%"*.

### 6.10 Motion presets (FR-508)

Built-in preset names (usable directly in `transition.preset`; creator presets are `pre_` IDs with versions, FR-705): `fade_in`, `fade_out`, `pop_in`, `pop_out`, `scale_in`, `scale_out`, `slide_in`, `slide_out`, `smooth_move`, `expand_fullscreen`, `collapse_fullscreen`, `swap_background`.

```ts
export interface MotionPreset {
  id: string;                 // pre_
  version: number;
  kind: 'entrance' | 'exit' | 'movement' | 'swap';
  defaultDurationFrames: number;
  easing: [number, number, number, number];   // cubic-bezier control points
  params?: { direction?: 'left'|'right'|'up'|'down'; overshoot?: number };  // pop_* overshoot, slide_* direction
}
```

Presets **compile to transform/opacity curves at compile time**; the master file stores only the preset reference, parameters, and anchor — never baked keyframes (readable diffs, R-002). `expand_fullscreen` animates the solved rect to `anchor: center, width: 100%, margin: 0%`; `collapse_fullscreen` is its inverse; `swap_background` runs two synchronized `smooth_move` curves exchanging the PiP rect with the background layer's rect (the background temporarily becomes a PiP box and vice versa), implemented as a coordinated curve pair on both layers. Both render paths evaluate the same curve code (TypeScript module shared via the compiled composition model).

### 6.11 Keyframed movement via semantic anchors (FR-509)

```ts
export type SemanticAnchor = string;   // Part 2 §2.3 grammar
// 'word:w000318' | 'beat:beat_x' | 'clip:clp_x@120' (clip-relative source frames)
// | 'timeline:seq_x@1234' (frames at that sequence's timeline rate — fallback only, per FR-402/FR-102)

export interface PipKeyframe {
  id: string;                       // kfr_
  at: SemanticAnchor;
  placement: PlacementConstraints;  // target state
  style?: Partial<PipStyle>;        // optional style change (e.g. drop border fullscreen)
  transition?: { preset: string; durationFrames: number };  // ends at `at`
}
```

Workflow (AC-006): pause at a frame or word → drag the PiP to the new position → `pip.keyframe.add` with the current review anchor. The transition *ends* at the anchor; its start is `durationFrames` earlier. Between keyframes the placement holds; before the first keyframe the base `placement` applies. Anchor resolution to timeline frames happens at compile time through the word-timing sidecar (Part 4) and clip mapping (Part 5), so upstream edits move the motion with the content (FR-204).

Serialized YAML in `episode.guyditor.yaml` — the FR-509 readability requirement:

```yaml
layers:
  - id: lyr_7kq2m3v9ap
    kind: video
    name: presenter
    pip:
      style:
        mask: { shape: rounded, cornerRadius: 0.08 }
        border: { widthPx: 4, color: "#FFFFFF", opacity: 0.9 }
        shadow: { dx: 0, dy: 8, blurPx: 24, color: "#000000", opacity: 0.35 }
      placement:
        base: { anchor: bottom_right, width: 24%, margin: 4% }
        overrides:
          "9:16": { anchor: top, width: 46%, margin_y: 6% }
      keyframes:
        - id: kfr_9d3n1qv8xw
          at: word:w000318
          placement: { anchor: bottom_left, width: 24%, margin: 4% }
          transition: { preset: smooth_move, durationFrames: 18 }
        - id: kfr_c5p8r2ty0z
          at: word:w000512
          placement: { anchor: center, width: 100%, margin: 0% }
          transition: { preset: expand_fullscreen, durationFrames: 24 }
```

### 6.12 Collision avoidance (FR-510)

```ts
export interface AvoidRegion {
  id: string;                       // avr_
  source: 'caption' | 'face' | 'subject' | 'marked' | 'safe_area' | 'cursor' | 'diagram';
  hardness: 'hard' | 'soft';        // hard = never overlap; soft = penalized
  rect: { x: number; y: number; w: number; h: number };   // normalized
  frames?: { from: number; to: number };                  // sequence frames; omit = always
}
export interface AvoidSolverConfig {
  enabled: boolean;
  sources: Array<AvoidRegion['source']>;
  softOverlapMax: number;           // default 0.15 of PiP area
  holdFrames: number;               // default 60 (hysteresis)
  fallbackAnchors: AnchorName[];    // default: authored anchor, then its ring clockwise
  moveTransition: { preset: string; durationFrames: number };  // default smooth_move/18
}
```

**Region sources:** (1) caption boxes from Part 4's layout engine via the `CaptionLayoutProvider` interface (`getCaptionBoxes(sequenceId, frameRange, aspectClass): AvoidRegion[]`) — computed per displayed caption line, hardness `hard`; (2) faces/subjects from the `subject.track` analysis sidecar `sidecars/analysis/<assetId>.subject.track.json` (`guyditor.analysis/v1`, Part 3 §3.5), mapped from source frames to sequence frames through clip ranges, hardness `soft`; (3) marked UI regions via `region.mark` (stored in the master file; may be created from a Part 8 annotation via `fromAnnotation: ann_x` without conflating review annotations with render inputs, FR-404); (4) platform safe areas from the deliverable's platform profile YAML (Part 11), hardness `hard`; (5) cursor-highlight and diagram regions from Part 3 analysis / Part 7 template bounds, hardness `soft`.

**Solver algorithm** (`pip.avoid.solve`):

1. Collect regions for the configured `sources` over the layer's active range, sampled every frame; merge per frame.
2. Sweep frames in order, tracking the current solved PiP rect. At each frame compute hard-overlap (boolean) and soft-overlap fraction of PiP area.
3. A relocation is required when hard-overlap occurs, or soft-overlap exceeds `softOverlapMax` continuously for 12 frames.
4. Candidates: solve the authored `PlacementConstraints` at each anchor of `fallbackAnchors` (size unchanged). Disqualify any candidate with hard-overlap over the lookahead window (`holdFrames`).
5. Score remaining candidates: `1.0·softOverlapFraction + 0.4·normalizedDistanceFromCurrentRect + 0.2·fallbackIndex`; choose the minimum.
6. Hysteresis: never relocate within `holdFrames` of the previous relocation unless resolving hard-overlap.
7. Emit a `PipKeyframe` per relocation using `moveTransition`, plus a return keyframe when the triggering regions expire (subject again to hysteresis).
8. Package the keyframes as a **proposal** (`prp_`, FR-105) with a summary per relocation (*"Move presenter to bottom_left at word:w000318 to avoid caption overlap"*). Never applied directly to accepted state; the UI previews the proposal live in the WebGL compositor before accept/reject (FR-903), satisfying "always previewable".

The same solver runs synchronously in the UI during dragging to show live overlap warnings (regions outlined; PiP border turns amber on soft, red on hard overlap).

### 6.13 Responsive per-aspect overrides (FR-511)

```ts
export type AspectClass = '16:9' | '9:16' | '1:1' | '4:5';   // extensible via profiles
export interface ResponsivePlacement {
  base: PlacementConstraints;
  overrides?: Partial<Record<AspectClass, Partial<PlacementConstraints>>>;
}
```

Resolution rules:

1. Every deliverable (Part 11) has a target aspect from its platform profile. Its aspect class is the exact match among declared classes, else the nearest by `|log(target/class)|`; a profile MAY pin a class explicitly.
2. Effective constraints = `base` shallow-merged with the matching override. Keyframe `placement`s participate: a keyframe MAY carry its own `overrides` map with the same merge rule; absent that, the keyframe's constraints are used for all aspects (percentages already scale).
3. Because placement is constraint-based, no pixel geometry is stored per aspect — the solver simply runs against the target dimensions (resolution independence, FR-403).

`ResponsivePlacement`, `solvePlacement`, the collision solver, and `AspectClass` are exported from `@guyditor/compositor` and consumed by Part 11's vertical recomposition (FR-803): a vertical deliverable re-solves every layer's constraints and collision pass against 9:16 dimensions and 9:16 safe areas, recomposing separate layers instead of cropping the flattened landscape frame. Every solver output remains manually correctable per deliverable (Part 11 override transactions).

### 6.14 Risk mitigations R-003 and R-004

**R-003 — green-screen quality is insufficient.** Layered defense, each element specified above: capture guidance at ingest catches problems while re-shooting is still cheap (§6.7); the traditional keyer provides tolerance/softness/edge refinement/spill suppression/masks (§6.4); the neural matting path is the documented fallback when chroma keying fails, with temporal stabilization against shimmer (§6.5); temporal and spatial quality checks quantify halo, spill, holes, chatter, and detail loss with diagnostic backgrounds for human confirmation (§6.6); unresolved severe QC warnings block export via FR-1004 wiring (§6.6). Acceptance path: AC-005.

**R-004 — vertical conversion hides important content.** Compositions stay layered with per-aspect constraint overrides so vertical deliverables are *recomposed*, not center-cropped (§6.13); subject/face tracking sidecars and caption boxes become avoid regions so automated placement cannot cover them (§6.12); platform safe areas are hard constraints from versioned profiles (§6.12, Part 11); every automated relocation is a previewable, rejectable proposal, and Part 11 provides per-deliverable manual correction of any solved layout (§6.12–§6.13). Acceptance path: AC-007.

### Part 6 requirements coverage

| BRD ID | Implemented in |
|---|---|
| FR-500 | 6.2 |
| FR-501 | 6.3 |
| FR-502 | 6.4 |
| FR-503 | 6.5 |
| FR-504 | 6.6 |
| FR-505 | 6.7 |
| FR-506 | 6.8 |
| FR-507 | 6.9 |
| FR-508 | 6.10 |
| FR-509 | 6.11 |
| FR-510 | 6.12 |
| FR-511 | 6.13 |
| FR-306 (composition share) | 6.2 (`Transform2D`; retiming/speed owned by Part 5) |
| FR-307 (composition share) | 6.2 (`ColorCorrection`, adjustment layers; looks-as-presets via Part 7) |
| R-003 | 6.4–6.7, 6.14 |
| R-004 | 6.12, 6.13, 6.14 |

---

## Part 7 — Graphics, motion templates, and B-roll adapters

### 7.1 Scope and definitions

This part specifies reusable motion-graphics templates (FR-600), the anchoring of graphics to project semantics (FR-601), agent-driven graphic composition (FR-602), the B-roll source taxonomy (FR-603), the generative-provider adapter interface and two concrete adapters (FR-604), provenance freezing for generated media (FR-605), the mandatory factual/brand review flow (FR-606), rights metadata (NFR-004), and the provider-change mitigations required by R-005.

Terms used below:

- **Template** — a versioned, parameterized package that renders a graphic (title, lower third, diagram, callout, highlight, transition, or motion treatment) deterministically through the overlay renderer (AD-006). ID prefix `tpl_`.
- **Graphic instance** — one placement of a template in a project: template + pinned version + parameter values + anchor + duration. ID prefix `gfx_` (new prefix introduced by this part; registered alongside the Part 0 prefixes). Graphic instances live on layers of type `text` or `animation` (Part 6 layer model) and are serialized in the master file, not in sidecars.
- **Generated asset** — media produced by a generative provider and frozen as an ordinary asset (`ast_`) before acceptance (business rule 8).
- **Adapter** — a pluggable provider integration (`adp_`) registered in the `AdapterRegistry` service (`@guyditor/agent`).

Code homes: template loading, sandboxing, and the overlay render contract live in `@guyditor/render`; graphic-instance schema and operations in `@guyditor/core`; adapters, generation jobs, and provenance in `@guyditor/agent`; asset freezing and hashing reuse `@guyditor/media`.

### 7.2 Template package format (FR-600)

A template is a directory:

```
lower-third-brand/
  template.yaml        # manifest (below)
  render.ts            # deterministic render entry (§7.3)
  preview.png          # static preview thumbnail, 640×360
  fonts/               # optional bundled font files (woff2/ttf)
  assets/              # optional static images used by render.ts
```

`template.yaml` manifest:

```yaml
schema: guyditor/template/v1
id: tpl_k3m9a2c7de          # immutable, assigned at creation
name: Brand lower third
kind: lower_third            # title | lower_third | diagram | callout | highlight | transition | motion
version: 1.2.0               # semver; a published version is immutable
engine: overlay/v1           # overlay renderer contract version (AD-006)
entry: render.ts
min_guyditor: "1.0.0"
duration:
  mode: param                # fixed | param | intrinsic | anchor_span
  default: { frames: 90, fps: "30/1" }
params:                      # JSON Schema (draft 2020-12) for instance params
  type: object
  required: [title]
  properties:
    title:    { type: string, maxLength: 60 }
    subtitle: { type: string, maxLength: 80 }
    accent:   { type: string, pattern: "^#[0-9a-fA-F]{6}$", default: "#ff5a1f" }
    position: { enum: [bottom_left, bottom_right, top_left], default: bottom_left }
preview:
  file: preview.png
  params: { title: "Jane Doe", subtitle: "Example Corp" }   # params used to render preview
fonts:
  - { family: "Inter", file: fonts/Inter-Bold.woff2, weight: 700 }
safe_area_aware: true        # template honors platform-profile safe areas passed in context
```

Rules:

1. `id` is immutable; `version` follows semver. The pair `(id, version)` identifies exact template content; Guyditor computes a SHA-256 over the canonicalized package contents (`contentHash`) at install time and records it wherever the version is pinned.
2. **Library locations** (decision made here): built-in templates ship inside `packages/render/templates/`; the creator's library lives in `~/.guyditor/templates/<tpl_id>/<version>/`; a project MAY vendor templates under `<project>/templates/` (project-local copies win over the user library for the same `(id, version)`). Installing a template (`template.install`, §7.6) copies the package into the user library; installed versions are never edited in place — editing produces a new version.
3. `params` MUST be a self-contained JSON Schema. The `OperationEngine` validates instance params against it on every `graphic.add` / `graphic.param.set`; invalid params are rejected with the Part 0 error envelope (`code: "E_TEMPLATE_PARAMS_INVALID"`).
4. `kind: transition` templates are referenced by `transition.set` (Part 5/6); they receive a `progress` value (§7.3) instead of owning a timeline duration.
5. Caption *presets* (`pre_`, Part 4) are not templates; templates never carry caption styling authority.

### 7.3 Template render contract and determinism (FR-600, FR-602, AD-006)

`render.ts` default-exports a `TemplateModule`. It is compiled with esbuild at install time (output cached in `~/.guyditor/templates/.compiled/<contentHash>.js`) and executed inside a `node:vm` isolated context with **only** the injected context object: no `fetch`, no filesystem, no timers, `Date` and `Math.random` replaced by throwing stubs. This is the mechanism that makes text rendering deterministic and provider-free (FR-602, AD-006).

```ts
// @guyditor/render — public template contract (engine overlay/v1)
export interface TemplateModule<P = Record<string, unknown>> {
  /** Draw exactly one frame. MUST be a pure function of its arguments. */
  render(ctx: TemplateRenderContext, params: P): void;
  /** Optional intrinsic duration (duration.mode: intrinsic). Pure. */
  duration?(params: P, media: TemplateStaticContext): DurationSpec;
}

export interface TemplateRenderContext {
  canvas: OverlayCanvas2D;      // deterministic subset of CanvasRenderingContext2D
  frame: number;                // 0-based frame index within the instance
  totalFrames: number;          // resolved instance duration in frames
  fps: string;                  // "num/den" — Part 0 time model
  width: number; height: number;            // output pixels for the current deliverable
  safeArea: { top: number; right: number; bottom: number; left: number }; // px, from platform profile
  progress: number;             // frame / (totalFrames - 1); for kind=transition this is the wipe progress
  fonts: ResolvedFontMap;       // families declared in manifest, loaded and measured deterministically
  brand: BrandContext;          // resolved brand palette/logo refs from the active brand skill (Part 9)
  rng: SeededRng;               // xoshiro128**, seeded from GraphicInstance.seed — the only randomness allowed
  staticAssets: (name: string) => OverlayImage;  // decoded images from the package assets/ dir only
}

export interface TemplateStaticContext { width: number; height: number; fps: string; }
export type DurationSpec =
  | { mode: 'fixed'; frames: number; fps: string }
  | { mode: 'intrinsic' }
  | { mode: 'anchor_span' };    // spans the resolved anchor range (§7.5)
```

Determinism rules (extend AD-013):

1. Same `(templateId, version, contentHash, params, seed, frame, width, height, fps, safeArea, brand)` MUST produce a byte-identical frame. Golden-frame tests (AD-014) enforce this per built-in template.
2. Fonts are resolved only from the package `fonts/` list or the brand skill's declared font assets; system font fallback is forbidden (it breaks cross-machine reproducibility, NFR-108).
3. The render cache key for an overlay segment is `hash(templateContentHash, canonicalParams, seed, frameRange, outputGeometry, brandHash)` (FR-1001).
4. At final render, `RenderService` invokes the same compiled module per frame to produce a transparent overlay asset that the FFmpeg filtergraph composites (AD-006). Preview uses the identical module in the renderer process WebGL path (AD-005); there is no second implementation.

### 7.4 Template versioning and project pinning (FR-600, FR-705, R-005)

The master file carries a pin table; every graphic instance references it implicitly through its `templateId`:

```yaml
templates:
  tpl_k3m9a2c7de: { version: "1.2.0", contentHash: "sha256:9f31…" }
```

1. `graphic.add` with an unpinned template pins the currently installed latest version.
2. All rendering resolves through the pin; a newer installed version never changes an existing project's output.
3. `template.pin` (risk class `consequential`) changes the pinned version; the proposal diff lists every affected `gfx_` instance and the preview shows before/after (FR-105, FR-108-style comparison).
4. If a pinned `(version, contentHash)` is absent from all libraries, validation reports `E_TEMPLATE_MISSING_VERSION` (export-blocking, FR-1004); the creator may reinstall from backup (NFR-106 covers `~/.guyditor/templates/`) or explicitly re-pin.

### 7.5 Graphic instances and anchoring (FR-601)

```ts
// @guyditor/core
export interface GraphicInstance {
  id: string;                    // gfx_
  templateId: string;            // tpl_ — version comes from the project pin table
  layerId: string;               // lyr_ (layer type text | animation)
  anchor: AnchorPoint;           // where the graphic starts
  duration: GraphicDuration;
  params: Record<string, unknown>;   // validated against the template's param schema
  seed: number;                  // uint32, assigned once at creation; drives ctx.rng
  transform?: LayerTransform;    // optional Part 6 transform override (position/scale/opacity)
}

export type AnchorPoint =                      // serialized string forms follow the Part 2 grammar
  | { kind: 'word'; wordId: string; edge: 'start' | 'end' }        // "word:w000042" (edge start), "word:w000042#end"
  | { kind: 'beat'; beatId: string; edge: 'start' | 'end' }        // "beat:beat_x"
  | { kind: 'clip'; clipId: string; offset: FrameTime }            // "clip:clp_x@{frames}" — offset in clip source frames
  | { kind: 'annotation'; annotationId: string }                   // "ann:ann_x" — resolves to the annotation's own anchor
  | { kind: 'timeline'; sequenceId: string; offset: FrameTime };   // "timeline:seq_x@{frames}" — last resort (FR-402 analog)

export type GraphicDuration =
  | { kind: 'fixed'; length: FrameTime }
  | { kind: 'untilAnchor'; end: AnchorPoint }     // e.g. highlight from word A to word B
  | { kind: 'intrinsic' };                        // template's duration() decides
```

`FrameTime` is the Part 0/Part 2 `{ frames: <int>, fps: "<num>/<den>" }` structure. Semantic anchors are preferred; `timeline:` anchors are permitted only when no stable alternative exists and are flagged in the semantic diff.

**Serialization.** `GraphicInstance` is the typed in-memory view, not a second on-disk schema: an instance is stored in the master file as a Part 2 §2.4 `PlacedItem` in its owning layer's `items` list. Mapping: `id` (`gfx_` prefix), `templateId` → `template` (version resolved through the §7.4 pin table), `anchor` → `at` (the serialized string forms shown above), `duration` → `duration` (`fixed` → `FrameTime`, `untilAnchor` → `{ until: <anchor> }`, `intrinsic` → `'intrinsic'`), `params` → `params`, `seed` → `seed`; the optional `transform` override serializes as an `Effect` of kind `'transform'` on the item; `layerId` is implied by containment and never stored.

**Anchor resolution algorithm** (run by the composition compiler each time a preview or render is built; results are derived, never stored — FR-101):

1. Resolve the anchor to a **source position**: `word` → word timing from the alignment sidecar (Part 4) → owning asset + source frame; `beat` → the beat's stored anchor (recursively resolved); `clip` → clip's source in-point + offset; `annotation` → the annotation's anchor via `AnnotationService`; `timeline` → sequence-relative frame directly.
2. Map source position → timeline time through the current clip layout (Part 2 derivation). If the source position falls inside a removed range, the containing clip was deleted, or the word no longer appears in any placed clip, mark the instance **orphaned**.
3. Resolve duration: `fixed` → convert via exact rational arithmetic to the sequence rate; `untilAnchor` → resolve the end anchor by steps 1–2 and take the span (error `E_GRAPHIC_NEGATIVE_SPAN` if end precedes start); `intrinsic` → call `TemplateModule.duration()`.
4. Clamp to the deliverable's timeline extent; a fully clipped-out instance renders nothing but stays in the project.
5. Orphaned instances are never silently dropped: they appear in the validation report (`E_GRAPHIC_ORPHANED_ANCHOR`, export-blocking per FR-1004 unless the creator marks the instance disabled) and in the timeline UI as detached badges.

### 7.6 Agent-generated composition operations (FR-602)

Graphics are created **only** through catalogued semantic operations (AD-009); neither the agent nor the UI writes graphic YAML directly. This part contributes the following entries to the Part 5 operation catalog (each with JSON-Schema params, summary template, inverse metadata, and risk class per the Part 0 grammar):

| Operation | Parameters (summary) | Inverse | Risk |
|---|---|---|---|
| `graphic.add` | `templateId, layerId?, anchor, duration, params, seed?` (layer auto-created if omitted) | `graphic.remove` | normal |
| `graphic.param.set` | `graphicId, patch` (RFC 7386 merge patch on params) | reverse patch | low |
| `graphic.anchor.set` | `graphicId, anchor` | prior anchor | normal |
| `graphic.retime` | `graphicId, duration` | prior duration | normal |
| `graphic.remove` | `graphicId` | `graphic.add` snapshot | normal |
| `template.install` | `packagePath \| builtinName` → library copy + contentHash | uninstall | low |
| `template.pin` | `templateId, version` | prior pin | consequential |
| `generation.request` | §7.8 `GenerationRequest` | none (job, not project state) | normal, **cost-gated** |
| `generation.accept` | `candidateId, rightsConfirmation` | none (creates immutable asset) | consequential |
| `generation.reject` | `candidateId, reason?` | none | low |
| `asset.rights.set` | `assetId, rights` (§7.12) | prior rights | low |

Rules:

1. **All glyph text in output video is rendered programmatically** by the overlay renderer via template params (FR-602). Generative providers are never asked to spell text: `generation.request` runs a prompt lint that warns (`E_GENERATION_TEXT_IN_PROMPT`) when the prompt appears to request rendered words (quoted strings combined with tokens like *text, caption, sign, label, says*). The warning is surfaced in the proposal; it does not block, because the heuristic is fallible — but the FR-606 checklist (§7.11) includes a mandatory text-artifact check.
2. Summary templates keep diffs semantic (BR-006), e.g. `graphic.add` → “Add {template.name} ‘{params.title}’ at {anchor}”.
3. Agent-created graphics follow the proposal flow (FR-105): they exist in `proposals/` until accepted; preview renders compile the proposal state.

### 7.7 B-roll source taxonomy (FR-603)

Every B-roll source class enters the project as an ordinary asset (`ast_`) via the FR-002 ingest path in `MediaEngine` (hash, metadata, immutable source), differing only in provenance `origin` and rights defaults:

| # | Source class | Entry path | `origin` (§7.12) | Rights default |
|---|---|---|---|---|
| 1 | Existing local footage | Standard ingest / `CaptureWatcher` watch folder | `captured` | creator-owned; no prompt |
| 2 | Licensed stock or downloaded assets | Standard ingest; ingest UI/agent prompts for rights metadata | `licensed` | **missing until entered** → NFR-004 warning |
| 3 | Still images and illustrations | Standard ingest | `licensed` or `captured` (creator selects) | as selected |
| 4 | Screen captures | `CaptureWatcher` or manual ingest | `captured` | creator-owned |
| 5 | Programmatic animations | Not an asset: a `GraphicInstance` (§7.5). If exported to media (e.g. for interchange), the export is frozen as an asset with `origin: programmatic` and provenance recording `(templateId, version, params hash, seed)` | `programmatic` | creator-owned |
| 6 | External generative providers | Adapter flow §7.8–§7.10 | `generated` | provider terms captured in provenance |
| 7 | Future local generation models | Local adapter (e.g. `adp_comfyui`, §7.9) through the same interface and freezing rules | `generated` | creator-owned output, model license recorded |

Classes 6 and 7 are the only paths that touch the adapter machinery; everything upstream of freezing is identical between remote and local generation, which is what keeps the canonical edit provider-independent (R-005).

### 7.8 Provider adapter interface (FR-604)

Adapters live in `@guyditor/agent`, register with `AdapterRegistry`, and are driven exclusively through `JobQueue` jobs of kind `broll.generate` (AD-010). Adapter configuration (non-secret) lives in `~/.guyditor/adapters/<adapterId>/manifest.json` (the Part 1 §1.12 layout); credentials go to the OS keychain keyed by adapter ID (AD-011) and are referenced as `apiKeyRef`.

```ts
// @guyditor/agent — public adapter contract
export interface BrollProviderAdapter {
  readonly descriptor: AdapterDescriptor;
  /** Part 9 CostMeter hook: called BEFORE submit; budget caps enforced on the estimate (NFR-006). */
  estimateCost(req: GenerationRequest): Promise<CostEstimate>;
  submit(req: GenerationRequest, signal: AbortSignal): Promise<AdapterJobHandle>;
  poll(handle: AdapterJobHandle): Promise<AdapterJobStatus>;
  /** Download outputs into destDir; called once poll reports 'succeeded'. */
  fetchResult(handle: AdapterJobHandle, destDir: string): Promise<GenerationResult>;
  cancel?(handle: AdapterJobHandle): Promise<void>;
  quota?(): Promise<QuotaInfo>;
}

export interface AdapterDescriptor {
  adapterId: string;              // adp_
  adapterVersion: string;         // semver of the adapter implementation (recorded in provenance, R-005)
  displayName: string;
  provider: string;               // e.g. "openai-compatible", "comfyui"
  local: boolean;                 // true → no external data transfer (NFR-001 labeling)
  modes: Array<'image' | 'video'>;
  models: Array<{ id: string; mode: 'image' | 'video'; maxWidth: number; maxHeight: number;
                  maxDurationSec?: number; supportsSeed: boolean }>;
  requestSchema: object;          // JSON Schema for GenerationRequest.providerSettings
  dataClassesSent: DataClass[];   // Part 1 §1.8 closed enum ('frames' for still images) — NFR-001/NFR-007 audit labels
  maxConcurrent: number;
}

export interface GenerationRequest {
  requestId: string;              // ulid, unique per submission
  mode: 'image' | 'video';
  model: string;
  prompt: string;
  negativePrompt?: string;
  referenceAssetIds?: string[];   // sending these is an external media transfer → NFR-002 consent gate
  width: number; height: number;
  durationFrames?: number; fps?: string;      // video mode; Part 0 time model
  seed?: number;
  count: number;                  // candidates requested (1..4)
  providerSettings: Record<string, unknown>;  // validated against descriptor.requestSchema
}

export interface AdapterJobHandle { adapterId: string; providerJobId: string; opaque?: string; }  // persisted for crash resume (NFR-103)
export type AdapterJobStatus =
  | { state: 'queued' | 'running'; progress?: number; etaSeconds?: number }
  | { state: 'succeeded' }
  | { state: 'failed'; error: string; retry: 'safe' | 'unsafe' | 'none' };

export interface GenerationResult {
  outputs: Array<{ filePath: string; mime: string; width: number; height: number;
                   durationSeconds?: number; seed?: number; providerMetadata: Record<string, unknown>;
                   rights?: Partial<RightsMetadata> }>;   // provider-supplied usage terms if any
  rawResponseRef: string;         // path of the stored raw provider response (audit evidence, NFR-007)
}

// CostEstimate is the single schema defined in Part 9 §9.12 and re-exported here:
// { adapterId, currency, amount, units, confidence: 'quote' | 'pricebook' | 'heuristic' }.
export interface QuotaInfo { remainingRequests?: number; ratePerMinute?: number; resetAt?: string; }
```

**Generation job algorithm** (`JobQueue` kind `broll.generate`):

1. Validate `providerSettings` against `descriptor.requestSchema`; record the schema's hash for drift detection (R-005).
2. Call `estimateCost`; `CostMeter` checks task/episode/lifetime budgets and warns or blocks per creator thresholds before anything is sent (NFR-006).
3. If `referenceAssetIds` is non-empty and the adapter is not `local`, require the NFR-002 external-media consent gate.
4. `submit`; persist the `AdapterJobHandle` in the job row so a crash resumes at `poll` (NFR-103).
5. `poll` with exponential backoff (2 s → 30 s cap), honoring `QuotaInfo` for throttling; map provider errors to the Part 0 error envelope with `acceptedStateChanged: false`.
6. On success, `fetchResult` into `.guyditor/cache/generations/<job_id>/`; immediately run the freezing pre-steps of §7.10.
7. Write the full external-call record (provider, data classes sent, units, actual cost, outcome) to `AuditLog`; reconcile actual cost against the estimate in `CostMeter` (Part 9).

### 7.9 Concrete adapters (FR-604)

**`adp_httpgen` — generic HTTP generation adapter (required usable path).** OpenAI-compatible wire shapes with a configurable endpoint, so any conforming service or self-hosted gateway works without new code:

```jsonc
// ~/.guyditor/adapters/adp_httpgen/manifest.json (Part 1 §1.12)
{
  "adapterId": "adp_httpgen",
  "baseUrl": "https://api.example.com/v1",
  "apiKeyRef": "keychain:adp_httpgen",             // AD-011; never stored here
  "paths": {                                        // overridable path templates
    "imageGenerate": "/images/generations",         // sync: POST {model,prompt,n,size,response_format:"b64_json"}
    "videoCreate": "/videos",                       // async: POST → {id,status}
    "videoStatus": "/videos/{id}",                  // GET → {status: queued|in_progress|completed|failed, progress}
    "videoContent": "/videos/{id}/content"          // GET → binary download
  },
  "pricing": {                                      // drives estimateCost (confidence: "pricebook")
    "imagePerOutput": { "1024x1024": 0.04 },
    "videoPerSecond": { "default": 0.35 },
    "currency": "USD"
  },
  "models": [ { "id": "gpt-image-1", "mode": "image" }, { "id": "sora-2", "mode": "video" } ]
}
```

Behavior: image mode is synchronous (`submit` performs the POST, `poll` returns `succeeded` immediately, `fetchResult` decodes `b64_json` payloads); video mode maps `submit → videoCreate`, `poll → videoStatus`, `fetchResult → videoContent`. Auth is `Authorization: Bearer <key>`. `dataClassesSent: ["prompt","metadata"]` plus `"image"` when reference images are attached. This adapter MUST ship functional in the Priority D milestone (M4) as the FR-604 “at least one usable generation path”.

**`adp_comfyui` — local ComfyUI adapter (outline for future local generation).** `local: true`, `baseUrl` default `http://127.0.0.1:8188`. Config carries named **workflow templates**: ComfyUI API-format JSON graphs with declared injection points (`$prompt`, `$negative`, `$seed`, `$width`, `$height`, `$frames`). `submit` injects request values and POSTs to `/prompt`; `poll` reads `/history/{prompt_id}`; `fetchResult` downloads node outputs via `/view`. `estimateCost` returns `{ adapterId: 'adp_comfyui', currency: 'USD', amount: 0, units: { localCompute: 1 }, confidence: 'quote' }`; `CostMeter` still logs the run for the audit trail. Capability probing at registration (`GET /system_stats`) feeds hardware adaptation (NFR-101). Implementation may lag `adp_httpgen`, but the interface conformance tests (AD-014) run against a mocked ComfyUI from day one so the contract cannot drift.

### 7.10 Generation lifecycle and provenance freezing (FR-605, FR-107)

Candidates are **not** project assets. The freeze happens exactly once, at acceptance:

1. After `fetchResult`, for each output file: compute SHA-256; write a **provisional provenance record** beside it in `.guyditor/cache/generations/<job_id>/`; register the file as a candidate (`candidateId = <job_id>/<n>`) visible in the review UI. Nothing is written to accepted project state.
2. The FR-606 review annotation is created per candidate (§7.11).
3. `generation.accept` (consequential) runs atomically: verify the review annotation is `resolved` with all required checklist items completed; re-hash the file and compare with step 1 (abort with `E_GENERATION_HASH_MISMATCH` on drift); copy the file to `<project>/media/generated/<ast_id>.<ext>` (the Part 2 §2.1 location; chmod read-only); write the final provenance sidecar to `sidecars/provenance/<ast_id>.provenance.json` and register it in the master's `sidecars` list (Part 2 §2.8); add the asset entry with its file hash and `provenance.sidecar` naming that registry entry. Only then may clips reference the asset.
4. `generation.reject` deletes nothing immediately; rejected candidates persist in cache until normal cache cleanup (NFR-102) and remain listed in the audit log.
5. **Regeneration is never silent** (FR-107, business rule 8): a repeat `generation.request` — even with identical parameters — always yields new candidates and, on acceptance, a new `ast_`; swapping usages is a separate reviewable operation with its own diff. `RenderService` MUST NOT call any adapter: if a frozen generated asset's file is missing at render time, the render fails with the standard missing-asset error and the FR-007 relink flow, never regeneration.

Provenance sidecar schema (`sidecars/provenance/<ast_id>.provenance.json`, hashed and referenced from the master file per AD-007):

```jsonc
{
  "schema": "guyditor.provenance/v1",
  "assetId": "ast_7fq2m8b3kd",
  "generation": {
    "adapterId": "adp_httpgen",
    "adapterVersion": "1.0.3",
    "provider": "openai-compatible",
    "endpoint": "https://api.example.com/v1",
    "model": "sora-2",
    "prompt": "slow aerial dolly over a foggy pine forest at dawn, cinematic",
    "negativePrompt": null,
    "settings": { "width": 1920, "height": 1080, "durationFrames": 240, "fps": "24/1" },
    "settingsSchemaHash": "sha256:11ab…",
    "seed": 771204633,
    "requestId": "01J9ZK8Q2E…",
    "jobId": "job_p2n8d4x1aa",
    "referenceAssetIds": [],
    "createdAt": "2026-07-17T14:03:22Z"
  },
  "rights": { "origin": "generated", "licensor": "Example API", "providerTermsUrl": "https://example.com/terms",
              "restrictions": [], "confirmedBy": "creator", "confirmedAt": "2026-07-17T14:10:01Z" },
  "reviewAnnotationId": "ann_x93kd02mfa",
  "contentHash": "sha256:5be0…"
}
```

`GenerationProvenance` is the TypeScript mirror of this schema in `@guyditor/core`. Reproducibility (FR-107/AC-009): a revision is rebuilt from the frozen asset file itself — provenance documents *how it was made* but replaying generation is never part of a rebuild.

### 7.11 Factual and brand review flow (FR-606)

Before any generated or externally sourced B-roll can be accepted, `AnnotationService` auto-creates an annotation of type `generation-review` (`ann_`, standard FR-406 lifecycle) attached to the candidate, carrying a checklist:

```ts
export interface GenerationReviewChecklist {
  schema: 'guyditor/genreview/v1';
  items: Array<{
    id: string;                       // stable slug
    label: string;
    required: boolean;
    state: 'pending' | 'pass' | 'fail' | 'not_applicable';
    note?: string;
    agentObservation?: string;        // agent-supplied evidence; advisory only
  }>;
}
```

Default items (creator-extensible through a `SkillRegistry` brand-review skill, versioned per FR-705): `factual-relevance` (required), `research-accuracy` (required), `brand-fit` (required), `visual-artifacts` (required), `text-artifacts` — no unintended rendered text/gibberish glyphs (required; complements §7.6 rule 1), `unintended-implications` (required), `rights-confirmed` (required; links to §7.12).

Rules:

1. `generation.accept` has the hard precondition: review annotation `resolved` and every `required` item is `pass` or `not_applicable` with a note. Enforced in `OperationEngine`; violation returns `E_GENERATION_REVIEW_INCOMPLETE`.
2. The agent MAY fill `agentObservation` fields (e.g. flagging a warped hand) but MUST NOT set item states or resolve the annotation: **visual plausibility is not factual verification** (FR-606), so checklist completion is a human action and is excluded from the low-risk automation policy (business rule 5).
3. A `fail` on any required item keeps acceptance blocked; the creator either rejects the candidate or edits/regenerates.
4. The resolved checklist is stored in the annotation record and referenced from provenance (`reviewAnnotationId`), giving each frozen asset a durable review trail (FR-104-style traceability).
5. The same flow applies to creator-supplied stock B-roll when the active brand-review skill sets `applyToLicensedImports: true`; otherwise stock imports only trigger the rights capture of §7.12.

### 7.12 Rights metadata and missing-rights warnings (NFR-004)

```ts
// @guyditor/core — stored per asset in the master file's asset entry
export interface RightsMetadata {
  origin: 'captured' | 'licensed' | 'stock' | 'generated' | 'programmatic' | 'unknown';
  licenseName?: string;         // e.g. "CC-BY-4.0", "Envato Standard"
  licenseUrl?: string;
  licensor?: string;
  purchaseRef?: string;         // order/invoice id for licensed assets
  restrictions: string[];       // e.g. "attribution-required", "no-commercial", "single-project"
  attributionText?: string;
  providerTermsUrl?: string;    // generated assets
  confirmedBy?: 'creator' | 'provider';
  confirmedAt?: string;         // ISO 8601
}
```

1. Ingest defaults `origin` per the §7.7 table; anything the system cannot classify is `unknown`.
2. `asset.rights.set` is the only mutation path; changes are transactions like any other edit (FR-104).
3. A **rights policy** (part of the creator's skills, default shipped) declares which origins require which fields, e.g. `licensed|stock → licenseName + licensor required`, `generated → providerTermsUrl + confirmedBy required`.
4. **Warnings**: the UI shows a rights badge on non-compliant assets; export validation (FR-1004, Part 12) emits a `E_RIGHTS_MISSING` warning per non-compliant asset actually used by the deliverable, listing asset ID and missing fields. Default severity is warning (export proceeds); the rights policy may escalate to `block`. Attribution-required assets add their `attributionText` to the deliverable's publish-metadata draft (FR-809, Part 11).

### 7.13 Provider-change resilience (R-005)

The R-005 mitigations, consolidated:

1. **Frozen assets** (§7.10): a provider changing models, pricing, or shutting down cannot alter any accepted edit or render — renders read only local frozen files.
2. **Canonical edit is provider-free**: composition semantics reference only `ast_`/`gfx_`/`tpl_` IDs. Adapter identifiers appear solely in provenance sidecars and the audit log, so removing an adapter never invalidates a project.
3. **Adapter versioning**: `adapterVersion` and `settingsSchemaHash` are recorded per generation; a provider API change ships as a new adapter version, and stale recorded schemas make behavioral drift detectable rather than silent.
4. **Interface, not integration**: all providers — remote or local — sit behind `BrollProviderAdapter`; adding a provider is config plus at most one adapter module, with conformance tests (AD-014) shared across adapters.
5. **Templates are local and pinned** (§7.4): programmatic graphics never depend on any provider, and version pins keep past projects stable against template evolution — the same independence principle applied to Guyditor's own artifacts.

### Part 7 requirements coverage

| BRD ID | Implemented in |
|---|---|
| FR-600 | §7.2 (package format), §7.3 (render contract), §7.4 (versioning and pinning) |
| FR-601 | §7.5 (anchor grammar, resolution algorithm, orphan handling) |
| FR-602 | §7.3 (deterministic text rendering), §7.6 (catalogued operations, prompt lint) |
| FR-603 | §7.7 (source taxonomy and per-class ingest paths) |
| FR-604 | §7.8 (adapter interface, job algorithm, cost hook), §7.9 (`adp_httpgen`, `adp_comfyui`) |
| FR-605 | §7.10 (freezing algorithm, provenance sidecar schema, no silent regeneration) |
| FR-606 | §7.11 (generation-review annotation and checklist gating acceptance) |
| NFR-004 | §7.12 (RightsMetadata, rights policy, missing-rights warnings), §7.7 (defaults) |
| R-005 | §7.13 (consolidated mitigations), §7.4, §7.8 (adapter/schema versioning), §7.10 (frozen assets) |

---

## Part 8 — Frame-accurate review and annotations

This part specifies the review subsystem: frame-accurate pause and scrub on proxy preview (FR-400), the annotation data model (FR-401), stable anchors (FR-402), resolution-independent coordinates (FR-403), the review-annotation / renderable-overlay boundary and conversion (FR-404), the agent context package (FR-405), and the annotation lifecycle (FR-406). Owning service: `AnnotationService` (main process), with preview behavior implemented by the renderer's `PreviewController` and agent access via the `AgentGateway` (AD-009). All annotation mutations are semantic operations executed by the `OperationEngine` (operation catalog additions are listed in 8.8.4 and registered in Part 5's catalog).

**Terms used below.** *Review position*: the paused playhead, expressed as a timeline frame of the active sequence plus the resolved per-layer source frames. *Canvas*: the composition raster of a sequence or deliverable (e.g. 16:9 for the long-form master, 9:16 for a Short); Part 6 owns canvas definition. *SourceTime*: `{ frames: <int>, fps: "<num>/<den>" }` per Part 0. *Word ID*: `w`-prefixed transcript word identity per Part 0 / Part 4.

### 8.1 Storage layout and master-file linkage

Annotations are accepted project state (FR-100 lists "annotations and their status" among master-file content), but individual records can be large (freehand paths), so they live in a sidecar per AD-007:

- `sidecars/annotations.yaml`, schema `guyditor.annotations/v1`, one document containing `annotations: [ ... ]` ordered by creation. Referenced from the master file's `sidecars:` list with relative path + SHA-256 (FR-103).
- The master file's `annotations:` section stores only the sidecar reference and a state-count summary, keeping master diffs small (FR-101):

```yaml
annotations:
  sidecar: annotations                 # registry name; path + hash live in the sidecars section (Part 2 §2.8)
  summary: { open: 2, resolved: 11, rejected: 1, reopened: 0 }
```

Annotation state changes are semantic operations recorded in `history/transactions.jsonl` like any other edit (AD-008). Agent context packages (8.7) are disposable derived artifacts under `.guyditor/cache/annctx/` and are never load-bearing.

### 8.2 Frame-accurate pause and scrub (FR-400)

#### 8.2.1 Proxy contract required for exact seeking

Part 3 generates proxies; Part 8 imposes these binding constraints on the proxy profile so that browser-video seeking can be made frame-exact:

1. Constant frame rate identical to the (CFR-normalized) source asset rate.
2. Closed GOPs, keyframe interval ≤ min(30 frames, 1 second).
3. `+faststart` (moov atom leading) so seeks never stall on trailing metadata.
4. Proxy timestamps start at 0; frame `k` of the proxy is frame `k` of the normalized source.

With this contract, source frame `k` at rate `fps` is presented during `[k/fps, (k+1)/fps)` of proxy media time.

#### 8.2.2 Exact-seek algorithm (per proxy `<video>` element)

The renderer composites per-layer proxies in WebGL driven by `requestVideoFrameCallback` (rVFC, AD-005). To display timeline frame `F`, `PreviewController` resolves, per visible layer, the layer's source frame `k` via Part 2's timeline↔source mapping, then for each layer's video element:

1. Compute the frame-center seek target `t = (k + 0.5) / fps` (exact rational, converted to seconds only at the DOM boundary). Frame-center targets avoid boundary rounding in browser demuxers.
2. Set `video.currentTime = t`. Mark the element `inFlight`.
3. On the next rVFC after `seeked`, read `metadata.mediaTime` and compute `presented = round(mediaTime * fps)`.
4. If `presented === k`, the layer is settled: hand the frame to the compositor.
5. If `presented !== k`, issue a corrective seek to `(k + 0.5 ± 0.25) / fps` (nudged toward the miss direction). Retry at most 3 times; after the third failure emit structured error `{ code: "E_SEEK_UNVERIFIED", affected: [assetId], acceptedStateChanged: false, retry: "safe", suggestion: "Regenerate the proxy for this asset" }` and display the nearest verified frame with a warning badge.

The preview reports **settled** only when every visible video layer has verified its exact frame; annotation creation (8.3) and context-package frame grabs (8.7) are only permitted at a settled position, guaranteeing that what the creator marks is the frame the project model says it is.

#### 8.2.3 Frame-step and scrub coalescing

- **Frame-step**: `stepFrames(delta)` sets target timeline frame `F' = clamp(F + delta, 0, seqDuration − 1)` and runs 8.2.2. UI bindings (Part 10): arrow keys ±1 frame, Shift+arrow ±10, comma/period ±1 while paused.
- **Scrub coalescing**: during drag, `PreviewController` keeps a single `targetFrame` per element (latest wins). At most one seek is in flight per element; when `seeked` fires, if the element's presented frame no longer matches the *current* `targetFrame`, seek again immediately. The timeline cursor and timecode display track `targetFrame` instantly; video settles behind it. Exact verification (steps 3–5 above) runs only once dragging stops.

#### 8.2.4 Scrub-to-word

`seekToWord(wordId)`:

1. `TranscriptEngine.wordTiming(wordId)` → `{ assetId, start: SourceTime, end: SourceTime }` from the canonical word-timing sidecar (Part 4).
2. Search the active sequence (Part 2 mapping) for clips referencing `assetId` whose trimmed source range contains `start`; pick the earliest in timeline order.
3. If found, seek to the timeline frame mapping to `start` (8.2.2) and highlight the word in the transcript panel.
4. If the word exists but no accepted clip contains it (it was cut), fall back to the nearest surviving word in the same transcript segment (preferring the following word); if none survives, return `{ code: "E_WORD_NOT_IN_EDIT", affected: [wordId], acceptedStateChanged: false, retry: "none", suggestion: "The passage containing this word was removed from the edit" }`.

Navigation by annotation (`seekToAnnotation(annId)`) resolves the anchor per 8.5.3 and seeks to the resulting timeline frame.

### 8.3 Annotation data model (FR-401)

All eight BRD annotation types are covered: `note`, `pin`, `rect`, `ellipse`, `arrow`, `freehand`, `spotlight` as shapes, and *time-range* both as the dedicated geometry-free shape `range` and as a nonzero `extent` allowed on any shape (a spotlight may persist over a range, for example).

```ts
// @guyditor/core — exported from the annotations module
export type AnnotationShape =
  | 'note' | 'pin' | 'rect' | 'ellipse' | 'arrow' | 'freehand' | 'spotlight' | 'range';

export interface NormPoint { x: number; y: number }        // normalized canvas coords, see 8.4

export type AnnotationGeometry =
  | { kind: 'pin';       at: NormPoint }
  | { kind: 'rect';      origin: NormPoint; size: NormPoint; rotationDeg?: number }
  | { kind: 'ellipse';   center: NormPoint; radii: NormPoint; rotationDeg?: number }
  | { kind: 'arrow';     from: NormPoint; to: NormPoint }
  | { kind: 'freehand';  points: NormPoint[]; closed: boolean }   // ≤ 512 points, see 8.4.2
  | { kind: 'spotlight'; region: { rect: { origin: NormPoint; size: NormPoint } }
                        | { ellipse: { center: NormPoint; radii: NormPoint } };
      dimOpacity: number };                                        // 0..1, surround dim

export interface AnnotationStyle {
  color: string;          // #rrggbb
  strokeWidth: number;    // normalized to canvas height, e.g. 0.004 = 0.4% of height
}

export type AnnotationAnchor =
  | { kind: 'clip';     clipId: string; assetId: string; sourceFrame: SourceTime }
  | { kind: 'word';     wordId: string; offset?: SourceTime }        // offset from word start
  | { kind: 'object';   trackId: string; assetId: string; sourceFrame: SourceTime }
  | { kind: 'beat';     beatId: string; offset?: SourceTime }
  | { kind: 'timeline'; sequenceId: string; frame: SourceTime };     // frame at sequence rate

export type AnnotationPersistedState = 'open' | 'resolved' | 'rejected' | 'reopened';
export type AnnotationState = AnnotationPersistedState | 'addressed'; // 'addressed' is derived, 8.8.1

export interface AnnotationStateChange {
  at: string;                       // ISO 8601 UTC
  from: AnnotationState; to: AnnotationState;
  actor: { kind: 'human' | 'agent'; id: string };
  txnId?: string;                   // transaction that carried the change
  reason?: string;
}

export interface Annotation {
  id: string;                       // ann_ + 10 base32 chars (Part 0)
  shape: AnnotationShape;
  body: string;                     // Markdown; may be '' for pure shapes, required for 'note'
  style?: AnnotationStyle;          // absent for 'note' and 'range'
  geometry: AnnotationGeometry | null;   // null for 'note' and 'range'
  anchor: AnnotationAnchor;
  extent: SourceTime;               // { frames: 0, fps } = single frame; >0 = time range
  canvasRef: { sequenceId: string; deliverableId?: string; aspect: string }; // authored canvas
  sourceProjection?: SourceProjection;   // 8.4.3
  state: AnnotationPersistedState;
  blocking: boolean;                // default true; feeds FR-1004 export validation
  author: { kind: 'human' | 'agent'; id: string };
  createdAt: string;                // ISO 8601 UTC
  history: AnnotationStateChange[];
  context?: { nearestWordId?: string; beatId?: string };   // snapshot at creation, for agents
  resolvedBy?: { txnId: string; revision: string };
  orphan?: OrphanInfo;              // 8.5.4
  convertedTo?: { itemId: string; txnId: string };         // 8.6
}
```

Serialized example (`sidecars/annotations.yaml` entry):

```yaml
- id: ann_k7m2q9d4tp
  shape: arrow
  body: "Logo clips the presenter's shoulder here — nudge it up."
  style: { color: "#ff3355", strokeWidth: 0.004 }
  geometry: { kind: arrow, from: { x: 0.612300, y: 0.381400 }, to: { x: 0.702100, y: 0.244900 } }
  anchor: { kind: clip, clipId: clp_8fj3ka92mm, assetId: ast_2n4vp8qq1c, sourceFrame: { frames: 4312, fps: "30000/1001" } }
  extent: { frames: 0, fps: "30000/1001" }
  canvasRef: { sequenceId: seq_main000001, aspect: "16:9" }
  sourceProjection:
    assetId: ast_2n4vp8qq1c
    clipId: clp_8fj3ka92mm
    geometry: { kind: arrow, from: { x: 0.455120, y: 0.502330 }, to: { x: 0.601480, y: 0.311270 } }
  state: open
  blocking: true
  author: { kind: human, id: creator }
  createdAt: "2026-07-17T14:22:31Z"
  context: { nearestWordId: w000418 }
  history: []
```

Validation rules (enforced by `annotation.create` / `annotation.update` schemas): `note` requires nonempty `body` and null geometry; `range` requires `extent.frames > 0` and null geometry; every other shape requires geometry of the matching `kind`; all coordinates within `[-0.25, 1.25]` (limited off-canvas overshoot allowed for arrows/freehand); `dimOpacity` in `[0,1]`.

### 8.4 Normalized coordinate system (FR-403)

#### 8.4.1 Canvas space (authoritative)

- Origin top-left; `x` grows rightward, `y` grows downward.
- `x` is normalized by canvas **width**, `y` by canvas **height** — each axis independently spans `[0,1]` regardless of aspect ratio. Pixel mapping for a raster of `W×H`: `px = x·W`, `py = y·H`.
- Coordinates are serialized as JSON/YAML numbers rounded to exactly 6 decimal places (sub-pixel at 8K; stable under re-serialization, so diffs stay clean — R-002). The Part 0 ban on floating point applies to *time*; normalized geometry is spatial and uses these fixed-precision decimals.
- Scalar sizes that must look identical at any resolution (`strokeWidth`, pin radius, arrowhead size) are normalized to canvas **height**.

Every annotation records `canvasRef` — the sequence (and deliverable, if authored while reviewing one) and aspect string of the canvas it was drawn on.

#### 8.4.2 Freehand simplification

Raw pointer samples are simplified at creation with Ramer–Douglas–Peucker, epsilon 0.002 (0.2% of canvas height). If the result still exceeds **512 points**, epsilon is doubled and simplification re-run until it fits. This bounds sidecar size and diff noise while preserving stroke intent.

#### 8.4.3 Source projection and cross-format mapping

Canvas coordinates alone would drift when the same content is recomposed for another aspect ratio (FR-511, FR-803). Therefore, at creation time `AnnotationService` computes an optional **source projection**:

```ts
export interface SourceProjection {
  assetId: string; clipId: string;
  geometry: AnnotationGeometry;   // same shape, coords normalized to the SOURCE raster (unit square)
}
```

**Capture algorithm (at settled review position):**

1. Compute the geometry centroid `c` in canvas space (for `pin`, the point itself; for `arrow`, midpoint; for `freehand`, bounding-box center).
2. Enumerate video/image layers visible at the frame in descending z-order (from `CompositorModel`).
3. For each layer, invert its full transform chain (crop, scale, position, rotation — Part 6) and map `c` into the layer's source raster. If `c` lands inside `[0,1]²` of the source, select that layer.
4. Map every geometry point through the same inverse transform, normalize by source raster dimensions, and store as `sourceProjection`. Rotation-bearing shapes adjust `rotationDeg` by the layer rotation.
5. If no layer is hit (annotation over empty canvas or caption area), omit `sourceProjection`.

**Display algorithm (rendering annotation on any target canvas — proxy preview, HQ preview, or a different deliverable):**

1. If `sourceProjection` exists and the target composition shows a clip of the same `assetId` at the resolved frame: map projected geometry → source pixels → apply that clip's transform in the *target* composition → target canvas pixels → normalize. This keeps the arrow on the shoulder even when the vertical derivative crops and repositions the presenter.
2. Else if the target canvas aspect equals `canvasRef.aspect`: use canvas geometry directly (proxy-resolution independence is automatic — multiply by the target raster's `W×H`).
3. Else **fit-map**: uniformly scale the authored canvas into the target canvas ("contain", centered, no stretching), map geometry through, and render with a dashed outline plus an `approximate` badge so the creator knows placement is best-effort.

### 8.5 Anchors and orphan handling (FR-402)

#### 8.5.1 Preference order

Anchors are chosen in this strict order, using the first that applies: **source clip + source frame → transcript word → tracked object → named beat → timeline-only**. Timeline-only anchors are legal but fragile by design; the UI labels them as such, and the creator may override the auto-selected anchor at creation (Part 10).

#### 8.5.2 Auto-selection algorithm (at creation, settled position)

1. Run the source-projection hit test (8.4.3). If a layer clip is hit → `{ kind: 'clip', clipId, assetId, sourceFrame }`, where `sourceFrame` is that layer's resolved source frame. For geometry-free shapes (`note`, `range`), the hit test uses the topmost visible video layer covering the playhead.
2. Else, if the paused timeline frame falls within an aligned word's timing on any audible speech track → `{ kind: 'word', wordId, offset }` (offset = frames past word start, in the word's asset rate).
3. Else, if an object track (subject/face tracking from the ML worker, Part 3) has a bounding box at this frame containing the centroid → `{ kind: 'object', trackId, assetId, sourceFrame }`.
4. Else, if a named story beat covers the timeline frame → `{ kind: 'beat', beatId, offset }` (offset at sequence rate).
5. Else → `{ kind: 'timeline', sequenceId, frame }` at sequence rate.

Regardless of the chosen anchor, `context.nearestWordId` (nearest aligned word within ±2 s) and `context.beatId` (covering beat, if any) are snapshotted for agent use (8.7).

#### 8.5.3 Anchor resolution (anchor → timeline frame at a given revision)

1. `clip`: if `clipId` exists and `sourceFrame` lies inside its trimmed source range → Part 2 mapping gives the timeline frame. If the clip exists but the frame was trimmed out → resolve to the nearest in-range frame and mark the result `approximate`. If the clip was deleted → search other accepted clips referencing `assetId` whose range contains `sourceFrame` (earliest in timeline order); if none, the annotation is orphaned.
2. `word`: `TranscriptEngine.wordTiming(wordId)` + `offset`, then the clip search of 8.2.4 steps 2–4; a word deleted from the canonical transcript orphans the annotation.
3. `object`: the track's asset + `sourceFrame`, then as for `clip` deletion fallback.
4. `beat`: the beat's current timeline position + `offset`; a deleted beat orphans the annotation.
5. `timeline`: the stored frame directly; orphaned only if the sequence was deleted or shortened below the frame.

#### 8.5.4 Orphan handling

Per Part 2's anchor-orphaning rules, an unresolvable anchor never deletes or mutates the annotation's content. After every accepted transaction, `AnnotationService` re-resolves all non-terminal annotations (synchronously; the set is small) and stamps failures:

```ts
export interface OrphanInfo {
  detectedAtRevision: string;                       // rev_00017
  lastResolved: { sequenceId: string; timelineFrame: SourceTime }; // last known good position
}
```

Orphaned annotations surface in the review panel with an "anchor lost" badge at `lastResolved`; the creator may re-anchor (`annotation.update` with a new anchor clears `orphan`), resolve, or reject them. Orphaned annotations that are `blocking` and not resolved/rejected still fail export validation (FR-1004). If a later transaction makes the anchor resolvable again (e.g. a restored clip), `orphan` is cleared automatically by the same re-resolution pass.

### 8.6 Review annotations versus renderable overlays (FR-404)

Review annotations are private review state: they render only in the review UI and in agent context packages, **never** into preview-quality exports or final output (business rule 7). Renderable graphics live on graphics layers as template instances (Part 7). The two are distinct record types with distinct IDs (`ann_` vs layer items referencing `tpl_`/`ast_`), and nothing converts between them implicitly.

The explicit bridge is the operation **`annotation.convert`** (risk class `normal`; when agent-initiated it flows through the proposal loop like any other consequential change, FR-105):

```jsonc
// annotation.convert parameters (JSON Schema in the Part 5 catalog)
{
  "annotationId": "ann_k7m2q9d4tp",
  "layerId": "lyr_gfx0000001",        // target graphics layer; created if omitted
  "templateId": "tpl_arrow",           // optional; defaults per the table below
  "durationOverride": { "frames": 60, "fps": "30000/1001" },  // optional
  "styleOverrides": { }                // template parameters, Part 7
}
```

Default template mapping and behavior:

| Annotation shape | Default overlay | Notes |
|---|---|---|
| `note` | `tpl_callout_text` | body becomes the callout text, deterministic text render (FR-602) |
| `pin` | `tpl_callout_pin` | |
| `rect` / `ellipse` | `tpl_highlight_box` | shape parameter set accordingly |
| `arrow` | `tpl_arrow` | |
| `freehand` | frozen SVG asset | path rendered to an SVG, ingested as a normal `ast_` asset (business rule 8), placed on an image layer |
| `spotlight` | `tpl_spotlight` | dim-surround matte with the region cut out |
| `range` | — | not convertible alone; `E_ANN_NOT_CONVERTIBLE` unless `templateId` is supplied |

Conversion semantics:

1. Geometry transfers via `sourceProjection` when present (so the overlay tracks the recomposed layer per 8.4.3 step 1), else via canvas geometry.
2. The created item anchors with the annotation's own anchor (graphics anchor to clips, words, beats, annotations, or frame ranges — FR-601), and its duration is the annotation `extent`, or `durationOverride`, or the default hold of **2 seconds at sequence rate** when extent is 0.
3. The item records provenance `source: { annotationId }`; the annotation gets `convertedTo: { itemId, txnId }`.
4. The converting transaction automatically lists the annotation in its `addresses` array (8.8.3), so acceptance resolves it in the same atomic transaction.

### 8.7 Agent context package (FR-405)

When the agent acts on an annotation (or a bare position), `AgentGateway` supplies a locally built bundle via the gateway tool `context_package` (Part 9 §9.2/§9.4). This section is the single normative definition of the FR-405 package — Part 9 §9.4 references it. Building is entirely local; whether any of it leaves the machine is governed by the data-boundary and audit rules of Part 9 (NFR-001/002): the `AuditLog` records the `DataClass` values (Part 1 §1.8) `frames`, `audio`, `transcript`, `metadata` whenever package content is sent to a remote director or provider.

#### 8.7.1 Bundle contents and limits (binding)

| Item | Content | Limits |
|---|---|---|
| `marked.png` | The annotation's frame composited at proxy quality with the annotation drawn in its own style by the deterministic overlay renderer (AD-006), plus a corner badge showing the `ann_` ID | PNG, long edge ≤ 1280 px, authored canvas aspect |
| `clean.png` | The identical composited frame with no annotation | same |
| `context.mp4` | Proxy-quality composited segment around the annotation: window `[anchorStart − 2 s, anchorEnd + 2 s]` clamped to the sequence; if the window exceeds **12 s**, use `[anchorStart − 2 s, anchorStart + 10 s]` and set `truncated: true` | H.264 yuv420p CRF 28, long edge ≤ 640 px, mono AAC 96 kbps, target ≤ 8 MB |
| `transcript` | Word window: **60 aligned words before** the annotation window, all words inside it (capped so the total ≤ 500), and **60 after**, each `{ id, text, startMs, endMs }` relative to clip start, with the anchor word flagged | JSON, inline in manifest |
| `layers` | Per visible layer at the anchor frame: `layerId`, z-order, type, `clipId`/`assetId`, enabled/locked, opacity, effective transform, normalized bounding box in canvas space, active effects list | JSON ≤ 32 KB; keyframe lists elided with `"truncated": true` |
| `annotation` | The full serialized `Annotation` record including `history` and `context` | JSON, inline |

```ts
export interface AnnotationContextPackage {
  requestedFor: { annotationId?: string; anchor: string };  // Part 0 anchor grammar; annotation requests set both
  revision: string;                       // accepted revision (or proposal preview, below)
  proposalId?: string;                    // set when built against a proposal's projected state
  builtAt: string;
  position: { sequenceId: string; timelineFrame: SourceTime; approximate: boolean };
  files: { markedFrame?: string; cleanFrame: string; proxyClip?: string;
           audioExcerpt?: string };       // paths under .guyditor/cache/annctx/; markedFrame absent
                                          // for anchor-only requests; audioExcerpt = mono WAV,
                                          // only when includeAudio (NFR-002 minimum-necessary)
  clip?: { startTimelineFrame: SourceTime; durationMs: number; truncated: boolean };
  clipPending?: string;                   // job_ id when the clip render exceeded the sync timeout
  transcript: { words: Array<{ id: string; text: string; startMs: number; endMs: number; anchor?: true }> };
  layers: unknown[];                      // schema above
  annotation?: Annotation;                // present for annotation requests
  dataClasses: DataClass[];               // exact classes present (Part 1 §1.8) — input to the Part 9 §9.9 boundary check
}
```

#### 8.7.2 Build algorithm

1. Resolve the anchor (8.5.3) against the accepted revision, or against a proposal's projected state when `proposalId` is passed (so the agent can inspect its own pending work). If orphaned, still build the package at `orphan.lastResolved` and mark `position.approximate = true`.
2. Check the deterministic cache: packages live at `.guyditor/cache/annctx/<annId or anchor-hash>/<revision or proposalId>/` keyed by (annotation content hash or anchor string, revision, request parameters) per AD-013; on hit, return the cached manifest.
3. Composite `clean.png` via the headless proxy compositor (same code path as preview, AD-005) at the resolved frame.
4. Produce `marked.png` = clean frame + overlay renderer drawing the display-mapped geometry (8.4.3) and ID badge.
5. Enqueue a high-priority `JobQueue` job (kind `annotation-context-clip`) that renders the context window through the standard segment-render path at proxy quality. If it finishes within the 15 s synchronous budget, include it; otherwise return the package with `clipPending: <jobId>` — the agent may poll the job and re-request.
6. Assemble transcript window (from `TranscriptEngine`), layer metadata (from `CompositorModel`), and the annotation record; write `manifest.json`; return.

Failure surfaces use the Part 0 error envelope: `E_ANN_NOT_FOUND`, `E_ANNCTX_TIMEOUT` (retry: `safe`), `E_ANN_ORPHANED` is *not* an error here (see step 1).

#### 8.7.3 AgentGateway surface

MCP tool names are operation names with dots replaced by underscores (MCP name-charset restriction). The gateway exposes:

- **`context_package`** (the FR-405 tool; catalog row in Part 9 §9.2) — input `{ annotationId | anchor, proposalId?, padMs? (≤ 5000, default 2000), includeClip? (default true), includeAudio? (default false), quality? ('proxy' default, 'hq' triggers a Part 12 segment render) }`. Returns the manifest as structured content; `marked.png` and `clean.png` are additionally returned inline as MCP image content blocks for a remote director (subject to the Part 9 §9.9 boundary check); `context.mp4` is returned only as a path/resource URI, never inlined.
- **`annotation_list`** / **`annotation_get`** — filter by state, blocking, sequence, orphaned; returns records without geometry point arrays unless `full: true`.
- There are **no direct-mutation annotation tools** (Part 9 §9.2: every mutation is a proposal). The lifecycle operations of 8.8.4 (`annotation.create`, `annotation.update`, `annotation.resolve`, …) reach the gateway only as ops inside `proposal_create`; the UI dispatches the same operations directly through `OperationEngine` (AD-009, FR-901) — one operation vocabulary, two entry disciplines.

### 8.8 Annotation lifecycle (FR-406)

#### 8.8.1 States

Persisted states: `open`, `resolved`, `rejected`, `reopened`. **`addressed` is a derived state**: an annotation whose persisted state is `open` or `reopened` reports effective state `addressed` while at least one pending proposal (`prp_`, Part 5) lists it in its `addresses` array. This is a deliberate design decision: proposals must not modify accepted state (FR-105), and persisting `addressed` on proposal creation would do exactly that. Deriving it means proposal rejection or withdrawal reverts the effective state with zero writes to accepted state. `AnnotationService.getState(annId)` and all UI/agent surfaces report the effective state; the BRD's five states are therefore all supported and visible.

`reopened` is behaviorally identical to `open` (it can be addressed, resolved, or rejected) but is kept distinct so history and filters distinguish first-pass from bounce-back feedback.

#### 8.8.2 Transition table

| From (effective) | Trigger | To | Notes |
|---|---|---|---|
| open / reopened | proposal created listing the annotation in `addresses` | addressed | derived; no accepted-state write |
| addressed | that proposal rejected or withdrawn | open / reopened | derived reversion |
| addressed | proposal **accepted** | resolved | `annotation.resolve` applied inside the accepting transaction (8.8.3) |
| open / reopened | `annotation.resolve` (manual, `reason` required) | resolved | creator fixed it by hand or deems it done |
| open / reopened / addressed | `annotation.reject` | rejected | "won't fix"; creator authority (an agent may only propose it) |
| resolved / rejected | `annotation.reopen` | reopened | |
| any | `annotation.delete` | — | record removed via transaction; discouraged — prefer `reject` to preserve review history |

All other transitions return `{ code: "E_ANN_INVALID_TRANSITION", affected: [annId], acceptedStateChanged: false, retry: "none" }`. Every persisted transition appends an `AnnotationStateChange` to `history` with actor and `txnId`.

#### 8.8.3 Transaction linkage (binding rule)

Transaction records in `history/transactions.jsonl` (Part 2 schema) carry an `addresses: string[]` field of `ann_` IDs. The rule: **an accepted transaction that addresses annotations must list them in `addresses`, and its acceptance atomically applies `annotation.resolve` to each, stamping `resolvedBy: { txnId, revision }` on the annotation**. Proposals carry the same field so the derived `addressed` state and the review UI ("this proposal answers annotations ann_x, ann_y") work before acceptance. This implements FR-406's traceability and AC-004 end-to-end: annotation → proposal → accepted revision → annotation resolved with a pointer back.

#### 8.8.4 Operation catalog additions (registered in Part 5)

| Operation | Risk class | Summary template |
|---|---|---|
| `annotation.create` | low | `Added {shape} annotation {id} at {anchorDescription}` |
| `annotation.update` | low | `Edited annotation {id} ({changedFields})` |
| `annotation.delete` | normal | `Deleted annotation {id}` |
| `annotation.resolve` | low | `Resolved annotation {id} via {txnId|manual: reason}` |
| `annotation.reject` | low | `Rejected annotation {id}: {reason}` |
| `annotation.reopen` | low | `Reopened annotation {id}: {reason}` |
| `annotation.convert` | normal | `Converted annotation {id} to overlay {itemId} on {layerId}` |

Each has a JSON Schema, inverse metadata for undo (create↔delete, state changes invert to the prior state), and the summary templates above (business rule 6). `blocking` interacts with export: Part 12's FR-1004 validation fails a deliverable while any annotation intersecting its source range has effective state `open`, `addressed`, or `reopened` **and** `blocking: true`; the creator clears blockers by resolving, rejecting, or setting `blocking: false` via `annotation.update`.

### Part 8 requirements coverage

| BRD ID | Implemented in |
|---|---|
| FR-400 | 8.2 (8.2.1 proxy contract, 8.2.2 exact seek, 8.2.3 frame-step/scrub, 8.2.4 scrub-to-word) |
| FR-401 | 8.3 (data model, all eight types, serialized schema, validation) |
| FR-402 | 8.5 (preference order 8.5.1, auto-selection 8.5.2, resolution 8.5.3, orphans 8.5.4) |
| FR-403 | 8.4 (canvas space 8.4.1, freehand bounds 8.4.2, source projection and cross-format mapping 8.4.3) |
| FR-404 | 8.6 (`annotation.convert`, template mapping, provenance); storage separation in 8.1; render exclusion per business rule 7 |
| FR-405 | 8.7 (bundle contents and limits 8.7.1, build algorithm 8.7.2, AgentGateway tools 8.7.3) |
| FR-406 | 8.8 (states 8.8.1, transitions 8.8.2, transaction linkage 8.8.3, operations 8.8.4) |

---

## Part 9 — Agent gateway, skills, audit, and cost

This part specifies the `@guyditor/agent` package (`packages/agent`): the **AgentGateway** MCP server (AD-009), the **SkillRegistry** and skill file format (FR-700/701/705), subjective assessment and specialist-critic advisory paths (FR-702/703, BR-004), explainability (FR-704), data-boundary and secrets enforcement (NFR-001/002/003, AD-011), and the **AuditLog** and **CostMeter** (NFR-006/007, AD-012). Terms: a **director** is the frontier model driving an editing session (BR-002); a **proposal** (`prp_`) is a set of semantic operations awaiting creator review (FR-105); an **adapter** (`adp_`) is an outbound integration registered in `AdapterRegistry`; a **session** (`ses_`) is one director connection to one project.

### 9.1 Session model and director connection (BR-002, BR-003)

The AgentGateway runs inside the Electron main process. Its transport is the **single** Part 1 §1.1 MCP endpoint: loopback streamable HTTP (`127.0.0.1`, ephemeral port) protected by the random 256-bit bearer token written to `~/.guyditor/state/gateway.json` (mode `0600`) at application startup — there is no per-session token and no per-project server. Sessions are **logical**, not transport-level: each MCP `initialize` creates a `GatewaySession` (`ses_`) bound to exactly one open project (named explicitly at `initialize` when more than one is open). Any MCP-capable frontier model (Claude, Codex-class, or future models) can act as director; there is **no per-vendor director code** — a director is pure configuration.

Attachment paths (both reach the same endpoint with the same token):

1. **External attach (canonical)** — the director CLI or desktop agent runs the packaged `guyditor-mcp` stdio proxy, which reads `gateway.json` and bridges stdio↔HTTP (Part 1 §1.1) with zero configuration.
2. **Convenience spawn (optional)** — Guyditor spawns a director CLI as a child process with `guyditor-mcp` pre-wired into that CLI's MCP configuration (`DirectorProfile.command`/`args` below). This is a launcher over path 1, not a second server or a distinct stdio protocol.

```ts
export interface DirectorProfile {
  id: string;                       // adp_-prefixed, registered in AdapterRegistry
  name: string;                     // "Claude CLI", "Codex CLI", ...
  command: string;                  // executable for the convenience spawn (path 2), "" when attaching externally
  args: string[];
  env: Record<string, string>;      // never contains raw secrets; see 9.11
  locality: 'local' | 'remote';     // does model inference leave this machine?
  modelLabel: string;               // recorded in transactions (FR-104) and audit
}

export interface GatewaySession {
  sessionId: string;                // ses_ prefix (Part 0)
  projectId: string;
  director: DirectorProfile;
  startedAt: string;                // ISO-8601 UTC
  policySnapshot: { automation: AutomationPolicy; boundaries: DataBoundaryPolicy };
}
```

Session lifecycle:

1. On MCP `initialize`, the gateway creates a `GatewaySession`, assigns `ses_` ID, snapshots the automation and data-boundary policies (mid-session policy tightening applies immediately; loosening applies only to new sessions), and opens `~/.guyditor/audit/<sessionId>.jsonl` (AD-012).
2. The gateway advertises MCP resources `guyditor://project/summary` (project settings, sequences, deliverables, pinned skills digest, current revision) and `guyditor://policy` so any director bootstraps without vendor prompts.
3. Every creator instruction relayed to the director, every tool call, and every proposal outcome is appended to the session audit file (9.12).
4. Disconnect or project close ends the session; pending proposals survive (they live in `proposals/`, AD-008).

**Decision (new):** MCP tool names use `snake_case` (MCP client name-charset compatibility); the operations *inside* proposals use the Part 0 dot grammar (`clip.trim`, `annotation.resolve`, …) unchanged.

### 9.2 Tool catalog

Data classes are defined in 9.9. "Risk" is `read` (no mutation), `propose(<max op risk>)` (creates/edits proposals only), `advisory` (records non-project artifacts), `job` (enqueues local work via JobQueue), or `external` (may transfer data off-machine — subject to 9.9 and 9.13 pre-flight). Every tool's inputs and outputs are JSON-Schema validated; failures return the Part 0 error envelope.

| Tool | Purpose | Input (summary) | Risk | Data classes returned |
|---|---|---|---|---|
| `project_summary` | Settings, sequences, layers, deliverables, revision, pinned skills | none | read | metadata |
| `timeline_query` | Clips/layers/transitions/gaps in a range or at an anchor | sequenceId, range \| anchor, filters | read | metadata |
| `history_get` | Transactions, revisions, semantic diff between two revisions | fromRev, toRev | read | metadata |
| `transcript_get` | Word/segment window | wordRange \| timeRange \| anchor, window | read | transcript |
| `transcript_search` | Text search over canonical transcript | query, limit | read | transcript |
| `asset_list` / `asset_get` | Asset metadata, hashes, analysis summary | filters \| assetId | read | metadata |
| `analysis_get` | Derived analysis: silence, scenes, faces, technical issues | assetId, kinds[] | read | metadata |
| `take_list` | Takes with marker metadata (FR-010) for draft/comparison work | assetId? | read | metadata, transcript |
| `draft_inputs` | FR-005 draft-generation inputs package — wraps `MediaEngine.getDraftInputs` (Part 3 §3.6) | constraints?: DraftConstraints | read | metadata, transcript |
| `annotation_list` / `annotation_get` | Review annotations with anchors, geometry, status | status[], filters \| annotationId | read | metadata, transcript |
| `context_package` | FR-405 media context package (schema: Part 8 §8.7; boundary rules: 9.4) | annotationId \| anchor, options | read | metadata, transcript, frames, (opt) audio, video |
| `frame_get` | Single proxy or HQ frame image at an anchor | anchor, quality | read | frames |
| `proxy_range_get` | Short proxy clip file for a range (bounded, 9.5) | range (≤ configured max) | read | video |
| `diff_preview` | Dry-run: validate ops, return semantic diff without creating a proposal | ops[] | read | metadata |
| `proposal_create` | Create a proposal from semantic operations (9.3) | title, ops[] each with Reason, addresses[]: ann_ ids, assessmentId? | propose(≤consequential) | metadata |
| `proposal_update` | Revise a pending proposal (new ops replace old; new diff) | proposalId, ops[], note | propose | metadata |
| `proposal_withdraw` | Withdraw a pending proposal | proposalId | propose | metadata |
| `proposal_list` / `proposal_get` | Status, creator feedback, acceptance outcome | filters \| proposalId | read | metadata |
| `preview_request` | Render proxy/HQ preview of accepted state or a pending proposal range | proposalId?, range, quality | job | metadata (file paths) |
| `job_status` | Progress of gateway-initiated jobs | jobId | read | metadata |
| `skill_list` | Pinned skills for this project + available versions | none | read | metadata |
| `skill_get` | Full skill: manifest, rules, markdown body | skillId, version? (default pinned) | read | metadata |
| `skill_example_get` | One approved/rejected example incl. media reference | skillId, exampleId | read | metadata, frames, (opt) video |
| `deliverable_list` / `deliverable_get` | Deliverables, platform profiles, staleness (FR-807) | filters \| deliverableId | read | metadata |
| `deliverable_metadata_draft` | Draft publish metadata as a proposal (Part 11 §11.10) | deliverableId | propose(low) | metadata, transcript |
| `export_validate` | Run FR-1004 validation for a deliverable, report only | deliverableId | job | metadata |
| `project_create` | Create a new project (Part 3 §3.2 flow; the sole non-proposal mutation — there is no project to propose against yet) | directory, profile, skills?, watchFolders? | job | metadata |
| `assist_fillers_detect` | Detect pauses/fillers; candidates compile into a proposal (Part 5 §5.5) | assetIds?, params? | propose(normal) | metadata, transcript |
| `assist_takes_compare` | Build a take-comparison record (Part 5 §5.6) | takeIds \| takeGroup | job | metadata, transcript |
| `assist_jumpcuts_conceal` | Propose jump-cut concealment (Part 5 §5.11) | range?, params? | propose(normal) | metadata |
| `assessment_submit` | Record a subjective assessment (9.6) | SubjectiveAssessment | advisory | metadata |
| `critic_request` | Invoke specialist critic adapter (9.7) | adapterId, subject, rubricSkillRefs, questions | external | metadata |
| `critic_result_get` | Retrieve a completed critique | critiqueId | read | metadata |
| `cost_estimate` | Pre-flight cost estimate for a described external call | adapterId, workload | read | metadata |
| `cost_status` | Spend and budget headroom at task/episode/cumulative levels | none | read | metadata |
| `policy_get` | Current automation + data-boundary policy for this session | none | read | metadata |

Notes:

- **Every mutation is a proposal.** Deliverable operations (`deliverable.derive`, `deliverable.metadata.set`, `deliverable.refresh`), annotation resolution (`annotation.resolve`, `annotation.reopen`), transcript corrections, and all Part 5/6/7 operations are expressed as ops inside `proposal_create` — there is no direct-mutation tool.
- **Annotation resolution:** `proposal_create.addresses` links a proposal to annotations; on acceptance, the transaction records the addressed annotations (FR-406) and the included `annotation.resolve` ops (risk `low`) move them to `resolved`.
- No tool exposes credentials, raw provider responses containing secrets, or audit files of other sessions.

#### 9.2.1 Initial-draft workflow (FR-005)

Part 3 §3.6 owns the inputs contract; this is the drafting half it defers here. Flow, using only catalogued tools — no special draft mutation path exists:

1. The creator sets `DraftConstraints` (Part 3 §3.6) in the project-creation wizard or the draft panel (Part 10), or states them as the session instruction; the gateway records the instruction on the session (9.1).
2. The director calls `draft_inputs`, receiving the complete `DraftGenerationInputs` package — asset metadata, takes and markers (FR-010), analysis summaries (FR-004), transcripts, and the constraints. Media excerpts needed while planning (a hook candidate's frames, a take's proxy clip) come from `frame_get` / `proxy_range_get` / `context_package` under the ordinary 9.4/9.9 boundary rules.
3. The director plans the edit (take selection, ordering, trims, pauses) and assembles ordinary Part 5 operations — `clip.insert`, `take.select`, `clip.trim`, `transition.set`, caption ops — into a single `proposal_create` batch. Every op carries a `Reason` (9.8) citing its evidence: take quality markers, analysis values, transcript ranges (FR-704; guaranteed available because drafts are never generated from raw media alone, §3.6).
4. The proposal runs the standard §9.3 lifecycle. An initial draft always reaches creator review: its batch inserts clips and builds structure, so its risk class is never `low` and the automation policy cannot auto-accept it (business rule 5).

### 9.3 Enforcement: the proposal boundary and the automation policy (FR-105, business rules 5, 6)

The gateway holds a **read-only** view of `ProjectStore`. Its only write path is `OperationEngine.createProposal(...)`; it has no code path that commits a transaction to accepted state. Acceptance is performed by the creator in the UI (Part 10) or by the automation policy evaluator below — both inside `OperationEngine`, never inside the gateway.

`proposal_create` algorithm:

1. Validate every op against its Part 5 JSON Schema; reject on first failure (`E_OP_SCHEMA`).
2. Validate that every op carries a `Reason` (9.8); reject with `E_OP_REASON_REQUIRED` otherwise.
3. Compute the proposal risk class = max over op risk classes (`low` < `normal` < `consequential`, Part 0 grammar).
4. Dry-run the ops against a shadow copy of the accepted revision; on conflict or invariant violation return the error envelope with `affected` IDs and `acceptedStateChanged: false`.
5. Generate the semantic diff and human-readable summary from each op's summary template (business rule 6), persist the Part 2 §2.10 proposal directory `proposals/<prp_id>/` (`proposal.json`, `master.proposed.yaml`, `diff.patch`, optional attached `assessment.json`, `previews/`), and notify the UI proposal panel.
6. Append `proposal.created` to the audit log.
7. Run the automation-policy evaluation (below). If it does not auto-accept, the proposal waits for creator review; rejection leaves the accepted revision untouched and archives the proposal with creator feedback visible to `proposal_get`.

Automation policy (business rule 5) — **default off**, stored in the project master file under `settings.automation` so it is versioned and diffable:

```yaml
automation:
  enabled: false                 # DEFAULT. Nothing auto-accepts until the creator turns this on.
  maxRisk: low                   # the only legal value; 'normal'/'consequential' fail validation
  allowedOperations:             # optional allowlist; empty list = all low-risk ops
    - transcript.word.correct
    - annotation.resolve
  maxOpsPerProposal: 5
  maxAutoAcceptsPerSession: 20
  notify: toast                  # every auto-acceptance is surfaced in the UI, never silent
```

Auto-accept evaluation (inside `OperationEngine`, after step 5 above):

1. If `enabled: false` → review queue.
2. If any op risk ≠ `low`, or op not in `allowedOperations` (when non-empty), or op count > `maxOpsPerProposal`, or session auto-accept count ≥ `maxAutoAcceptsPerSession` → review queue. **Consequential and normal ops always require explicit creator acceptance** — the schema forbids configuring otherwise.
3. Otherwise accept: commit the transaction with `acceptance: { status: 'auto-accepted-low-risk', by: 'automation-policy' }` (Part 2 §2.9 — the sole auto-acceptance marker), append `policy.autoaccept` to the audit log, emit the UI notification with a one-click revert (FR-904 inverse metadata).

### 9.4 Media context package (FR-405)

`context_package` returns the FR-405 bundle whose single normative definition is Part 8 §8.7 (`AnnotationContextPackage`: marked/clean frame, bounded `context.mp4`, transcript window, per-layer metadata, the annotation record when one was named, and the exact `dataClasses` present, using the Part 1 §1.8 `DataClass` enum). The tool accepts an `annotationId` **or** a bare semantic anchor (Part 0 grammar) plus the Part 8 §8.7.3 options, with **minimum-necessary defaults** (NFR-002): frames on by default, moving media (`includeClip` beyond the bounded context clip) and audio (`includeAudio`) off by default.

```ts
// DataClass: the closed enum defined in Part 1 §1.8 — 'metadata' | 'prompt' | 'transcript' | 'frames' | 'audio' | 'video'.
export interface FileRef { path: string; sha256: string; mime: string; bytes: number; }  // gateway file-handoff envelope
```

Assembly and caching follow Part 8 §8.7.2 (packages under `.guyditor/cache/annctx/`). Frames come from the proxy tier by default (`quality: 'proxy' | 'hq'`; HQ triggers a Part 12 segment render job first). All media is returned as file references — a **local** director reads the files directly; for a **remote** director the gateway inlines base64 content per MCP content blocks, which counts as external transfer and is checked against the data-boundary policy (9.9) before assembly.

### 9.5 Skills: format, registry, pinning (BR-007, FR-700, FR-701, FR-705, business rule 11)

A **skill** is a local, versioned directory: `~/.guyditor/skills/<name>/<version>/` (global library) or `<project>/skills/<name>/<version>/` (project-local), containing `skill.yaml`, `SKILL.md` (the prose body the director reads), and `examples/` media. Skills are the BR-007 progressive-personalization mechanism: creator preferences accumulate as versioned, inspectable skill content — rules and approved/rejected examples — never as opaque hidden state, and evolve only through the explicitly approved path of rule 3 below. Skill versions are **immutable**: any edit publishes a new semver version. Projects pin exact versions in the master file (FR-100 "presets and skill versions"; serialized as the Part 2 §2.4 `SkillPin`):

```yaml
# in episode.guyditor.yaml
skills:
  - id: skl_k3f9a2m8xq
    name: martin-pacing
    version: "1.3.0"
    path: skills/martin-pacing/1.3.0/    # project-local snapshot dir (Part 2 §2.12)
    contentHash: "…"                     # sha256 over skill.yaml + SKILL.md + examples manifest
```

```yaml
# skill.yaml
format: guyditor-skill/v1
id: skl_k3f9a2m8xq
name: martin-pacing
version: 1.3.0
title: "Pacing and cut rhythm"
categories: [pacing, pauses_fillers]     # closed enum, from FR-700:
# pacing | pauses_fillers | framing_cuts | subtitle_style | motion_transitions
# | brand_voice | brand_visual | hooks_retention | research_accuracy
summary: "Cut rhythm and pause handling for analytical episodes."
rules:
  - id: rule_hook_12s
    category: hooks_retention
    strength: must              # must | prefer | avoid
    text: "The opening hook must reach the thesis within 12 seconds."
  - id: rule_keep_thinking_pauses
    category: pauses_fillers
    strength: avoid
    text: "Do not remove pauses longer than 700 ms that precede a conclusion sentence."
examples:
  approved:
    - id: ex_hook_good
      description: "Episode 12 hook — accepted on first proposal."
      media: { path: examples/hook-good.mp4, sha256: "…" }
      provenance: { projectId: "…", revision: rev_00017 }   # optional
  rejected:
    - id: ex_jumpy_cuts
      description: "Rejected: cut frequency above 1 cut / 2 s felt frantic."
      media: { path: examples/jumpy.mp4, sha256: "…" }
body: SKILL.md
```

```ts
export interface SkillManifest { id: string; name: string; version: string; title: string;
  categories: SkillCategory[]; summary: string; rules: SkillRule[];
  examples: { approved: SkillExample[]; rejected: SkillExample[] }; contentHash: string; }
export type SkillCategory = 'pacing'|'pauses_fillers'|'framing_cuts'|'subtitle_style'
  |'motion_transitions'|'brand_voice'|'brand_visual'|'hooks_retention'|'research_accuracy';
export interface SkillRule { id: string; category: SkillCategory;
  strength: 'must'|'prefer'|'avoid'; text: string; }
export interface SkillExample { id: string; description: string;
  media?: { path: string; sha256: string }; provenance?: { projectId: string; revision: string }; }

export interface SkillRegistry {
  list(scope: 'global'|'project'|'all'): SkillManifest[];
  versions(skillId: string): string[];
  get(skillId: string, version?: string): { manifest: SkillManifest; body: string };
  publish(dir: string): SkillManifest;          // validates, hashes, assigns immutable version
  pinned(projectId: string): SkillManifest[];   // resolves master-file pins, verifies contentHash
  verify(skillId: string, version: string): { ok: boolean; expected: string; actual: string };
}
```

Rules (business rule 11, FR-705):

1. `SkillRegistry.pinned` verifies each pin's `contentHash`; a mismatch is a hard error (`E_SKILL_HASH`) surfaced before any director session starts — skills are versioned inputs, never hidden global behavior.
2. Changing a project's pinned version is the semantic operation `skill.pin.set` (risk `normal` → always creator-reviewed), recorded as a transaction; existing projects keep the version they were approved with.
3. **Learning from history (FR-701):** the director MAY read acceptance/rejection history (`history_get`, `proposal_list`) and draft a *new skill version* including new approved/rejected examples. Publishing that version and re-pinning both require explicit creator approval in the UI; behavior never changes silently.

### 9.6 Subjective assessment output schema (FR-702, BR-004, business rule 12, R-001)

When the director scores or compares moments (clarity, delivery, emotion, pacing, likely retention), it MUST submit the result through `assessment_submit` using this schema. Assessments are **advisory artifacts**, stored beside the proposal they inform (`proposals/<prp>/assessment.json`) or in `.guyditor/cache/assessments/` when standalone — never part of accepted project state. **Decision (new):** assessments use ID prefix `asm_`, critiques `crt_` (extending the Part 0 registry).

```ts
export interface SubjectiveAssessment {
  assessmentId: string;                     // asm_
  framing: 'recommendation';                // constant; the UI MUST label output as a
                                            // recommendation, never a fact (rule 12, BR-004)
  question: string;                         // what was assessed and why
  criteria: CriterionRef[];                 // full disclosure of the rubric used
  subjects: AssessedMoment[];
  comparison?: { rankedRefs: string[]; rationale: string };  // when comparing alternatives
  limitations: string;                      // REQUIRED uncertainty statement (R-001), e.g.
                                            // "retention estimates are heuristic, not measured"
}
export interface CriterionRef { id: string; source: 'skill_rule' | 'inline';
  skillId?: string; ruleId?: string;        // when source = skill_rule
  text: string; }
export interface AssessedMoment {
  ref: EvidenceRef;                         // the moment itself
  observations: Observation[];              // directly observable facts only
  inferences: Inference[];                  // judgments; each must cite observations
  scores?: { criterionId: string; value: number; scale: '1-5' }[];
}
export interface Observation { id: string; text: string; evidence: EvidenceRef[]; }
export interface Inference { text: string; basedOn: string[];       // Observation ids, ≥ 1
  confidence: 'low' | 'medium' | 'high'; }
export interface EvidenceRef {              // pointer the creator can jump to and inspect
  assetId?: string; sourceRange?: { start: {frames: number; fps: string}; durFrames: number };
  wordRange?: { from: string; to: string }; // word IDs (w000042)
  annotationId?: string; deliverableId?: string; }
```

Validation on submit: every `Inference.basedOn` entry must name an existing `Observation`; every `Observation` must carry ≥ 1 `EvidenceRef` resolvable in the project; `criteria` must be non-empty; missing `limitations` is a schema error. The UI renders assessments with per-evidence "inspect footage" jumps and side-by-side alternative previews so the creator can compare and override (BR-004).

### 9.7 Specialist critic adapter (FR-703)

An optional specialist model that reviews video directly is integrated as a `CriticAdapter` in `AdapterRegistry` — strictly an **adviser**: its output can never become an operation, a proposal, or accepted state by itself. The director must translate accepted critique points into `proposal_create` ops with `Reason.basis: 'media_evidence'` referencing the critique finding; the creator remains final authority.

```ts
export interface CriticAdapter {
  id: string;                                // adp_
  kind: 'critic';
  provider: string;                          // for audit and NFR-001 disclosure
  accepts: { dataClasses: DataClass[]; maxVideoSeconds: number };
  estimate(req: CritiqueRequest): CostEstimate;                 // for 9.13 pre-flight
  critique(req: CritiqueRequest): Promise<CritiqueResult>;
}
export interface CritiqueRequest { critiqueId: string;          // crt_
  subject: { deliverableId?: string; proxyFile: FileRef; range: object };
  rubric: CriterionRef[];                    // built from pinned skill rules
  questions: string[]; }
export interface CritiqueResult { critiqueId: string; adapterId: string; model: string;
  findings: CritiqueFinding[]; rawCostUnits: object; }
export interface CritiqueFinding { id: string; range: object;   // timestamp range in subject
  observation: string; suggestion: string; severity: 'note'|'minor'|'major'; }
```

`critic_request` algorithm: (1) resolve adapter; (2) data-boundary check (9.9) — a critic necessarily receives `video`, so the call fails with `E_DATA_BOUNDARY` unless `video` is allowed for that adapter; (3) CostMeter pre-flight (9.13); (4) run as a job; (5) store the result at `.guyditor/cache/critiques/<crt_id>.json`; (6) append an `external.call` audit record with exact data classes, units, and cost.

### 9.8 Explainability: the required Reason field (FR-704, business rule 6)

Every operation in every proposal carries a `Reason`. This is what the UI shows next to each diff line, satisfying "a user-visible diff and reason accompany every meaningful agent edit".

```ts
export interface Reason {
  text: string;                              // ≤ 280 chars, imperative, creator-readable
  basis: 'instruction' | 'annotation' | 'skill_rule' | 'media_evidence';
  ref: string;    // instruction → audit record ref "ses_x#seq"; annotation → ann_ id;
                  // skill_rule → "skl_x@1.3.0#rule_hook_12s";
                  // media_evidence → serialized EvidenceRef or crt_ finding "crt_x#f3"
}
```

Validation in `proposal_create` step 2: `basis` refs must resolve (annotation exists, skill rule exists at the pinned version, audit seq exists in this session, evidence resolves). A group of homogeneous ops produced by one instruction (e.g. 40 `clip.trim` ops from "remove all filler words") MAY share a single `Reason` via `reasonGroup` — the shared reason still appears on every diff line.

### 9.9 Data boundaries and the external-transfer kill switch (NFR-001, NFR-002)

Data classes (the closed `DataClass` enum, Part 1 §1.8): `metadata` (IDs, structure, durations, settings), `prompt` (instruction/prompt text), `transcript`, `frames` (still images), `audio`, `video`. Every tool row in 9.2 declares its classes; every adapter declares `accepts.dataClasses`; every external call records the classes **actually sent** (9.12).

Policy — global defaults in the `dataBoundaries` block of `~/.guyditor/settings.json` (the Part 1 §1.12 `UserSettings` file; this part owns the block's schema), per-project overrides in the master file (project may only *tighten*, never loosen, the global policy):

```jsonc
// ~/.guyditor/settings.json — dataBoundaries block
{
  "dataBoundaries": {
    "killSwitch": false,             // true → allowedClasses forced to [metadata, prompt] everywhere
                                     // (no media content leaves); all local editing keeps working (NFR-002)
    "allowedClasses": ["metadata", "prompt", "transcript", "frames"],  // minimum-necessary default;
                                                                       // audio and video are opt-in
    "perAdapter": {
      "adp_criticxyz": ["metadata", "transcript", "frames", "video"]   // explicit widening per adapter
    }
  }
}
```

Enforcement algorithm (single choke point, in the gateway/adapter dispatch layer):

1. Determine destination locality: adapters are always external; the director session is external iff `DirectorProfile.locality === 'remote'`. Local directors reading `FileRef` paths perform no transfer — no check applies.
2. Compute the classes the response/request would carry (from tool declaration + actual payload, e.g. a `context_package` without its proxy clip carries no `video` — the package's own `dataClasses` field, Part 8 §8.7).
3. Effective allowlist = `killSwitch ? ['metadata', 'prompt'] : (perAdapter[dest] ?? allowedClasses)`, intersected with the project override.
4. If any class is outside the allowlist, fail with error envelope `{ code: 'E_DATA_BOUNDARY', retry: 'none', suggestion }` naming the blocked classes — never silently degrade the payload.
5. On success, stamp the audit `external.call`/`tool.result` record with the exact classes sent (NFR-001 disclosure), and the UI marks the operation with the external-transfer indicator.

Minimum-necessary defaults (NFR-002): `context_package` excludes the proxy clip and `audioExcerpt` unless requested (Part 8 §8.7.3); critic requests send the proxy tier, never source media; adapters receive only the fields their request schema declares; frame images default to proxy resolution.

### 9.10 Secrets handling (NFR-003, AD-011)

1. Credentials are stored via Electron `safeStorage` (OS keychain), keyed by adapter ID: `credentials.set(adapterId, key, value)` / `credentials.get(adapterId, key)`, exposed only in the main process. No MCP tool reads or returns credentials.
2. Secrets MUST NOT appear in: project files or sidecars, `proposals/`, audit logs, render/export logs, job records, backups (Part 13 excludes the keychain; NFR-108 restore re-enters secrets).
3. The `AuditLog` writer runs a **scrubber** before persisting any record: replaces every currently stored credential value verbatim, plus pattern matches for common token shapes (`sk-…`, `Bearer …`, AWS-style keys), with `«redacted»`.
4. Adapter child processes receive only their own credentials via env injected at spawn; the environment is never logged. `DirectorProfile.env` holds variable *names* to forward, not values.

### 9.11 Audit log record schemas (NFR-007, AD-012)

One append-only JSONL file per session: `~/.guyditor/audit/<ses_id>.jsonl`. Records share an envelope; `ts` is wall-clock ISO-8601 UTC (media positions inside payloads use the Part 0 rational time model).

```ts
export type AuditRecord =
  | SessionRecord | InstructionRecord | ToolCallRecord | ProposalRecord
  | ExternalCallRecord | CostChargeRecord | PolicyRecord | BudgetEventRecord;

interface Base { ts: string; sessionId: string; seq: number;   // monotonic per session
  projectId: string; type: string; }

export interface SessionRecord extends Base { type: 'session.start' | 'session.end';
  director: { profileId: string; modelLabel: string; locality: 'local'|'remote' };
  policySnapshot?: object; }
export interface InstructionRecord extends Base { type: 'instruction';
  source: 'creator' | 'annotation'; text: string; annotationId?: string; }
export interface ToolCallRecord extends Base { type: 'tool.call' | 'tool.result';
  tool: string; callId: string; paramsDigest: object;          // scrubbed, size-bounded
  ok?: boolean; errorCode?: string; dataClassesReturned?: DataClass[]; durationMs?: number; }
export interface ProposalRecord extends Base { type: 'proposal.created' | 'proposal.outcome';
  proposalId: string; opCount?: number; riskClass?: 'low'|'normal'|'consequential';
  outcome?: 'accepted' | 'rejected' | 'withdrawn' | 'auto_accepted';
  transactionId?: string; revision?: string; creatorFeedback?: string; }
export interface ExternalCallRecord extends Base { type: 'external.call';
  adapterId: string; provider: string; purpose: string;
  dataClassesSent: DataClass[];
  payloadSummary: { frames?: number; transcriptWords?: number; videoSeconds?: number;
                    audioSeconds?: number; promptChars?: number };
  units: { inputTokens?: number; outputTokens?: number; images?: number; seconds?: number };
  costUsd: { estimated: number; actual?: number };
  outcome: 'ok' | 'error' | 'cancelled'; durationMs: number; }
export interface CostChargeRecord extends Base { type: 'cost.charge';
  externalCallSeq: number; costUsd: number;
  totals: { taskUsd: number; episodeUsd: number; cumulativeUsd: number }; }
export interface PolicyRecord extends Base { type: 'policy.autoaccept';
  proposalId: string; transactionId: string; matchedPolicy: object; }
export interface BudgetEventRecord extends Base { type: 'budget.event';
  level: 'task'|'episode'|'cumulative'; kind: 'warn'|'cap_block'|'creator_override';
  thresholdUsd: number; projectedUsd: number; }
```

Operational rules: the audit log is operational history, separate from project state (R-007) — it is never required to rebuild a revision. Retention is configurable (`audit.retentionDays`, default 365; pruning runs as a JobQueue job and never deletes the current session). The UI audit browser and a `guyditor audit export` CLI read these files directly (FR-905 spirit: plain text, inspectable with ordinary tools).

### 9.12 CostMeter: budgets and pre-flight warnings (NFR-006)

`CostMeter` (main-process service) prices every external call before it starts and records what it actually cost.

- **Price book** `~/.guyditor/pricebook.yaml`: per adapter, unit prices (`usdPerInputMTok`, `usdPerOutputMTok`, `usdPerImage`, `usdPerVideoSecond`), a `version`, and `updatedAt`. Adapters may override `estimate()` with provider-supplied quotes; the price book is the fallback.
- **Aggregates** live in `~/.guyditor/cost.sqlite` at three levels — **task** (one tool-initiated job or external call chain), **episode** (project), **cumulative** (lifetime, all projects) — and are always rebuildable from the audit JSONL files (audit is the source of truth).
- **Budgets** are the `budgets` block of `~/.guyditor/settings.json` (Part 1 §1.12 `UserSettings`), shaped exactly as `BudgetConfig` below.

```ts
export interface CostEstimate {                // the single CostEstimate schema; Part 7 §7.8 adapters return this type
  adapterId: string;
  currency: string;                            // ISO 4217; v1 budgets assume 'USD'
  amount: number;                              // estimated cost in `currency`
  units: object;                               // workload units the estimate priced (tokens, images, seconds, localCompute…)
  confidence: 'quote' | 'pricebook' | 'heuristic';   // provider quote > price book > heuristic
}
export interface BudgetConfig {
  task:       { warnUsd: number | null; capUsd: number | null };   // defaults: 1.00 / 5.00
  episode:    { warnUsd: number | null; capUsd: number | null };   // defaults: 25.00 / null
  cumulative: { warnUsd: number | null; capUsd: number | null };   // defaults: 100.00 / null
}
export interface CostMeter {
  estimate(adapterId: string, workload: object): CostEstimate;
  preflight(est: CostEstimate, ctx: { sessionId: string; projectId: string; taskId: string;
            initiator: 'creator' | 'agent' }): Preflight;
  charge(rec: ExternalCallRecord): void;      // writes cost.charge + updates aggregates
  status(projectId: string): { taskUsd: number; episodeUsd: number; cumulativeUsd: number;
                               budgets: BudgetConfig };
}
export type Preflight =
  | { verdict: 'proceed' }
  | { verdict: 'warn'; level: 'task'|'episode'|'cumulative'; message: string;
      confirmToken: string }                  // creator must confirm to proceed
  | { verdict: 'blocked'; level: 'task'|'episode'|'cumulative'; message: string };
```

Pre-flight algorithm (runs before **every** external call, including `critic_request` and Part 7 generation adapters):

1. Compute `projected = actualSoFar(level) + estimate.amount` (USD) for each of task, episode, cumulative.
2. If any `projected > capUsd` (non-null) → `blocked`, error envelope `E_BUDGET_CAP`, audit `budget.event(kind: cap_block)`. No call is issued.
3. Else if any `projected > warnUsd` → `warn`: the operation pauses; the UI shows the estimate and levels; agent-initiated calls MUST obtain the creator's `confirmToken` (surfaced in the proposal/agent panel) before the gateway releases the call; creator-initiated calls show a confirm dialog. Audit `budget.event(kind: warn)`.
4. Else → `proceed`. In all issued cases, on completion `charge()` records actual cost, reconciles estimate vs actual in the `external.call` record, and updates all three aggregate levels; `cost_status` and the UI cost panel (Part 10) read the same numbers.

### Part 9 requirements coverage

| BRD ID | Implemented in |
|---|---|
| BR-002 | 9.1 (MCP director sessions, stable tools), 9.2 (tool catalog) |
| BR-003 | 9.1 (config-only director profiles, no per-vendor code), 9.7 (bounded specialist adapters) |
| BR-004 | 9.6 (recommendation framing, evidence, inspect/override), 9.3 (creator acceptance) |
| BR-007 | 9.5 (versioned skill format, approved/rejected examples, rule 3 learning with explicit approval), 9.6 (assessments as inspectable advisory artifacts) |
| FR-005 | 9.2 (`draft_inputs` tool), 9.2.1 (initial-draft workflow; inputs contract in Part 3 §3.6) |
| FR-405 | 9.4 (`context_package` tool; package schema in Part 8 §8.7) |
| FR-700 | 9.5 (skill format, category enum, rules) |
| FR-701 | 9.5 (approved/rejected examples; rule 3: learning via new versions, never silent) |
| FR-702 | 9.6 (`SubjectiveAssessment` schema, validation, UI rendering) |
| FR-703 | 9.7 (`CriticAdapter`, advisory-only flow) |
| FR-704 | 9.8 (`Reason` schema and validation) |
| FR-705 | 9.5 (immutable versions, per-project pinning, `skill.pin.set`) |
| NFR-001 | 9.9 (data classes, per-tool labels in 9.2, disclosure in 9.11 records) |
| NFR-002 | 9.9 (minimum-necessary defaults, kill switch), 9.4 (package defaults) |
| NFR-003 | 9.10 (keychain, scrubber, exclusion rules) |
| NFR-006 | 9.12 (CostMeter, budgets, pre-flight), 9.11 (`cost.charge` records) |
| NFR-007 | 9.11 (audit record schemas, retention), 9.1 (per-session files) |
| Business rule 5 | 9.3 (proposal boundary, default-off automation policy) |
| Business rule 6 | 9.3 (diff + summary per proposal), 9.8 (reason on every op) |
| Business rule 11 | 9.5 (versioned pinned skills, hash verification) |
| Business rule 12 | 9.6 (`framing: 'recommendation'`, criteria + evidence disclosure) |
| R-001 | 9.6 (rubrics, evidence, `limitations`), 9.3/9.7 (creator approval of consequential decisions) |

---

## Part 10 — UI application

This part specifies the Guyditor desktop UI: the Electron renderer application in `packages/app` (`@guyditor/app`, AD-001/AD-002). It owns FR-900..FR-906 and NFR-100, and provides the interaction surface for FR-400 (frame/word navigation). Terms used below: **accepted revision** — the current creator-approved project state (`rev_00017` style IDs, Part 0 §0.4); **proposal** — an agent- or UI-produced change set (`prp_` prefix) living in `proposals/` until accepted or rejected (AD-008); **operation** — a semantic `<noun>.<verb>` mutation executed by the `OperationEngine` (AD-009, catalog in Part 5); **proxy** — lower-resolution derived media used for responsive preview (Part 3).

### 10.1 Unified workspace: panel inventory and layout (FR-900)

The workspace is a single window with **fixed docking regions, resizable splitters, and collapsible panels**. There are no free-floating tool windows in v1 (Decision D10-01). Every panel has a stable `PanelId` used by the layout store, the keyboard map (§10.9), and Playwright tests (AD-014).

```ts
export type PanelId =
  | 'media'       // P1 media and asset browser (assets, takes, generated media)
  | 'preview'     // P2 video preview: WebGL compositor, meters, annotation overlay, comparison
  | 'transcript'  // P3 transcript and subtitle editor
  | 'inspector'   // P4 context properties for current selection (clip, layer, caption, annotation)
  | 'agent'       // P5 agent conversation + proposed-change list + semantic diff + approval controls
  | 'timeline'    // P6 multi-layer timeline with waveforms, markers, beats, annotations
  | 'status';     // P7 deliverable / render-status / job / loudness / cost strip
```

Layout sketch (default arrangement; splitters `┃`/`━` are user-resizable, any side panel collapsible to an icon rail):

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title bar: project name · rev_00017 · search · background-job badge          │
├────────────┬──────────────────────────────────────────┬──────────────────────┤
│ P1 Media   ┃ P2 Preview                               ┃ P5 Agent             │
│  assets    ┃   WebGL proxy compositor / HQ player     ┃  conversation        │
│  takes     ┃   annotation overlay + drawing tools     ┃  proposed changes    │
│  generated ┃   comparison controls (toggle/AB/wipe)   ┃  semantic diff       │
│            ┃   R128 meters + true-peak (right edge)   ┃  accept/reject/revise│
│            ┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫──────────────────────┤
│            ┃ P3 Transcript / subtitle editor          ┃ P4 Inspector         │
│            ┃   words · segments · captions · styles   ┃   selection props    │
├────────────┸──────────────────────────────────────────┸──────────────────────┤
│ P6 Timeline: layer rows · clips with waveforms · transitions · beat/         │
│    annotation markers · playhead · range in/out · zoom + minimap             │
├──────────────────────────────────────────────────────────────────────────────┤
│ P7 Status: deliverables + staleness · render queue · jobs · loudness · cost  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Panel inventory and responsibilities (all FR-900 bullets are covered):

| Panel | Component (in `packages/app/src/renderer/panels/`) | Contents |
|---|---|---|
| P1 `media` | `MediaBrowserPanel` | Asset grid/list (`ast_`), filter by kind, take groups (`tak_`) with marker metadata (FR-010), generated assets with provenance badge (FR-605), drag-to-timeline, relink UI for missing media (FR-007). |
| P2 `preview` | `PreviewPanel` | Player surface (§10.3), annotation drawing tools (Part 8 tool set: note, pin, rect/ellipse, arrow, freehand, spotlight, range), comparison controls (§10.4), meters (§10.7), quality-mode switch, safe-area overlay from the active platform profile. |
| P3 `transcript` | `TranscriptPanel` | Word-level transcript with stable `w000042` IDs, selection → operations (remove/retain/create clip/short candidate, FR-302), caption preview line breaks, correction editing (FR-203), confidence shading. |
| P4 `inspector` | `InspectorPanel` | Schema-driven property editors for the current selection; every edit dispatches a semantic operation (never writes state directly). |
| P5 `agent` | `AgentPanel` | Conversation with the director model (via `AgentGateway`), proposal list, per-proposal semantic diff rendered from operation summary templates (business rule 6), approval controls (§10.5), cost/budget readout from `CostMeter`. |
| P6 `timeline` | `TimelinePanel` | Layer rows (`lyr_`) with enable/disable/lock/reorder, clips (`clp_`) with waveform tiles (§10.7), transitions (`trn_`), gaps/overlaps, annotation (`ann_`) and beat (`beat_`) markers, playhead, in/out range. |
| P7 `status` | `StatusStripPanel` | Deliverables (`dlv_`) with stale badges (FR-807), render queue with progress/cancel/retry (FR-1003), `JobQueue` job list (AD-010), integrated-loudness last reading, session cost. |

### 10.2 State architecture: view state vs. project truth (FR-901)

**Binding rule (AD-002/AD-009):** project truth lives only in the main process (`ProjectStore` + `OperationEngine`). The renderer holds (a) a read-only **project mirror** and (b) **view state**. Zustand stores never contain writable project truth; every mutation — from timeline drag, transcript selection, inspector field, annotation tool, or agent — is a semantic operation through the same API, so anything done visually is expressible semantically and every agent proposal is visible and adjustable in the same panels (FR-901, FR-006).

Renderer stores (all in `packages/app/src/renderer/state/`):

| Store | Holds |
|---|---|
| `useProjectMirror` | Immutable snapshot of the open project + applied patches (read-only). |
| `useWorkspaceStore` | `WorkspaceLayoutState`: panel sizes, collapsed flags, active tabs. Persisted to `~/.guyditor/state/ui-state.json` (Part 1 §1.12), never to the project (Decision D10-02). |
| `useSelectionStore` | Selected clip/layer/word/annotation/deliverable IDs; marquee state. |
| `useTimelineViewStore` | Zoom (px per frame), scroll offset, track heights, snapping flags. |
| `usePreviewStore` | Playhead (`{ frames, fps }` of the active sequence), play state, quality mode, comparison session, loop range. |
| `useTranscriptViewStore` | Scroll position, follow-playhead flag, correction draft text. |
| `useAgentPanelStore` | Conversation scroll, expanded proposal, per-operation exclusion set. |
| `useJobsStore` | Mirror of `JobQueue` job records from `job.state` / `job.progress` events (Part 1 §1.3). |
| `useUndoStore` | Undo/redo stacks (§10.5). |

IPC contract. The renderer uses the Part 1 §1.3 two-channel contract verbatim: requests go through `ipcRenderer.invoke('gd:rpc', req)` and server-push events arrive on `'gd:evt'`; the preload script exposes exactly one typed bridge (`contextBridge`) as `window.guyditor: GuyditorApi` — `call(service, method, params)` + `on(kind, handler)`. No per-method channels exist, and no synchronous IPC anywhere (NFR-100).

```ts
// packages/app/src/renderer/ipc.ts — typed conveniences over window.guyditor.call(...).
// They add no channels and no semantics of their own (Part 1 §1.3 rule 1).
export const executeOperations = (req: ExecuteRequest) =>
  guyditor.call('OperationEngine', 'execute', req) as Promise<ExecuteResult>;
export const getSnapshot = (projectPath: string) =>
  guyditor.call('ProjectStore', 'getSnapshot', { projectPath }) as Promise<ProjectSnapshot>;
export const getPatch = (fromRevision: string, toRevision: string) =>
  guyditor.call('ProjectStore', 'getPatch', { fromRevision, toRevision }) as Promise<ProjectPatch>;
export const listHistory = (filter?: { entityId?: string; fromRev?: string }) =>
  guyditor.call('ProjectStore', 'listHistory', { filter }) as Promise<TransactionRecord[]>;

// Push events are the Part 1 §1.3 GdEvent kinds. Events are thin and droppable (rule 3):
// on 'project.revision' the mirror fetches the delta via getPatch(mirror.revision, evt.revision)
// (falling back to a full getSnapshot when the range is unavailable); 'proposal.updated' and
// 'annotation.updated' trigger a re-query of the affected record; 'job.state'/'job.progress'
// feed useJobsStore directly from the event payload.

export interface ExecuteRequest {
  operations: SemanticOperation[];      // Part 5 catalog, JSON-Schema validated
  intent: 'direct' | 'undo' | 'redo';   // provenance for FR-104
  label: string;                        // human summary, e.g. "Trim clp_ab12cd34ef by 30 frames"
  undoOf?: string;                      // txn_ id when intent is undo/redo
}
export interface ExecuteResult { txnId: string; revision: string; inverse: SemanticOperation[]; }
export interface ProjectSnapshot { revision: string; master: MasterFileDoc; sidecarIndex: SidecarRef[]; }
export interface ProjectPatch { fromRevision: string; toRevision: string; jsonPatch: JsonPatchOp[]; summary: string[]; }
```

Mutation flow (algorithm):

1. A UI gesture completes (e.g. clip trim handle released). The panel builds the semantic operation(s) with exact `{ frames, fps }` values — during the drag, only view state changes (ghost outline), never the mirror.
2. Renderer calls `executeOperations({ operations, intent: 'direct', label })` — i.e. `guyditor.call('OperationEngine', 'execute', …)` over `gd:rpc`.
3. `OperationEngine` validates against the operation's JSON Schema, applies it to the accepted state, appends the transaction to `history/transactions.jsonl` (AD-008), and returns `{ txnId, revision, inverse }`.
4. Main process broadcasts the `project.revision` event (Part 1 §1.3); `useProjectMirror` fetches the `ProjectPatch` via `getPatch` and applies it; all panels re-render from selectors. The originating panel pushes `{ txnId, ops, inverse, label }` onto `useUndoStore`.
5. On error, nothing changed (`acceptedStateChanged: false` in the envelope); the ghost is discarded and the error surfaces per NFR-104 (affected IDs are highlighted in the relevant panel).

Component-to-package mapping: all React components live in `@guyditor/app`; they import **pure logic only** from workspace packages — schema types, diff/summary formatting from `@guyditor/core`; caption layout engine (shared with final render) from `@guyditor/transcript`; layer transform math and responsive layout solving from `@guyditor/compositor`; the deterministic overlay renderer (identical code path as final render, AD-006) from `@guyditor/render`; platform-profile types from `@guyditor/deliver`. UI components never import `@guyditor/media` or spawn processes; all media work is requested over IPC.

### 10.3 Preview system and quality modes (FR-902)

```ts
export type PreviewQualityMode = 'proxy' | 'hq';
export interface HqPreviewRequest {
  sequenceId: string;                        // seq_
  range: { start: FrameTime; end: FrameTime }; // timeline frames at sequence fps
  reason: 'keyEdges' | 'compositing' | 'motion' | 'captions' | 'manual';
}
export interface PreviewController {
  mode: PreviewQualityMode;
  setMode(mode: PreviewQualityMode): void;
  requestHq(req: HqPreviewRequest): Promise<{ jobId: string }>;
  hqCoverage(): Array<{ range: [FrameTime, FrameTime]; state: 'ready' | 'rendering' | 'stale' }>;
}
```

- **`proxy` mode (default).** Per-layer proxy media is composited live in the renderer by the WebGL compositor, frame-synced via `requestVideoFrameCallback` (AD-005). Captions and template graphics are drawn by the shared overlay renderer, so what you preview is what final render composites (FR-206). If sustained compositing drops below 24 fps, the compositor degrades visibly in fixed order — (1) disable edge-refinement preview on keys, (2) reduce compositor canvas to ½ resolution, (3) skip non-selected adjustment layers — and shows a "degraded preview" badge. Degradation never alters project state.
- **`hq` mode.** The creator selects a range (current in/out range, current clip, an annotation's range, or the extent of a proposal's affected entities) and requests HQ. `RenderService` renders that segment through the final-render path (AD-006) into `.guyditor/cache/hqpreview/<cacheKey>.mp4`, where `cacheKey` follows AD-013 (content hashes + operation parameters + tool versions). The player swaps the cached file in for that range and shows an "HQ" badge; outside covered ranges playback falls back to proxy compositing with a subtle border-color change so the boundary is visible.

HQ switching algorithm:

1. On `requestHq`, snap the range outward to the nearest clip boundaries plus 12 frames of padding on each side (Decision D10-03) so transitions render in context.
2. Compute the cache key; if a ready cache entry exists, activate it immediately (no job).
3. Otherwise enqueue a `render.hqpreview` job on `JobQueue`; progress appears in P7; the range shows "rendering" hatching in the timeline ruler.
4. On completion, if the playhead is inside the range, the player switches sources at the next `requestVideoFrameCallback` boundary (no visible seek).
5. Any accepted transaction or previewed proposal whose operations touch a contributing entity invalidates overlapping HQ entries (they flip to `stale` and are re-requestable with one click); cache files are evicted LRU under the Part 13 cache budget.

### 10.4 Comparison workflows (FR-903)

```ts
export type ComparisonMode = 'toggle' | 'sideBySide' | 'wipe';
export type ComparisonSource =
  | { kind: 'revision'; revision: string }                    // accepted revision (rev_)
  | { kind: 'proposal'; proposalId: string }                  // prp_ preview state
  | { kind: 'take'; takeId: string }                          // tak_ alternative
  | { kind: 'keyConfig'; clipId: string; params: KeyParams; background: 'black' | 'white' | 'saturated' | 'checker' | 'composite' }
  | { kind: 'layout'; presetId: string }                      // pre_ PiP/layout preset applied transiently
  | { kind: 'reframe'; deliverableId: string };               // dlv_ vertical recomposition vs landscape source
export interface ComparisonSession {
  mode: ComparisonMode;
  a: ComparisonSource;        // baseline (usually the accepted revision)
  b: ComparisonSource;        // candidate
  linkTransport: boolean;     // one playhead drives both (default true)
  wipePosition?: number;      // 0..1, draggable vertical split (wipe mode)
}
```

Modes, all rendered inside P2:

- **`toggle` (before/after):** one player surface; the `\` key (§10.9) flips between A and B at the same timeline frame. Fastest for spot checks.
- **`sideBySide` (A/B):** two synced surfaces. For `take` comparisons the transports are aligned by transcript word (`w` IDs) rather than raw time, so the same sentence plays in both takes; a delivery/technical summary from FR-304 analysis is shown beneath each side.
- **`wipe`:** both sources composited into one surface split by a draggable vertical line — the primary tool for key quality (matte vs composite) and reframe checks.

Where each comparison appears:

| Context | Baseline A | Candidate B | Entry point | BRD |
|---|---|---|---|---|
| Agent proposal | accepted revision | proposal preview state | P5 "Preview" on a proposal; diff rows link to affected ranges | FR-105, FR-903 |
| Takes | current take in edit | alternative `tak_` | P1 take group → "Compare"; agent recommendation shown with reasons | FR-304 |
| Key settings | current key params | adjusted params over diagnostic background (black/white/saturated/checker per FR-504) | P4 inspector on a keyed clip | FR-502/504 |
| Layouts | current layout | named layout/PiP preset (`pre_`) applied transiently (not committed) | P4 layout section; committing dispatches the corresponding operations | FR-506..509 |
| Short-form reframe | landscape source frame | vertical recomposition | P7 deliverable → "Review reframe"; per-shot correction dispatches reframe operations | FR-803 |
| Revisions | rev A | rev B | history viewer (§10.6) "Compare" | FR-108 |

Transient candidates (`keyConfig`, `layout`) render through the proxy compositor with overridden parameters and are discarded unless the creator clicks **Apply**, which dispatches the equivalent semantic operations (FR-901). Proposal previews render from the proposal's projected state without touching accepted files (FR-105).

### 10.5 Undo/redo and proposal controls (FR-904)

**Undo/redo (direct UI actions).** The transaction journal is append-only (AD-008), so undo never rewrites history: it executes the stored inverse operations as a *new* transaction.

```ts
export interface UndoStackEntry { txnId: string; label: string; ops: SemanticOperation[]; inverse: SemanticOperation[]; }
```

1. Every successful direct `ExecuteResult` pushes an `UndoStackEntry` (inverse comes from the engine, derived from Part 5 inverse metadata) onto `useUndoStore.undo`; `redo` is cleared.
2. **Undo** pops the entry, calls `executeOperations({ operations: entry.inverse, intent: 'undo', undoOf: entry.txnId, label: 'Undo: ' + entry.label })`, and pushes the entry onto `redo`.
3. **Redo** mirrors this with `entry.ops` and `intent: 'redo'`.
4. Stacks are per open project, in-memory, depth 200 (Decision D10-04). If an operation from another actor (agent acceptance) lands in between, entries whose inverse no longer validates are greyed out with the reason, not silently dropped.
5. Agent proposals are **not** on the undo stack; their controls are below. Accepting a proposal clears nothing — undoing past an acceptance is done via the history viewer's revision restore (FR-108), which is an explicit, labeled operation.

**Proposal controls (P5).** Each proposal shows: the agent's reason (FR-704), the semantic diff (one row per operation, rendered from its summary template), risk-class badges, affected-entity chips that highlight in the timeline/preview, and a "Preview" comparison launcher (§10.4).

- **Accept** — applies the proposal's operations as one accepted transaction referencing `prp_` id and the originating instruction/annotation (FR-104); resolves any addressed annotation (FR-406).
- **Accept partial** — per-operation exclusion checkboxes (Decision D10-05); excluded operations are recorded as rejected within the proposal record. The engine re-validates the reduced set before applying; if the subset is inconsistent, the specific conflicting rows are flagged.
- **Reject** — marks the proposal rejected in `proposals/`; accepted revision is untouched (FR-105).
- **Revise** — opens an inline instruction box pre-filled with the proposal context; sends the feedback to the same agent session via `AgentGateway`; the revised proposal supersedes (links to) the original.

### 10.6 Accessible project state affordances (FR-905)

The project must stay understandable without the UI; the UI actively hands the creator over to plain files:

- **Reveal in file manager** — project menu and P7 context actions call Electron `shell.showItemInFolder` on `episode.guyditor.yaml` (also available per-asset on `ast_` items and per-deliverable on export outputs).
- **Open master in editor** — `shell.openPath` on the master file, with a non-blocking notice that external edits are detected on window focus via mtime+hash and offered as a reviewable reload (never auto-merged).
- **Copy path / copy ID** — every entity chip (asset, clip, annotation, deliverable) offers "Copy ID" so IDs can be grepped in the master, sidecars, and journal.
- **Semantic history viewer** — a modal reading `history/transactions.jsonl` via `listHistory`. It groups transactions by revision; each row shows the summary template output, actor (human/agent/tool), instruction or annotation that caused it (FR-104), and skill/model versions. Filters: by entity ID, actor, revision range. Actions: "Compare revisions" (launches a `revision`-vs-`revision` comparison, §10.4) and "Restore this revision" (dispatches the Part 2 restore operation as a new labeled transaction, FR-108). The viewer renders exactly what the journal contains — no UI-only annotations — so the same understanding is reachable with `less` and `grep` (AC-002).

### 10.7 Waveforms and metering (FR-906)

**Peaks cache (produced by `MediaEngine`, Part 3 §3.4; consumption contract fixed here, Decision D10-06).** Waveform peaks are the disposable cache file `.guyditor/cache/peaks/<astId>.<hash8>.peaks.json` (`format: guyditor.peaks/v1`, Part 3 §3.4): mono interleaved min/max int8 pairs at the three fixed tiers `samplesPerPeak` 960 / 9 600 / 48 000. Peaks are **never** registered in the master file — they are regenerable cache under the Part 1 §1.10 disposability invariant, keyed to the source via the filename `hash8` and the embedded `sourceHash`.

**Waveform tile rendering (TimelinePanel), algorithm:**

1. For the current zoom (px per frame → samples per pixel), pick the smallest tier whose `samplesPerPeak ≤ samplesPerPixel * 4` (when zoomed closer than the finest tier serves, use tier 960 and stretch its peaks across pixels); aggregate min/max across peaks per pixel column.
2. Waveforms are drawn into 512-px-wide offscreen canvas **tiles** keyed by `(assetId, tier, tileIndex, rowHeightPx, theme)`; an LRU cache holds 512 tiles (Decision D10-07).
3. During scroll/zoom, cached tiles blit synchronously; missing tiles render on `requestIdleCallback` and fade in — scrolling never blocks on waveform work (NFR-100).
4. Clip gain and fades (FR-301/308) are drawn as an envelope overlay on the tile, not baked into it, so gain edits don't invalidate the cache.
5. If the peaks cache file is missing or stale (its `sourceHash` no longer matches the asset, Part 3 §3.4), the clip shows a flat placeholder plus a one-click "Rebuild peaks" job; rendering never blocks on generation.

**Loudness and true-peak metering (PreviewPanel).** Preview audio runs through a Web Audio graph; a `LoudnessWorklet` (AudioWorklet, Decision D10-08) implements ITU-R BS.1770-4 / EBU R128 on the actual preview mix (post ducking and clip gain, so FR-309 ducking is verifiable by ear and meter):

```ts
export interface LoudnessFrame {   // posted by the worklet at 10 Hz
  momentaryLufs: number;           // 400 ms window
  shortTermLufs: number;           // 3 s window
  integratedLufs: number | null;   // gated (−70 LUFS absolute, −10 LU relative) over the measurement session
  truePeakDbtp: number[];          // per channel, 4× oversampled, 3 s hold
}
export interface LoudnessTargetOverlay {   // field names mirror the profile's audio.loudness block (Part 11 §11.6)
  integratedLufs: number; toleranceLu: number; truePeakDbtp: number; profileId: string;
}
```

Meter UI: vertical M / S / I bars plus per-channel true-peak with numeric readouts; the integrated measurement runs while playing and offers "Reset measurement". The **target overlay** comes from the active deliverable's platform profile (Part 11 §11.6 profiles carry `audio.loudness: { integratedLufs, toleranceLu, truePeakDbtp, lraMaxLu }`, FR-805): the target band is drawn on the I bar, the true-peak ceiling as a red line, and a pass/warn/fail badge summarizes the current measurement. The meter is advisory; export validation (FR-1004, Part 12) remains the authority — the badge says so on hover.

### 10.8 Responsiveness budgets and virtualization (NFR-100)

Binding interaction budgets on the supported workstation (measured in the Part 14 performance suite; a regression is a failing test):

| Interaction | Budget |
|---|---|
| Input → visible acknowledgment (any click/drag/keypress) | ≤ 100 ms |
| Frame step (proxy, cached neighborhood) | ≤ 80 ms to displayed frame |
| Scrub: displayed frame during drag | ≤ 100 ms behind pointer |
| Transcript word click → selection highlight | ≤ 50 ms |
| Normal operation round trip (execute → patched UI) | ≤ 150 ms |
| Timeline zoom/scroll, panel resize | 60 fps (no frame > 32 ms) |
| Proposal diff render (≤ 200 operations) | ≤ 300 ms |

Rules and strategies:

1. **No synchronous IPC; no blocking work on the renderer main thread.** Anything projected over 50 ms of compute goes to a worker (waveform aggregation, diff formatting for large proposals) or to `JobQueue` in the main process with progress in P7 (analysis, transcription, renders — "visible background work", FR-009/NFR-100).
2. **Timeline virtualization.** Only clips intersecting the visible range ± one viewport width are mounted; layer rows outside the vertical viewport render as flat summary strips. Annotation/beat markers denser than one per 8 px collapse into numbered cluster chips that expand on click.
3. **Transcript virtualization.** Windowed list keyed by word ordinal, overscan two screens; per-word spans are plain DOM (no per-word React component) with event delegation, so hour-long transcripts (~10k words) stay responsive.
4. **Patch batching.** `project.revision` events arriving within one animation frame are coalesced into one `getPatch` fetch before the mirror applies the result.
5. **Media readiness.** Proxy `<video>` elements for the playhead clip and its two timeline neighbors are kept warm; others are released. Waveform tiles per §10.7.

### 10.9 Keyboard map (FR-400 support, FR-301 navigation)

Defaults below; `Ctrl` means `Cmd` on macOS. The map is fixed in v1 but read from `~/.guyditor/keymap.json` at startup so it is user-overridable without a settings UI (Decision D10-09). Frame and word navigation are the FR-400-critical rows.

| Keys | Action |
|---|---|
| `Space` | Play / pause |
| `J` / `K` / `L` | Shuttle reverse / stop / forward (repeat to speed up) |
| `←` / `→` | Step **−1 / +1 frame** |
| `Shift+←` / `Shift+→` | Step −10 / +10 frames |
| `Alt+←` / `Alt+→` | Jump to **previous / next transcript word** start (`w` IDs) |
| `Ctrl+←` / `Ctrl+→` | Jump to previous / next clip boundary |
| `B` / `Shift+B` | Next / previous story beat (`beat_`) |
| `A` / `Shift+A` | Next / previous annotation (`ann_`) |
| `Home` / `End` | Sequence start / end |
| `I` / `O` | Set range in / out (drives HQ preview, comparison, short-form candidate) |
| `M` | Add annotation at playhead (opens tool chooser) |
| `\` | Comparison A/B toggle (when a comparison session is active) |
| `Q` | Toggle preview quality mode (`proxy` ↔ `hq` for the current range) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo (§10.5) |
| `Ctrl+Enter` (in P5) | Accept focused proposal |
| `1`–`7` | Focus panel P1–P7 |

Scrubbing to an exact frame (FR-400): the timeline ruler and preview scrub bar both snap-release to integer frames at the sequence fps; the transport readout shows `HH:MM:SS:FF` timecode plus the raw `{ frames, fps }` value on hover, and clicking a transcript word seeks to that word's first frame.

### Part 10 requirements coverage

| Requirement | Implemented in |
|---|---|
| FR-900 | §10.1 (panel inventory, layout, docking model) |
| FR-901 | §10.2 (project mirror, Zustand view stores, `GuyditorApi` IPC per Part 1 §1.3, mutation flow, package mapping); §10.4 (Apply dispatches semantic operations) |
| FR-902 | §10.3 (`proxy`/`hq` modes, HQ request/caching/invalidation, degradation rules) |
| FR-903 | §10.4 (`toggle`/`sideBySide`/`wipe`, `ComparisonSession`, context table for proposals, takes, keys, layouts, reframes) |
| FR-904 | §10.5 (inverse-operation undo/redo, accept / accept-partial / reject / revise) |
| FR-905 | §10.6 (reveal-in-file-manager, open-master-in-editor, copy ID, semantic history viewer) |
| FR-906 | §10.7 (peaks sidecar contract, tile rendering, EBU R128 M/S/I + true peak, platform-profile target overlay); §10.1 P6/P7 |
| NFR-100 | §10.8 (interaction budgets, virtualization, IPC/threading rules); §10.3 degradation; §10.7 steps 3/5 |
| FR-400 (support) | §10.9 (frame/word keyboard map, exact-frame scrub) — annotation model itself is Part 8 |

---

## Part 11 — Deliverables, shorts, and publish kits

This part specifies the `DeliverableService` (main process) and the `@guyditor/deliver` package (`packages/deliver`): the deliverable model in the master file, short-form candidate discovery, derivative editing and vertical recomposition, platform profiles, staleness tracking, batch export, and publish packaging (metadata, chapters, thumbnails, upload kits, text exports). It implements FR-800..FR-813, R-004, and business rules 9 and 10.

Terms used below (defined in Parts 0/2/4 and restated here for self-containment): a **sequence** (`seq_`) is an ordered list of clips; a **clip** (`clp_`) references an asset (`ast_`) plus a source range in that asset's native frame time `{ frames: <int>, fps: "<num>/<den>" }`; a **word** is a canonical transcript word with stable ID `w000042` (never renumbered); a **beat** (`beat_`) is a named story moment anchored to a word or clip; a **deliverable** (`dlv_`) is one exportable output. Timeline positions are always derived from sequence order and durations (Part 0 time model). All operations below follow the Part 0 `<noun>.<verb>` grammar, are catalogued in Part 5's registry, and go through `OperationEngine` as proposals unless covered by the low-risk automation policy (business rule 5).

```ts
// packages/deliver/src/model.ts — all types exported from @guyditor/deliver
export interface FrameTime { frames: number; fps: string }        // Part 2 canonical serialization
export interface WordRange { startWordId: string; endWordId: string } // inclusive, canonical word IDs
export interface NormRect { x: number; y: number; w: number; h: number } // normalized 0..1, top-left origin
```

### 11.1 Deliverable model and lifecycle (FR-800)

Every project has exactly one deliverable of kind `longform` (created by `project.create`, Part 3) and zero or more of kind `short`. Deliverables live in the master file under the top-level `deliverables:` key. Each deliverable owns its own sequence; the long-form deliverable's sequence is the main timeline. Render/output parameters come from a pinned platform profile (11.6) plus explicit overrides, satisfying FR-800's configurable resolution, frame rate, codec, audio format, and caption options.

```ts
export type DeliverableKind = 'longform' | 'short';
export type DeliverableStatus = 'draft' | 'in-review' | 'approved' | 'stale';
export type DivergenceClass =
  'hook' | 'order' | 'pacing' | 'cuts' | 'graphics' | 'captions' | 'cta' | 'ending' | 'framing';

export interface SourceRangeRef {
  assetId: string;                                   // ast_
  range: { start: FrameTime; end: FrameTime };       // source time, end-exclusive
  words?: WordRange;                                 // word anchors when the range carries speech
  longformClipId?: string;                           // clp_ in the long-form sequence at derivation time
}
export interface DependencyEntry { derivativeClipId: string; source: SourceRangeRef }

export interface StaleReason {
  transactionId: string;                             // txn_ that caused staleness
  revision: string;                                  // rev_NNNNN produced by that transaction
  affected: { dependency: DependencyEntry; change: string }[]; // human-readable per-range explanation
  detectedAt: string;                                // ISO-8601 UTC
}

export interface Deliverable {
  id: string;                                        // dlv_
  kind: DeliverableKind;
  name: string;
  profile: string;                                   // '<profileId>@<semver>', e.g. 'youtube-shorts@1.0.0'
  profileOverrides?: object;                         // deep-merge patch over the profile; reviewed like any edit
  sequenceId: string;                                // seq_ owned exclusively by this deliverable
  captionsTrackId?: string;                          // cts_ derivative caption track (11.5)
  status: DeliverableStatus;
  approvedRevision?: string;                         // rev_ at last deliverable.approve
  dependencies?: DependencyEntry[];                  // shorts only — the dependency map (11.8)
  divergences?: { class: DivergenceClass; transactionIds: string[] }[]; // business rule 9 traceability
  staleReasons?: StaleReason[];                      // present only while status === 'stale'
  publishFiles?: { path: string; sha256: string }[]; // publish/<dlvId>/... references (rule 4 hashing)
}
```

Lifecycle: `draft → in-review → approved`; an accepted upstream change affecting an approved short moves it `approved → stale` (11.8); an accepted refresh moves it `stale → in-review`; `deliverable.approve` (risk class `consequential`, always creator-confirmed) sets `approved` and records `approvedRevision`. Rejecting a refresh leaves it `stale` untouched. `deliverable.export` and `deliverable.kit.build` require `approved` and refuse `stale` with error `{ code: 'E_DELIVERABLE_STALE', retry: 'none', acceptedStateChanged: false, suggestion: 'Run deliverable.refresh and review the diff' }` (Part 0 error envelope).

### 11.2 Short candidate discovery and manual selection (FR-801)

**Automatic discovery.** `deliverable.candidates.discover { profile, maxCandidates?: number = 8, constraints?: { mustIncludeBeats?: string[], durationSeconds?: {min,max} } }` enqueues a `JobQueue` job (kind `candidates`). Results are derived, disposable data written to `.guyditor/cache/candidates/<revision>.json` — they are not project state until a candidate is derived (11.3).

Scoring inputs: the canonical transcript sidecar (words + timing, Part 4), beats, silence/VAD analysis (Part 3), and the hook/retention rubric skills (`skl_`, FR-700) pinned by the project. Algorithm:

1. Build candidate windows: every span between consecutive beat boundaries, plus every merged run of such spans whose duration fits the profile's `duration.min/max`; additionally split on silences > 2.0 s. Discard windows outside duration bounds.
2. Score **hook** (0..1) on the first 2.5 s of the window using deterministic heuristics — presence of a question, a number, an imperative, a named entity, or a contrarian/negation pattern — combined with the agent's rubric-based judgment via the `AgentGateway` (criteria disclosed per business rule 12).
3. Score **coherence** (0..1): penalize unresolved references (window-initial pronouns/deictics without an in-window antecedent), sentences cut mid-clause at either boundary, and dependencies on visuals not present in the window's layers.
4. Score **payoff** (0..1): reward conclusion markers ("so", "that's why", result statements) and a beat marked `payoff` in the final third.
5. `overall = 0.4·hook + 0.35·coherence + 0.25·payoff` (weights overridable by the rubric skill). Rank, drop overlapping windows keeping the higher score (>50 % word overlap counts as overlapping), emit top `maxCandidates`.

```ts
export interface ShortCandidate {
  candidateId: string;                    // cache-local, not a project ID
  words: WordRange;
  beats: string[];                        // beat_ ids inside the window
  durationSeconds: number;
  scores: { hook: number; coherence: number; payoff: number; overall: number };
  evidence: { hookLine: string; reasons: string[]; criteria: string[] };  // rule 12 / FR-702
}
```

**Manual selection.** The creator may derive a short from any of: a timeline range of the long-form sequence, a transcript word range, a clip range, or a beat (or beat span). All four resolve to the same `deliverable.derive` parameters (11.3); the UI performs the resolution, the operation only ever receives explicit anchors.

### 11.3 Derivation and independent derivative edits (FR-802, business rule 9)

`deliverable.derive { kind: 'short', name, profile, from: { words?: WordRange, clips?: string[], beats?: string[], timelineRange?: ... }, candidateId? }` (risk `normal`, proposal-gated) does:

1. Resolve `from` to an ordered list of `SourceRangeRef`s: for word ranges, map word IDs to source asset ranges via the transcript sidecar; for clips/beats/timeline ranges, take the covered long-form clips' asset + source ranges, recording `longformClipId` and covered `words` for each.
2. Create a new sequence `seq_` with one clip per `SourceRangeRef` (same assets, same source ranges — never re-encoded media), a derivative caption track `cts_` (11.5), and copies of the long-form layer stack restricted to the range (layers referenced, not duplicated, where immutable).
3. Write the `Deliverable` record with `dependencies` = one `DependencyEntry` per created clip, `status: 'draft'`.
4. Enqueue the vertical recomposition pipeline (11.4) if the profile aspect differs from the source composition.

**Override model.** After derivation the derivative is edited with the ordinary Part 5 operations (`clip.trim`, `clip.move`, `clip.split`, `layer.add`, `caption.style.set`, `transition.set`, …) scoped to the derivative's sequence. This is the whole model — there is no second operation vocabulary. Two rules keep divergence traceable (business rule 9):

1. Every transaction touching a derivative sequence MUST carry a `divergence` field naming one `DivergenceClass` (`hook`, `order`, `pacing`, `cuts`, `graphics`, `captions`, `cta`, `ending`, `framing`). The UI and `AgentGateway` require it; `OperationEngine` rejects derivative-scoped transactions without it. Transaction IDs accumulate under `Deliverable.divergences`, so "how does this short differ from the master?" is answerable by class from the journal alone.
2. Clips keep provenance. A derivative clip either descends from a `DependencyEntry` (its `derivativeClipId` follows splits/trims: the engine updates the dependency map on `clip.split`/`clip.trim` by narrowing `source.range`/`source.words`) or is **local** — added only in the derivative (hook title card, CTA end card, B-roll). Local clips are marked `origin: 'local'` in the sequence and are excluded from staleness intersection (11.8) but included in export.

Derivative operations never mutate the long-form sequence; the long-form sequence never references derivative clips. Source traceability (business rule 3) is preserved because every non-local derivative clip resolves to asset + source range + word anchors.

### 11.4 Vertical recomposition pipeline (FR-803, R-004)

Recomposition is a `JobQueue` job (kind `reframe`) run at derivation and re-run per-shot on refresh. It implements every R-004 mitigation: layer-level recomposition, subject/interface tracking, safe-area constraints, shot-level previews, and manual correction of every automated decision.

**Stage 1 — subject tracking.** For each source asset in the derivative, ensure the Part 3 §3.5 `subject.track` analysis sidecar exists and is fresh: `sidecars/analysis/<assetId>.subject.track.json`, common envelope `guyditor.analysis/v1`, schema-versioned and hashed (business rule 4); missing or stale sidecars enqueue the mlworker `track` task (Part 1 §1.2). The sidecar's `data` is the sampled-boxes shape defined in Part 3 §3.5 — normalized boxes with `kind: 'face' | 'body' | 'object' | 'screen-region'` (`screen-region` = detected UI/diagram area) and a `trackId` stable per subject within the asset. There is no second tracking sidecar: Part 6 §6.12 collision avoidance reads this same file.

**Stage 2 — shot segmentation.** The derivative sequence is split into **shots**: maximal clip spans with no cut, using clip boundaries plus the scene-detection sidecar (Part 3) within clips.

**Stage 3 — per-shot framing decision.** For each shot, deterministically (AD-013):

1. Load tracked boxes for the shot's source range; select subjects: all `face`/`body` tracks with mean confidence ≥ 0.5, plus `screen-region` tracks overlapping any enabled screen-recording layer.
2. If the shot's composition has ≥ 2 independently movable layers (presenter over screen recording, PiP, diagram layers), choose `mode: 'recompose'`: select the vertical responsive layout constraint set (Part 6, FR-511) named by the profile (`captionDefaults`/safe areas feed the solver), producing per-layer placement instead of cropping the flattened frame.
3. Otherwise choose `mode: 'crop'`: compute the subject envelope per frame (union of subject rects, padded 15 %), fit the profile's aspect (e.g. 9:16) around the envelope centroid, clamp to frame, and smooth the crop path with a centered moving average over 0.5 s; collapse to keyframes where movement < 1 % of frame width. Keep all subjects inside the profile's action-safe area; if impossible, prefer faces and record a warning.
4. Emit a `FramingDecision`; render a shot-level proxy preview strip (first/middle/last frame plus motion path overlay) into `.guyditor/cache/reframe/<dlvId>/`.

```ts
export interface FramingDecision {
  decisionId: string;                                  // 'fd_' + shot ordinal, stable across re-runs of same shot
  shot: { clipId: string; source: { start: FrameTime; end: FrameTime } };
  mode: 'crop' | 'recompose';
  crop?: { keyframes: { at: FrameTime; rect: NormRect }[] };   // source-time keyframes
  layout?: string;                                     // named Part 6 responsive constraint set
  subjects: string[]; confidence: number; warnings: string[];
  overriddenBy?: string;                               // FramingOverride id when manually corrected
}
export interface FramingOverride {
  id: string; decisionId: string;
  crop?: { keyframes: { at: FrameTime; rect: NormRect }[] };
  layout?: string;
  note?: string;
}
```

Decisions are stored in `sidecars/framing/<dlvId>.framing.json` (schema `guyditor.framing/v1`, registered per Part 2 §2.8; hashed, referenced from the master file). **Every** decision is correctable: `deliverable.framing.override { deliverableId, override: FramingOverride }` (risk `low`; direct-UI drag of the crop box or layer emits it) stores overrides in the master file itself so they are diff-visible, and re-runs never discard them: a re-run only replaces decisions whose `decisionId` has no surviving override for unchanged source content. Overrides count as divergence class `framing`.

### 11.5 Short-form subtitles (FR-804)

Derivative captions always read the **canonical** word timing — the derivative caption track `cts_` contains no word text or timing of its own, only (a) a reference to the deliverable's sequence and (b) style/layout overrides. Rendering maps each canonical word through the derivative sequence (Part 4 timeline-mapping algorithm: word source time → owning clip → derived timeline time); words whose source range is not in the derivative simply do not appear. Transcript corrections (FR-203) therefore propagate to all shorts automatically, and re-timing follows FR-208.

Style resolution order (later wins): project caption preset (`pre_`) → profile `captionDefaults` (11.6) → derivative overrides set via `caption.style.set` on the derivative's `cts_` track (divergence class `captions`). Overridable per platform: font size, weight, max lines, max chars per line, placement (anchored inside the profile's title-safe area), entrance animation, and per-word highlight style. Line-breaking re-runs per deliverable with the resolved constraints; canonical word IDs keep highlight timing exact.

### 11.6 Platform profiles (FR-805)

A platform profile is a versioned YAML document, schema `guyditor-profile/v1`. Built-in profiles ship in the repo `profiles/` directory as `profiles/<profileId>/<semver>.yaml` and are packaged read-only with the app. Resolution order for `<id>@<version>`: project `profiles/` directory → user `~/.guyditor/profiles/` → built-ins; unknown references fail with `{ code: 'E_PROFILE_NOT_FOUND', retry: 'none' }`. Projects pin exact `id@version` (business rule 11); spec changes by platforms ship as **new profile versions**, never in-place edits, so an approved deliverable's meaning never changes silently. Numeric limits below are the shipped defaults as of 2026-07 and live in profile data, not code (nothing is hard-coded, per FR-805).

```yaml
# profiles/youtube-shorts/1.0.0.yaml
format: guyditor-profile/v1
id: youtube-shorts
version: 1.0.0
displayName: "YouTube Shorts"
kind: short                                  # short | longform
video:
  aspect: "9:16"
  resolution: { width: 1080, height: 1920 }
  fps: { allowed: ["30/1", "60/1", "30000/1001", "60000/1001"], default: "30/1" }
  container: mp4
  codec: h264
  codecProfile: high
  pixelFormat: yuv420p
  colorSpace: bt709
  rateControl: { mode: crf, crf: 18, maxBitrateKbps: 12000 }
duration: { minSeconds: 1, maxSeconds: 180, recommendedMaxSeconds: 60 }
audio:
  codec: aac
  sampleRate: 48000
  channels: 2
  bitrateKbps: 256
  loudness:                                  # validated at export (FR-1004) and metered live (FR-906)
    integratedLufs: -14
    toleranceLu: 1.0
    truePeakDbtp: -1.0
    lraMaxLu: 11
safeAreas:                                   # normalized insets from each edge
  title:  { top: 0.06, bottom: 0.26, left: 0.05, right: 0.16 }   # captions/titles must stay inside
  action: { top: 0.03, bottom: 0.20, left: 0.02, right: 0.12 }   # subjects should stay inside
  platformUi:                                # regions the platform overlays; collision-avoid (FR-510)
    - { name: right-rail,  rect: { x: 0.86, y: 0.38, w: 0.14, h: 0.42 } }
    - { name: bottom-meta, rect: { x: 0.00, y: 0.82, w: 0.80, h: 0.18 } }
captionDefaults:
  maxLines: 2
  maxCharsPerLine: 18
  placement: { anchor: center, verticalCenter: 0.62 }
  perWordHighlight: true
metadata:                                    # validation limits for FR-809
  title:       { maxChars: 100 }
  description: { maxChars: 5000 }
  tags:        { maxCount: 60, totalMaxChars: 500 }
  hashtags:    { maxCount: 20, countedIn: description }
cover: { resolution: { width: 1080, height: 1920 }, formats: [jpg, png], maxBytes: 2097152 }
chapters: null                               # shorts have no chapters
```

The `PlatformProfile` TypeScript interface in `@guyditor/deliver` mirrors this YAML one-to-one and is validated by JSON Schema on load. Shipped built-ins (each version `1.0.0`) differ in these key values:

| Field | youtube-longform | youtube-shorts | tiktok | instagram-reels |
|---|---|---|---|---|
| aspect / resolution | 16:9, 3840×2160 (1080p allowed) | 9:16, 1080×1920 | 9:16, 1080×1920 | 9:16, 1080×1920 |
| duration max | none | 180 s | 600 s (rec. 180 s) | 180 s (rec. 90 s) |
| loudness / true peak | −14 LUFS / −1 dBTP | −14 / −1 | −14 / −1 | −14 / −1 |
| title max | 100 chars | 100 chars | 90 chars (overlay title) | n/a (caption only) |
| description/caption max | 5000 | 5000 | 4000 | 2200 |
| tags / hashtags | 500 chars total tags | tags 500 chars, hashtags in desc. | hashtags in caption, ≤ 20 | hashtags ≤ 30, rec. ≤ 5 |
| thumbnail/cover | 1280×720 JPG/PNG ≤ 2 MB | 1080×1920 cover | 1080×1920 cover | 1080×1920 cover |
| chapters | `{minCount: 3, minChapterSeconds: 10, firstMustBeZero: true}` | none | none | none |
| safe insets (t/b/l/r) | 0.05 each (title) | .06/.26/.05/.16 | .08/.25/.05/.14 | .12/.24/.05/.12 |

### 11.7 Required short-form output set (FR-806)

`deliverable.export { deliverableId }` (approved, non-stale only) enqueues a render job (Part 12) whose output contract for `kind: 'short'` is:

```ts
export interface ShortExportSet {
  videoBurned: string;      // exports/<dlvId>/video.burned.mp4  — captions burned in
  videoClean: string;       // exports/<dlvId>/video.clean.mp4   — no burned captions
  srt: string;              // exports/<dlvId>/subtitles.srt     — from canonical timing (FR-207)
  vtt: string;              // exports/<dlvId>/subtitles.vtt
  coverCandidates: string[];// exports/<dlvId>/covers/cover-01.jpg … cover-06.jpg
  report: string;           // exports/<dlvId>/export-report.json (FR-1005 schema, Part 12)
}
```

Cover-candidate selection (deterministic): candidate frames are (1) the first frame of the hook word, (2) the first frame of each beat in the short, (3) the top-scoring frames by `faceArea × sharpness` (face area from the `subject.track` analysis sidecar, Part 3 §3.5; sharpness = Laplacian variance from Part 3 analysis), deduplicated with ≥ 1 s spacing, top 6 exported at the profile's `cover` spec. The export report records duration, resolved technical settings, loudness measurement, and all warnings.

### 11.8 Staleness tracking and refresh (FR-807, business rule 10)

**Detection** runs synchronously inside transaction acceptance (`OperationEngine` post-commit hook):

1. Each accepted transaction declares its affected entity IDs (Part 5 requirement): clip, word, beat, layer, caption-track, and asset IDs.
2. `DeliverableService` expands these to canonical source ranges: affected long-form clips → their asset + source range + covered words; affected word IDs → their source times; beats → their anchor words. Purely derivative-scoped transactions expand to nothing (they cannot stale a sibling).
3. For every deliverable with status `approved` or `in-review` (never `draft`), intersect the affected ranges with its `dependencies`: word-range intersection by word ID where both sides have `words` (exact even after timeline moves, since word IDs are stable); otherwise asset-ID + source-frame overlap. Local clips (11.3) are skipped.
4. On any nonempty intersection, append a `StaleReason` whose per-entry `change` string is generated from the transaction's operation summaries, e.g. `"clip.trim removed words w000210–w000258 used by derivative clip clp_k3f9x2m4aa"`, set `status: 'stale'`, and emit a UI event. The derivative's sequence, captions, framing, and publish files are **not** modified — the approved content stays byte-identical (business rule 10). Chapter and metadata staleness for the long-form deliverable is handled the same way (11.10, 11.11).

**Refresh** — `deliverable.refresh { deliverableId }` builds a proposal (`prp_`, FR-105), never a direct write:

1. Re-derive the base cut: for each `DependencyEntry`, look up the current source ranges of its `source.words` word IDs (survivors of the upstream edit). Deleted words shrink the range; a fully deleted entry is flagged.
2. Replay the derivative's divergence transactions (from `divergences`, in journal order) on top, remapping anchors by word ID and clip provenance. Any operation whose anchors no longer resolve is retained in the proposal marked `orphaned: true` with an explanation — never silently dropped; the creator resolves each one during review.
3. Re-run the recomposition pipeline (11.4) only for shots whose source content changed; framing overrides whose decisions survive are kept.
4. Attach a semantic diff (current approved derivative vs proposed) and enqueue a preview render of the affected ranges.
5. Acceptance applies the proposal as a normal transaction and sets status `in-review`; `deliverable.approve` is a separate explicit step. Rejection leaves the stale deliverable and its `staleReasons` intact.

### 11.9 Batch export (FR-808)

`deliverable.export.batch { deliverableIds: string[], buildKits?: boolean }`:

1. Validate each deliverable independently: status `approved`, not `stale`, profile resolvable, Part 12 pre-export validation (FR-1004) dry-run. Failures are collected per deliverable; valid ones proceed — one failure never aborts the batch.
2. Enqueue a parent `JobQueue` job (kind `render.batchexport`) with one child export job per valid deliverable (plus a kit job when `buildKits`). Child failures are isolated; the parent completes when all children are terminal.
3. The batch result records per-item `{ deliverableId, jobId, state, error? }` using the Part 0 job envelope; the UI deliverable panel (FR-900) shows individual statuses. Retrying the batch re-runs only failed children (`retry: 'safe'` — exports never mutate accepted state).

### 11.10 Publish metadata drafting and storage (FR-809)

Metadata lives as creator-editable YAML at `publish/<dlvId>/metadata.yaml` (Git-friendly, FR-106), referenced from the master file via `publishFiles` with SHA-256 (business rule 4). Schema `guyditor-publish/v1`:

```ts
export interface PublishMetadata {
  format: 'guyditor-publish/v1';
  deliverableId: string; profile: string; language: string;
  title: string; description: string;
  tags: string[]; hashtags: string[]; cta?: string;
  status: 'draft' | 'approved' | 'stale';
  draftedBy?: { agent: string; model: string; skillVersions: Record<string, string> };
  approvedRevision?: string;
}
```

Drafting flow: `deliverable.metadata.draft { deliverableId }` (exposed as gateway tool `deliverable_metadata_draft`, Part 9 §9.2) has as inputs the deliverable's transcript text (11.14 extraction), beat names, and the pinned brand-voice skill (`skl_`); its output is a proposal writing `metadata.yaml` with `status: 'draft'` and `draftedBy` provenance. The creator edits via the UI form or the file directly; `deliverable.metadata.set` (risk `low`) records edits as transactions. Validation `validateMetadata(meta, profile): FieldError[]` runs on every save, before approval, and again at kit build: title/description/caption length against `metadata.*.maxChars` (Unicode code points), tag count and total characters, hashtag count (hashtags found in `description` count when `countedIn: description`). Violations return `{ code: 'E_METADATA_LIMIT_EXCEEDED', affected: [dlvId], retry: 'none', suggestion: '<field>: <n>/<max>' }`. Approved metadata follows 11.8 staleness: an accepted edit that changes the deliverable's transcript content marks it `stale` with a diff instead of silently rewriting it.

### 11.11 Chapter generation (FR-810)

Beats carry an optional `chapter: { title: string }` field (Part 2 schema). `deliverable.chapters.generate { deliverableId }` (long-form only) derives `publish/<dlvId>/chapters.yaml` + paste-ready `chapters.txt`:

1. Collect beats with `chapter` set, resolve each anchor word/clip to **timeline time** in the long-form sequence, floor to whole seconds.
2. Enforce the profile's `chapters` rules (youtube-longform: first chapter forced to `0:00` — if no beat maps to 0, prepend an "Intro" chapter; minimum 3 chapters; merge any chapter shorter than `minChapterSeconds` into its predecessor with a warning).
3. Write `ChapterList` and the text block (`M:SS Title` / `H:MM:SS Title` lines).

```ts
export interface Chapter { beatId: string; title: string; startSeconds: number }
export interface ChapterList {
  format: 'guyditor-chapters/v1';
  deliverableId: string; derivedAtRevision: string;
  status: 'draft' | 'approved' | 'stale';
  chapters: Chapter[];
}
```

Because chapters derive from semantic anchors, timestamps recompute automatically: while `status: 'draft'`, any accepted edit re-runs generation silently. Once approved (with the metadata approval), a timeline-shifting accepted edit marks the chapter list `stale` via the 11.8 mechanism — the affected-beat explanation and a regenerated diff are offered, and the approved `chapters.txt` is never rewritten in place (FR-807 semantics; AC-011's stale-chapter warning).

### 11.12 Long-form thumbnail candidates (FR-811)

Thumbnails are declarative compositions rendered by the deterministic overlay renderer (AD-006) — no generative text (FR-602). `deliverable.thumbnail.compose { deliverableId, composition }` writes `publish/<dlvId>/thumbnails/<name>.yaml`; rendering exports PNG/JPEG at the profile's thumbnail spec (`1280×720, ≤ 2 MB` for youtube-longform).

```ts
export interface ThumbnailComposition {
  format: 'guyditor-thumb/v1';
  name: string;
  canvas: { width: number; height: number };          // from profile
  layers: (
    | { kind: 'frame'; assetId: string; at: FrameTime; transform?: object }      // frame grab
    | { kind: 'cutout'; assetId: string; at: FrameTime; keyPresetId: string;     // keyed presenter (FR-502, Part 6)
        transform?: object }
    | { kind: 'template'; templateId: string; params: Record<string, unknown> }  // graphics template (tpl_, Part 7)
    | { kind: 'image'; assetId: string; transform?: object }
  )[];
}
```

Frame candidates are suggested by the 11.7 cover algorithm run over the full long-form timeline. Multiple named compositions per deliverable are allowed; the kit build (11.13) uses the one marked `selected: true` in the deliverable record and fails validation if a long-form kit has none.

### 11.13 Upload kits (FR-812)

`deliverable.kit.build { deliverableId }` produces a consolidated per-platform directory under `exports/kits/`:

```
exports/kits/<deliverableId>/<profileId>@<version>/
  kit-manifest.json          # UploadKitManifest
  metadata.yaml              # approved PublishMetadata copy (documented format, 11.10)
  video.burned.mp4
  video.clean.mp4
  subtitles.srt
  subtitles.vtt
  thumbnail.png              # long-form (selected ThumbnailComposition render)
  covers/cover-01.jpg …      # short-form candidate covers
  chapters.txt               # long-form only
  transcript.txt             # 11.14 extraction for this deliverable
  export-report.json         # FR-1005 report from the export that produced the videos
```

Build algorithm: (1) require status `approved`, non-stale deliverable **and** approved, non-stale metadata/chapters; (2) run FR-1004 export validation (Part 12) — reusing cached exports when their report's revision and hashes match the approved revision, otherwise re-exporting; (3) run `validateMetadata` and thumbnail-spec checks (dimensions, byte size); (4) copy files, compute SHA-256 per file, write the manifest. Any check failure returns `{ code: 'E_KIT_VALIDATION_FAILED', affected: [...], retry: 'safe' }` and writes nothing. A passing kit requires no further gathering or checking before manual upload.

```ts
export type KitFileRole = 'video-burned' | 'video-clean' | 'thumbnail' | 'cover'
  | 'subtitles-srt' | 'subtitles-vtt' | 'chapters' | 'metadata' | 'transcript' | 'export-report';
export interface UploadKitManifest {
  format: 'guyditor-kit/v1';
  deliverableId: string; profile: string; revision: string; createdAt: string; // ISO-8601 UTC
  files: { role: KitFileRole; path: string; sha256: string; bytes: number }[];
  validation: { passed: true; warnings: string[] };    // a manifest only exists for passing kits
}
```

### 11.14 Plain-text exports (FR-813)

`deliverable.text.export { deliverableId, targets: ('transcript'|'chapters'|'metadata')[] }` writes UTF-8 text under `publish/<dlvId>/`:

1. **Transcript** (`transcript.txt`): walk the deliverable's sequence in timeline order; for each non-local clip emit the corrected canonical words covered by its source range (word IDs → current corrected text, Part 4); insert paragraph breaks at beat boundaries and at source pauses > 1.5 s; no timestamps, no speaker tags unless multi-speaker.
2. **Chapters** (`chapters.txt`): the 11.11 text block, byte-identical to the kit copy.
3. **Metadata** (`metadata.txt`): title line, blank line, description, blank line, `Tags: a, b, c`, `Hashtags: #x #y` — a paste-ready block assembled from the approved `metadata.yaml`.

These are derived artifacts (business rule 2): regenerating them never changes project state, and each is listed in `publishFiles` with its hash when the creator chooses to keep it in the project.

### Part 11 requirements coverage

| BRD ID | Implemented in |
|---|---|
| FR-800 | 11.1 (long-form deliverable, profile + overrides), 11.6 (youtube-longform profile) |
| FR-801 | 11.2 |
| FR-802 | 11.3 |
| FR-803 | 11.4 |
| FR-804 | 11.5 |
| FR-805 | 11.6 |
| FR-806 | 11.7 |
| FR-807 | 11.8 (detection, refresh), 11.10–11.11 (metadata/chapter staleness) |
| FR-808 | 11.9 |
| FR-809 | 11.10 |
| FR-810 | 11.11 |
| FR-811 | 11.12 |
| FR-812 | 11.13 |
| FR-813 | 11.14 |
| R-004 | 11.4 (layer recomposition, tracking, safe areas, shot previews, overrides), 11.6 (safe-area data) |
| Business rule 9 | 11.3 (divergence classes, clip provenance), 11.1 (`divergences` record) |
| Business rule 10 | 11.1 (lifecycle), 11.8 (no-overwrite detection and proposal-gated refresh), 11.11 (chapters) |

---

## Part 12 — Rendering, export, validation, and interchange

This part specifies how `@guyditor/render` turns an accepted project revision into preview and delivery media: the render-graph intermediate representation (IR), FFmpeg filtergraph compilation (AD-004, AD-006), the render cache and selective rendering (FR-1001), determinism guarantees (FR-1002, AD-013), the render queue on `JobQueue` (FR-1003, AD-010, NFR-103), pre-export validation (FR-1004), the export report (FR-1005), render error surfaces (NFR-104), and OpenTimelineIO interchange export (FR-1102).

**Terms used in this part.** A *deliverable* (`dlv_` ID, Part 11) is one output the project promises (long-form master, a short, an upload-kit variant). A *variant* is one rendered file of a deliverable (`burnin` with captions burned, `clean` without — FR-207/FR-806). A *platform profile* is a versioned file in `profiles/` (Part 11 §11.6) carrying resolution, fps, codec, safe areas, and audio targets (`audio.loudness.integratedLufs`, `audio.loudness.toleranceLu`, `audio.loudness.truePeakDbtp`). A *segment* is a contiguous timeline interval rendered and cached as one unit (§12.4).

### 12.1 RenderService, package boundaries, and the local-only guarantee (FR-1000)

`RenderService` (main process, implemented in `@guyditor/render`) is the only component that produces rendered media. It consumes:

- the canonical project (`episode.guyditor.yaml` + sidecars) at a named revision (`rev_NNNNN`) via `ProjectStore`;
- compiled composition state from `CompositorModel` (Part 6) and caption/graphic render plans from `@guyditor/transcript` and `@guyditor/compositor`;
- FFmpeg/ffprobe exclusively through the `@guyditor/media` command compiler (AD-004) — `@guyditor/render` never assembles command lines itself;
- `JobQueue` for all execution (§12.6).

```typescript
// @guyditor/render — public service surface
export interface RenderService {
  renderPreview(req: RenderRequest): Promise<{ jobId: string }>;          // kind 'render.preview' | 'render.hqpreview'
  renderExport(req: ExportRequest): Promise<{ jobId: string }>;           // kind 'render.export'
  validateExport(deliverableId: string, revision: string): Promise<ExportValidationResult>; // FR-1004, no side effects
  verifyEquivalence(fileA: string, fileB: string, spec?: FunctionalEquivalenceSpec): Promise<EquivalenceResult>; // FR-1002
  cacheStats(): Promise<{ entries: number; bytes: number; byKind: Record<string, number> }>; // NFR-102 input for Part 13
}

export interface RenderRequest {
  revision: string;                 // rev_NNNNN or 'accepted' or a proposal id prp_* (proposal previews, FR-105)
  deliverableId: string;            // dlv_*
  range?: { startFrame: number; endFrame: number };  // timeline frames at deliverable output fps; omitted = full
  quality: 'proxy' | 'high';        // AD-005: 'proxy' uses proxy sources; 'high' uses the final-render path
}

export interface ExportRequest {
  revision: string;                 // MUST be an accepted revision; proposals are rejected with E_EXPORT_UNACCEPTED_REVISION
  deliverableId: string;
  variants: Array<'burnin' | 'clean'>;
  outputDir: string;                // ordinary directory; outputs are plain files (FR-1103)
  skipValidationWarnings?: boolean; // warnings block only with explicit acknowledgment; failures always block (§12.7)
}
```

**Local-only guarantee (FR-1000, BR-001).** Preview and final rendering MUST complete with no network access. Enforcement is threefold: (1) `@guyditor/render` and `workers` spawned by it contain no HTTP/socket client code — a lint rule in the package forbids importing `http`, `https`, `net`, `dgram`, and `fetch` usage; (2) the `@guyditor/media` command compiler rejects any FFmpeg input/output whose path parses as a URL with a scheme other than `file`, and always passes `-nostdin`; (3) render jobs are tagged data class `local-only` in the audit log (NFR-001) — a render job that attempted an external call would be an implementation bug, not a configurable behavior. External rendering MAY be added later behind `AdapterRegistry` (NFR-105) but the core workflow MUST NOT require it.

### 12.2 Render-graph IR

Every render compiles the canonical project into a **render graph**: a directed acyclic graph of typed nodes, one graph per deliverable variant per revision. The graph is the single meeting point of Parts 2–7: it contains no YAML paths, no semantic anchors, and no proposal state — only resolved assets, exact rational times, and numeric parameters.

```typescript
export type RenderNodeKind =
  | 'source'      // decode one asset range
  | 'trim'        // exact in/out on a stream
  | 'transform'   // crop/scale/position/rotation/opacity, keyframed (FR-306)
  | 'key'         // chroma key / matte application (FR-502/503)
  | 'composite'   // ordered stack of video inputs onto a canvas
  | 'overlay'     // composite a pre-rendered transparent overlay asset (captions, titles, graphics)
  | 'audiochain'  // per-clip and master audio processing (FR-308/309), incl. loudness normalization
  | 'encode';     // encoder + container settings from the platform profile

export interface RenderNode {
  id: string;                        // 'rn_' + 10 base32 chars, unique within one graph, NOT persisted in the project
  kind: RenderNodeKind;
  inputs: string[];                  // ids of upstream nodes; [] for 'source'
  params: SourceNodeParams | TrimNodeParams | TransformNodeParams | KeyNodeParams
        | CompositeNodeParams | OverlayNodeParams | AudioChainNodeParams | EncodeNodeParams;
}

export interface RenderGraph {
  graphVersion: 'guyditor-rg/1';
  revision: string;                  // rev_* this graph was compiled from
  deliverableId: string;
  variant: 'burnin' | 'clean' | 'preview';
  outputFps: string;                 // "num/den"
  outputSize: { w: number; h: number };
  nodes: RenderNode[];               // topologically ordered; exactly one 'encode' node (the root)
  toolchain: ToolchainManifest;      // §12.5
}

export interface SourceNodeParams  { assetId: string; assetSha256: string; stream: 'video' | 'audio';
                                     path: string; useProxy: boolean; }
export interface TrimNodeParams    { in: { frames: number; fps: string } | { samples: number; rate: number };
                                     out: { frames: number; fps: string } | { samples: number; rate: number };
                                     speed?: { num: number; den: number }; freezeAtFrame?: number; }  // FR-306
export interface TransformNodeParams { keyframes: Array<{ atOutputFrame: number; crop?: [number,number,number,number];
                                     scale?: number; pos?: [number, number]; rotateDeg?: number; opacity?: number }>;
                                     interpolation: 'linear' | 'easePreset'; easePresetId?: string; }
export interface KeyNodeParams     { method: 'chroma' | 'neuralMatte'; keyColor?: string; tolerance?: number;
                                     edgeSoftness?: number; spillSuppression?: number;
                                     garbageMaskAssetId?: string; matteAssetId?: string; }  // neural mattes are frozen assets (Part 6 §6.5)
export interface CompositeNodeParams { canvas: { w: number; h: number; background: string }; }  // inputs stack bottom→top
export interface OverlayNodeParams { overlayAssetPath: string; overlaySha256: string;
                                     atOutputFrame: number; durationFrames: number; }         // §12.3
export interface AudioChainNodeParams { stages: Array<{ stage: 'gain'|'fade'|'channelmap'|'denoise'|'eq'|'compress'
                                     |'limit'|'duck'|'loudnorm'; params: Record<string, number | string | boolean> }>; }
export interface EncodeNodeParams  { profileId: string; profileVersion: string; profileSha256: string;
                                     vcodec: string; vcodecParams: Record<string, string | number>;
                                     acodec: string; abitrate: string; pixFmt: string; container: 'mp4' | 'mov' | 'webm'; }
```

**Compilation algorithm** (`compileRenderGraph(revision, deliverableId, variant, quality)`):

1. Load the master file and referenced sidecars at `revision`; verify every sidecar SHA-256 recorded in the master file (mismatch → error `E_RENDER_SIDECAR_HASH_MISMATCH`, §12.9).
2. Resolve the deliverable's sequence and layer stack via `CompositorModel`, applying the deliverable's responsive layout constraints (FR-511, Part 6) for its aspect ratio.
3. Resolve every semantic anchor (`word:w000042`, `beat:beat_x`, `clip:clp_x@{frames}`) to exact output frames using the canonical word timing sidecar (Part 4). All arithmetic is exact rational (Part 0 time model); the only rounding permitted is the final snap of an anchor to an integer output frame — round to the nearest output frame, exact ties toward the earlier frame (Part 2 §2.2 rule 3).
4. For each clip: emit `source` (proxy path if `quality: 'proxy'` and a valid proxy exists, else original) → `trim` → optional `key` → optional `transform`. A source node referencing an asset absent from the project asset table, or a generated asset not frozen (`ast_` missing), aborts compilation with `E_RENDER_UNFROZEN_GENERATION` — defense in depth for business rule 8 / FR-1002.
5. Emit one `composite` node per output canvas, inputs ordered bottom→top by layer order (FR-500). Transitions (`trn_`) compile into overlapping trims plus crossfade parameters on the composite input edges.
6. Ask the overlay renderer (§12.3) for the overlay plan; emit one `overlay` node per rendered overlay asset. For variant `clean`, caption-track overlays are omitted; deliberate final graphics (FR-404 converted overlays, titles, lower thirds) are always included.
7. Emit the `audiochain`: per-clip gain/fades, music ducking envelopes (FR-309, precomputed by Part 5 into explicit gain keyframes), then the master bus stages ending in the two-pass `loudnorm` stage (§12.7) targeting the profile's loudness and true-peak values.
8. Emit the single `encode` root from the platform profile.
9. Topologically sort, validate (single root, no cycles, every input id defined), and return the graph.

The same graph feeds both the segment planner (§12.4) and the filtergraph compiler (§12.3). The WebGL live preview (AD-005) does **not** consume this IR; only file-producing renders do.

### 12.3 Filtergraph compilation and the overlay renderer

`compileFiltergraph(graph, segment)` in `@guyditor/render` lowers one segment of the graph to a single FFmpeg invocation, built through `@guyditor/media`:

1. Each `source`+`trim` pair becomes an input with `-ss`/`-to` expressed in exact seconds derived from rational frame math, followed by `trim`/`atrim` + `setpts`/`asetpts` filters for frame-exact boundaries (input seeking is only a fast pre-roll; exactness comes from the filter).
2. `transform` → `crop`, `scale` (flags `bicubic`), `rotate`, `format=yuva420p` + `colorchannelmixer` for opacity; keyframed values compile to FFmpeg expressions in terms of `n` (frame number) with linear or preset easing sampled to piecewise-linear.
3. `key` (chroma) → `chromakey=<color>:<tolerance>:<edgeSoftness>` + `despill`; garbage masks composite via `alphamerge` with the mask asset. Neural mattes are pre-rendered alpha assets (Part 6) applied with `alphamerge` — never computed during final render.
4. `composite` → chained `overlay` filters bottom→top on a `color=c=<background>:s=<w>x<h>` base; crossfades use `xfade` (video) and `acrossfade` (audio).
5. `overlay` nodes → the overlay asset as an additional input, composited with `overlay=enable='between(n,START,END)'` preserving alpha.
6. `audiochain` → `volume`, `afade`, `channelmap`, `arnndn` (denoise), `equalizer`, `acompressor`, `alimiter`, envelope-driven `volume` for ducking, and `loudnorm` (two-pass, §12.7).
7. `encode` → output options verbatim from `EncodeNodeParams`, plus segment-boundary options from §12.4.

**Overlay renderer (AD-006).** Captions with per-word highlighting (FR-205), titles, callouts, and template graphics are rendered by the deterministic TypeScript overlay renderer (shared with the interactive preview) using `@napi-rs/canvas` at a pinned version with **bundled fonts only** — font files ship in the app and their SHA-256 hashes enter the toolchain manifest (§12.5). System fonts MUST NOT be used in render paths. Output format: per overlay span, a zero-padded PNG frame sequence with straight alpha at output resolution and fps, written to `.guyditor/cache/render/overlays/<overlayKey>/%08d.png`, where `overlayKey` is the SHA-256 of (overlay plan canonical JSON + caption/preset versions + font hashes + renderer version). FFmpeg ingests it via the `image2` demuxer at the output frame rate. This is the exact point where the overlay renderer's output enters the FFmpeg pipeline: as an ordinary hashed input to an `overlay` node — never as a filter approximation of text (FR-602).

### 12.4 Selective rendering and the render cache (FR-1001)

**Segmentation.** The planner partitions the deliverable timeline into segments:

1. Collect boundary frames: every clip start/end, transition start/end, overlay start/end, layer enable/disable, and audio-stage boundary, expressed in output frames.
2. Merge boundaries into maximal intervals with a constant node-closure *structure* (parameter keyframes inside an interval do not split it).
3. Split any interval longer than 10 s of output time at 10 s marks (bounds worst-case re-render cost and enables parallel encoding).
4. Every boundary is an integer output frame; segments tile the timeline exactly with no gaps or overlaps.

**Cache key.** For each node, compute bottom-up:

1. Replace every file reference in `params` with the file's SHA-256 (assets, proxies, overlay sequences, mask/matte assets, sidecar-derived data).
2. `nodeHash = SHA-256(canonicalJSON({ kind, params, inputHashes: [sorted child nodeHashes], tool: toolchainEntriesRelevantTo(kind) }))` — canonical JSON is UTF-8, keys sorted, no whitespace, integers exact, rationals as `"num/den"` strings.
3. `segmentKey = SHA-256(canonicalJSON({ rootNodeHash, segmentStartFrame, segmentEndFrame, graphVersion }))`.

Because asset hashes, operation parameters, and tool versions are all inside the key (AD-013), an unchanged segment after any edit hashes identically and is reused with zero correctness risk; a changed clip, preset version bump, or FFmpeg upgrade changes the key and invalidates exactly the affected segments — this is the entire invalidation mechanism; there is no manual dirty-tracking.

**Storage and assembly.** Cache root `.guyditor/cache/render/` (AD-007 — disposable, never load-bearing):

```
.guyditor/cache/render/
  segments/<segmentKey>.mp4      # video+audio segment encoded at profile settings
  overlays/<overlayKey>/         # PNG sequences (§12.3)
  audio/<audioKey>.wav           # full-timeline master audio mix (float WAV), pre-loudnorm
  measure/<audioKey>.json        # pass-1 loudness measurement (§12.7)
  tmp/                           # in-flight writes only; swept at startup (§12.6)
  index.sqlite                   # key → { path, bytes, createdAt, lastUsedAt, kind }
```

Segments are encoded with a forced keyframe at their first frame and closed GOPs (`-force_key_frames 0`, `-flags +cgop`) using identical encoder parameters, so final assembly is lossless: the concat demuxer with stream copy joins segments, then the finished audio track is muxed in. **Audio is never segmented:** loudness normalization is a whole-program operation, so the master mix is always rendered as one continuous WAV (its own cache entry keyed by the audiochain closure), normalized, encoded once, and muxed over the concatenated video. Preview renders of a `range` reuse the same segment cache and concat only the covered segments. Eviction (LRU by `lastUsedAt`, size-capped) and safe cleanup semantics are owned by Part 13 (NFR-102); `RenderService.cacheStats` feeds it.

### 12.5 Determinism and functional equivalence (FR-1002, AD-013)

**Pinned toolchain.** Every graph and every export report embeds:

```typescript
export interface ToolchainManifest {
  ffmpeg: { version: string; buildSha256: string };     // hash of the bundled binary
  ffprobe: { version: string; buildSha256: string };
  renderPackage: string;                                 // @guyditor/render semver
  overlayRenderer: { version: string; canvasVersion: string; fontHashes: Record<string, string> };
  encoderThreads: number;                                // recorded because thread count can affect encoder output
  os: 'darwin' | 'win32' | 'linux';
}
```

Render code paths MUST NOT read wall-clock time, RNG, locale, or environment-dependent defaults (AD-013); container metadata that would embed a timestamp is neutralized (`-map_metadata -1`, explicit `creation_time` omitted).

**Functionally equivalent output** (the FR-1002 acceptance predicate — bit-identity is NOT required, because encoder builds across OSes may differ):
two files are functionally equivalent iff all of:

1. Same stream layout, codecs, pixel format, resolution, frame rate, sample rate, and durations equal within 1 video frame and 1 audio frame.
2. Video: for sampled frames (first, last, and every 24th output frame), the 64-bit DCT perceptual hash (pHash over a 32×32 grayscale downscale) differs by Hamming distance ≤ 6 on every sampled frame and mean ≤ 2 across all sampled frames.
3. Audio: integrated loudness (EBU R128) within ±0.2 LU, true peak within ±0.3 dB, and per-second momentary loudness deviating ≤ 0.5 LU at every second.

`RenderService.verifyEquivalence` implements this predicate (`FunctionalEquivalenceSpec` carries the three tolerance sets, defaulting to the values above); it is also the comparator for golden-file render tests (AD-014) and for AC-009 revision-reproduction verification (Part 14).

**Frozen generations.** Nondeterministic external outputs (generative B-roll, synthetic voice, neural mattes) MUST be frozen as ordinary hashed assets before a proposal referencing them can be accepted (business rule 8, Part 7). The render layer enforces this again at compile time (§12.2 step 4): a render can only ever read bytes whose hash is recorded in the project, so re-rendering an accepted revision can never re-invoke a generator.

### 12.6 Render queue, cancellation, retry, and crash recovery (FR-1003, NFR-103)

All rendering runs on `JobQueue` (AD-010, `.guyditor/jobs.sqlite`), visible in the UI render panel (FR-900), reporting the Part 0 job shape `{ jobId, kind, state, progress, error? }` with `jobId` = `job_*`.

| Job kind | Priority | Preempts |
|---|---|---|
| `render.preview` (proxy quality, current playhead region) | 100 | everything below |
| `render.hqpreview` (FR-902 high-quality segment) | 80 | exports |
| `render.diagnostic` (FR-504 key-QC diagnostic-background segment, Part 6 §6.6) | 70 | exports |
| `render.export` (single deliverable variant) | 60 | batch |
| `render.batchexport` (FR-808 parent job; children are `render.export`) | 50 | — |

Higher priority preempts at **segment boundaries only**: the scheduler never kills a healthy in-flight FFmpeg segment for priority; it inserts the higher-priority job before the next segment claim. At most `min(4, physicalCores/2)` segment encodes run concurrently (tunable via hardware detection, NFR-101).

**Job payload and checkpointing.**

```typescript
export interface RenderJobCheckpoint {
  graphSha256: string;               // hash of the compiled RenderGraph canonical JSON
  segmentKeys: string[];             // full plan, in timeline order
  completedKeys: string[];           // updated transactionally in jobs.sqlite after each segment lands in the cache
  audioKey?: string; audioDone: boolean;
  phase: 'planning' | 'segments' | 'audio' | 'assemble' | 'validate' | 'report' | 'done';
}
```

**Cancellation safety.** Cancel requests set the job to `cancelled`; the running FFmpeg child receives SIGTERM, then SIGKILL after 5 s. Every artifact is written to `.guyditor/cache/render/tmp/<random>` and atomically renamed into place (fsync + rename) only on successful completion, so cancellation can never leave a partial file under a valid cache key. Cancelling a render changes nothing in accepted project state — renders are pure readers, so every render error and cancellation reports `acceptedStateChanged: false` (§12.9).

**Crash recovery (NFR-103).**

1. On startup, `JobQueue` marks every job found in state `running` as `failed` with `retry: 'safe'`.
2. `RenderService` deletes everything under `.guyditor/cache/render/tmp/`.
3. Retrying a failed/crashed job recompiles the graph; if `graphSha256` matches the checkpoint, all `completedKeys` (and any key already present in the cache index with a verified file) are skipped — resume cost is only the interrupted segment. If the hash differs (the project changed meanwhile), the checkpoint is discarded and the plan recomputed; unchanged segments are still reused via the cache.
4. The same startup pass covers interrupted analysis and proxy jobs (owned by Part 3) — the mechanism is `JobQueue`-generic; accepted project state is untouched by any job failure, satisfying NFR-103's "accepted state remains valid" clause by construction.

**Retry semantics.** `retry: 'safe'` for infrastructure failures (crash, disk-full after cleanup, cancelled); `retry: 'unsafe'` never occurs for renders (no partial state); `retry: 'none'` for deterministic compile failures (missing asset, unfrozen generation) — those need a correction, and the error's `suggestion` says which (§12.9). Failed jobs keep their checkpoint until retried or explicitly discarded.

### 12.7 Pre-export validation (FR-1004)

`validateExport` runs the full check suite; `renderExport` runs it automatically in phase `validate` **after** rendering (audio checks measure the actual output) plus a cheap pre-flight of VAL-100..401 **before** rendering. Severity semantics: **pass** — no action; **warn** — export completes only if `skipValidationWarnings: true` was set or the creator acknowledges each warning in the UI; **fail** — export is blocked, no output file is produced (a temp file may exist and is deleted).

| ID | Check (BRD FR-1004 item) | How | fail | warn |
|---|---|---|---|---|
| VAL-100 | Missing assets | every `source` asset file exists | missing | — |
| VAL-101 | Changed assets | file SHA-256 vs project record (NFR-005) | mismatch | — |
| VAL-200 | Unsupported/unavailable effects | every graph node compilable with current toolchain + detected hardware (NFR-101) | uncompilable node | slower-fallback path chosen |
| VAL-300 | Stale transcripts/sidecars | sidecar hashes vs master file; transcript staleness flags from Part 4 (FR-208) | caption track references stale word timing | stale analysis sidecar not used by this deliverable |
| VAL-400 | Unresolved render-blocking annotations | `AnnotationService`: annotations intersecting the deliverable's source range with effective state `open`/`addressed`/`reopened` and `blocking: true` (Part 8 §8.8.4) | any blocking | non-blocking open annotations exist |
| VAL-401 | Caption overflow / safe areas | overlay renderer dry-run: any caption line exceeding its box, or any caption/graphic bounding box intersecting a profile safe-area exclusion (FR-205, FR-805) | intersection with a profile zone marked `strict: true` | overflow or non-strict zone intersection |
| VAL-500 | Loudness vs profile target | §12.7.1 measurement on final output | \|I − target\| > `audio.loudness.toleranceLu` | within tolerance but > tolerance/2 |
| VAL-501 | True peak | `ebur128=peak=true` on final output | TP > `audio.loudness.truePeakDbtp` | within 0.3 dB below ceiling |
| VAL-502 | Clipping | §12.7.2 | ≥ 3 consecutive full-scale samples | 1–2 consecutive full-scale samples |
| VAL-503 | Unintended silence | §12.7.3 | — | any detected span |
| VAL-600 | Invalid output settings | profile schema validation; resolution divisible by 2 for `yuv420p`; duration within platform min/max (FR-805); fps allowed by profile | violation | — |
| VAL-700 | Known compositing/media errors | decode/filter errors or dropped-frame warnings collected from FFmpeg stderr during segment renders; output frame count equals plan | any error, frame-count mismatch | non-fatal FFmpeg warnings |

```typescript
export interface ExportValidationCheckResult {
  id: string;                        // 'VAL-500'
  status: 'pass' | 'warn' | 'fail';
  message: string;                   // human-readable, includes measured vs target values
  affected: string[];                // ast_/clp_/cts_/ann_/dlv_ IDs
  range?: { startFrame: number; endFrame: number };   // output frames, when localizable
  measured?: Record<string, number>; // e.g. { integratedLufs: -13.2, truePeakDbtp: -0.8 }
}
export interface ExportValidationResult {
  deliverableId: string; revision: string; profileId: string; profileVersion: string;
  checks: ExportValidationCheckResult[];
  outcome: 'pass' | 'warnings' | 'blocked';
}
```

#### 12.7.1 Two-pass EBU R128 loudness (VAL-500/501 and the `loudnorm` stage)

1. **Pass 1 (measure):** run the master mix WAV (§12.4) through `loudnorm=I=<target>:TP=<tp>:LRA=<profileLra>:print_format=json`; parse `input_i`, `input_tp`, `input_lra`, `input_thresh`, `target_offset`; cache the JSON at `measure/<audioKey>.json`.
2. **Pass 2 (correct):** re-run with `measured_I/measured_TP/measured_LRA/measured_thresh/offset` from pass 1 and `linear=true`, producing linearly normalized audio (dynamic mode is forbidden — it is program-dependent and hurts determinism). If linear normalization cannot reach the target without exceeding the true-peak ceiling, `alimiter=limit=<tp>` is appended and the fact is recorded as a VAL-500 warn.
3. **Verify:** after final mux, measure the delivered file with `ebur128=peak=true` and evaluate VAL-500/VAL-501 against `audio.loudness.integratedLufs ± toleranceLu` and `audio.loudness.truePeakDbtp` (Part 11 §11.6 field names). Measured values go into the export report.

#### 12.7.2 Clipping detection (VAL-502)

Decode the final audio to float32 PCM (`-f f32le`) and scan in `@guyditor/render`: a *clipped run* is ≥ N consecutive samples with |s| ≥ 0.999 on any channel. N ≥ 3 → fail; N ∈ {1,2} → warn. Report each run's output-frame range.

#### 12.7.3 Unintended-silence detection (VAL-503)

Over the same PCM, compute RMS in 100 ms hop-free windows; a window is *silent* if RMS < −60 dBFS. Flag as warn: (a) **tail silence** — a trailing silent run ≥ 1.5 s before end of program; (b) **head silence** — a leading silent run ≥ 1.0 s; (c) **internal silence** — any silent run ≥ 3.0 s that does not overlap a clip, marker (`mrk_`), or annotation tagged `intentionalPause` (Parts 5/8). All spans are reported with output-frame ranges so the creator can jump to them; never fail, because silence can be intentional (FR-303 rationale).

### 12.8 Export report (FR-1005)

Every completed final export writes `<output-basename>.export-report.json` beside the output file and a copy under the deliverable's directory (Part 11 includes it in upload kits, FR-812).

```typescript
export interface ExportReport {
  reportVersion: 'guyditor-export-report/1';
  createdAt: string;                       // ISO 8601 UTC (wall clock allowed here: reports are records, not render inputs)
  jobId: string;                           // job_*
  revision: string;                        // rev_* actually rendered
  deliverableId: string; variant: 'burnin' | 'clean';
  profile: { id: string; version: string; sha256: string };
  toolchain: ToolchainManifest;            // §12.5
  sources: Array<{ assetId: string; path: string; sha256: string }>;      // every asset the graph read
  sidecars: Array<{ path: string; sha256: string }>;
  renderSettings: EncodeNodeParams;        // resolved encoder/container settings
  audio: { integratedLufs: number; loudnessRangeLu: number; truePeakDbtp: number;
           targetLufs: number; truePeakMaxDbtp: number };
  validation: ExportValidationResult;      // full check results, incl. acknowledged warnings
  warningsAcknowledged: boolean;
  output: { path: string; sha256: string; bytes: number; durationFrames: number; fps: string;
            width: number; height: number; container: string };
  cache: { segmentsTotal: number; segmentsReused: number; renderSeconds: number };
}
```

The report plus the revision snapshot (AD-008), source assets, and toolchain manifest are sufficient to re-render and verify the output with `verifyEquivalence` — the operational form of FR-107/AC-009 for rendered artifacts.

### 12.9 Error surfaces (NFR-104)

All `RenderService` errors use the Part 0 envelope `{ code, message, affected, acceptedStateChanged, retry, suggestion? }`. Renders never mutate accepted state, so `acceptedStateChanged` is `false` for every code below.

| code | affected | retry | suggestion pattern |
|---|---|---|---|
| `E_RENDER_SOURCE_MISSING` | `ast_*` | `none` | relink the asset (FR-007) then retry |
| `E_RENDER_SIDECAR_HASH_MISMATCH` | sidecar path, `rev_*` | `none` | regenerate or restore the sidecar; project integrity check (NFR-005) |
| `E_RENDER_UNFROZEN_GENERATION` | `prp_*`/asset ref | `none` | freeze the generated media as an asset before accepting (rule 8) |
| `E_RENDER_TOOLCHAIN_UNSUPPORTED` | node id, feature | `none` | VAL-200 detail; switch effect or enable fallback path (NFR-101) |
| `E_RENDER_SEGMENT_FAILED` | `dlv_*`, segment range | `safe` | FFmpeg stderr excerpt attached; retry resumes at the failed segment |
| `E_RENDER_DISK_FULL` | cache path | `safe` | free space or run cache cleanup (Part 13) |
| `E_RENDER_CANCELLED` | `job_*` | `safe` | — |
| `E_EXPORT_UNACCEPTED_REVISION` | `prp_*` | `none` | accept the proposal first (FR-105) |
| `E_EXPORT_VALIDATION_FAILED` | failing VAL IDs' subjects | `none` | per-check messages; fix and re-run validateExport |
| `E_EXPORT_OUTPUT_UNWRITABLE` | output path | `safe` | choose a writable directory |
| `E_OTIO_UNSUPPORTED_CONSTRUCT` | construct IDs | `none` | listed constructs exported lossily as metadata (§12.10) |

Every error message names the affected asset, operation, or deliverable by ID and display name — never only an internal path — and the UI render panel and Agent Gateway surface the same envelope (FR-901 symmetry).

### 12.10 OpenTimelineIO interchange export (FR-1102)

`DeliverableService` (`@guyditor/deliver`) exposes an interchange export producing a single `.otio` JSON file (OpenTimelineIO 0.17.x serialization, written directly by a TypeScript serializer — no Python/OTIO runtime dependency; the JSON schema-version envelope is emitted per the OTIO documentation).

```typescript
export interface OtioExportOptions {
  deliverableId: string; revision: string;
  mediaPaths: 'absolute' | 'relative';
  includeBeatsAsMarkers: boolean;         // default true
  includeAnnotationsAsMarkers: boolean;   // default false — review annotations are private (FR-404)
}
export interface OtioExportResult { path: string; sha256: string; losses: Array<{ construct: string; ids: string[]; disposition: string }>; }
```

**Mapping table (guyditor/v1 → OTIO):**

| guyditor/v1 construct | OTIO schema | Notes |
|---|---|---|
| deliverable timeline (`dlv_`) | `Timeline.1` | name = deliverable name; global start 0 |
| layer stack | `Stack.1` of `Track.1` | video tracks bottom→top order preserved; audio layers → `Track` kind `Audio` |
| clip (`clp_`) + source range | `Clip.2` + `ExternalReference.1` | `source_range` as `RationalTime` at the asset's native fps from `{frames, fps}` — exact, no float drift |
| explicit gap | `Gap.1` | derived timeline positions (FR-101) materialize as ordered items |
| crossfade / audio crossfade (`trn_`) | `Transition.1` (`SMPTE_Dissolve`) | duration exact in frames |
| custom/preset transitions | `Transition.1` `Custom_Transition` | parameters under `metadata.guyditor` |
| speed change / freeze (FR-306) | `LinearTimeWarp.1` / `FreezeFrame.1` | non-linear retimes → nearest linear warp + loss entry |
| named beats (`beat_`), markers (`mrk_`) | `Marker.2` | color GREEN; word-anchored positions resolved to frames |
| review annotations (`ann_`) | `Marker.2` (opt-in only) | color RED, note text in metadata |
| everything else | `metadata.guyditor.*` | full canonical fragments embedded for round-trip forensics, invisible to other editors |

**Documented losses** (every export writes its `losses` list; the UI shows them before the file is produced):

- **Review annotations and lifecycle states** — not representable; exported only as flat markers on opt-in (FR-404 privacy default).
- **Agent provenance, transactions, proposals, skill/preset versions** — no OTIO concept; embedded under `metadata.guyditor` only.
- **Responsive layouts (FR-511)** — OTIO has one timeline geometry; only the exported deliverable's resolved layout survives; sibling aspect-ratio layouts are dropped.
- **Semantic anchors (word/beat/clip-relative)** — resolved to absolute frames at export; the anchor identity is lost to external editors.
- **Effects beyond linear retiming** — chroma key, mattes, transforms, color looks, PiP presets, keyframes: parameters preserved only as opaque `metadata.guyditor` payloads; external editors will render clips un-keyed and un-transformed.
- **Captions and per-word timing** — not representable in OTIO tracks; deliver burned-in video or SRT/VTT sidecars (FR-207, Part 4) alongside.

**Why guyditor/v1 stays canonical (binding restatement of FR-1102/BRD §26):** the constructs above are load-bearing for Guyditor's core promises — reviewability (FR-104/105), reproducibility (FR-107), responsive derivatives (FR-511/803), and word-anchored editing (FR-204). Any adapter that cannot carry them would silently break those guarantees if treated as a source of truth. Therefore OTIO export is **one-way and derived**: importing an externally modified `.otio` back is out of scope for v1, and the exporter stamps `metadata.guyditor.canonical = false` into the file so a future importer can never mistake it for authority.

### Part 12 requirements coverage

| BRD ID | Implemented in |
|---|---|
| FR-1000 | §12.1 (local-only guarantee, enforcement), §12.3 (bundled tooling) |
| FR-1001 | §12.4 (segmentation, cache key, invalidation, storage, reuse) |
| FR-1002 | §12.5 (toolchain manifest, functional equivalence + tolerances, frozen generations), §12.2 step 4 |
| FR-1003 | §12.6 (queue kinds, priorities, cancellation, retry), §12.1 (`RenderService` API) |
| FR-1004 | §12.7 (check table VAL-100..700, pass/warn/fail semantics, §12.7.1–12.7.3 audio algorithms) |
| FR-1005 | §12.8 (`ExportReport` schema, placement, reproduction linkage) |
| FR-1102 | §12.10 (OTIO mapping, losses, canonicality rule) |
| NFR-103 | §12.6 (checkpointing, atomic writes, startup recovery, pure-reader renders) |
| NFR-104 | §12.9 (error code table on the Part 0 envelope), §12.7 (localized, actionable check results) |

---

## Part 13 — Backup, archival, migration, and storage

This part specifies the durability layer of Guyditor: storage accounting and safe cleanup (NFR-102), verifiable backup (NFR-106), archival and media offlining (NFR-107), cross-machine restore (NFR-108), and the schema migration framework (NFR-109). Together these implement the required mitigations for R-006 (hardware/storage exhaustion) and R-009 (data loss in a local-first product).

Terminology used below (from Part 0 and Part 2): the **master file** is `episode.guyditor.yaml` (`format: guyditor/v1`); **sidecars** live in `sidecars/` and are schema-versioned and SHA-256 hashed; **history** is the append-only journal `history/transactions.jsonl` plus per-revision snapshots in `history/revisions/`; **proposals** live in `proposals/`; everything under `.guyditor/cache/` is derived and disposable (AD-007, AD-008). Wall-clock timestamps in every manifest defined in this part are ISO 8601 UTC strings (`2026-07-17T14:03:00Z`); media time never appears in these manifests.

**Code placement (Part 13 decision).** Backup, archival, and storage accounting are implemented in `@guyditor/media` (module `packages/media/src/backup/`), because they depend on hashing and file I/O owned by that package; the `BackupService` main-process service (canonical name, Part 0 §0.4) is its runtime facade. Schema migration is implemented in `@guyditor/core` (module `packages/core/src/migration/`), which owns the project schema.

**New ID prefixes (Part 13 decision), following the Part 0 convention (prefix + 10 random base32 chars):** backup runs `bak_`, archive operations `arc_`, environment bundles `env_`, migration runs `mig_`.

**Job kinds owned by this part** (executed on `JobQueue` per AD-010, reported with the Part 0 job envelope): `storage.scan`, `storage.cleanup`, `backup.run`, `backup.verify`, `backup.restoreTest`, `backup.restore`, `archive.offline`, `archive.restore`, `migration.dryRun`, `migration.apply`.

**Error codes added by this part** (returned in the Part 0 error envelope `{ code, message, affected, acceptedStateChanged, retry, suggestion? }`): `E_STORAGE_INSUFFICIENT`, `E_CLEANUP_PATH_REFUSED`, `E_BACKUP_TARGET_UNAVAILABLE`, `E_BACKUP_VERIFY_MISMATCH`, `E_RESTORE_INTEGRITY_FAILED`, `E_ARCHIVE_HASH_MISMATCH`, `E_ARCHIVE_TARGET_UNAVAILABLE`, `E_ENV_BUNDLE_INVALID`, `E_MIGRATION_SEMANTIC_UNCONFIRMED`, `E_MIGRATION_BACKUP_MISSING`. All of them report `acceptedStateChanged: false` except a failed `migration.apply` after the write phase begins, which reports the true value and points at the pre-migration snapshot (§13.6).

### 13.1 Storage model and accounting (NFR-102)

#### 13.1.1 Storage categories

Every byte Guyditor knows about belongs to exactly one category. The classification is by path pattern and asset role, not by heuristics:

```ts
// @guyditor/media — backup/storage.ts
export type StorageCategory =
  | 'sources'        // original ingested media (FR-002), wherever it lives; immutable (business rule 1)
  | 'generated'      // accepted generated assets, frozen per business rule 8 (<project>/media/generated/, Part 7 §7.10)
  | 'project-state'  // master file, sidecars/, history/, proposals/, backup.guyditor.yaml, archive/ manifests+previews
  | 'proxies'        // .guyditor/cache/proxies/** (regenerable, FR-003)
  | 'caches'         // .guyditor/cache/** except proxies: analysis, waveforms, preview segments, render cache, thumbnails
  | 'renders'        // exported deliverables and upload kits (Part 11/12 output dirs); reproducible (FR-1002)
  | 'archives'       // local staging for cold-storage copies (§13.3)
  | 'jobs-db'        // .guyditor/jobs.sqlite
  | 'audit';         // ~/.guyditor/audit/** (NFR-007; retention configured, Part 9)

export interface StorageReport {
  scannedAt: string;                    // ISO 8601 UTC
  projectDir: string;
  volumeFreeBytes: number;              // free space on the volume holding projectDir
  categories: Record<StorageCategory, { bytes: number; files: number; reclaimable: boolean }>;
  externalSources: { assetId: string; path: string; bytes: number; volumeFreeBytes: number }[]; // sources outside projectDir
  orphans: { path: string; bytes: number }[]; // cache entries whose cache key matches no live asset hash / revision
}
```

`reclaimable` is `true` only for `proxies`, `caches`, and `jobs-db` (completed-job rows). `renders` are reproducible but are never auto-reclaimed; deleting them is a separate explicit user action with its own confirmation.

`StorageAccountant` is the implementing class, exported from `@guyditor/media` and used by `BackupService`, `JobQueue` preflight, and the UI storage panel. It exposes:

```ts
export interface StorageAccountant {
  scan(projectDir: string): Promise<StorageReport>;                    // job kind storage.scan
  estimate(op: EstimatableOperation): Promise<StorageEstimate>;        // §13.1.2
  planCleanup(projectDir: string, categories: StorageCategory[]): Promise<CleanupPlan>;
  executeCleanup(projectDir: string, plan: CleanupPlan): Promise<JobRef>; // job kind storage.cleanup
}
export interface JobRef { jobId: string }
```

#### 13.1.2 Estimation model

Prospective operations are estimated before they run (R-006). `EstimatableOperation` is a tagged union covering: proxy generation, transcription/analysis, high-quality preview render, final render, backup run, archive offline. Estimation rules:

1. **Proxies:** `bytes ≈ duration_s × (v_kbps + 128) × 125`, where `v_kbps` comes from the proxy ladder defined in Part 3 (e.g. 540p → 2500 kbps). Sum over eligible assets.
2. **Final/HQ renders:** if the platform profile (Part 11) pins a bitrate, `bytes ≈ duration_s × (v_kbps + a_kbps) × 125`; for CRF-based profiles use the conservative table {2160p: 45 Mbps, 1440p: 24, 1080p: 12, vertical 1080×1920: 12, 720p: 7.5} as `v_kbps` input.
3. **Analysis/transcription caches:** `bytes ≈ duration_min × 250 KB` (waveforms + JSON) — small, but reported so background ingest (FR-009) can be preflighted as a whole.
4. **Backup run:** manifest delta against the target's object store (§13.2.3): sum of sizes of objects not yet present.
5. **Archive offline:** sum of exact source file sizes plus manifest overhead.

```ts
export interface StorageEstimate { category: StorageCategory; bytes: number; basis: string } // basis: human-readable formula instantiation
```

**Preflight invariant (Part 13 decision, R-006).** `JobQueue` MUST call `StorageAccountant.estimate` for any job kind that writes media-scale output (proxies, renders, exports, backups, archive restores). If `volumeFreeBytes < estimate.bytes + headroom` where `headroom = max(10 GiB, 5% of volume capacity)`, the job fails preflight with `E_STORAGE_INSUFFICIENT`, `retry: 'safe'`, and a `suggestion` naming the reclaimable bytes from the latest `StorageReport`. The job is not started; accepted state is untouched.

#### 13.1.3 Safe cleanup

Cleanup is plan-then-execute. `planCleanup` produces an itemized `CleanupPlan`; `executeCleanup` deletes exactly the planned items.

```ts
export interface CleanupPlan {
  createdAt: string;
  items: { path: string; category: StorageCategory; bytes: number; regenerable: true }[];
  totalBytes: number;
}
```

**Cleanup invariant (NFR-102, business rule 2).** Cleanup MUST NOT delete accepted project state, source media, accepted generated assets, archive manifests or archived previews, pre-migration snapshots (§13.6.3), or backups. Enforcement is structural, not advisory:

1. The deletion allowlist is exactly: `.guyditor/cache/**`, completed rows in `.guyditor/jobs.sqlite`, and stale restore-test directories (§13.2.6). Nothing else is ever passed to `unlink`.
2. Before each deletion, the path is resolved with `realpath` and MUST still be inside an allowlisted root; symlinks that escape are refused with `E_CLEANUP_PATH_REFUSED`.
3. `history/pre-migration/**` and `archive/**` are inside the project but outside the allowlist by construction; a defensive check refuses them anyway.
4. Every executed cleanup appends a summary line (plan id, bytes, item count) to `.guyditor/cleanup.log` for inspection.

Proxies deleted by cleanup are regenerated on demand through the normal FR-003 regeneration path.

### 13.2 BackupService (NFR-106)

#### 13.2.1 Load-bearing vs derived — the binding enumeration

A backup MUST capture everything needed to satisfy FR-107 reproducibility and MUST NOT depend on anything disposable. The classification below is normative; Part 2 defines the file formats themselves.

| Class | Contents | In backup? |
|---|---|---|
| Load-bearing | `episode.guyditor.yaml` (master); all of `sidecars/`; all of `history/` (journal, revision snapshots, pre-migration snapshots); `proposals/` (open work-in-progress, FR-105); `backup.guyditor.yaml`; `archive/` (manifests + retained previews, §13.3); source media files referenced by assets (inside or outside the project dir); accepted generated assets; project-local presets/skill pins | Always |
| Load-bearing (environment) | `~/.guyditor/skills/`, `presets/`, `templates/`, `profiles/`, `settings.json`, `adapters/` (manifests + config; secrets excluded, AD-011) | When `include.environment` |
| Optional | exported renders and upload kits (`renders` category); `~/.guyditor/audit/` | Per config flags |
| Derived — never required | `.guyditor/cache/**` (proxies, waveforms, analysis, render cache, thumbnails), `.guyditor/jobs.sqlite`, restore-test dirs | Never backed up |

**Global environment layout (owned by Part 1 §1.12; restated):** global skills live in `~/.guyditor/skills/`, presets in `~/.guyditor/presets/`, the creator template library in `~/.guyditor/templates/` (Part 7 §7.2 — covered per §7.4's NFR-106 claim), platform-profile overrides in `~/.guyditor/profiles/`, application settings in `~/.guyditor/settings.json`, and adapter configuration (endpoints, model choices — never credentials, AD-011) in `~/.guyditor/adapters/<adapterId>/manifest.json`. Brand voice/visual preferences are brand *skills* (Part 9 §9.5 categories `brand_voice`/`brand_visual`) under `skills/`; there is no separate `brand/` directory.

#### 13.2.2 Targets

```ts
export type BackupTargetKind = 'local-path' | 'rclone-remote';
export interface BackupTarget {
  name: string;                 // unique per config, user-chosen
  kind: BackupTargetKind;
  path?: string;                // 'local-path': absolute dir — a second local disk or a mounted NAS share
  remote?: string;              // 'rclone-remote': '<remote>:<path>' as configured in the user's rclone config
  rcloneBinary?: string;        // default: 'rclone' resolved on PATH
}
```

`local-path` covers both local disks and NAS mounts; the only difference is that NAS availability is probed (write+read+delete of a probe file) before each run, failing early with `E_BACKUP_TARGET_UNAVAILABLE` (`retry: 'safe'`).

**rclone is a documented external integration (Part 13 decision), not a bundled dependency.** For `rclone-remote` targets, `BackupService` maintains a local staging mirror at `~/.guyditor/backup-staging/<targetName>/` in the same layout as §13.2.3, then shells out with a fixed command set: `rclone sync <staging> <remote> --checksum`, and for verification `rclone check <staging> <remote> --checksum --one-way`. Any encryption is the user's rclone `crypt` remote; Guyditor never sees remote credentials (they live in rclone's own config), and per AD-011 no Guyditor secret ever enters the staging tree.

#### 13.2.3 Target layout and manifest format

Backups are stored content-addressed so unchanged files cost nothing across runs (Part 13 decision):

```
<target-root>/guyditor-backup/
  objects/<aa>/<sha256>            # aa = first two hex chars; file content, verbatim
  projects/<projectId>/runs/<backupId>.manifest.json
  environment/runs/<backupId>.manifest.json
```

```ts
export interface BackupManifestEntry {
  path: string;      // project-relative; out-of-tree sources use 'ext/<sha256[0:8]>/<basename>' with originalPath kept
  originalPath?: string;               // absolute path at backup time, for out-of-tree sources
  role: 'master' | 'sidecar' | 'history' | 'proposal' | 'source' | 'generated'
      | 'preset' | 'render' | 'audit' | 'environment' | 'archive-manifest' | 'config';
  sha256: string;
  size: number;
  mtime: string;
}
export interface BackupManifest {
  format: 'guyditor-backup/v1';
  backupId: string;                    // bak_*
  projectId: string | null;            // null for environment-only runs
  projectRevision: string | null;      // rev_* current accepted revision at snapshot time
  createdAt: string;
  appVersion: string;
  toolVersions: Record<string, string>; // ffmpeg, mlworker, schema format — from AD-013 version records
  target: { name: string; kind: BackupTargetKind };
  reason: 'scheduled' | 'manual' | 'pre-migration' | 'quit';
  entries: BackupManifestEntry[];
  stats: { files: number; bytes: number; newObjects: number; newBytes: number };
}
```

The manifest is the recovery index: a restore needs only manifests plus `objects/`. Everything in `entries` is load-bearing per §13.2.1; nothing derived is ever listed.

#### 13.2.4 Configuration and scheduling

Backup configuration is itself load-bearing and lives in the project root:

```yaml
# <project>/backup.guyditor.yaml
format: guyditor-backup-config/v1
targets:
  - name: nas
    kind: local-path
    path: /mnt/nas/guyditor-backups
  - name: offsite
    kind: rclone-remote
    remote: b2crypt:guyditor
schedule:
  onAcceptedRevision: true      # debounced run after each accepted transaction
  debounceMinutes: 10
  intervalHours: 24             # periodic full pass even without edits
  onQuit: true
include: { renders: false, auditLogs: true, environment: true }
retention: { keepLast: 10, keepDaily: 14, keepWeekly: 12 }
verify: { afterEveryRun: true, mode: sample, samplePercent: 1, minSample: 20, fullEveryDays: 30 }
```

**Backup run algorithm** (job `backup.run`, one target per job):

1. Probe target availability (§13.2.2); fail early with `E_BACKUP_TARGET_UNAVAILABLE` if unreachable.
2. Snapshot the load-bearing set (§13.2.1): read master, walk `sidecars/`, `history/`, `proposals/`, `archive/`, resolve every asset path from the master's asset table (Part 2), include configured optional classes.
3. Hash every file (SHA-256, streamed). For assets, compare against the recorded ingest hash (FR-002); a mismatch aborts the run with `E_BACKUP_VERIFY_MISMATCH` naming the asset (`affected: [ast_…]`) — a backup must never launder silent corruption (NFR-005) into the object store as truth.
4. Upload objects absent from `objects/` (write to temp name, fsync, atomic rename). Existing objects are skipped (dedup).
5. Write `<backupId>.manifest.json` (temp + atomic rename). The run is complete only when the manifest exists.
6. If `verify.afterEveryRun`, enqueue `backup.verify` in `sample` mode (or `full` if the last full check is older than `fullEveryDays`).
7. Apply retention: delete manifests beyond the keep policy, then garbage-collect objects referenced by no remaining manifest.

Scheduling: `BackupService` subscribes to `OperationEngine` transaction-accepted events (debounced per config), a timer for `intervalHours`, and the app-quit hook. All runs are visible `JobQueue` jobs (NFR-100); overlapping triggers coalesce into one queued run per target.

#### 13.2.5 Verification pass

Job `backup.verify` with `mode: 'sample' | 'full'`:

1. Fetch the manifest; validate JSON shape and `format`.
2. Build the check set. `full`: every entry. `sample`: a seeded random sample of `max(minSample, ceil(samplePercent% × entries))` entries, ALWAYS force-including the master file, the latest revision snapshot, `history/transactions.jsonl`, and every `archive-manifest` entry. The RNG seed is recorded in the report so a failed sample is reproducible.
3. For each checked entry, stream-hash the stored object (for `rclone-remote`, run `rclone check --checksum` against the staging mirror, then re-hash the staged copy) and compare to `entry.sha256`.
4. Emit a `VerificationReport`; any mismatch fails the job with `E_BACKUP_VERIFY_MISMATCH`, `retry: 'unsafe'`, and marks the backup run `damaged` in the UI so it is never offered as a restore source without a warning.

```ts
export interface VerificationReport {
  backupId: string; mode: 'sample' | 'full'; seed: string;
  checked: number; totalEntries: number; failures: { path: string; expected: string; actual: string }[];
  completedAt: string;
}
```

#### 13.2.6 Restore-test mode (never disturbs the working project)

Job `backup.restoreTest` proves a backup is restorable without touching the live project:

1. Create a scratch directory OUTSIDE the project tree: default `<os-tmp>/guyditor-restore-test/<backupId>/`, overridable. The live project directory is never written; this is enforced by refusing any scratch path whose `realpath` is inside a known project directory.
2. Materialize every manifest entry from `objects/` into the scratch dir, verifying each SHA-256 during the copy (full check — restore tests are always `full`).
3. Open the restored master with `ProjectStore` in read-only mode; run full project validation (Part 2): schema validity, sidecar hash agreement, asset table consistency.
4. Verify the revision chain: replay `history/transactions.jsonl` head-to-tail and confirm the final revision ID equals `projectRevision` in the manifest (AD-008).
5. Emit a `RestoreTestReport` (same shape as `VerificationReport` plus `validationErrors: string[]` and `revisionChainOk: boolean`), then delete the scratch dir unless `keepScratch: true` was requested.

`backup.restore` (real restore) is the same algorithm with steps 1's target replaced by a user-chosen EMPTY destination directory and no deletion; it refuses a non-empty destination.

### 13.3 Archival and media offlining (NFR-107)

Archiving a finished project moves heavy source media to cold storage while the project stays openable, searchable, and restorable. Cold-storage targets reuse `BackupTarget` (§13.2.2).

**Archival never mutates the master file (Part 13 decision).** Asset entries, paths, and hashes in `episode.guyditor.yaml` are untouched; offline status lives solely in `archive/archive.manifest.json`. `ProjectStore` overlays this manifest at load time to mark assets `offline` instead of `missing`, so no noisy diff or revision bump results from archiving (FR-101).

```ts
export interface ArchiveEntry {
  assetId: string;              // ast_*
  originalPath: string;         // project-relative or absolute, exactly as the master references it
  sha256: string;               // the asset's ingest hash (FR-002)
  size: number;
  target: string;               // BackupTarget.name
  archivePath: string;          // path within <target-root>/guyditor-archive/<projectId>/
  offlinedAt: string;
  state: 'offline' | 'restored';
}
export interface ArchiveManifest {
  format: 'guyditor-archive/v1';
  archiveId: string;            // arc_*
  projectId: string;
  entries: ArchiveEntry[];
}
```

**What stays local and searchable:** the master file, all sidecars (including full transcripts — cross-project search and FR-813 text export keep working), history, proposals, and retained previews. **Retained previews (Part 13 decision):** before an asset is offlined, `archive.offline` promotes from cache (regenerating if evicted) into `archive/previews/<assetId>/`: one poster frame (JPEG, ≤1280px wide), a filmstrip (1 frame per 5 s, 160 px tall, single JPEG strip), and for audio a waveform PNG. These become `project-state` (backed up, never cleaned) so the timeline and browser remain visually navigable with media offline.

**Offline algorithm** (job `archive.offline`), copy–verify–delete, never move-then-hope:

1. Build the plan: eligible files are `sources` and `generated` category only; each must have a recorded ingest hash. `planOffline(projectId, assetIds | 'auto')` returns the plan (`'auto'` selects all sources of the project not shared with an unarchived project).
2. Re-hash each local file and compare with the ingest hash; mismatch aborts with `E_ARCHIVE_HASH_MISMATCH` (`affected: [assetId]`) before anything is copied.
3. Generate/promote retained previews (above) and fsync them.
4. Copy each file to `<target-root>/guyditor-archive/<projectId>/<assetId>/<basename>` (temp + rename), then re-read and hash the cold copy; only on hash equality proceed.
5. Append the `ArchiveEntry` to `archive/archive.manifest.json` (rewrite atomically), THEN delete the local file. A crash between copy and delete leaves a harmless duplicate, never a loss (NFR-103).
6. Trigger a backup run so the updated archive manifest and previews are captured (§13.2.4).

**Restore algorithm** (job `archive.restore`), built on FR-007 relinking:

1. For each requested `assetId`, locate its `ArchiveEntry`; probe the target (fail `E_ARCHIVE_TARGET_UNAVAILABLE`, `retry: 'safe'`).
2. Copy the cold file back to `originalPath` (temp + rename); stream-hash during copy and compare with `entry.sha256`; mismatch fails with `E_ARCHIVE_HASH_MISMATCH` and deletes the partial file.
3. If `originalPath` is unwritable or the user picks a new location, place the file there and execute the FR-007 relink operation (`asset.relink`, Part 3) — which itself re-verifies the hash before accepting the link, so an incorrect replacement can never be accepted silently.
4. Mark the entry `state: 'restored'` (the cold copy is retained until the user explicitly prunes the archive).
5. Missing-media UX hook: when `MediaEngine` reports an asset missing, the FR-007 dialog MUST first consult the archive manifest and offer one-click `archive.restore` before offering manual relinking.

### 13.4 Cross-machine restore (NFR-108)

#### 13.4.1 Environment export bundle

`BackupService.exportEnvironment(destFile)` writes a single zip, `guyditor-env-<date>-<env_id>.zip`, containing the global environment (§13.2.1 layout) plus a manifest at its root. Environment content is also captured inside normal backups when `include.environment` is on; the standalone bundle exists for deliberate machine moves.

```ts
export interface EnvironmentBundleManifest {
  format: 'guyditor-env/v1';
  bundleId: string;              // env_*
  createdAt: string;
  appVersion: string;
  entries: { path: string; sha256: string; size: number;
             role: 'skill' | 'preset' | 'brand' | 'platform-profile' | 'settings' | 'adapter-config' }[];
  secretsExcluded: true;         // literal true: bundles claiming otherwise are rejected
  secretPlaceholders: { adapterId: string; credentialKeys: string[] }[]; // what the user must re-enter (AD-011)
}
```

Exclusions are mandatory, not configurable: OS-keychain secrets (AD-011) are replaced by `secretPlaceholders`; machine-specific hardware capability records (NFR-101) are excluded and re-detected on the new machine; `settings.json` values containing absolute paths are exported but flagged `needsReview` on import.

`importEnvironment(bundleFile)` verifies every entry hash against the manifest (reject with `E_ENV_BUNDLE_INVALID` on any mismatch or on `secretsExcluded !== true`), writes files under `~/.guyditor/` (existing files are backed up to `~/.guyditor/pre-import-<date>/` first, never overwritten blind), and returns an `EnvironmentImportReport` listing imported roles, flagged path settings, and the `secretPlaceholders` checklist.

#### 13.4.2 Project restore procedure with integrity verification

Numbered, end-to-end, for a clean replacement machine:

1. Install Guyditor (same or newer version than `BackupManifest.appVersion`; older versions refuse newer manifest formats).
2. Import the environment bundle (§13.4.1) or restore the latest environment backup run from the target. Verify the import report.
3. Re-enter provider secrets from the `secretPlaceholders` checklist into the OS keychain via the adapter settings UI (AD-011; NFR-003).
4. Attach the backup target (mount the NAS path, or configure rclone with the user's own rclone config for the remote) and open **Restore project** in Guyditor; pick the project and backup run (damaged-flagged runs warn, §13.2.5).
5. Run `backup.restore` into an empty directory (§13.2.6): full hash verification of every entry, revision-chain replay, project validation. Any failure surfaces `E_RESTORE_INTEGRITY_FAILED` with the failing entries; the restore directory is then quarantined, not opened.
6. Out-of-tree sources (`role: 'source'` with `originalPath`) are restored under `<project>/restored-sources/` and relinked via `asset.relink` with hash verification (FR-007) — or, if the source lives in cold storage, restored via `archive.restore` (§13.3).
7. Open the project. Hardware capability detection re-runs (NFR-101); proxies, waveforms, and analysis caches are absent by design and regenerate as visible background jobs (FR-003, FR-009) — no derived data was ever needed from the old machine.
8. Confirm: latest accepted revision matches `projectRevision` from the manifest; render a short HQ preview segment to exercise the toolchain (AD-013 tool versions are recorded in the manifest for comparison).

#### 13.4.3 AC-012 walkthrough

AC-012 ("Survive machine loss") maps directly: back up = §13.2.4 run (with `include.environment: true`) + §13.4.1 bundle; restore on a clean machine = §13.4.2 steps 1–6; verify integrity = §13.4.2 step 5 (hash + chain + validation) plus an explicit `backup.restoreTest` if desired; continue editing with skills, presets, and provider configuration intact = steps 2 and 7; re-entered secrets = step 3. Part 14 automates this as milestone-M4 acceptance: scripted restore into a container followed by a scripted edit + render.

### 13.5 Schema migration framework (NFR-109)

#### 13.5.1 Migrator chain

`@guyditor/core` ships a `MigrationRegistry` holding single-step migrators; migrating `guyditor/v1 → guyditor/vN` composes the chain v1→v2→…→vN. Version skipping is forbidden — every step is written, tested, and reviewed once.

```ts
// @guyditor/core — migration/
export interface MigrationContext {
  projectDir: string;
  readSidecar(relPath: string): Promise<unknown>;   // read-only during planning
  log(message: string): void;
}
export interface MigrationDiffEntry {
  kind: 'structural' | 'semantic';
  target: string;                 // JSON Pointer into the master, or 'sidecars/<path>#<pointer>'
  summary: string;                // human-readable, business-rule-6 style ("caption style X: field renamed …")
  before?: unknown; after?: unknown;
}
export interface MigrationStepResult {
  document: ProjectDocument;      // Part 2's parsed master type
  sidecarWrites: { path: string; content: unknown; schema: string }[];
  diff: MigrationDiffEntry[];
}
export interface SchemaMigrator {
  from: string;                   // 'guyditor/v1'
  to: string;                     // 'guyditor/v2'
  describe(): string;
  migrate(doc: ProjectDocument, ctx: MigrationContext): Promise<MigrationStepResult>;
}
export interface MigrationPlan {
  migrationId: string;            // mig_*
  fromFormat: string; toFormat: string;
  chain: { from: string; to: string; description: string }[];
  diff: MigrationDiffEntry[];     // concatenated, per-step attributed
  semanticChangeCount: number;
}
export interface MigrationRegistry {
  register(m: SchemaMigrator): void;
  plan(projectDir: string, targetFormat: string): Promise<MigrationPlan>;                 // dry run, job migration.dryRun
  apply(projectDir: string, plan: MigrationPlan,
        confirmations: { acknowledgedSemanticTargets: string[] }): Promise<JobRef>;       // job migration.apply
}
```

**Diff classification is the never-silent mechanism.** `structural` = pure representation change (field renamed, container reshaped, defaults made explicit) that provably round-trips editorial meaning; `semantic` = anything that could alter what the creator sees or hears (timing reinterpretation, default-behavior change, lossy consolidation). Classification is declared per change by the migrator author and audited by tests (Part 14 requires a golden round-trip render comparison for every structural-only migrator, per AD-014).

#### 13.5.2 Dry run and review

`plan()` never writes. It parses the master and sidecars, runs the chain in memory, and returns the `MigrationPlan` whose `diff` the UI presents as a reviewable semantic diff — the same diff surface used for agent proposals (FR-105 review idiom). Agents may request a plan through the `AgentGateway` but `apply` is a `consequential`-risk operation (Part 0 operation grammar) and is never covered by the low-risk automation policy (business rule 5).

#### 13.5.3 Apply — with automatic pre-migration backup

Job `migration.apply`:

1. Refuse if `confirmations.acknowledgedSemanticTargets` does not cover every `semantic` diff entry (`E_MIGRATION_SEMANTIC_UNCONFIRMED`, listing the unacknowledged targets). Structural-only migrations still require one overall confirmation in the UI.
2. Run a full backup with `reason: 'pre-migration'` to the primary target and wait for its verification pass. If no backup target is configured or the run fails, abort with `E_MIGRATION_BACKUP_MISSING` — migration without a verified escape hatch is forbidden.
3. Copy the current master and all sidecars to `history/pre-migration/<from>-to-<to>-<date>/` (local escape hatch, exempt from cleanup, §13.1.3).
4. Execute the chain; write new sidecars (temp + atomic rename), then the new master; update sidecar hashes in the master.
5. Record an accepted transaction (FR-104) with operation `project.migrate`, parameters `{ migrationId, fromFormat, toFormat, semanticChangeCount }`, the full plan diff attached, and a new revision snapshot — migration is inspectable history like any edit (AC-002).
6. Re-validate the project; on validation failure, roll back from step 3's snapshot and report with `acceptedStateChanged: false`.

The pre-migration project therefore remains recoverable three ways: local snapshot (step 3), verified backup (step 2), and the prior revision snapshot in `history/revisions/` (AD-008).

### 13.6 Risk mitigation traceability (R-006, R-009)

| Risk | Mitigation mechanism in this part |
|---|---|
| R-006 storage exhaustion | Category accounting and scan (§13.1.1); per-operation estimation formulas (§13.1.2); mandatory `JobQueue` preflight with headroom and `E_STORAGE_INSUFFICIENT` (§13.1.2); safe cleanup limited to regenerable categories with the structural allowlist invariant (§13.1.3); archival to reclaim source-media space without losing restorability (§13.3) |
| R-009 data loss | Load-bearing/derived separation enumerated normatively (§13.2.1); scheduled, deduplicated, hash-verified backups with retention (§13.2.3–13.2.4); sampled and full verification passes with damage flagging (§13.2.5); non-destructive restore tests (§13.2.6); copy-verify-delete offlining and hash-checked archive restore via FR-007 (§13.3); documented cross-machine rebuild with integrity verification and secrets re-entry (§13.4); pre-migration backups and snapshots (§13.5.3) |

### Part 13 requirements coverage

| BRD ID | Implemented in |
|---|---|
| NFR-102 | §13.1.1 (categories, scan, reclaimable classes), §13.1.2 (estimation model, preflight), §13.1.3 (safe cleanup invariant) |
| NFR-106 | §13.2.1 (load-bearing enumeration), §13.2.2 (targets incl. rclone integration), §13.2.3 (manifest format, object store), §13.2.4 (scheduling, run algorithm), §13.2.5 (verification pass), §13.2.6 (restore-test mode) |
| NFR-107 | §13.3 (archive manifest, retained previews, offline and restore algorithms, FR-007 integration) |
| NFR-108 | §13.4.1 (environment bundle, secrets exclusion per AD-011), §13.4.2 (restore procedure with integrity verification), §13.4.3 (AC-012 walkthrough) |
| NFR-109 | §13.5.1 (migrator chain and diff classification), §13.5.2 (dry-run semantic diff), §13.5.3 (pre-migration backup, never-silent apply, recoverability) |
| R-006 | §13.1.2 (preflight), §13.1.3 (cleanup), §13.3 (archival as space recovery); summarized §13.6 |
| R-009 | §13.2 (backup), §13.3 (archival), §13.4 (cross-machine restore), §13.5.3 (pre-migration safety); summarized §13.6 |

---

## Part 14 — Testing, milestones, and implementer workflow

This part defines the test strategy mandated by AD-014, concrete verification procedures for the BRD acceptance scenarios AC-001..AC-012, milestone exit criteria for M0–M4 (Part 0 §0.6, BRD §24), the per-feature definition of done, the workflow rules an AI implementer MUST follow, and the local instrumentation plan for the BRD §23 success indicators. "The BRD" is `BUSINESS-REQUIREMENTS.md` Draft v2 (2026-07-17). All package, service, ID, and time-model names below are the binding names from Part 0 §0.3–0.4.

### 14.1 Test layers, tooling, and commands

Per AD-014 the stack is **Vitest** (unit + property), **Playwright** (UI flows, driving the packaged Electron app via Playwright's `_electron` launcher), **golden-file render tests** (perceptual hashes with explicit tolerances), **pytest** contract tests for `workers/mlworker`, and **script-generated fixture media** (§14.4) — no media binary larger than 100 KB is ever committed (CI enforces this).

Test-file conventions (binding):

1. Unit tests are colocated: `packages/<pkg>/src/**/*.test.ts`.
2. Property tests use **fast-check**, live in `*.prop.test.ts` files, run ≥ 500 cases per property by default, and MUST print the failing seed on failure so runs are reproducible.
3. Golden render cases live in `packages/render/test/golden/*.golden.json` (JSON hash manifests only — never image files).
4. Playwright specs live in `packages/app/e2e/`; acceptance-scenario specs in `packages/app/e2e/ac/ac<NNN>.spec.ts` (one file per AC).
5. mlworker tests live in `workers/mlworker/tests/` (pytest) plus a TypeScript contract suite in `packages/media/src/mlworker/*.contract.test.ts` that spawns the real worker process.

Workspace-root commands (binding names, wired in the root `package.json`):

```json
{
  "scripts": {
    "fixtures":      "node scripts/make-fixtures.mjs",
    "test":          "pnpm -r typecheck && pnpm -r lint && vitest run",
    "test:golden":   "vitest run --project golden",
    "test:contract": "vitest run --project contract && pytest workers/mlworker/tests",
    "test:e2e":      "playwright test -c packages/app/e2e",
    "test:ac":       "playwright test -c packages/app/e2e --grep",
    "check:conventions": "node scripts/check-conventions.mjs",
    "gate:m0": "node scripts/gate.mjs m0", "gate:m1": "node scripts/gate.mjs m1",
    "gate:m2": "node scripts/gate.mjs m2", "gate:m3": "node scripts/gate.mjs m3",
    "gate:m4": "node scripts/gate.mjs m4"
  }
}
```

`scripts/check-conventions.mjs` statically enforces Part 0 conventions: ID prefixes match their regexes (`^ast_[a-z2-7]{10}$`, …, words `^w\d{6}$`, revisions `^rev_\d{5}$`), no `number`-typed seconds fields in `@guyditor/core` model types (float time is forbidden — an ESLint rule `guyditor/no-float-time` flags arithmetic on time-model types outside the rational-time module), canonical service names only, and no committed file in `packages/` or `workers/` larger than 100 KB unless allowlisted.

### 14.2 Per-package test requirements

| Package / worker | Required unit coverage | Required property tests | Golden / e2e |
|---|---|---|---|
| `@guyditor/core` | schema parse/serialize round-trip; `OperationEngine` execute/undo per operation; transaction journal; proposal accept/reject; semantic diff | rational time (P-T1..P-T5 below); diff stability (P-D1) | AC-002, AC-009 suites |
| `@guyditor/media` | ffprobe parsing; hash/ingest; proxy job planning; relink checks | — | mlworker contract suite |
| `@guyditor/transcript` | correction ops; caption cue compilation; SRT/VTT IO | word identity (P-W1..P-W5) | AC-003 golden frames |
| `@guyditor/compositor` | layout constraint solver; keyframe eval; responsive recompose | anchor resolution stability under edits | AC-005/006 goldens |
| `@guyditor/render` | filtergraph compiler snapshot tests (compiled graph text is snapshot-asserted); export validation rules | cache-key: equal inputs ⇒ equal key; any changed input ⇒ changed key | all golden cases (§14.3) |
| `@guyditor/agent` | MCP tool schemas; `AuditLog` write/replay; `CostMeter` budget math | — | AC-004 via stub director |
| `@guyditor/deliver` | platform-profile validation; staleness computation; kit assembly | staleness: overlap detection correct for random edit/range pairs | AC-007/008/011 |
| `@guyditor/app` | Zustand view-state stores; IPC serialization | — | all Playwright AC suites |
| `workers/mlworker` | task handlers with tiny inputs (pytest) | — | contract suite (§14.5) |

**Rational-time properties** (over the Part 2 rational time types, values serialized `{ frames: <int>, fps: "<num>/<den>" }`; oracle = BigInt cross-multiplication):

- **P-T1** add is associative and commutative; `sub(add(a,b), b) == a` exactly.
- **P-T2** `parse(serialize(t)) == t` for all representable values; serialization is canonical (one byte-form per value).
- **P-T3** comparison across different fps values agrees with the BigInt oracle (total order, no epsilon).
- **P-T4** rate conversion between commensurate rates round-trips losslessly; incommensurate conversion returns the Part 0 error envelope (`code: "E_TIME_INCOMMENSURATE"`) rather than rounding silently.
- **P-T5** derived timeline positions: for random clip/gap/overlap sequences, derived starts are exact prefix sums; inserting or removing one clip changes no *stored* field of any other clip (FR-101).
- **P-D1** applying any single operation from the Part 5 catalog to a random valid project changes only the YAML nodes owned by the touched entities: re-serialize and assert the line-level diff touches no other entity block (R-002).

**Word-identity properties** (FR-204; over random sequences of `transcript.word.correct`, split, merge, insert, delete):

- **P-W1** an ordinal assigned once is never renumbered; deleted ordinals are never reused.
- **P-W2** inserted words receive the lowest never-used ordinal (monotonically increasing allocation).
- **P-W3** any anchor `word:w<NNNNNN>` to a surviving word resolves to the identical source-time range after arbitrary edit sequences.
- **P-W4** the word sidecar serializes sorted by source time, and an edit touching k words changes at most k + 1 sidecar lines.
- **P-W5** compiled caption cues: every cue boundary equals its anchored word's canonical timing by exact rational equality — rounding happens only at SRT/VTT serialization, independently per cue, so error never accumulates (FR-208).

### 14.3 Golden-file render tests

Two comparison modes, chosen per artifact class:

- **Pixel-exact (SHA-256)** for output of the deterministic TypeScript overlay renderer (AD-006): captions, titles, callouts rendered to PNG MUST be byte-identical across runs on the same platform and hash-identical across platforms (the renderer uses bundled fonts and no platform text stack).
- **Perceptual (dHash)** for FFmpeg-decoded video frames, where codec/platform variance makes exact matching wrong.

**Perceptual hash algorithm** (binding):

1. Extract the frame at the specified timeline time via the bundled FFmpeg (`select` + `showinfo`, exact frame index — never nearest-seek).
2. Convert to grayscale using Rec.709 luma.
3. Downscale to 9×8 with bilinear filtering.
4. Compute the 64-bit difference hash (dHash): bit = 1 iff `pixel[x][y] > pixel[x+1][y]`.
5. Compare to the golden as Hamming distance over 64 bits.

Default tolerances: **≤ 6/64** for composited video frames; **≤ 2/64** for frames whose purpose is caption/text verification (text defects must fail); **0** where the case says so. Audio assertions use FFmpeg `ebur128`: integrated loudness within **±0.5 LU** of target, true peak not above the profile ceiling.

```ts
// packages/render/test/golden/types.ts
export interface GoldenFrameSpec {
  at: { frames: number; fps: string };   // timeline time, Part 0 time model
  dhash: string;                          // 16 hex chars (64-bit dHash)
  maxDistance: number;                    // Hamming tolerance, 0..64
  reason: string;                         // what this frame proves; shown on failure
}

export interface GoldenTestCase {
  id: string;                             // e.g. "golden-key-diagnostic-checker"
  project: string;                        // fixture project template under .fixtures/projects/
  deliverable?: string;                   // dlv_ id; defaults to the long-form master
  frames: GoldenFrameSpec[];
  overlays?: { path: string; sha256: string }[];      // pixel-exact overlay PNGs
  audio?: { integratedLufs: number; toleranceLu: number; truePeakMaxDb: number };
  toolVersions: { ffmpeg: string; overlayRenderer: string };  // must match pinned versions (AD-013)
}
```

Regenerating goldens requires `vitest run --project golden -- --update`; the commit updating a `.golden.json` MUST state in its body which visual change is intended and which AC or FR justifies it. CI rejects golden updates whose commit message lacks a BRD ID (§14.10).

### 14.4 Fixture media generation (`scripts/make-fixtures.mjs`)

`pnpm fixtures` generates all test media into `.fixtures/` (gitignored) using the bundled FFmpeg from `@guyditor/media`. The script is deterministic: fixed filter expressions, fixed seeds, no wall-clock input; total output < 25 MB; runtime < 60 s. It writes `.fixtures/manifest.json` recording SHA-256, size, and machine-readable **ground truth** for every file, so tests assert against the manifest rather than magic numbers.

```ts
export interface FixtureManifest {
  generatorVersion: string;
  ffmpegVersion: string;
  files: Record<string, {
    sha256: string;
    bytes: number;
    kind: 'video' | 'audio' | 'image' | 'sidecar';
    groundTruth?: unknown;   // per-fixture, documented below
  }>;
}
```

Required fixtures (all durations short by design):

1. **`bars-1080p30-10s.mp4`** — `smptehdbars` 1920×1080@30, 10 s, 1 kHz sine audio, H.264 CRF 18 yuv420p, with the frame number burned in via `drawtext=text='%{n}'` so frame accuracy is visually checkable. Ground truth: fps, frame count.
2. **`speech-48k-20s.wav`** — TTS-free speech-*like* audio: pink noise band-limited 200–3000 Hz, amplitude-modulated at ~4 Hz (syllabic rhythm) via `tremolo`, with scripted silences (volume-enable expressions) at 3.0–3.8 s, 9.0–10.2 s, 15.5–16.0 s. Ground truth: the silence map. Because the audio contains no real words, ASR tests assert *structure and timing*, never word text (§14.5); word-content logic is tested against **synthetic transcript JSON fixtures** (`.fixtures/transcripts/*.json`, generated word lists with exact timings, including a 2,800-word / 20-minute one for drift tests).
3. **`greenscreen-720p30-6s.mp4`** — solid chroma green `0x00B140` background with an animated "presenter": a white ellipse + dark rectangle moving sinusoidally (exercises edges), plus `noise=alls=6` to simulate sensor noise. Ground truth: key color, subject bounding-box path.
4. **`screencast-1080p30-15s.mp4`** — `testsrc2` motion content standing in for a screen recording. Contains one hard cut at exactly frame 225 (two concatenated segments) for scene-detection ground truth.
5. **`avsync-video.mp4` / `avsync-audio.wav`** — a flash + beep at a known frame in the video, and the same beep in a separate WAV shifted **+500 ms**. Ground truth: the offset (FR-008 sync tests).
6. **`stills/diagram-1080.png`, `stills/logo-256.png`** — generated via FFmpeg color/drawtext sources.
7. **`disc-track-720p30-8s.mp4`** — high-contrast moving disc for object-tracking contract tests. Face tracking (mediapipe) cannot be exercised with synthetic media; it is capability-gated (AD-003) and validated manually during dogfood episodes (§14.8), a deliberate decision.
8. **`.fixtures/projects/`** — project-directory templates (an `episode.guyditor.yaml` + sidecars referencing the media above) used by golden and e2e suites; templates are built by the script through `@guyditor/core` so they are always schema-valid.

### 14.5 mlworker contract tests

The TypeScript contract suite spawns the real `workers/mlworker` process over JSON-RPC 2.0 stdio (AD-003) and asserts the protocol, not model quality:

```ts
export interface MlWorkerContractCase {
  task: 'capabilities' | 'transcribe' | 'align' | 'vad' | 'scenes' | 'track' | 'matte';
  fixture?: string;                        // path key into FixtureManifest
  params: Record<string, unknown>;
  expect:
    | { mode: 'schema-only' }              // result validates against the task's JSON Schema
    | { mode: 'ground-truth'; key: string; toleranceMs?: number; toleranceFrames?: number };
}
```

Required cases and pass criteria:

1. **capabilities** — handshake returns the advertised task list; with `GUYDITOR_ML_DISABLE=matting` set, `matte` is absent and the worker still starts (graceful degradation, NFR-101).
2. **vad** on `speech-48k-20s.wav` — detected silence intervals match the manifest silence map within **±150 ms** per boundary.
3. **transcribe** on `speech-48k-20s.wav` — schema-only: segments with start/end, words nested in segments, language + confidence fields present; all timings within media duration and monotonic.
4. **align** on a synthetic transcript fixture + `speech-48k-20s.wav` — returns per-word timings, monotonic, within media bounds (schema + monotonicity only).
5. **scenes** on `screencast-1080p30-15s.mp4` — the hard cut is reported within **±2 frames** of frame 225.
6. **track** on `disc-track-720p30-8s.mp4` — reported box centers within **10 % of frame width** of the ground-truth path on ≥ 90 % of frames.
7. **cancel** — a `transcribe` task cancelled mid-run acknowledges within 2 s and the worker accepts the next task (NFR-103).

### 14.6 Playwright UI-flow harness

A shared helper `launchApp({ projectTemplate })` in `packages/app/e2e/helpers/` copies a `.fixtures/projects/` template into a temp directory, launches the built Electron app with an isolated `--user-data-dir`, and returns Playwright handles. Rules: selectors use `data-testid` attributes from the Part 10 test-ID catalog (never pixel coordinates); job completion is awaited via the `JobQueue` status surfaced in the UI, never `sleep`; every AC spec asserts on-disk outcomes (master file, `history/transactions.jsonl`, exports) in addition to UI state, proving FR-901's single-model rule. Agent-loop specs use the **deterministic stub director**: a scripted MCP client in `packages/agent/test/stub-director/` that connects to the real `AgentGateway` and replays a fixed tool-call sequence, so proposal/accept flows are testable in CI with zero model calls and zero cost; real-model runs are manual (§14.8 dogfood).

### 14.7 Acceptance-scenario test procedures

Each scenario below states fixtures, a numbered procedure, pass criteria, and automation level. Automated procedures are the CI-runnable specs named in §14.1; "manual script" steps are executed verbatim during milestone gates and their results recorded in the dogfood report (§14.8).

#### 14.7.1 AC-001 — Build a long-form episode (automated: `ac001.spec.ts` + golden)

Fixtures: bars, greenscreen, screencast, stills, `speech-48k-20s.wav`. Procedure: (1) create a project (FR-001) choosing the `youtube-longform` profile; (2) import all fixtures via the UI (FR-002) and wait for proxy + transcription + analysis jobs; (3) assemble a 3-layer sequence via UI timeline operations (`clip.*` ops); (4) trim two clips, split one, reorder once; (5) queue a final export. Pass: export completes; the export report (FR-1005) records `rev_`-id, profile, source hashes, output hash; output duration equals the derived timeline duration exactly at the profile fps; container/codec/resolution match the profile; 4 golden frames within tolerance; every UI action appears in `history/transactions.jsonl` as a semantic operation.

#### 14.7.2 AC-002 — Inspect every accepted edit (automated: `@guyditor/core` integration)

Procedure: (1) build a 40-clip project programmatically; (2) apply a scripted 12-transaction sequence (trims, one move, a caption style change, a deliverable derivation); (3) snapshot the master file at `rev_00001` and `rev_00013`. Pass: a line diff between any two consecutive revision snapshots touches only the YAML blocks of the entities named in that transaction — moving one clip in the 40-clip sequence changes **≤ 12 lines** and zero lines inside other clips' blocks (FR-101, P-D1); each `txn_` record renders a human-readable summary from its operation templates; `history/transactions.jsonl` is parseable with `jq` alone — no Guyditor code required (FR-905).

#### 14.7.3 AC-003 — Correct word-highlight subtitles (automated: golden + drift test)

Fixtures: 2,800-word synthetic transcript + `speech-48k-20s.wav`-backed project template. Procedure: (1) compile per-word captions with a caption preset (`pre_`); (2) apply `transcript.word.correct` to three words, split one segment; (3) render caption frames at each corrected word's midpoint; (4) export burned-in MP4, clean MP4, SRT, VTT. Pass: text frames match goldens at distance ≤ 2 (corrected text visible, highlight on the right word); the four outputs exist; **drift check** — for every 50th word of the 20-minute transcript, the SRT/VTT cue time equals the canonical word timing rounded independently per cue with zero accumulated error (last word offset error = first word offset error = 0 ms after rounding); word ordinals unchanged by corrections (P-W1 spot-check).

#### 14.7.4 AC-004 — Review with visual notes (automated: `ac004.spec.ts` with stub director)

Procedure: (1) launch on a template project; (2) pause at an exact frame by frame-stepping; (3) draw an arrow + rectangle, type a note (creates `ann_` with normalized coordinates, FR-403); (4) trigger the stub director, which reads the annotation context package via `AgentGateway` tools and submits a scripted `prp_` proposal trimming the annotated clip; (5) open the comparison view; (6) accept. Pass: before acceptance the accepted revision is unchanged on disk (FR-105); after acceptance a `txn_` exists referencing the `ann_` id and instruction; the annotation state is `resolved` and links to the new `rev_` (FR-406); the `AuditLog` session file contains the tool calls in order.

#### 14.7.5 AC-005 — Composite a presenter (automated: golden)

Fixtures: greenscreen clip, bars background, generated foreground overlay PNG. Procedure: (1) apply chroma key (key color from manifest ground truth) with spill suppression; (2) place presenter between background and foreground layers (FR-501); (3) render the matte over black, white, saturated (`0xFF00FF`), and checkerboard diagnostic backgrounds (FR-504); (4) render the composite. Pass: on each diagnostic render, sampled subject-edge pixels show mean green-channel excess below the case threshold (spill check) and background regions are fully keyed (alpha 0); composite golden frames within distance ≤ 6; layer order in the master file matches FR-501's sandwich.

#### 14.7.6 AC-006 — Use picture-in-picture (automated: `ac006.spec.ts`)

Procedure: (1) place the keyed presenter over the screencast via the named layout constraint `{ anchor: bottom_right, width: 24%, margin: 4% }` (FR-507); (2) drag it in the preview to a new position; (3) at anchor `word:w000123`, apply a movement preset (`pip-smooth-move`) creating a keyframed transition (FR-509); (4) inspect the semantic diff. Pass: the master-file diff for steps 1–3 is **≤ 20 lines**, references the preset by `pre_` id + version and the anchor by word ID, and contains no per-frame coordinate dumps; the drag produced the same operation type as a semantically equivalent agent call would (FR-901); preview golden at the anchor word midpoint within tolerance.

#### 14.7.7 AC-007 — Create short-form derivatives (automated core + manual model step)

Procedure (automated): (1) stub director proposes two short candidates with hook/payoff ranges; (2) the test also selects a transcript passage manually and calls `deliverable.derive` for the `tiktok`, `instagram-reels`, and `youtube-shorts` profiles (Part 11 §11.6 IDs); (3) apply a shot-specific reframe correction (manual crop override, FR-803); (4) export all three. Pass: each output is 1080×1920 at the profile's fps/codec; loudness within profile tolerance; burned + clean variants, SRT + VTT, cover-frame candidates, and export report exist per short (FR-806); short subtitle cues resolve to the same `w`-ordinals as the long-form (FR-804); the manual crop override survives re-derivation. Manual script (dogfood): run candidate discovery with a real director model and record whether candidates are coherent (BR-004 judgment — not CI-assertable).

#### 14.7.8 AC-008 — Detect stale derivatives (automated: `@guyditor/deliver` integration)

Procedure: (1) approve a short derived from long-form range R; (2) record the SHA-256 of its exported file; (3) apply `clip.trim` to a long-form clip overlapping R and accept; (4) apply another edit outside R. Pass: after step 3 the short is `stale` with the affected source range identified and a refresh proposal (preview + diff) available; after step 4 it is *not* re-marked; the approved short's exported file hash is unchanged throughout (business rule 10); a UI spec asserts the stale badge and affected-range explanation render.

#### 14.7.9 AC-009 — Reproduce a revision (automated: determinism harness)

Procedure: (1) build a project through 10 accepted transactions including one frozen "generated" asset (a fixture PNG registered with provenance, business rule 8); (2) export at `rev_00008`, record the export report; (3) advance to `rev_00011`; (4) restore `rev_00008` (FR-108); (5) re-export with the same profile and pinned tools. Pass: restored master file is byte-identical to the `history/revisions/` snapshot; the re-export's frame dHashes match the first export at distance 0 and, on the same platform + FFmpeg build, the output file hash matches the recorded one (FR-1002, AD-013); the frozen asset was reused, not regenerated (FR-107 — asserted via `JobQueue` history containing no generation job).

#### 14.7.10 AC-010 — Reuse creator preferences (automated: `SkillRegistry` integration)

Procedure: (1) in project A, save a caption preset, a motion preset, and an editorial skill (`skl_`) at version 1; (2) create fresh project B and apply the pack; (3) render B's caption test frame; (4) bump the skill to version 2 with different rules. Pass: B references identical `pre_`/`skl_` ids **and versions**; B's caption golden frame is hash-equal to A's; after step 4, project B still resolves version 1 until explicitly upgraded (FR-705) and the version-2 change appears as a distinct skill revision, not an episode edit.

#### 14.7.11 AC-011 — Package an upload kit (automated: `ac011` deliver integration)

Procedure: (1) after AC-001 and AC-007 exports, run kit generation for the long-form master and one short; (2) validate kit contents; (3) trim the long-form opening by 30 frames and accept. Pass: each kit directory contains burned + clean videos, thumbnail/cover, SRT + VTT, `chapters.txt`, `metadata.yaml` (title/description/tags/hashtags within the platform profile's length and count limits — validation must *fail* on an over-limit fixture case), and the export report (FR-812); after step 3 the long-form kit's chapters are flagged **stale** with a warning and are not silently rewritten (FR-810, AC-011's trim clause).

#### 14.7.12 AC-012 — Survive machine loss (automated in CI + manual gate script)

Automated: (1) configure `BackupService` to a temp target; back up a project with skills, presets, and a fake adapter credential stored via the keychain mock; (2) verify the backup (hash manifest check); (3) restore into a fresh temp user-data dir + fresh project location simulating a clean machine (NFR-108); (4) open the restored project, apply and accept one operation. Pass: integrity verification passes; skills, presets, and adapter *configuration* are present; the secret is absent and the adapter reports `needs-credentials` (AD-011 — secrets never in backups); editing works. Manual (once, before the M4 gate closes): perform the restore on a physically different machine following `docs/runbooks/restore.md` and record the result in the dogfood report.

### 14.8 Milestones and exit criteria

Milestones map to BRD §24 (Part 0 §0.6). A milestone closes only when `pnpm gate:m<N>` passes. The gate algorithm:

1. Run `pnpm fixtures`, `pnpm check:conventions`, `pnpm test`, `pnpm test:contract`, `pnpm test:golden`, `pnpm test:e2e` — all green.
2. Run the milestone's AC suites (below) — all pass; earlier milestones' AC suites MUST still pass (no regression).
3. Verify every requirement on the milestone checklist is `implemented` in `docs/traceability.md` (§14.9).
4. Verify `docs/dogfood/M<N>-episode.md` exists and is complete (the BR-008 obligation): a real video was produced **using only functionality shipped in this milestone or earlier** — no hand-run FFmpeg, no external editor for in-scope work. Required fields: episode title/date, source-footage inventory, which shipped features were used, which manual workarounds were needed (each workaround MUST link a filed issue or amendment), links to the export report(s), and the §23 metrics snapshot (§14.11).
5. Emit the gate report to `docs/gates/m<N>-<date>.md`.

| Milestone | Ships (BRD IDs) | AC suites that must pass | BR-008 dogfood obligation |
|---|---|---|---|
| **M0** — scaffold | Repo layout §0.3 builds; `@guyditor/core` schema round-trips; `OperationEngine` executes `clip.trim`/`clip.split` with journal; `JobQueue` persists; fixture script + P-T1..P-T5 green | none (unit/property/contract only) | Render a 10 s "video zero" from a hand-written master file over fixture media through `RenderService` |
| **M1** — Priority A | FR-001..008, FR-100..108, FR-200/201/203/204, FR-300..305, FR-400..406 (core), FR-900/901/904/905, FR-1000..1005, NFR-006/007, NFR-106 (foundation) | AC-001, AC-002, AC-004; AC-009 automated harness | A real presenter episode: ingest, transcript-assisted cut, review loop, long-form export — done entirely in Guyditor |
| **M2** — Priority B | FR-500..511, FR-205..208, FR-306..311, FR-600 (basics), FR-906, FR-009..011 | AC-003, AC-005, AC-006 | A real episode with keyed presenter, PiP, and per-word captions |
| **M3** — Priority C | FR-800..813 | AC-007, AC-008, AC-011 | A real long-form episode **plus ≥ 2 published-quality shorts** exported via upload kits |
| **M4** — Priority D | FR-700..705, FR-304, FR-603..606, FR-702..704, NFR-102, NFR-107..109, FR-1102 | AC-009 (incl. restore-and-rebuild on real episode), AC-010, AC-012 (incl. manual cross-machine restore) | An episode produced by *reusing* saved skills/presets from a previous episode; §23 metrics compared against the M2/M3 episodes |

### 14.9 Definition of done per feature

A feature (one or more BRD requirement IDs, owned by the part named in Part 0 §0.5) is **done** only when all of:

1. Implemented exactly as its owning part specifies, using Part 0 canonical names, ID formats, time model, and operation grammar.
2. Unit tests cover the new code paths; property tests exist where the owning part or §14.2 requires them; a golden or Playwright spec exists if the feature is user-visible.
3. `pnpm test` and `pnpm check:conventions` pass; affected golden/e2e projects pass.
4. The feature's row(s) in `docs/traceability.md` are updated. That file is a single table with columns `BRD ID | Owning part | Status (todo | partial | implemented) | Test evidence (spec/test file paths) | Notes`, seeded at M0 with every BR/FR/NFR/AC ID from the BRD. CI fails if a commit message references a BRD ID whose row was not updated when its status changes.
5. No AD-001..AD-014 decision is violated. If the implementer believes an AD or spec detail is wrong, they file an amendment (§14.10) — the feature is *not done* while code silently deviates.

### 14.10 AI-implementer workflow

Rules for any model (or human) working on this codebase:

1. **Before coding:** read Part 0 in full, then the part that owns the requirement (Part 0 §0.5 table), then the requirement's current `docs/traceability.md` row. Never implement from the BRD alone — the spec parts carry the binding detail.
2. **Small verifiable increments:** each commit is one logical change that leaves `pnpm test` green. Write or update the failing test first where practical.
3. **Never change without an accepted amendment:** AD-001..AD-014; ID prefixes and formats; word-ordinal semantics (`w` + 6 digits, assigned once, never renumbered, never reused); the operation grammar (`<noun>.<verb>`); the error envelope; the master-file schema version; committed golden hashes (except with an intended, justified visual change).
4. **Amendments instead of silent deviation:** proposed spec changes go in `docs/amendments/<NNN>-<slug>.md` (NNN = zero-padded sequence). Required YAML front matter:

```yaml
status: proposed        # proposed | accepted | rejected
affects: [AD-009, "Part 5 §5.3"]
brd_ids: [FR-105]
author: <model or person>
date: 2026-07-17
```

   followed by sections **Problem**, **Proposed change**, **Migration**, **Alternatives considered**. Code may implement an amendment only after `status: accepted` (set by the project owner). Rejected amendments stay in the directory as a record.
5. **Commit messages carry BRD IDs:** format `[<ID>[, <ID>…]] <area>: <imperative summary>`, e.g. `[FR-204] transcript: preserve ordinals across segment merge`. Golden updates additionally justify the visual change in the body. CI lints the format.
6. **Never commit large binaries:** fixtures are generated (`pnpm fixtures`); the 100 KB CI limit (§14.1) is not negotiable.
7. **When blocked or uncertain:** prefer filing an amendment or a `Notes` entry in the traceability row over guessing; a wrong guess in the project format or ID semantics is far more expensive than a paused task.

### 14.11 Success-indicator instrumentation (BRD §23)

Guyditor measures its own usefulness **locally only**: metrics are appended to `~/.guyditor/metrics/usage-<YYYY-MM>.jsonl`, never transmitted anywhere (BR-001, NFR-001), separate from both project state (R-007) and the `AuditLog`, and rendered in-app as a per-episode **Production report**. Timestamps here are operational wall-clock ISO-8601 UTC (the project-model float-time ban applies to project state, not logs).

```ts
export type MetricsEvent =
  | { kind: 'session';           ts: string; projectId: string; durationSec: number }
  | { kind: 'op.executed';       ts: string; projectId: string; op: string;
      source: 'ui' | 'agent' | 'skill-default'; risk: 'low' | 'normal' | 'consequential' }
  | { kind: 'proposal.outcome';  ts: string; projectId: string; proposalId: string;
      outcome: 'accepted' | 'rejected' | 'revised'; understoodFromDiff: boolean | null } // null = not asked
  | { kind: 'phase.reached';     ts: string; projectId: string;
      phase: 'ingest-complete' | 'first-draft' | 'first-accepted-edit' | 'master-export' | 'shorts-export' | 'kit-built' }
  | { kind: 'transcript.correction'; ts: string; projectId: string; wordCount: number; deliverablesAffected: number }
  | { kind: 'derivative.refresh';    ts: string; projectId: string; deliverableId: string; accepted: boolean }
  | { kind: 'revision.restore';      ts: string; projectId: string; revision: string; rebuiltOk: boolean };

export interface SuccessIndicatorReport {   // computed per episode by the Production report view
  projectId: string;
  totalEditingHours: number;
  mechanicalOpShare: number;        // ui-sourced low-risk ops / all ops — should fall across episodes (§23)
  agentAcceptRate: number;          // accepted / (accepted + rejected)
  diffOnlyUnderstanding: number;    // share of proposals resolved without opening generated commands (§23)
  ingestToMasterHours: number;      // phase.reached deltas
  correctionsReused: number;        // transcript corrections with deliverablesAffected > 1 (§23 reuse indicator)
  restoresAttempted: number; restoresRebuilt: number;   // §23 rebuildability
}
```

Mapping to §23: episode-completion-without-external-editor comes from `phase.reached` covering the full chain in one project; declining mechanical time from `mechanicalOpShare` and `ingestToMasterHours` trends across dogfood episodes; proposal comprehensibility from `diffOnlyUnderstanding` (an optional one-tap prompt after proposal review — dismissible, recorded as `null` when skipped); caption-correction reuse from `correctionsReused`; derivative traceability from `derivative.refresh`; rebuildability from restore events. Per the BRD, numerical targets are **not** set until real-episode baselines exist; each dogfood report (§14.8) attaches the `SuccessIndicatorReport` snapshot so M2→M4 trends are comparable. Metrics collection is on by default but disableable in settings; disabling MUST NOT affect any editing functionality.

### Part 14 requirements coverage

| BRD ID | Implemented by |
|---|---|
| AC-001 | §14.7.1 (procedure), §14.3–14.4 (goldens/fixtures), §14.8 (M1 gate) |
| AC-002 | §14.7.2, §14.2 (P-D1), §14.8 (M1 gate) |
| AC-003 | §14.7.3, §14.2 (P-W1..P-W5), §14.8 (M2 gate) |
| AC-004 | §14.7.4, §14.6 (stub director), §14.8 (M1 gate) |
| AC-005 | §14.7.5, §14.4 (green-screen fixture), §14.8 (M2 gate) |
| AC-006 | §14.7.6, §14.8 (M2 gate) |
| AC-007 | §14.7.7, §14.8 (M3 gate) |
| AC-008 | §14.7.8, §14.8 (M3 gate) |
| AC-009 | §14.7.9, §14.8 (M4 gate; harness from M1) |
| AC-010 | §14.7.10, §14.8 (M4 gate) |
| AC-011 | §14.7.11, §14.8 (M3 gate) |
| AC-012 | §14.7.12, §14.8 (M4 gate, manual cross-machine step) |
| BR-008 | §14.8 (dogfood obligation + gate step 4, per-milestone column), §14.11 (episode metrics attached to dogfood reports) |
