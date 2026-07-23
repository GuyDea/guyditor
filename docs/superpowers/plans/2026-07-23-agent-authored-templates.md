# Agent-authored Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement FR-612’s sandbox-validated authoring, draft review, immutable publication, deliverable enforcement, UI, audit trail, end-to-end golden, documentation, and gate traceability.

**Architecture:** `TemplateAuthoringService` owns submission validation and draft/review persistence beneath a hidden registry root. `TemplateRegistry` exposes drafts only to catalog/preview callers, while review state travels on template descriptors so core placement/freeze and render overlay paths reject unreviewed packages with `E_TEMPLATE_UNREVIEWED`; approval copies a normalized immutable package into the existing published registry and therefore reuses normal content-hash pinning.

**Tech Stack:** TypeScript strict mode, Ajv draft-2020-12, esbuild, Node VM sandbox, `@napi-rs/canvas`, MCP/Zod, React, Vitest/Playwright.

---

### Task 1: Authoring contract and validation pipeline

**Files:**
- Create: `packages/render/src/template-authoring.test.ts`
- Create: `packages/render/src/template-authoring.ts`
- Modify: `packages/render/src/template-registry.ts`
- Modify: `packages/render/src/template-runtime.ts`
- Modify: `packages/render/src/index.ts`
- Modify: `packages/core/src/templates/types.ts`

- [ ] **Step 1: Write failing validation tests**

Cover a successful primitives-only stat badge and structured failures for disallowed imports, `Math.random`, invalid parameter schemas/preview params, and source bytes over `MAX_AUTHORED_TEMPLATE_SOURCE_BYTES`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm exec vitest run packages/render/src/template-authoring.test.ts`

Expected: FAIL because `TemplateAuthoringService` and its contract do not exist.

- [ ] **Step 3: Implement the minimal contract and service**

Define strict submission/result/check types, a documented 64 KiB cap, static import analysis, Ajv validation, schema-derived defaults/boundaries, two-seed sandbox probes, byte-equal repeat checks, measured frames/second, preview-strip persistence, and draft metadata. Extend sandbox module resolution to allow only:

```ts
"@guyditor/render/primitives/v1"
`asset:${declaredAssetName}`
```

All checks return:

```ts
interface TemplateAuthorValidationCheck {
  check: "source_size" | "source_parse" | "imports" | "manifest" |
    "param_schema" | "sandbox_probe" | "determinism" | "performance";
  ok: boolean;
  errors: Array<{ code: string; message: string; path?: string }>;
  metrics?: Record<string, number>;
}
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `pnpm exec vitest run packages/render/src/template-authoring.test.ts`

Expected: PASS.

### Task 2: Draft boundary and immutable publication

**Files:**
- Modify: `packages/core/src/templates/freeze.test.ts`
- Modify: `packages/core/src/templates/freeze.ts`
- Modify: `packages/core/src/operations/graphic.test.ts`
- Modify: `packages/core/src/operations/graphic.ts`
- Modify: `packages/render/src/graphic-overlay.test.ts`
- Modify: `packages/render/src/graphic-overlay.ts`
- Modify: `packages/render/src/service.ts`
- Modify: `packages/render/src/template-authoring.test.ts`

- [ ] **Step 1: Write failing enforcement/lifecycle tests**

Assert draft descriptors fail `graphic.add`, `template.freeze`, and deliverable overlay resolution with `E_TEMPLATE_UNREVIEWED`; direct template preview remains allowed. Assert approve publishes `1.0.0` with immutable `contentHash`, reject archives a reason, request-changes requires a superseding submission, and old drafts remain non-renderable.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm exec vitest run packages/core/src/templates/freeze.test.ts packages/core/src/operations/graphic.test.ts packages/render/src/graphic-overlay.test.ts packages/render/src/template-authoring.test.ts`

Expected: FAIL on missing draft-state enforcement and lifecycle.

- [ ] **Step 3: Implement descriptor guards and review transitions**

Add `reviewState: "published" | "draft"` to descriptors/packages/catalog entries. Return:

```ts
makeGuyditorError(
  "E_TEMPLATE_UNREVIEWED",
  `Template ${id}@${version} is awaiting creator review and is preview-only.`,
  { affected: [id] },
)
```

from core placement/freeze and render deliverable-overlay paths. Publish by writing a complete package into a temporary sibling, validating it, and atomically renaming it to `<userRoot>/<templateId>/1.0.0`; never overwrite an existing version.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Task 2 command and expect PASS.

### Task 3: Gateway tools and audit provenance

**Files:**
- Modify: `packages/agent/src/gateway.test.ts`
- Modify: `packages/agent/src/gateway.ts`
- Modify: `packages/agent/src/audit-types.ts`
- Modify: `packages/agent/src/audit-log.ts`
- Modify: `packages/agent/src/audit-log.test.ts`
- Modify: `packages/agent/src/index.ts`

- [ ] **Step 1: Write failing gateway/audit tests**

Exercise `template_author_submit` and `template_author_status` over MCP, including session/model propagation, structured validation failure output, and submitted/reviewed audit records.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm exec vitest run packages/agent/src/gateway.test.ts packages/agent/src/audit-log.test.ts`

