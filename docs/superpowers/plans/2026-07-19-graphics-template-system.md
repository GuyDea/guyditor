# Graphics and Motion Template System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement FR-600, FR-601, and FR-602 as deterministic, version-pinned template packages whose anchored graphic instances render identically in preview, burn-in exports, and clean exports.

**Architecture:** `@guyditor/core` owns a renderer-neutral template descriptor/provider contract and every semantic graphic/template operation. `@guyditor/render` owns package discovery, manifest/content validation, esbuild compilation, the isolated `node:vm` runtime, seeded rendering, anchor resolution, PNG overlay sequences, and shared preview frames. The app injects one registry into the operation and render services, then exposes a schema-driven graphics panel over the existing typed IPC surface.

**Tech Stack:** TypeScript strict, Vitest, AJV draft 2020-12, YAML, esbuild, `node:vm`, `@napi-rs/canvas`, React 18, Electron IPC, Playwright, FFmpeg overlay nodes.

---

### Task 1: Core graphic model and operations

**Files:**
- Create: `packages/core/src/templates/types.ts`
- Create: `packages/core/src/templates/index.ts`
- Create: `packages/core/src/operations/graphic.ts`
- Create: `packages/core/src/operations/graphic.test.ts`
- Create: `packages/core/src/operations/schemas/graphic.add.json`
- Create: `packages/core/src/operations/schemas/graphic.param.set.json`
- Create: `packages/core/src/operations/schemas/graphic.anchor.set.json`
- Create: `packages/core/src/operations/schemas/graphic.retime.json`
- Create: `packages/core/src/operations/schemas/graphic.remove.json`
- Create: `packages/core/src/operations/schemas/template.install.json`
- Create: `packages/core/src/operations/schemas/template.pin.json`
- Modify: `packages/core/src/operations/engine.ts`
- Modify: `packages/core/src/project/model.ts`
- Modify: `packages/core/src/project/validate.ts`
- Modify: `packages/core/schema/guyditor-v1.schema.json`
- Modify: `packages/core/src/index.ts`

- [ ] Write failing tests proving pin-on-first-use, supplied/generated uint32 seeds, auto-created animation layers, fixed/until/intrinsic serialization, RFC 7386 parameter updates, anchor/retime/remove inverses, explicit pin upgrades, and `E_TEMPLATE_PARAMS_INVALID` failures.
- [ ] Run `pnpm exec vitest run packages/core/src/operations/graphic.test.ts` and confirm the missing catalog/provider behavior fails.
- [ ] Implement `TemplateProvider`, `TemplateDescriptor`, schema validation, semantic applications, inverse metadata, summaries, mutations, and catalog risk classes exactly matching §7.6.
- [ ] Run the focused core test and `pnpm --filter @guyditor/core typecheck` until both pass.

### Task 2: Package registry and sandboxed deterministic renderer

