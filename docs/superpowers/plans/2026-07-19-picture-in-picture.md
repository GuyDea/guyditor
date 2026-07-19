# Picture-in-Picture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement FR-506 through FR-510, complete FR-306 keyframed transform lowering, automate AC-006, and add the M2 PiP authoring UI without storing solved coordinates.

**Architecture:** Core stores and validates only sparse semantic data and registers invertible operations. Compositor exposes pure placement, motion, preview, and collision functions. Render converts those functions' derived states into raster mask/chrome assets and FFmpeg expressions. App controls call the same semantic operations as agents.

**Tech Stack:** TypeScript strict, AJV draft 2020-12, Vitest, fast-check, React 18, Zustand, WebGL 2, `@napi-rs/canvas`, FFmpeg, Playwright.

---

### Task 1: Canonical PiP model and operations

**Files:**
- Modify: `packages/core/src/project/model.ts`
- Modify: `packages/core/src/project/index.ts`
- Modify: `packages/core/src/project/canonical.ts`
- Modify: `packages/core/src/project/validate.ts`
- Modify: `packages/core/schema/guyditor-v1.schema.json`
- Modify: `packages/core/src/operations/engine.ts`
- Create: `packages/core/src/operations/schemas/pip.style.set.json`
- Create: `packages/core/src/operations/schemas/pip.place.json`
- Create: `packages/core/src/operations/schemas/pip.keyframe.add.json`
- Create: `packages/core/src/operations/schemas/pip.keyframe.remove.json`
- Create: `packages/core/src/operations/schemas/pip.preset.apply.json`
- Create: `packages/core/src/operations/schemas/pip.avoid.solve.json`
- Create: `packages/core/src/operations/schemas/region.mark.json`
- Test: `packages/core/src/project/pip-project.test.ts`

- [ ] Write schema round-trip tests for every FR-506 style field, sparse constraints, semantic keyframes, and typed `AvoidRegion`; verify they fail while `Layer.pip` and `avoidRegions` are `unknown`.
- [ ] Add `ShapeMask`, `PipStyle`, `PipConfig`, `PlacementConstraints`, `ResponsivePlacement`, `PipKeyframe`, `AvoidRegion`, and `AvoidSolverConfig`, then export them.
- [ ] Add canonical key ordering and schema definitions. Validate kind restrictions, preset pins/versions, avoid-region IDs/ranges, semantic anchor syntax, and malformed constraints.
- [ ] Register the seven exact Part 6 operation names with JSON schemas, risk classes, and summaries; compositor dispatch will implement their domain effects.
- [ ] Run the focused core tests and keep the existing project round-trip suite green.

### Task 2: Constraint, drag, motion, and collision engine

**Files:**
- Create: `packages/compositor/src/placement.ts`
- Create: `packages/compositor/src/motion.ts`
- Create: `packages/compositor/src/pip.ts`
- Create: `packages/compositor/src/avoidance.ts`
- Modify: `packages/compositor/src/index.ts`
- Test: `packages/compositor/src/placement.test.ts`
- Test: `packages/compositor/src/motion.test.ts`
- Test: `packages/compositor/src/pip-operations.test.ts`
- Test: `packages/compositor/src/avoidance.test.ts`

- [ ] Write failing grammar tests for all allowed keys, percentage bases, aspect/fit modes, output-size stability, and `E_PIP_CONSTRAINT` failures.
- [ ] Implement `parsePlacementConstraints`, `formatPlacementConstraints`, `solvePlacement`, pixel rounding, and drag-to-constraint round-trip with the 1.5%-of-width snap tolerance.
- [ ] Write failing tests covering every named FR-508 preset, fixed `pre_` identity/version, cubic-bezier sampling, holds between semantic keyframes, and midpoint evaluation.
- [ ] Implement the preset registry and shared curve compiler. Curve samples are derived `TransformKeyframe` values; master `PipKeyframe` objects stay semantic.
- [ ] Write failing operation tests for style/place/add/remove/apply plus UI/agent byte equivalence, locked/wrong-kind errors, inverses, and preset pin creation.
- [ ] Extend `CompositorModel.dispatchOperation` with the exact PiP and region operations.
- [ ] Write failing collision tests for hard caption/safe-area/marked regions, soft overlap persistence, candidate scoring, hysteresis, return motion, tracking-hook diagnostics, and proposal-only output.
- [ ] Implement the pure collision preview/plan API and expose proposal operations without directly applying them.

