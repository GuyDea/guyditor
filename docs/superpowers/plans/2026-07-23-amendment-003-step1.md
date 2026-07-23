# Amendment 003 Step 1 Implementation Plan

> **For agentic workers:** Execute inline on `impl/visuals-003`; do not create a
> worktree, branch, or commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver FR-610, the SVG/font portion of FR-611, and a first-class
template-to-programmatic-clip flow that works in an empty project.

**Architecture:** The current sandboxed painter gains one versioned primitives import
and strictly declared assets. A profile-aware render service freezes frames to local
media and commits the prepared asset through a semantic core operation. Brand
defaults are parsed by the agent skill layer and resolved by the render layer before
every painter entry point.

**Tech Stack:** TypeScript strict, Vitest, `node:vm`, `@napi-rs/canvas`, FFmpeg,
Electron/React, Playwright.

---

### Task 1: Primitives contract and deterministic painter

**Files:**
- Create: `packages/render/src/primitives/v1.ts`
- Create: `packages/render/src/primitives/v1.test.ts`
- Modify: `packages/render/src/template-contract.ts`
- Modify: `packages/render/src/template-runtime.ts`
- Modify: `packages/render/src/graphic-overlay.ts`
- Modify: `packages/render/src/service.ts`
- Modify: `packages/render/src/index.ts`

- [ ] Add failing tests for easing/spring samples, word/character reveal timing,
  shapes/masks/wipes, exact chart values, SVG-map highlighting, cutout styling, and
  deterministic textures.
- [ ] Run the focused test and confirm the missing `PRIMITIVES_V1` import/API failure.
- [ ] Implement the frozen `primitives/v1` module, exact rational word timing context,
  and the single allowed sandbox import.
- [ ] Re-run focused render tests and typecheck.

### Task 2: Hashed SVG/font assets and brand resolution

**Files:**
- Modify: `packages/render/src/template-registry.ts`
- Modify: `packages/render/src/template-runtime.ts`
- Modify: `packages/render/src/template-registry.test.ts`
- Modify: `packages/render/src/template-runtime.test.ts`
- Create: `packages/agent/src/brand-template.ts`
- Create: `packages/agent/src/brand-template.test.ts`
- Modify: `packages/agent/src/index.ts`

- [ ] Add failing tests for font/SVG hash mismatches, missing license fields, and
  explicit-over-brand-over-schema parameter order.
- [ ] Add closed manifest declarations and repeat byte verification at runtime load.
- [ ] Parse the `guyditor-template-brand/v1` JSON block from pinned `brand_visual`
  content and expose typed defaults.
- [ ] Resolve and validate all parameters before preview, overlay, or freeze painting.

### Task 3: Core freeze operation and render/media service

**Files:**
- Create: `packages/core/src/operations/schemas/template.freeze.json`
- Create: `packages/core/src/templates/freeze.ts`
- Create: `packages/core/src/templates/freeze.test.ts`
- Modify: `packages/core/src/operations/engine.ts`
- Modify: `packages/core/src/operations/graphic.ts`
- Modify: `packages/core/src/templates/types.ts`
- Modify: `packages/core/src/templates/index.ts`
- Create: `packages/media/src/programmatic-animation.ts`
- Create: `packages/media/src/programmatic-animation.test.ts`
- Modify: `packages/media/src/index.ts`
- Modify: `packages/render/src/service.ts`
- Create: `packages/render/src/template-freeze.test.ts`

- [ ] Add failing operation and integration tests proving a prepared programmatic
  asset is registered and optionally inserted as the first sequence clip.
- [ ] Add deterministic provenance/asset construction in media and profile-aware
  frame rendering/encoding in render.
- [ ] Execute `template.freeze` only after bytes and sidecar hashes are final.
- [ ] Assert the resulting empty-project timeline duration exactly equals the frozen
  duration.

### Task 4: UI and starter pack

**Files:**
- Modify: `packages/app/src/main/surfaces.ts`
- Modify: `packages/app/src/main/service-host.ts`
- Modify: `packages/app/src/renderer/panels/GraphicsPanel.tsx`
- Modify: `packages/app/src/renderer/styles.css`
- Modify: `packages/app/e2e/workspace.spec.ts`
- Create: `templates/kinetic-title/*`
- Create: `templates/stat-counter-card/*`
- Create: `templates/bar-chart-card/*`
- Create: `templates/cutout-collage-card/*`
- Create: `templates/highlight-underline/*`

- [ ] Add failing surface/component/e2e assertions for “Freeze to clip” in both the
  selected template browser and graphics compose area.
- [ ] Wire the typed IPC method to `RenderService.templateFreeze`.
- [ ] Build five branded parameterized templates exclusively through primitives/v1.
- [ ] Generate 640×360 previews through the production runtime.

### Task 5: Goldens, probe, and traceability

**Files:**
- Create: `packages/render/test/golden/primitives.golden.test.ts`
- Modify: `packages/render/test/golden/templates.golden.test.ts`
- Modify: `packages/render/test/golden/templates.golden.json`
- Modify: `scripts/render-template-previews.mjs`
- Modify: `scripts/probe-no-footage.mjs`
- Modify: `docs/traceability.md`

- [ ] Pin primitive and all nine built-in preview hashes.
- [ ] Rewrite the no-footage probe to freeze the infographic before any generated
  footage and assert the first real clip establishes duration.
- [ ] Mark FR-610 implemented, FR-611 partial, FR-612 todo, and record the FR-600
  probe-gap closure.
- [ ] Run focused tests, then every verification command from the task and report
  exact exit status/output.