**Files:**
- Create: `packages/render/src/template-contract.ts`
- Create: `packages/render/src/template-registry.ts`
- Create: `packages/render/src/template-registry.test.ts`
- Create: `packages/render/src/template-runtime.ts`
- Create: `packages/render/src/template-runtime.test.ts`
- Create: `packages/render/src/seeded-rng.ts`
- Modify: `packages/render/src/index.ts`
- Modify: `packages/render/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] Write a package-validation matrix covering missing files, closed manifest fields, malformed IDs/semver/engine/duration/schema, path traversal, missing declared assets/fonts, entry compilation failures, and valid package hashing.
- [ ] Run the focused registry tests and observe the missing loader/runtime failures.
- [ ] Implement canonical package SHA-256, project→user→built-in resolution, semver selection, immutable installation, compiled-cache output, and exact pin resolution.
- [ ] Write and fail determinism tests for same params/seed/frame/output context producing byte-identical PNG bytes, different seeds changing seeded decoration, and forbidden `Date`, timers, network, filesystem/imports, and `Math.random` access.
- [ ] Implement `overlay/v1`, xoshiro128**, bundled-font registration, `node:vm` execution with only contract values, static package assets, and PNG rendering through `@napi-rs/canvas`.
- [ ] Run focused render tests and package typecheck.

### Task 3: Built-in packages and golden frames

**Files:**
- Create: `templates/lower-third/template.yaml`, `render.ts`, `preview.png`, and font/assets directory
- Create: `templates/title-card/template.yaml`, `render.ts`, `preview.png`, and font/assets directory
- Create: `templates/callout-box/template.yaml`, `render.ts`, `preview.png`, and font/assets directory
- Create: `templates/full-frame-infographic/template.yaml`, `render.ts`, `preview.png`, and font/assets directory
- Create: `packages/render/test/golden/templates.golden.json`
- Create: `packages/render/test/golden/templates.golden.test.ts`
- Modify: `scripts/setup-caption-font.mjs`
- Create: `scripts/render-template-previews.mjs`

- [ ] Add failing golden assertions for one representative frame per built-in and exact 640×360 preview dimensions.
- [ ] Implement four self-contained manifests and deterministic render modules, including the full-frame card parameters `title`, `body`, `accent`, and `logoSlot`.
- [ ] Generate previews through the same runtime, record exact PNG hashes, and prove repeated renders are byte-identical.

### Task 4: Anchors and render-graph overlays

**Files:**
- Create: `packages/render/src/graphic-overlay.ts`
- Create: `packages/render/src/graphic-overlay.test.ts`
- Modify: `packages/render/src/graph.ts`
- Modify: `packages/render/src/graph.test.ts`
- Modify: `packages/render/src/service.ts`
- Modify: `packages/render/src/filtergraph.test.ts`
- Modify: `packages/render/src/index.ts`
- Create: `packages/render/test/golden/graphics.golden.test.ts`

- [ ] Write failing tests that resolve timeline, clip, beat, and word anchors; reject orphaned and negative spans; resolve fixed/until/intrinsic durations; and preserve full-frame timed instances.
- [ ] Implement ordered graphic frame painting and cached PNG sequences with keys over pin/hash/params/seed/range/geometry/brand/renderer versions.
- [ ] Write failing graph tests proving deliberate graphic overlays are present in `burnin`, `clean`, and preview graphs while captions remain burn-in-only.
- [ ] Extend the M1 supported subset for text/animation item layers and inject graphic overlays through the existing FFmpeg image-sequence rail.
- [ ] Add an anchored lower-third integration golden that asserts preview pixels and both final variants.

### Task 5: App and gateway surfaces

**Files:**
- Create: `packages/app/src/renderer/panels/GraphicsPanel.tsx`
- Modify: `packages/app/src/renderer/App.tsx`
- Modify: `packages/app/src/renderer/panels/PreviewPanel.tsx`
- Modify: `packages/app/src/renderer/panels/Panel.tsx`
- Modify: `packages/app/src/renderer/state/view-state.ts`
- Modify: `packages/app/src/renderer/styles.css`
- Modify: `packages/app/src/shared/ipc.ts`
- Modify: `packages/app/src/main/surfaces.ts`
- Modify: `packages/app/src/main/service-host.ts`
- Modify: `packages/agent/src/gateway.ts`
- Modify: `packages/agent/src/gateway.test.ts`
- Modify: `packages/app/e2e/workspace.spec.ts`
- Modify: `packages/app/e2e/helpers/workspace-project.ts`

- [ ] Add failing service/IPC and Playwright tests for catalog browsing, schema-derived fields, playhead/selected-word placement, live param preview, accepted-instance preview, layer ordering, journaling, and gateway proposal parity.
- [ ] Inject the project-aware registry into every UI/proposal operation engine and the render service.
- [ ] Implement the graphics rack, accessible schema controls, selected-instance editing/removal, word/playhead anchor choice, duration controls, and layer move actions using only semantic operations.
- [ ] Composite the shared main-process painter result above video and below annotation review marks.

### Task 6: Traceability and verification

**Files:**
- Modify: `docs/traceability.md`

- [ ] Mark FR-600/601/602 implemented with exact test/file evidence and note that FR-404 converted overlays can later select installed templates.
- [ ] Run focused tests after every red/green cycle, then the complete user-specified verification matrix.
- [ ] Inspect `git diff --check`, `git status --short`, all changed paths, generated goldens, and package hashes; make no commit.