Expected: FAIL because the tools and record variants are absent.

- [ ] **Step 3: Register tools and audit records**

Inject a narrow authoring service:

```ts
interface GatewayTemplateAuthoring {
  submit(input: TemplateAuthorSubmission, provenance: {
    sessionId: string;
    model: string;
  }): Promise<TemplateAuthorSubmitResult>;
  status(submissionId?: string): Promise<TemplateAuthorStatus | TemplateAuthorStatus[]>;
}
```

Register both tools with closed Zod schemas, route through the existing audited `#toolCall`, and add `template.author.submitted` / `template.author.reviewed` record variants.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Task 3 command and expect PASS.

### Task 4: Creator review and template-browser UI

**Files:**
- Modify: `packages/app/src/main/project-services.ts`
- Modify: `packages/app/src/main/service-host.test.ts`
- Modify: `packages/app/src/main/service-host.ts`
- Modify: `packages/app/src/main/surfaces.ts`
- Modify: `packages/app/src/shared/ipc.ts`
- Modify: `packages/app/src/renderer/panels/GraphicsPanel.tsx`
- Modify: `packages/app/src/renderer/styles.css`
- Modify: `packages/app/e2e/workspace.spec.ts`

- [ ] **Step 1: Write failing service/UI coverage**

Assert the app exposes draft status/review calls, catalog entries label `awaiting_review`, preview strips render, parameter forms remain interactive, and approve/reject/request-changes controls call the authoring service with explicit reasons where required.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm exec vitest run packages/app/src/main/service-host.test.ts && pnpm --filter @guyditor/app test:e2e -- --grep "authored template"`

Expected: FAIL because the IPC surface and UI controls are absent.

- [ ] **Step 3: Wire service and UI**

Construct one project-scoped authoring service using the registry’s draft root and the app `AuditLog`. Add `TemplateAuthoringService.status/review` IPC methods. Render preview-strip thumbnails, an `Awaiting review` badge, an inline reason field, and `Approve`, `Request changes`, and `Reject` buttons; keep place/freeze actions disabled for draft selections.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Task 4 command and expect PASS.

### Task 5: Authored-template end-to-end golden

**Files:**
- Create: `packages/render/test/golden/authored-template.golden.test.ts`
- Create: `packages/render/test/golden/authored-template.golden.json`

- [ ] **Step 1: Write the failing integration golden**

Submit a novel animated stat badge using rectangles, text, easing, and a seeded accent; validate, approve, place, freeze, export, hash representative frames/output, and assert provenance pins the published template hash.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run --project golden packages/render/test/golden/authored-template.golden.test.ts`

Expected: FAIL until lifecycle/render wiring is complete or expected hashes are recorded.

- [ ] **Step 3: Complete only the integration wiring required by the proof**

Use the real `TemplateAuthoringService`, `TemplateRegistry`, `OperationEngine`, and `RenderService`; do not bypass package validation, review, freeze, or export.

- [ ] **Step 4: Run and confirm GREEN**

Run the Task 5 command and expect PASS with stable hashes across repeated runs.

### Task 6: Director contract, traceability, and gate

**Files:**
- Create: `docs/authoring-templates.md`
- Modify: `docs/traceability.md`
- Modify: `docs/amendments/003-motion-design-system.md`
- Modify: `scripts/gate.test.mjs`
- Modify: `scripts/gate.mjs`

- [ ] **Step 1: Write the failing gate test**

Require M4 focused visuals checks to include the authored-template unit/integration suite and require FR-610, FR-611, and FR-612 as implemented traceability rows.

- [ ] **Step 2: Run and confirm RED**

Run: `node --test scripts/gate.test.mjs`

Expected: FAIL because FR-612 and the visuals focus are not in M4.

- [ ] **Step 3: Add docs and gate wiring**

Document the exact submission schema, primitives/asset imports, 64 KiB cap, probe samples/seeds, performance floor, structured errors, preview-only draft state, review outcomes, superseding loop, and immutable publication. Add `implemented: 2026-07-23` to amendment front matter and mark FR-612 implemented with evidence. Add a focused Vitest visuals command to M4.

- [ ] **Step 4: Run focused checks and confirm GREEN**

Run: `node --test scripts/gate.test.mjs && node scripts/check-conventions.mjs`

Expected: PASS.

### Task 7: Full verification and review

**Files:**
- Review all task-owned changes; do not commit.

- [ ] **Step 1: Run the required verification matrix**

```sh
pnpm -r typecheck && pnpm -r lint && pnpm exec vitest run && node scripts/check-conventions.mjs
pnpm exec vitest run --project golden
pnpm --filter @guyditor/app build && pnpm test:e2e
node scripts/probe-no-footage.mjs
node scripts/gate.mjs m4 -- --skip-dogfood
```

- [ ] **Step 2: Inspect ownership and whitespace**

Run: `git status --short && git diff --check && git diff --stat && git diff`

Expected: only FR-612 task files changed, no whitespace errors, and no commit created.

- [ ] **Step 3: Report evidence**

Summarize validation checks/metrics, the two requested blocked deliverable paths, authored-template lifecycle/golden hashes, every verification exit status, and any remaining caveat.