### Task 3: Final-render and WebGL parity

**Files:**
- Modify: `packages/render/src/ir.ts`
- Modify: `packages/render/src/graph.ts`
- Modify: `packages/render/src/filtergraph.ts`
- Modify: `packages/render/src/service.ts`
- Modify: `packages/render/src/index.ts`
- Create: `packages/render/src/pip-assets.ts`
- Create: `packages/app/src/renderer/pip-preview.tsx`
- Test: `packages/render/src/filtergraph.test.ts`
- Test: `packages/render/src/graph.test.ts`
- Test: `packages/render/src/pip-assets.test.ts`
- Test: `packages/app/src/renderer/pip-preview.test.ts`

- [ ] Write a failing filtergraph test with two transform keyframes and assert piecewise `n` expressions for position, scale, opacity, and eased samples.
- [ ] Replace the static-only transform guard with deterministic piecewise-linear FFmpeg expression compilation, while preserving the one-keyframe output byte-for-byte.
- [ ] Write failing graph tests that resolve semantic PiP anchors, solve target rectangles, emit transforms, and reject unresolved anchors.
- [ ] Connect graph compilation to compositor motion output using a supplied semantic-anchor frame map; RenderService builds that map from transcript sidecars.
- [ ] Write failing style-raster tests for none/rect/rounded/circle/ellipse masks, border, shadow, background padding/blur metadata, and device-frame chrome.
- [ ] Add cache-keyed deterministic gray-mask and transparent-chrome assets, a PiP render node, and filtergraph alpha/chrome compositing.
- [ ] Add a WebGL SDF preview that consumes the same solved rectangle, style, and evaluated curve state; expose a deterministic shader contract test and fall back visibly if WebGL is unavailable.

### Task 4: PiP authoring UI

**Files:**
- Create: `packages/app/src/renderer/panels/PipInspector.tsx`
- Modify: `packages/app/src/renderer/panels/InspectorPanel.tsx`
- Modify: `packages/app/src/renderer/panels/PreviewPanel.tsx`
- Modify: `packages/app/src/renderer/state/view-state.ts`
- Modify: `packages/app/src/renderer/styles.css`
- Test: `packages/app/src/renderer/state/workspace.test.ts`
- Test: `packages/app/e2e/ac/ac006.spec.ts`

- [ ] Add failing state/helper tests for transient drag rectangles, overlap warnings, live preset preview, and semantic operation generation.
- [ ] Add preview pointer dragging/resizing that emits `pip.place` or `pip.keyframe.add`; never put its transient rectangle in the project mirror.
- [ ] Add a compact constraint editor, style controls, named preset picker, selected-word/current-frame anchor choice, transition duration, and live loop preview.
- [ ] Add a marked-region tool that emits `region.mark`, outlines hard/soft overlap, shows collision proposal moves, and requires explicit proposal accept/reject.
- [ ] Add keyboard focus, labels, reduced-motion behavior, and visible WebGL fallback messaging.

### Task 5: AC-006 and M2 gate

**Files:**
- Modify: `scripts/fixture-spec.mjs`
- Modify: `scripts/make-fixtures.mjs`
- Modify: `scripts/test-ac.mjs`
- Modify: `scripts/gate.mjs`
- Modify: `scripts/gate.test.mjs`
- Create: `packages/render/test/golden/ac006.golden.test.ts`
- Create: `packages/render/test/golden/ac006.golden.json`
- Modify: `docs/traceability.md`

- [ ] Generate a schema-valid keyed-presenter-over-screencast AC-006 project with `word:w000123` timing and a built-in motion pin.
- [ ] Automate placement, drag-equivalent operation comparison, preset/keyframe application, canonical line-diff count, absence of coordinate dumps, and midpoint preview golden.
- [ ] Add AC-006 to `test:ac m2`, make FR-506/507/508/509, FR-306, and AC-006 full M2 requirements, and keep FR-510 partial with explicit M3 tracking exclusions.
- [ ] Update traceability evidence to exact unit/golden/e2e files.
- [ ] Run focused red/green cycles, then the complete verification command matrix supplied by the task. Do not commit.

