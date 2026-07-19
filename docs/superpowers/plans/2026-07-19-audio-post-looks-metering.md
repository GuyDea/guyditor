# Audio Post, Looks, and Metering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement M2 Step 6 audio post, music ducking/looping, image finishing, preview metering, and their required verification.

**Architecture:** Core owns closed, typed project schemas and reversible semantic operations. Render derives exact-sample ducking envelopes and lowers clip/layer/master audio plus color parameters to deterministic FFmpeg filters; Media owns FFmpeg loudness command construction while Render owns the two-pass whole-program orchestration. The app connects proxy playback to an AudioWorklet meter and exposes ducking configuration and visualization without persisting derived envelopes.

**Tech Stack:** TypeScript strict mode, AJV JSON Schema, FFmpeg/EBU R128, React/Electron Web Audio, Vitest, Playwright.

---

### Task 1: Core audio and color contracts

**Files:**
- Modify: `packages/core/src/project/model.ts`
- Modify: `packages/core/schema/guyditor-v1.schema.json`
- Create: `packages/core/src/operations/audio-color.test.ts`
- Create: `packages/core/src/operations/audio-color.ts`
- Create: operation schemas under `packages/core/src/operations/schemas/`
- Modify: `packages/core/src/operations/engine.ts`
- Modify: `packages/core/src/operations/clip.ts`
- Modify: `packages/core/src/operations/layer.ts`
- Modify: `packages/core/src/project/canonical.ts`
- Modify: `packages/core/src/project/index.ts`

- [x] Write failing operation tests using the exact public types `AudioChain`, `AudioChainNode`, `DuckingConfig`, `DuckingOverridePoint`, and `ColorCorrection`.
- [x] Run `pnpm exec vitest run packages/core/src/operations/audio-color.test.ts` and confirm the new operation names fail as unknown.
- [x] Add closed JSON schemas and reversible handlers for `clip.audio.offset.set`, `clip.audio.channels.set`, `clip.audio.chain.set`, `sequence.audio.master.set`, `clip.loop.set`, `clip.anchor.set`, `layer.ducking.set`, `layer.ducking.override`, `clip.color.set`, and `clip.look.apply`.
- [x] Store look effects as concrete correction values plus `{ presetId, presetVersion }`; require a matching `pre_` pin of kind `look`.
- [x] Re-run the focused test and confirm schema validation, canonical order, bypass, inverse, and YAML round trips pass.

### Task 2: Deterministic ducking and render lowering

**Files:**
- Create: `packages/render/src/ducking.test.ts`
- Create: `packages/render/src/ducking.ts`
- Modify: `packages/render/src/ir.ts`
- Modify: `packages/render/src/graph.test.ts`
- Modify: `packages/render/src/graph.ts`
- Modify: `packages/render/src/filtergraph.test.ts`
- Modify: `packages/render/src/filtergraph.ts`
- Modify: `packages/render/src/index.ts`

- [x] Write failing tests for exact-sample speech interval merging, attack/hold/release ramps, overlapping-ramp minimum gain, manual override precedence, and repeat-call identity.
- [x] Run the focused ducking test and confirm the missing compiler causes RED.
- [x] Implement `compileDuckingEnvelope` over `SampleTime` inputs with stable sorting and no persisted derived state.
- [x] Write failing graph/filter tests for clip and layer chains, audio role layers, anchored placement, loop crossfades, duck automation, master loudness, and color lowering.
- [x] Extend audiochain IR with sequential/anchored/mix modes and typed per-input stages; compile enabled nodes in canonical order, clip fades outside the chain, layer stages after clip stages, ducking before master loudnorm.
- [x] Add a color render node and lower exposure/contrast/saturation through `eq`, tint through `colorbalance`, and temperature through `colortemperature`.
- [x] Re-run focused render tests and confirm GREEN.

### Task 3: Two-pass loudness pipeline and golden

**Files:**
- Create: `packages/media/src/loudness.test.ts`
- Create: `packages/media/src/loudness.ts`
- Modify: `packages/media/src/index.ts`
- Create: `packages/render/src/loudness.test.ts`
- Create: `packages/render/src/loudness.ts`
- Modify: `packages/render/src/index.ts`
- Create: `packages/render/test/golden/audio-post.golden.test.ts`

- [x] Write failing tests for pass-one command construction, JSON extraction, linear pass-two arguments, optional limiter recording, and ebur128 summary parsing.
- [x] Run the media/render focused tests and confirm RED.
- [x] Implement typed loudnorm measurement/correction/verification commands in Media and whole-program cached pass orchestration in Render.
- [x] Add a golden that creates deterministic audio, normalizes it, verifies with FFmpeg `ebur128=peak=true`, and asserts integrated loudness within ±0.5 LU and peak at/below target.
- [x] Run `pnpm exec vitest run --project golden` and record the measured I/TP values.

### Task 4: Preview meter and ducking UI

**Files:**
- Create: `packages/app/src/renderer/loudness-meter.test.ts`
- Create: `packages/app/src/renderer/loudness-meter.ts`
- Create: `packages/app/src/renderer/panels/AudioInspector.tsx`
- Modify: `packages/app/src/renderer/panels/PreviewPanel.tsx`
- Modify: `packages/app/src/renderer/panels/InspectorPanel.tsx`
- Modify: `packages/app/src/renderer/panels/TimelinePanel.tsx`
- Modify: `packages/app/src/renderer/styles.css`
- Modify: `packages/app/e2e/helpers/workspace-project.ts`
- Modify: `packages/app/e2e/workspace.spec.ts`

- [x] Write failing unit tests for target pass/warn/fail status and reset state.
- [x] Run the focused app test and confirm RED.
- [x] Implement the 10 Hz `LoudnessWorklet` proxy-audio graph, M/S/I and true-peak readouts, target band/ceiling, reset, and authority tooltip.
- [x] Add ducking config controls and a music-layer derived-envelope overlay with stable test IDs.
- [x] Add an e2e flow that renders the meter, applies automatic ducking, verifies the visualization, and confirms the semantic journal entry.
- [x] Run app build and the focused Playwright flow.

### Task 5: Traceability and complete verification

**Files:**
- Modify: `docs/traceability.md`

- [x] Update FR-307/308/309/906 status and evidence, explicitly noting source histogram color matching if it remains deferred.
- [x] Run `git diff --check`, inspect every task-owned diff, and correct review findings.
- [x] Run every verification command from the task exactly as written and report command exit status plus the audio golden measurement.

