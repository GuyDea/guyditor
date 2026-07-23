# Guyditor

An **agent-native, local-first video editor** for solo creators. A frontier AI model
acts as the editing director through a structured API; you stay in control of every
consequential decision. One human-readable project file is the source of truth; every
accepted edit is a reviewable semantic transaction.

**Core workflow:** shoot → local transcription → agent-proposed condensed cut →
review with frame annotations → keyed/matted presenter compositing, per-word
captions, motion graphics → optional segmented AI restyling with seam concealment →
long-form export + platform-ready shorts with upload kits.

- Business scope: [BUSINESS-REQUIREMENTS.md](BUSINESS-REQUIREMENTS.md)
- Technical spec (binding): [IMPLEMENTATION-SPEC.md](IMPLEMENTATION-SPEC.md)
- Current status: [docs/PROJECT-STATE.md](docs/PROJECT-STATE.md) — all milestones
  M0–M4 and amendments 001–003 are implemented and gated.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 22+ (24 tested) | `node:sqlite` is used (experimental warning is expected) |
| pnpm | 10.x | workspace root pins `packageManager` |
| FFmpeg + ffprobe | 4.4+ on PATH | or set `GUYDITOR_FFMPEG` / `GUYDITOR_FFPROBE`; bundled binaries are a later packaging task |
| uv | 0.11+ | provisions the Python 3.11 ML worker (system Python is not used) |
| Linux/macOS | — | developed on Linux; Electron 43 |

## Setup

```bash
pnpm install                 # workspace dependencies
pnpm fixtures                # deterministic test media into .fixtures/ (<25 MB, ~10 s)
bash workers/mlworker/setup.sh   # uv-managed Python 3.11 venv: faster-whisper, VAD,
                                 # CTC alignment, mediapipe tracking (~400 MB, CPU-only)
```

> **"Error: Electron uninstall" on `dev`?** pnpm 10 blocks dependency install
> scripts unless approved; the workspace approves `electron` and `esbuild` via
> `onlyBuiltDependencies` in `pnpm-workspace.yaml`. If the Electron binary is still
> missing after `pnpm install` (older installs), run
> `node node_modules/electron/install.js` once.

Optional ML extras:

- **Whisper models** download on first transcription into
  `GUYDITOR_ML_MODEL_DIR` (default `~/.cache/guyditor-mlworker`); `tiny` is used by
  tests, pick larger models in-app for real footage.
- **Neural matting** (green-screen-free presenter cutout): download the official
  [RobustVideoMatting v1.0](https://github.com/PeterL1n/RobustVideoMatting/releases/tag/v1.0.0)
  MobileNetV3 TorchScript file into `GUYDITOR_ML_MODEL_DIR`. Without it the `matte`
  capability is simply absent (everything else works).

## Run the app

```bash
pnpm dev          # launch the Electron workspace (alias: pnpm start)
pnpm build:app    # production build to packages/app/dist
```

First steps in the app: create a project (pick a platform profile), drop media into
the asset browser (or configure a watch folder — see
[docs/capture-integration.md](docs/capture-integration.md)), and watch the global
progress bar: everything the system is doing — or waiting on you for — is one click
away.

**Attach an AI director:** the Agent Gateway (MCP over loopback HTTP) starts with the
app; endpoint + bearer token are written to `~/.guyditor/state/gateway.json`
(mode 0600). Any MCP-capable model can drive the full editing surface — every change
arrives as a proposal you review. Template authoring contract for directors:
[docs/authoring-templates.md](docs/authoring-templates.md).

**External providers** (optional, off by default): Kling restyling and generative
B-roll adapters run in deterministic stub mode until you add credentials (stored in
the OS keychain, never in project files). Budgets and pre-flight cost estimates are
enforced before any paid call.

## Verify your setup

```bash
pnpm test              # typecheck + lint + unit/property suites
pnpm test:contract     # spawns the real Python worker
pnpm test:golden       # pixel-exact render goldens
pnpm test:e2e          # Playwright over the built Electron app
node scripts/gate.mjs m4 -- --skip-dogfood   # full milestone gate chain
node scripts/probe-no-footage.mjs            # end-to-end: empty project → generated-
                                             # only 4K export
```

## Repository map

```
packages/core        project model, rational time, operations, proposals, journal
packages/media       ffmpeg engine, ingest, proxies, ML worker supervisor, backup
packages/transcript  transcription, word identity, captions, range editing
packages/compositor  PiP constraints, motion presets, collision avoidance
packages/render      render graph, filtergraph, overlay/template renderer, service
packages/agent       MCP gateway, skills, adapters, audit log, cost meter
packages/deliver     deliverables, platform profiles, shorts, publish kits
packages/app         Electron main + React workspace
workers/mlworker     Python sidecar (transcribe/align/vad/scenes/track/matte)
templates/           built-in motion-graphics templates
profiles/            versioned platform export profiles
docs/                state, traceability, amendments, gates, runbooks
```

Contributing (human or AI): read `IMPLEMENTATION-SPEC.md` Part 0 first; §14.10
defines the workflow rules, commit format, and the amendment process. Requirement
status lives in [docs/traceability.md](docs/traceability.md).
