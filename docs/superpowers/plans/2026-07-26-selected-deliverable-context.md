# Selected Deliverable Workspace Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one project-portable active deliverable drive every Guyditor editing and review surface without changing the canonical edit merely because the creator switched distributions.

**Architecture:** A strict optional `workspace.guyditor.yaml` file is owned by a main-process state store and exposed through two `ProjectStore` IPC methods. The renderer has one pure deliverable resolver and one activation action; panels resolve through it, while project opening hydrates it and ordinary revision refreshes preserve it. Backup and storage services treat the file as non-editorial project state, and the existing transcript range operation gains a backward-compatible optional sequence target so short-form transcript edits cannot fall through to the master.

**Tech Stack:** TypeScript 5 strict mode, Electron 43, React 18, Zustand 5, YAML 2.9, Vitest 4, Playwright 1.61, pnpm workspaces.

---

**Execution branch:** `fix/selected-deliverable-context`. This branch was created from the local default branch before implementation; execute the plan on it rather than creating another branch or worktree.

## File structure

### New files

- `packages/app/src/main/project-workspace-state.ts` — strict parsing, fallback, serialized atomic publication, and project-deliverable validation for `workspace.guyditor.yaml`.
- `packages/app/src/main/project-workspace-state.test.ts` — persistence, compatibility, corruption preservation, and last-write coverage.
- `packages/app/src/renderer/active-deliverable.ts` — the shared resolver, local reset, and persistence-aware activation action.
- `packages/app/src/renderer/active-deliverable.test.ts` — resolver, reset, and failed-autosave behavior.
- `packages/app/src/renderer/panels/active-deliverable-panels.test.ts` — server-rendered proof that Preview, Timeline, and Captions resolve the same short.
- `packages/app/e2e/active-deliverable.spec.ts` — packaged Electron proof of cross-phase selection, short-targeted editing, canonical byte stability, project copying, and fresh-profile reopen.

### Existing files by responsibility

- Main/IPC: `packages/app/package.json`, `pnpm-lock.yaml`, `packages/app/src/shared/ipc.ts`, `packages/app/src/main/project-services.ts`, `packages/app/src/main/service-host.ts`, `packages/app/src/main/service-host.test.ts`, `packages/app/src/main/surfaces.ts`, `packages/app/src/main/surfaces.test.ts`.
- Storage safety: `packages/media/src/storage.ts`, `packages/media/src/storage.test.ts`, `packages/media/src/backup.ts`, `packages/media/src/backup.test.ts`.
- Renderer state/lifecycle: `packages/app/src/renderer/ipc.ts`, `packages/app/src/renderer/App.tsx`, `packages/app/src/renderer/state/view-state.ts`, `packages/app/src/renderer/state/workspace.test.ts`.
- Read/review panels: `packages/app/src/renderer/panels/PreviewPanel.tsx`, `TimelinePanel.tsx`, `TranscriptPanel.tsx`.
- Editing/switch panels: `GraphicsPanel.tsx`, `BrollPanel.tsx`, `PipInspector.tsx`, `KeyInspector.tsx`, `RestylePlan.tsx`, `PublishPanel.tsx`, `StatusStripPanel.tsx`, `ProposalPanel.tsx`, `InspectorPanel.tsx`.
- Sequence-scoped transcript edit: `packages/core/src/operations/schemas/transcript.range.remove.json`, `packages/transcript/src/range-operations.ts`, `packages/transcript/src/range-operations.test.ts`.
- Electron fixture/docs: `packages/app/e2e/helpers/workspace-project.ts`, `docs/MANUAL.md`, `docs/traceability.md`.

## Invariants to preserve

- `episode.guyditor.yaml`, `history/HEAD`, and `history/transactions.jsonl` do not change on a deliverable switch.
- The workspace file is not passed into render, staleness, undo, or operation code.
- A legacy missing workspace document is silent; invalid state warns but never blocks
  the project, and a just-created project's failed initialization surfaces one
  non-blocking warning.
- Invalid bytes remain untouched until an explicit valid selection replaces them.
- Switching stops playback; resets playhead, scroll, loop, key audition, and sequence-bound selections; and preserves zoom and layouts.
- Deriving a new short and the explicitly named “render primary” action remain anchored to `settings.primaryDeliverable`.

### Task 1: Strict atomic project workspace state

**Files:**
- Create: `packages/app/src/main/project-workspace-state.ts`
- Create: `packages/app/src/main/project-workspace-state.test.ts`
- Modify: `packages/app/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add YAML as a direct app dependency**

Add `"yaml": "^2.9.0"` beside the other runtime dependencies in `packages/app/package.json`, then update only the lockfile importer:

```bash
pnpm install --lockfile-only
```

Expected: `pnpm-lock.yaml` gains `yaml` under the `packages/app` importer and reuses version `2.9.0`; no unrelated package versions change.

- [ ] **Step 2: Write failing workspace-state tests**

Create `packages/app/src/main/project-workspace-state.test.ts` with temporary-root cleanup and these concrete cases:

```ts
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import {
  PROJECT_WORKSPACE_FILE,
  ProjectWorkspaceStateStore,
} from "./project-workspace-state.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "guyditor-workspace-state-"));
  roots.push(value);
  return value;
}

function projectWithShort() {
  const project = projectFixture();
  project.deliverables.push({
    id: "dlv_bbbbbbbbbb",
    kind: "short",
    name: "Portrait short",
    profile: "youtube-shorts@1.0.0",
    sequenceId: "seq_bbbbbbbbbb",
    status: "draft",
  });
  return project;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true }),
  ));
});

describe("ProjectWorkspaceStateStore", () => {
  it("falls back silently when the optional document is missing", async () => {
    const path = await root();
    const loaded = await new ProjectWorkspaceStateStore(path).load(projectWithShort());
    expect(loaded).toEqual({
      state: {
        format: "guyditor.workspace/v1",
        activeDeliverableId: "dlv_aaaaaaaaaa",
      },
    });
  });

  it("does not block project creation when preference initialization fails", async () => {
    const unavailable = join(await root(), "missing-parent");
    const store = new ProjectWorkspaceStateStore(unavailable);
    const project = projectWithShort();

    await expect(store.initialize(project)).resolves.toEqual({
      format: "guyditor.workspace/v1",
      activeDeliverableId: "dlv_aaaaaaaaaa",
    });
    await expect(store.load(project)).resolves.toMatchObject({
      state: { activeDeliverableId: "dlv_aaaaaaaaaa" },
      warning: expect.stringContaining(
        "Could not initialize workspace selection",
      ),
    });
  });

  it.each([
    ["invalid YAML", "format: [\n"],
    ["unsupported format", "format: guyditor.workspace/v2\nactiveDeliverableId: dlv_bbbbbbbbbb\n"],
    ["unknown field", "format: guyditor.workspace/v1\nactiveDeliverableId: dlv_bbbbbbbbbb\nextra: true\n"],
    ["malformed ID", "format: guyditor.workspace/v1\nactiveDeliverableId: master\n"],
    ["deleted deliverable", "format: guyditor.workspace/v1\nactiveDeliverableId: dlv_cccccccccc\n"],
  ])("preserves %s bytes and returns a warned primary fallback", async (_label, bytes) => {
    const path = await root();
    const document = join(path, PROJECT_WORKSPACE_FILE);
    await writeFile(document, bytes, "utf8");

    const loaded = await new ProjectWorkspaceStateStore(path).load(projectWithShort());

    expect(loaded.state.activeDeliverableId).toBe("dlv_aaaaaaaaaa");
    expect(loaded.warning).toContain("using primary deliverable");
    await expect(readFile(document, "utf8")).resolves.toBe(bytes);
  });

  it("publishes known IDs atomically and rejects unknown IDs without replacing the file", async () => {
    const path = await root();
    const store = new ProjectWorkspaceStateStore(path);
    const project = projectWithShort();
    await store.setActiveDeliverable(project, "dlv_bbbbbbbbbb");
    const before = await readFile(join(path, PROJECT_WORKSPACE_FILE), "utf8");

    await expect(store.setActiveDeliverable(project, "dlv_cccccccccc"))
      .rejects.toMatchObject({ code: "E_WORKSPACE_DELIVERABLE_NOT_FOUND" });
    expect(await readFile(join(path, PROJECT_WORKSPACE_FILE), "utf8")).toBe(before);
    expect(await readdir(path)).toEqual([PROJECT_WORKSPACE_FILE]);
  });

  it("replaces preserved corrupt bytes on the next explicit valid selection", async () => {
    const path = await root();
    const document = join(path, PROJECT_WORKSPACE_FILE);
    const store = new ProjectWorkspaceStateStore(path);
    const project = projectWithShort();
    await writeFile(document, "not: [valid\n", "utf8");
    await store.load(project);

    await store.setActiveDeliverable(project, "dlv_bbbbbbbbbb");

    await expect(readFile(document, "utf8")).resolves.toContain(
      "activeDeliverableId: dlv_bbbbbbbbbb",
    );
  });

  it("serializes rapid writes so the last requested deliverable wins", async () => {
    const path = await root();
    const store = new ProjectWorkspaceStateStore(path);
    const project = projectWithShort();

    await Promise.all([
      store.setActiveDeliverable(project, "dlv_aaaaaaaaaa"),
      store.setActiveDeliverable(project, "dlv_bbbbbbbbbb"),
    ]);

    await expect(store.load(project)).resolves.toEqual({
      state: {
        format: "guyditor.workspace/v1",
        activeDeliverableId: "dlv_bbbbbbbbbb",
      },
    });
  });
});
```

- [ ] **Step 3: Run the test to verify RED**

Run:

```bash
pnpm vitest run packages/app/src/main/project-workspace-state.test.ts
```

Expected: FAIL because `project-workspace-state.ts` does not exist.

- [ ] **Step 4: Implement the state store**

Create `packages/app/src/main/project-workspace-state.ts` with the following public contract and behavior:

```ts
import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  isId,
  makeGuyditorError,
} from "../../../core/src/index.js";
import type { GuyditorProject } from "../../../core/src/index.js";
import { parse as parseYaml } from "yaml";

import type {
  LoadedProjectWorkspaceState,
  ProjectWorkspaceState,
} from "../shared/ipc.js";

export const PROJECT_WORKSPACE_FILE = "workspace.guyditor.yaml";
const WORKSPACE_FORMAT = "guyditor.workspace/v1" as const;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

function primaryState(project: GuyditorProject): ProjectWorkspaceState {
  const id = project.settings.primaryDeliverable;
  if (!isId("dlv", id) || !project.deliverables.some((item) => item.id === id)) {
    throw makeGuyditorError(
      "E_PROJECT_INVARIANT",
      `Primary deliverable ${id} does not exist.`,
      { affected: [id] },
    );
  }
  return { format: WORKSPACE_FORMAT, activeDeliverableId: id };
}

function parseState(source: string): ProjectWorkspaceState {
  const value = parseYaml(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Workspace state must be a mapping.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 ||
      keys[0] !== "activeDeliverableId" ||
      keys[1] !== "format") {
    throw new TypeError("Workspace state must contain only format and activeDeliverableId.");
  }
  if (record["format"] !== WORKSPACE_FORMAT) {
    throw new TypeError(`Unsupported workspace format ${String(record["format"])}.`);
  }
  if (!isId("dlv", record["activeDeliverableId"])) {
    throw new TypeError("Workspace activeDeliverableId is malformed.");
  }
  return {
    format: WORKSPACE_FORMAT,
    activeDeliverableId: record["activeDeliverableId"],
  };
}

function serialize(state: ProjectWorkspaceState): string {
  return [
    `format: ${state.format}`,
    `activeDeliverableId: ${state.activeDeliverableId}`,
    "",
  ].join("\n");
}

async function atomicWrite(path: string, source: string): Promise<void> {
  const temporary = `${path}.tmp-${String(process.pid)}-${randomBytes(4).toString("hex")}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class ProjectWorkspaceStateStore {
  readonly #path: string;
  #pendingWarning: string | undefined;
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(projectRoot: string) {
    this.#path = join(projectRoot, PROJECT_WORKSPACE_FILE);
  }

  #surface(
    loaded: LoadedProjectWorkspaceState,
  ): LoadedProjectWorkspaceState {
    const warning = loaded.warning ?? this.#pendingWarning;
    this.#pendingWarning = undefined;
    return warning === undefined ? loaded : { ...loaded, warning };
  }

  public async load(project: GuyditorProject): Promise<LoadedProjectWorkspaceState> {
    await this.#writeTail;
    const fallback = primaryState(project);
    let source: string;
    try {
      source = await readFile(this.#path, "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) return this.#surface({ state: fallback });
      return this.#surface({
        state: fallback,
        warning: `Could not read workspace selection; using primary deliverable ${fallback.activeDeliverableId}.`,
      });
    }
    try {
      const state = parseState(source);
      if (!project.deliverables.some(({ id }) => id === state.activeDeliverableId)) {
        throw new TypeError(`Deliverable ${state.activeDeliverableId} no longer exists.`);
      }
      return this.#surface({ state });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.#surface({
        state: fallback,
        warning: `Workspace selection is invalid (${detail}); using primary deliverable ${fallback.activeDeliverableId}.`,
      });
    }
  }

  public async initialize(project: GuyditorProject): Promise<ProjectWorkspaceState> {
    const fallback = primaryState(project);
    try {
      return await this.setActiveDeliverable(
        project,
        fallback.activeDeliverableId,
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#pendingWarning =
        `Could not initialize workspace selection; using primary deliverable ` +
        `${fallback.activeDeliverableId}: ${detail}`;
      return fallback;
    }
  }

  public async setActiveDeliverable(
    project: GuyditorProject,
    activeDeliverableId: string,
  ): Promise<ProjectWorkspaceState> {
    if (!isId("dlv", activeDeliverableId) ||
        !project.deliverables.some(({ id }) => id === activeDeliverableId)) {
      throw makeGuyditorError(
        "E_WORKSPACE_DELIVERABLE_NOT_FOUND",
        `Deliverable ${activeDeliverableId} does not exist in the open project.`,
        { affected: [activeDeliverableId] },
      );
    }
    const state: ProjectWorkspaceState = {
      format: WORKSPACE_FORMAT,
      activeDeliverableId,
    };
    const publication = this.#writeTail.then(() =>
      atomicWrite(this.#path, serialize(state)),
    );
    this.#writeTail = publication.catch(() => undefined);
    await publication;
    return state;
  }
}
```

- [ ] **Step 5: Run focused verification**

Run:

```bash
pnpm vitest run packages/app/src/main/project-workspace-state.test.ts
pnpm --filter @guyditor/app typecheck
```

Expected: both commands PASS; the temporary-file assertion sees only `workspace.guyditor.yaml`.

- [ ] **Step 6: Commit**

```bash
git add packages/app/package.json pnpm-lock.yaml packages/app/src/main/project-workspace-state.ts packages/app/src/main/project-workspace-state.test.ts
git commit -m "feat(app): persist project workspace selection"
```

### Task 2: Project lifecycle and IPC integration

**Files:**
- Modify: `packages/app/src/shared/ipc.ts`
- Modify: `packages/app/src/main/project-services.ts`
- Modify: `packages/app/src/main/service-host.ts`
- Modify: `packages/app/src/main/service-host.test.ts`
- Modify: `packages/app/src/main/surfaces.ts`
- Modify: `packages/app/src/main/surfaces.test.ts`

- [ ] **Step 1: Add failing surface and host assertions**

In `packages/app/src/main/surfaces.test.ts`, add the two method names to the `ProjectStore` expectation:

```ts
ProjectStore: [
  "getSnapshot",
  "getWorkspaceState",
  "setActiveDeliverable",
  "pickTemplatePackage",
  "listHistory",
  "listProposals",
  "readTranscript",
  "revealProject",
  "openMaster",
],
```

In the existing project-creation test in `packages/app/src/main/service-host.test.ts`, add:

```ts
await expect(readFile(join(target, "workspace.guyditor.yaml"), "utf8"))
  .resolves.toBe([
    "format: guyditor.workspace/v1",
    `activeDeliverableId: ${snapshot.master.settings.primaryDeliverable}`,
    "",
  ].join("\n"));
```

Add a second host test that creates a valid project with an independent `seq_bbbbbbbbbb` / `dlv_bbbbbbbbbb`, records these three files, calls `setActiveDeliverable`, and compares the bytes:

```ts
const protectedPaths = [
  "episode.guyditor.yaml",
  "history/HEAD",
  "history/transactions.jsonl",
];
const before = await Promise.all(protectedPaths.map((path) =>
  readFile(join(root, path), "utf8"),
));
const projectService = windowHost.resolveService("ProjectStore");
const setActive = projectService?.["setActiveDeliverable"];
const getWorkspace = projectService?.["getWorkspaceState"];
if (typeof setActive !== "function" || typeof getWorkspace !== "function") {
  throw new Error("Workspace-state IPC is unavailable.");
}

await expect(Reflect.apply(setActive, projectService, [{
  deliverableId: "dlv_bbbbbbbbbb",
}])).resolves.toMatchObject({ activeDeliverableId: "dlv_bbbbbbbbbb" });
await expect(Reflect.apply(getWorkspace, projectService, []))
  .resolves.toEqual({
    state: {
      format: "guyditor.workspace/v1",
      activeDeliverableId: "dlv_bbbbbbbbbb",
    },
  });
await expect(Reflect.apply(setActive, projectService, [{
  deliverableId: "dlv_cccccccccc",
}])).rejects.toMatchObject({
  code: "E_WORKSPACE_DELIVERABLE_NOT_FOUND",
});
const after = await Promise.all(protectedPaths.map((path) =>
  readFile(join(root, path), "utf8"),
));
expect(after).toEqual(before);
expect(windowHost.snapshot().revision).toBe("rev_00001");
```

Construct the short fixture before `createProject` with:

```ts
model.sequences.push({
  id: "seq_bbbbbbbbbb",
  name: "short",
  clips: [{
    id: "clp_cccccccccc",
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: 0, fps: "24/1" },
      out: { frames: 12, fps: "24/1" },
    },
  }],
});
model.layers.push({
  id: "lyr_bbbbbbbbbb",
  kind: "video",
  name: "short video",
  order: 0,
  enabled: true,
  locked: false,
  sequence: "seq_bbbbbbbbbb",
});
model.captions.push({
  ...structuredClone(model.captions[0]!),
  id: "cts_bbbbbbbbbb",
  name: "short captions",
  sourceLayerIds: ["lyr_bbbbbbbbbb"],
});
model.deliverables.push({
  id: "dlv_bbbbbbbbbb",
  kind: "short",
  name: "Portrait short",
  profile: "youtube-shorts@1.0.0",
  sequenceId: "seq_bbbbbbbbbb",
  captionsTrackId: "cts_bbbbbbbbbb",
  status: "draft",
});
```

- [ ] **Step 2: Run the integration tests to verify RED**

Run:

```bash
pnpm vitest run packages/app/src/main/surfaces.test.ts packages/app/src/main/service-host.test.ts
```

Expected: FAIL because the surface, service methods, and creation initializer are absent.

- [ ] **Step 3: Define shared IPC result types and schemas**

In `packages/app/src/shared/ipc.ts`, add:

```ts
export interface ProjectWorkspaceState {
  format: "guyditor.workspace/v1";
  activeDeliverableId: string;
}

export interface LoadedProjectWorkspaceState {
  state: ProjectWorkspaceState;
  warning?: string;
}
```

In the `ProjectStore` methods inside `packages/app/src/main/surfaces.ts`, add:

```ts
getWorkspaceState: {
  paramsSchema: emptyParams,
  resultSchema: anyResult,
  budgetMs: 20,
},
setActiveDeliverable: {
  paramsSchema: deliverableIdParams,
  resultSchema: anyResult,
  budgetMs: 20,
},
```

- [ ] **Step 4: Attach the workspace store to each open project**

In `packages/app/src/main/project-services.ts`, import the class and add it to `ProjectServices`:

```ts
import type { ProjectWorkspaceStateStore } from "./project-workspace-state.js";

export interface ProjectServices extends RecoveryServices {
  store: ProjectStore;
  workspace: ProjectWorkspaceStateStore;
  jobs: JobQueue;
}
```

In `packages/app/src/main/service-host.ts`, import
`ProjectWorkspaceStateStore` as a value. In `WindowServiceHost.openProject`,
instantiate it after opening the core store:

```ts
const store = resultValue(opened);
const workspace = new ProjectWorkspaceStateStore(store.root);
```

Include `workspace` in the `this.#project` object. Add these `ProjectStore` service methods:

```ts
getWorkspaceState: () => project === undefined
  ? Promise.reject(new Error("No project is open."))
  : project.workspace.load(project.store.currentProject),
setActiveDeliverable: ({ deliverableId }: { deliverableId: string }) =>
  this.#requireProject().workspace.setActiveDeliverable(
    this.#requireProject().store.currentProject,
    deliverableId,
  ),
```

- [ ] **Step 5: Initialize new projects without making preference IO blocking**

Give `openProject` an internal creation option while preserving all existing calls:

```ts
public async openProject(
  projectPath: string,
  options: { initializeWorkspace?: boolean } = {},
): Promise<ReturnType<WindowServiceHost["snapshot"]>> {
```

Immediately after constructing `workspace`, initialize only for a project that this
window just created:

```ts
if (options.initializeWorkspace === true) {
  await workspace.initialize(store.currentProject);
}
```

`initialize` records a pending warning and resolves to primary state on write
failure, so this await cannot turn a valid canonical creation into a failed open.
It also keeps legacy `openProject(path)` behavior silent and non-migrating.

In the `ProjectStore.createDialog` service callback, pass the option through the
existing creation helper's `open` callback:

```ts
createDialog: () => createProjectDialog(
  this.#chooseNewProject,
  (path) => this.openProject(path, { initializeWorkspace: true }),
  this.#app.appVersion,
  this.#app.profilesRoot,
),
```

The renderer's first `getWorkspaceState` call consumes and displays any pending
initialization warning.

- [ ] **Step 6: Run focused integration and type verification**

Run:

```bash
pnpm vitest run packages/app/src/main/project-workspace-state.test.ts packages/app/src/main/surfaces.test.ts packages/app/src/main/service-host.test.ts
pnpm --filter @guyditor/app typecheck
```

Expected: PASS. The integration test proves selection changes neither canonical bytes nor revision/history.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/shared/ipc.ts packages/app/src/main/project-services.ts packages/app/src/main/service-host.ts packages/app/src/main/service-host.test.ts packages/app/src/main/surfaces.ts packages/app/src/main/surfaces.test.ts
git commit -m "feat(app): expose active deliverable workspace state"
```

### Task 3: Storage accounting, backup, verification, and restore

**Files:**
- Modify: `packages/media/src/storage.ts`
- Modify: `packages/media/src/storage.test.ts`
- Modify: `packages/media/src/backup.ts`
- Modify: `packages/media/src/backup.test.ts`

- [ ] **Step 1: Write failing storage and backup assertions**

In `storageFixture` in `packages/media/src/storage.test.ts`, write a known workspace document and return its byte length:

```ts
const workspace = [
  "format: guyditor.workspace/v1",
  "activeDeliverableId: dlv_aaaaaaaaaa",
  "",
].join("\n");
await writeFile(join(projectDir, "workspace.guyditor.yaml"), workspace);
```

Add `workspaceBytes: number` to the fixture return type and return object:

```ts
return {
  accountant: new StorageAccountant({ userDirectory: userDir }),
  externalSource,
  projectDir,
  userDir,
  workspaceBytes: Buffer.byteLength(workspace),
};
```

In the classification test, compare a scan with and without the file:

```ts
const {
  accountant,
  externalSource,
  projectDir,
  workspaceBytes,
} = await storageFixture();
const withWorkspace = await accountant.scan(projectDir);
await rm(join(projectDir, "workspace.guyditor.yaml"));
const withoutWorkspace = await accountant.scan(projectDir);
expect(
  withWorkspace.categories["project-state"].files -
  withoutWorkspace.categories["project-state"].files,
).toBe(1);
expect(
  withWorkspace.categories["project-state"].bytes -
  withoutWorkspace.categories["project-state"].bytes,
).toBe(workspaceBytes);
```

In `fixture` in `packages/media/src/backup.test.ts`, write the same document. In the deduplication test add:

```ts
expect(first.entries).toContainEqual(expect.objectContaining({
  path: "workspace.guyditor.yaml",
  role: "workspace",
}));
```

In the restore test, materialize to a retained destination and assert exact bytes:

```ts
const restoredRoot = join(await temporaryRoot("guyditor-restored-"), "project");
await service.restore(target, manifest.backupId, restoredRoot);
await expect(readFile(join(restoredRoot, "workspace.guyditor.yaml"), "utf8"))
  .resolves.toBe([
    "format: guyditor.workspace/v1",
    "activeDeliverableId: dlv_aaaaaaaaaa",
    "",
  ].join("\n"));
```

Add a legacy-backup assertion:

```ts
await rm(join(projectDir, "workspace.guyditor.yaml"));
const legacy = await service.run(projectDir, "local", "manual");
expect(legacy.entries.some(({ path }) => path === "workspace.guyditor.yaml"))
  .toBe(false);
```

- [ ] **Step 2: Run the media tests to verify RED**

Run:

```bash
pnpm vitest run packages/media/src/storage.test.ts packages/media/src/backup.test.ts
```

Expected: FAIL because storage ignores the document and the manifest has no `workspace` entry.

- [ ] **Step 3: Count the optional workspace document**

In `StorageAccountant.scan` in `packages/media/src/storage.ts`, add:

```ts
...await optionalFile(join(root, "workspace.guyditor.yaml")),
```

immediately after `episode.guyditor.yaml` in `projectState`.

- [ ] **Step 4: Collect and force-verify workspace state**

In `packages/media/src/backup.ts`, extend `BackupManifestRole`:

```ts
| "workspace"
```

In `#collect`, after the canonical master candidate and before backup config, add an optional candidate without turning a missing file into an error:

```ts
const workspacePath = join(root, "workspace.guyditor.yaml");
try {
  const workspaceMetadata = await stat(workspacePath);
  if (workspaceMetadata.isFile()) {
    candidates.set("workspace.guyditor.yaml", {
      sourcePath: workspacePath,
      backupPath: "workspace.guyditor.yaml",
      role: "workspace",
    });
  }
} catch (error: unknown) {
  if (!isMissing(error)) throw error;
}
```

In sample verification’s forced-entry predicate, add the role:

```ts
entry.role === "master" || entry.role === "workspace" ||
entry.role === "archive-manifest" ||
```

No restore branch is needed: `#materialize` already hash-verifies every safe relative project path and writes it to the destination.

- [ ] **Step 5: Run focused media verification**

Run:

```bash
pnpm vitest run packages/media/src/storage.test.ts packages/media/src/backup.test.ts
pnpm --filter @guyditor/media typecheck
pnpm --filter @guyditor/media lint
```

Expected: PASS. The direct restore contains exact workspace bytes, and a legacy project still backs up.

- [ ] **Step 6: Commit**

```bash
git add packages/media/src/storage.ts packages/media/src/storage.test.ts packages/media/src/backup.ts packages/media/src/backup.test.ts
git commit -m "feat(media): protect workspace state in backups"
```

### Task 4: Shared renderer resolver and activation reset

**Files:**
- Create: `packages/app/src/renderer/active-deliverable.ts`
- Create: `packages/app/src/renderer/active-deliverable.test.ts`
- Modify: `packages/app/src/renderer/ipc.ts`
- Modify: `packages/app/src/renderer/state/view-state.ts`
- Modify: `packages/app/src/renderer/state/workspace.test.ts`

- [ ] **Step 1: Write failing resolver and reset tests**

Create `packages/app/src/renderer/active-deliverable.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import {
  activateDeliverable,
  applyDeliverableSelection,
  resolveActiveDeliverable,
} from "./active-deliverable.js";
import {
  usePreviewStore,
  useSelectionStore,
  useTimelineViewStore,
  useWorkspaceStore,
} from "./state/view-state.js";
import { useUndoStore } from "./state/undo.js";

function projectWithShort() {
  const project = projectFixture();
  project.deliverables.push({
    id: "dlv_bbbbbbbbbb",
    kind: "short",
    name: "Portrait short",
    profile: "youtube-shorts@1.0.0",
    sequenceId: "seq_bbbbbbbbbb",
    status: "draft",
  });
  return project;
}

describe("active deliverable", () => {
  it("resolves a live selection, then primary fallback, but never guesses another item", () => {
    const project = projectWithShort();
    expect(resolveActiveDeliverable(project, "dlv_bbbbbbbbbb").id)
      .toBe("dlv_bbbbbbbbbb");
    expect(resolveActiveDeliverable(project, "dlv_cccccccccc").id)
      .toBe("dlv_aaaaaaaaaa");
    project.settings.primaryDeliverable = "dlv_cccccccccc";
    expect(() => resolveActiveDeliverable(project, null))
      .toThrow("Primary deliverable dlv_cccccccccc does not exist");
  });

  it("clears sequence state while retaining zoom and layout", () => {
    const project = projectWithShort();
    useSelectionStore.setState({
      selectedClipId: "clp_aaaaaaaaaa",
      selectedLayerId: "lyr_aaaaaaaaaa",
      selectedWordId: "w000001",
      selectedAnnotationId: "ann_aaaaaaaaaa",
      selectedDeliverableId: "dlv_aaaaaaaaaa",
      wordRange: { fromWord: "w000001", toWord: "w000002" },
    });
    usePreviewStore.setState({
      playing: true,
      playhead: { frames: 72, fps: "24/1" },
      loopRange: { start: 12, end: 24 },
      previewKeySettings: {
        schema: "guyditor/key@1",
        mode: "chroma",
        chroma: {
          keyColor: "#00B140",
          tolerance: 0.35,
          softness: 0.12,
          preBlur: 1.5,
          edge: { erodePx: 1, featherPx: 2 },
          spill: { mode: "despill", strength: 0.6 },
        },
        masks: [],
      },
    });
    useTimelineViewStore.setState({
      zoomPixelsPerFrame: 8,
      scrollOffsetFrames: 40,
    });
    useUndoStore.getState().clear();
    useUndoStore.getState().record({
      txnId: "txn_aaaaaaaaaa",
      label: "Existing edit",
      ops: [],
      inverse: [],
    });
    const undoBefore = structuredClone(useUndoStore.getState().undo);
    const layout = useWorkspaceStore.getState().layout;

    applyDeliverableSelection(project, "dlv_bbbbbbbbbb");

    expect(useSelectionStore.getState()).toMatchObject({
      selectedDeliverableId: "dlv_bbbbbbbbbb",
      selectedClipId: null,
      selectedLayerId: null,
      selectedWordId: null,
      selectedAnnotationId: null,
      wordRange: null,
    });
    expect(usePreviewStore.getState()).toMatchObject({
      playing: false,
      playhead: { frames: 0, fps: "24/1" },
      loopRange: null,
      previewKeySettings: null,
    });
    expect(useTimelineViewStore.getState()).toMatchObject({
      zoomPixelsPerFrame: 8,
      scrollOffsetFrames: 0,
    });
    expect(useWorkspaceStore.getState().layout).toBe(layout);
    expect(useUndoStore.getState().undo).toEqual(undoBefore);
  });

  it("keeps the local switch and reports an actionable autosave failure", async () => {
    const project = projectWithShort();
    const setNotice = vi.fn();
    const persist = vi.fn().mockRejectedValue(new Error("disk full"));
    useSelectionStore.setState({
      selectedDeliverableId: "dlv_aaaaaaaaaa",
    });

    await activateDeliverable(
      project,
      "dlv_bbbbbbbbbb",
      setNotice,
      persist,
    );

    expect(useSelectionStore.getState().selectedDeliverableId)
      .toBe("dlv_bbbbbbbbbb");
    expect(setNotice).toHaveBeenCalledWith(
      "Switched to Portrait short, but workspace autosave failed: disk full",
    );
  });

  it("retries persistence without resetting navigation when reselecting the active item", async () => {
    const project = projectWithShort();
    applyDeliverableSelection(project, "dlv_bbbbbbbbbb");
    usePreviewStore.getState().setPlayhead({ frames: 7, fps: "24/1" });
    useTimelineViewStore.getState().setScrollOffset(5);
    const persist = vi.fn().mockResolvedValue(undefined);

    await activateDeliverable(
      project,
      "dlv_bbbbbbbbbb",
      vi.fn(),
      persist,
    );

    expect(persist).toHaveBeenCalledWith("dlv_bbbbbbbbbb");
    expect(usePreviewStore.getState().playhead.frames).toBe(7);
    expect(useTimelineViewStore.getState().scrollOffsetFrames).toBe(5);
  });
});
```

In `packages/app/src/renderer/state/workspace.test.ts`, add a direct store-level test:

```ts
useSelectionStore.setState({
  selectedClipId: "clp_aaaaaaaaaa",
  selectedLayerId: "lyr_aaaaaaaaaa",
  selectedWordId: "w000001",
  selectedAnnotationId: "ann_aaaaaaaaaa",
  wordRange: { fromWord: "w000001", toWord: "w000002" },
});
useSelectionStore.getState().activateDeliverable("dlv_bbbbbbbbbb");
expect(useSelectionStore.getState()).toMatchObject({
  selectedDeliverableId: "dlv_bbbbbbbbbb",
  selectedClipId: null,
  selectedLayerId: null,
  selectedWordId: null,
  selectedAnnotationId: null,
  wordRange: null,
});
```

- [ ] **Step 2: Run renderer tests to verify RED**

Run:

```bash
pnpm vitest run packages/app/src/renderer/active-deliverable.test.ts packages/app/src/renderer/state/workspace.test.ts
```

Expected: FAIL because the helper and `activateDeliverable` store action do not exist.

- [ ] **Step 3: Add the atomic selection mutation to Zustand**

In `SelectionState` in `packages/app/src/renderer/state/view-state.ts`, replace `selectDeliverable` with:

```ts
activateDeliverable: (id: string) => void;
```

Implement it as one store mutation:

```ts
activateDeliverable: (selectedDeliverableId) => set({
  selectedDeliverableId,
  selectedClipId: null,
  selectedLayerId: null,
  selectedWordId: null,
  selectedAnnotationId: null,
  wordRange: null,
}),
```

- [ ] **Step 4: Add typed IPC wrappers**

In `packages/app/src/renderer/ipc.ts`, import the shared workspace types and add:

```ts
export function getWorkspaceState(): Promise<LoadedProjectWorkspaceState> {
  return window.guyditor.call("ProjectStore", "getWorkspaceState", {});
}

export function setActiveDeliverable(
  deliverableId: string,
): Promise<ProjectWorkspaceState> {
  return window.guyditor.call(
    "ProjectStore",
    "setActiveDeliverable",
    { deliverableId },
  );
}
```

- [ ] **Step 5: Implement the shared resolver and activation**

Create `packages/app/src/renderer/active-deliverable.ts`:

```ts
import type {
  Deliverable,
  GuyditorProject,
} from "../../../core/src/index.js";

import { errorMessage, setActiveDeliverable } from "./ipc.js";
import {
  usePreviewStore,
  useSelectionStore,
  useTimelineViewStore,
} from "./state/view-state.js";

type PersistSelection = (deliverableId: string) => Promise<unknown>;

export function resolveActiveDeliverable(
  project: GuyditorProject,
  selectedDeliverableId: string | null,
): Deliverable {
  const selected = project.deliverables.find(
    ({ id }) => id === selectedDeliverableId,
  );
  if (selected !== undefined) return selected;
  const primary = project.deliverables.find(
    ({ id }) => id === project.settings.primaryDeliverable,
  );
  if (primary === undefined) {
    throw new Error(
      `Primary deliverable ${project.settings.primaryDeliverable} does not exist.`,
    );
  }
  return primary;
}

export function applyDeliverableSelection(
  project: GuyditorProject,
  deliverableId: string,
): Deliverable {
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  if (deliverable === undefined) {
    throw new Error(`Deliverable ${deliverableId} does not exist.`);
  }
  const preview = usePreviewStore.getState();
  preview.setPlaying(false);
  preview.setPlayhead({ frames: 0, fps: project.settings.timeline.fps });
  preview.setLoopRange(null);
  preview.setPreviewKeySettings(null);
  useTimelineViewStore.getState().setScrollOffset(0);
  useSelectionStore.getState().activateDeliverable(deliverable.id);
  return deliverable;
}

export async function activateDeliverable(
  project: GuyditorProject,
  deliverableId: string,
  setNotice: (message: string) => void,
  persist: PersistSelection = setActiveDeliverable,
): Promise<void> {
  const current = useSelectionStore.getState().selectedDeliverableId;
  const deliverable = current === deliverableId
    ? project.deliverables.find(({ id }) => id === deliverableId)
    : applyDeliverableSelection(project, deliverableId);
  if (deliverable === undefined) {
    throw new Error(`Deliverable ${deliverableId} does not exist.`);
  }
  try {
    await persist(deliverable.id);
  } catch (error: unknown) {
    setNotice(
      `Switched to ${deliverable.name}, but workspace autosave failed: ${errorMessage(error)}`,
    );
  }
}
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
pnpm vitest run packages/app/src/renderer/active-deliverable.test.ts packages/app/src/renderer/state/workspace.test.ts
pnpm --filter @guyditor/app typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/renderer/active-deliverable.ts packages/app/src/renderer/active-deliverable.test.ts packages/app/src/renderer/ipc.ts packages/app/src/renderer/state/view-state.ts packages/app/src/renderer/state/workspace.test.ts
git commit -m "feat(renderer): centralize deliverable activation"
```

### Task 5: Sequence-scoped transcript range removal

**Files:**
- Modify: `packages/core/src/operations/schemas/transcript.range.remove.json`
- Modify: `packages/transcript/src/range-operations.ts`
- Modify: `packages/transcript/src/range-operations.test.ts`

- [ ] **Step 1: Write a failing derivative-target test**

In `packages/transcript/src/range-operations.test.ts`, add a test that first derives a short with the existing `transcript.range.shortCandidate` operation, then removes a word only from that short:

```ts
it("removes a range from an explicitly targeted derivative without touching primary", async () => {
  const { store, engine } = await fixture();
  await valueOf(engine.execute(store, [{
    op: "transcript.range.shortCandidate",
    params: {
      wordRange: { fromWord: "w000002", toWord: "w000003" },
      title: "Targeted short",
    },
  }]));
  const primaryBefore = structuredClone(
    store.currentProject.sequences.find(({ id }) => id === "seq_aaaaaaaaaa"),
  );

  await valueOf(engine.execute(store, [{
    op: "transcript.range.remove",
    params: {
      sequenceId: "seq_bbbbbbbbbb",
      wordRange: { fromWord: "w000002", toWord: "w000002" },
      paddingMs: 0,
      snapPolicy: "none",
    },
  }]));

  expect(
    store.currentProject.sequences.find(({ id }) => id === "seq_aaaaaaaaaa"),
  ).toEqual(primaryBefore);
  expect(
    store.currentProject.sequences.find(({ id }) => id === "seq_bbbbbbbbbb")
      ?.clips.map(({ source }) => source),
  ).toEqual([{
    in: { frames: 48, fps: "24/1" },
    out: { frames: 72, fps: "24/1" },
  }]);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
pnpm vitest run packages/transcript/src/range-operations.test.ts
```

Expected: FAIL with operation-schema rejection because `sequenceId` is not allowed.

- [ ] **Step 3: Extend the existing operation without adding a new operation name**

In `packages/core/src/operations/schemas/transcript.range.remove.json`, add:

```json
"sequenceId": {
  "type": "string",
  "pattern": "^seq_[a-z2-7]{10}$"
},
```

to `properties`.

In `packages/transcript/src/range-operations.ts`, replace `primarySequenceId` with:

```ts
function removalSequenceId(
  project: GuyditorProject,
  input: OperationInput,
): Result<string> {
  const requested = input.params["sequenceId"];
  if (requested !== undefined) {
    return typeof requested === "string" &&
      project.sequences.some(({ id }) => id === requested)
      ? success(requested)
      : operationFailure(
          "E_OP_NOT_FOUND",
          `Sequence ${String(requested)} does not exist.`,
          typeof requested === "string" ? [requested] : [],
        );
  }
  const deliverable = project.deliverables.find(
    ({ id }) => id === project.settings.primaryDeliverable,
  );
  return deliverable === undefined
    ? operationFailure(
        "E_OP_NOT_FOUND",
        `Primary deliverable ${project.settings.primaryDeliverable} does not exist.`,
        [project.settings.primaryDeliverable],
      )
    : success(deliverable.sequenceId);
}
```

In `removeWordRange`, call:

```ts
const sequenceId = removalSequenceId(project, input);
```

Existing callers that omit `sequenceId`, including filler proposals, retain primary-source behavior.

- [ ] **Step 4: Run transcript and core operation verification**

Run:

```bash
pnpm vitest run packages/transcript/src/range-operations.test.ts packages/core/src/operations/engine.test.ts
pnpm --filter @guyditor/transcript typecheck
pnpm --filter @guyditor/core typecheck
```

Expected: PASS; the old primary test and new derivative test both pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/operations/schemas/transcript.range.remove.json packages/transcript/src/range-operations.ts packages/transcript/src/range-operations.test.ts
git commit -m "fix(transcript): scope range removal to a sequence"
```

### Task 6: Active Preview, Timeline, Transcript, and annotation canvas

**Files:**
- Create: `packages/app/src/renderer/panels/active-deliverable-panels.test.ts`
- Modify: `packages/app/src/renderer/panels/PreviewPanel.tsx`
- Modify: `packages/app/src/renderer/panels/TimelinePanel.tsx`
- Modify: `packages/app/src/renderer/panels/TranscriptPanel.tsx`

- [ ] **Step 1: Write a failing shared-panel render test**

Create `packages/app/src/renderer/panels/active-deliverable-panels.test.ts`. Build a snapshot with:

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import {
  useSelectionStore,
  useWorkspaceStore,
} from "../state/view-state.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { TimelinePanel } from "./TimelinePanel.js";
import { TranscriptPanel } from "./TranscriptPanel.js";
import type { WorkspacePanelProps } from "./types.js";

afterEach(() => {
  useSelectionStore.setState({ selectedDeliverableId: null });
});

describe("active deliverable panels", () => {
  it("renders the same selected short in preview, timeline, and captions", () => {
    const project = projectFixture();
project.sequences.push({
  id: "seq_bbbbbbbbbb",
  name: "short",
  clips: [{
    id: "clp_cccccccccc",
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: 12, fps: "24/1" },
      out: { frames: 24, fps: "24/1" },
    },
  }],
});
project.layers.push({
  id: "lyr_bbbbbbbbbb",
  kind: "video",
  name: "short video",
  order: 0,
  enabled: true,
  locked: false,
  sequence: "seq_bbbbbbbbbb",
});
project.captions.push({
  ...structuredClone(project.captions[0]!),
  id: "cts_bbbbbbbbbb",
  name: "short captions",
  sourceLayerIds: ["lyr_bbbbbbbbbb"],
});
project.deliverables.push({
  id: "dlv_bbbbbbbbbb",
  kind: "short",
  name: "Portrait short",
  profile: "youtube-shorts@1.0.0",
  sequenceId: "seq_bbbbbbbbbb",
  captionsTrackId: "cts_bbbbbbbbbb",
  status: "draft",
});
useSelectionStore.setState({ selectedDeliverableId: "dlv_bbbbbbbbbb" });
useWorkspaceStore.getState().setPhase("cut");
useWorkspaceStore.getState().resetLayout();
```

Use one complete `WorkspacePanelProps` fixture:

```ts
const props: WorkspacePanelProps = {
  snapshot: {
    revision: project.revision,
    master: project,
    sidecarIndex: project.sidecars,
    projectPath: "/fixture",
  },
  transcripts: [],
  annotations: [],
  proposals: [],
  skills: [],
  pinnedSkills: [],
  skillDrafts: [],
  restylePlan: null,
  exportReport: null,
  refreshProject: () => Promise.resolve(),
  refreshAnnotations: () => Promise.resolve(),
  refreshProposals: () => Promise.resolve(),
  refreshSkills: () => Promise.resolve(),
  refreshRestylePlan: () => Promise.resolve(),
  refreshExportReport: () => Promise.resolve(),
  setNotice: () => undefined,
};
const preview = renderToStaticMarkup(createElement(PreviewPanel, props));
const timeline = renderToStaticMarkup(createElement(TimelinePanel, props));
const transcript = renderToStaticMarkup(createElement(TranscriptPanel, props));
```

Then assert:

```ts
expect(preview).toContain('data-aspect="portrait"');
expect(timeline).toContain('data-testid="timeline-clip-clp_cccccccccc"');
expect(timeline).not.toContain('timeline-clip-clp_aaaaaaaaaa');
expect(transcript).toContain("cts_bbbbbbbbbb");
expect(transcript).not.toContain("cts_aaaaaaaaaa");
  });
});
```

- [ ] **Step 2: Run the panel test to verify RED**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/active-deliverable-panels.test.ts
```

Expected: FAIL because all three panels still resolve `settings.primaryDeliverable`.

- [ ] **Step 3: Make Preview use the active deliverable**

In `PreviewPanel.tsx`:

1. Import `resolveActiveDeliverable`.
2. Add `Deliverable` to the existing core type import.
3. Subscribe to `selectedDeliverableId`.
4. Resolve once:

```ts
const selectedDeliverableId = useSelectionStore(
  (state) => state.selectedDeliverableId,
);
const deliverable = snapshot === null
  ? undefined
  : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
```

5. Change `activeClip` and `totalFrames` to accept `Deliverable` and use its `sequenceId` instead of looking up primary:

```ts
function activeClip(
  snapshot: NonNullable<WorkspacePanelProps["snapshot"]>,
  deliverable: Deliverable,
  frame: number,
) {
  const sequence = snapshot.master.sequences.find(
    ({ id }) => id === deliverable.sequenceId,
  );
}

function totalFrames(
  snapshot: WorkspacePanelProps["snapshot"],
  deliverable: Deliverable | undefined,
): number {
  if (snapshot === null || deliverable === undefined) return 0;
  const derived = deriveTimeline(snapshot.master, deliverable.sequenceId);
}
```

Update the call sites:

```ts
const duration = totalFrames(snapshot, deliverable);
const active = snapshot === null || deliverable === undefined
  ? undefined
  : activeClip(snapshot, deliverable, playhead.frames);
```

6. Restrict selected PiP and annotations:

```ts
const selectedPipLayer = snapshot?.master.layers.find((candidate) =>
  candidate.id === selectedLayerId &&
  (candidate.sequence === undefined ||
    candidate.sequence === deliverable?.sequenceId) &&
  candidate.pip !== undefined);
const activeAnnotations = annotations.filter(
  ({ canvasRef }) => canvasRef.sequenceId === deliverable?.sequenceId,
);
```

Use `activeAnnotations` for overlay and list rendering.

7. In annotation creation, require the resolved deliverable and use only its sequence:

```ts
if (snapshot === null || deliverable === undefined || playing || !settled) return;
const sequenceId = deliverable.sequenceId;
```

This removes the fallback to `snapshot.master.sequences[0]`. Compute one active
output size, using portrait defaults while a short’s framing result is still
loading:

```ts
const defaultWidth = snapshot?.master.settings.timeline.width ?? 1920;
const defaultHeight = snapshot?.master.settings.timeline.height ?? 1080;
const outputWidth = framingFrame?.output.width ??
  (deliverable?.kind === "short" ? 1080 : defaultWidth);
const outputHeight = framingFrame?.output.height ??
  (deliverable?.kind === "short" ? 1920 : defaultHeight);
```

Use `outputWidth` / `outputHeight` for caption-canvas layout, PiP composition, and
the new annotation's `canvasRef.aspect`:

```ts
aspect: `${String(outputWidth)}:${String(outputHeight)}`,
```

- [ ] **Step 4: Make Timeline and Transcript use the same resolver**

In `TimelinePanel.tsx`, replace `sequenceFor(snapshot)` with:

```ts
const selectedDeliverableId = useSelectionStore(
  (state) => state.selectedDeliverableId,
);
const deliverable = snapshot === null
  ? undefined
  : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
const sequence = snapshot?.master.sequences.find(
  ({ id }) => id === deliverable?.sequenceId,
);
```

Do not fall back to `sequences[0]`. Synchronize the actual scroll container when
activation resets the Zustand offset; otherwise a later DOM scroll event can restore
the old sequence’s position:

```ts
useEffect(() => {
  const viewport = viewportRef.current;
  if (viewport === null) return;
  const expected = scrollOffset * zoom;
  if (Math.abs(viewport.scrollLeft - expected) > 0.5) {
    viewport.scrollLeft = expected;
  }
}, [scrollOffset, sequence?.id, zoom]);
```

In `TranscriptPanel.tsx`, resolve the same way and select only its caption track:

```ts
const selectedDeliverableId = useSelectionStore(
  (state) => state.selectedDeliverableId,
);
const deliverable = snapshot === null
  ? undefined
  : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
const captionTrack = snapshot?.master.captions.find(
  ({ id }) => id === deliverable?.captionsTrackId,
);
const sequence = snapshot?.master.sequences.find(
  ({ id }) => id === deliverable?.sequenceId,
);
const layer = snapshot?.master.layers.find(
  ({ sequence: sequenceId }) => sequenceId === sequence?.id,
);
```

Pass active scope to word navigation:

```ts
{
  target: { kind: "word", wordId: id },
  ...(deliverable === undefined ? {} : { scope: deliverable.sequenceId }),
}
```

Include the active sequence in transcript removal:

```ts
params: {
  sequenceId: deliverable.sequenceId,
  wordRange,
  paddingMs: 0,
  snapPolicy: "none",
},
```

Require `deliverable` and `sequence` before building either range operation.

- [ ] **Step 5: Run focused panel and transcript tests**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/active-deliverable-panels.test.ts packages/transcript/src/range-operations.test.ts
pnpm --filter @guyditor/app typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/renderer/panels/active-deliverable-panels.test.ts packages/app/src/renderer/panels/PreviewPanel.tsx packages/app/src/renderer/panels/TimelinePanel.tsx packages/app/src/renderer/panels/TranscriptPanel.tsx
git commit -m "fix(renderer): follow active deliverable in edit surfaces"
```

### Task 7: Active edit targets and every selection entry point

**Files:**
- Modify: `packages/app/src/renderer/panels/GraphicsPanel.tsx`
- Modify: `packages/app/src/renderer/panels/BrollPanel.tsx`
- Modify: `packages/app/src/renderer/panels/PipInspector.tsx`
- Modify: `packages/app/src/renderer/panels/KeyInspector.tsx`
- Modify: `packages/app/src/renderer/panels/RestylePlan.tsx`
- Modify: `packages/app/src/renderer/panels/PublishPanel.tsx`
- Modify: `packages/app/src/renderer/panels/StatusStripPanel.tsx`
- Modify: `packages/app/src/renderer/panels/ProposalPanel.tsx`
- Modify: `packages/app/src/renderer/panels/InspectorPanel.tsx`
- Modify: `packages/app/src/renderer/styles.css`
- Modify: `packages/app/src/renderer/panels/PublishPanel.test.ts`
- Modify: `packages/app/src/renderer/panels/StatusStripPanel.test.ts`

- [ ] **Step 1: Add active-selection and primary-origin assertions to existing panel tests**

In both `PublishPanel.test.ts` and `StatusStripPanel.test.ts`, import
`useSelectionStore` beside `useWorkspaceStore`, import `afterEach` from Vitest,
and reset the selected ID after each test:

```ts
afterEach(() => {
  useSelectionStore.setState({ selectedDeliverableId: null });
});
```

Give each fixture a valid short sequence, layer, and captions track:

```ts
project.sequences.push({
  id: "seq_bbbbbbbbbb",
  name: "short",
  clips: [{
    id: "clp_cccccccccc",
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: 12, fps: "24/1" },
      out: { frames: 24, fps: "24/1" },
    },
  }],
});
project.layers.push({
  id: "lyr_bbbbbbbbbb",
  kind: "video",
  name: "short video",
  order: 0,
  enabled: true,
  locked: false,
  sequence: "seq_bbbbbbbbbb",
});
project.captions.push({
  ...structuredClone(project.captions[0]!),
  id: "cts_bbbbbbbbbb",
  name: "short captions",
  sourceLayerIds: ["lyr_bbbbbbbbbb"],
});
```

In `PublishPanel.test.ts`, append an approved short so the existing long-form
metadata fixture remains intact:

```ts
project.deliverables.push({
  id: "dlv_bbbbbbbbbb",
  kind: "short",
  name: "Portrait short",
  profile: "youtube-shorts@1.0.0",
  sequenceId: "seq_bbbbbbbbbb",
  captionsTrackId: "cts_bbbbbbbbbb",
  status: "approved",
  approvedRevision: "rev_00001",
  dependencies: [],
});
```

In `StatusStripPanel.test.ts`, keep the existing stale deliverable and its
`staleReasons`; add only `captionsTrackId: "cts_bbbbbbbbbb"` to that object.
Do not append a second deliverable with the same ID.

Set the renderer selection:

```ts
useSelectionStore.setState({
  selectedDeliverableId: "dlv_bbbbbbbbbb",
});
```

For Publish, assert the select renders the short as selected and the short output set contains covers rather than chapters:

```ts
expect(html).toContain('<option value="dlv_bbbbbbbbbb" selected="">');
expect(html).toContain("covers/cover-01..06.jpg");
expect(html).not.toContain("thumbnail.png");
```

For Status, assert that the active card is exposed accessibly while retaining the
existing stale range assertions:

```ts
expect(html).toMatch(
  /data-testid="deliverable-dlv_bbbbbbbbbb"[^>]*aria-pressed="true"/u,
);
expect(html).toContain("12–36@24/1");
expect(html).toContain("Build refresh review");
```

Export a small pure helper from `StatusStripPanel.tsx` so primary-origin timeline
derivation is directly testable rather than inferred from static markup:

```ts
export function primaryTimelineSelection(
  project: GuyditorProject,
  startFrames: number,
  endFrames: number,
): Record<string, unknown> | undefined {
  const primary = project.deliverables.find(
    ({ id }) => id === project.settings.primaryDeliverable,
  );
  return primary === undefined || endFrames <= startFrames
    ? undefined
    : {
        timelineRange: {
          sequenceId: primary.sequenceId,
          start: { frames: startFrames, fps: project.settings.timeline.fps },
          end: { frames: endFrames, fps: project.settings.timeline.fps },
        },
      };
}
```

Import `GuyditorProject` as a type, call this helper from the `timeline` branch of
`manualSelection`, and add this regression assertion after selecting the short:

```ts
expect(primaryTimelineSelection(project, 0, 30)).toEqual({
  timelineRange: {
    sequenceId: "seq_aaaaaaaaaa",
    start: { frames: 0, fps: "24/1" },
    end: { frames: 30, fps: "24/1" },
  },
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
pnpm vitest run packages/app/src/renderer/panels/PublishPanel.test.ts packages/app/src/renderer/panels/StatusStripPanel.test.ts
```

Expected: Publish’s output assertions fail until it uses the shared resolver.

- [ ] **Step 3: Target Graphics and B-roll at the active sequence**

For each panel, import `resolveActiveDeliverable`, subscribe to `selectedDeliverableId`, and resolve from `snapshot.master`.

Apply these exact targets:

- `GraphicsPanel.tsx`

```ts
const deliverable = snapshot === null
  ? undefined
  : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
const graphicLayers = snapshot?.master.layers.filter((layer) =>
  (layer.kind === "text" || layer.kind === "animation") &&
  (layer.sequence === undefined || layer.sequence === deliverable?.sequenceId)) ?? [];
```

Use `deliverable.sequenceId` for timeline anchors and `until` anchors, and use `deliverable.id` for `templateFreeze`.
Clear the panel’s sequence-bound local choice when the active ID changes:

```ts
useEffect(() => {
  setSelectedGraphicId(null);
  setLayerId("auto");
}, [deliverable?.id]);
```

- `BrollPanel.tsx`

```ts
const deliverable = resolveActiveDeliverable(
  snapshot.master,
  selectedDeliverableId,
);
```

Pass `deliverable.sequenceId` to `GenerationService.acceptCandidate`; change the empty-state message from “primary deliverable” to “active deliverable”.

- [ ] **Step 4: Target PiP and Key Inspector at the active sequence**

- `PipInspector.tsx`

Resolve the deliverable and require the selected layer to be either global or owned by that sequence:

```ts
const layer = snapshot?.master.layers.find(({ id, sequence }) =>
  id === selectedLayerId &&
  (sequence === undefined || sequence === deliverable?.sequenceId));
const sequenceId = deliverable?.sequenceId;
```

- `KeyInspector.tsx`

Resolve the active sequence first and search for the selected clip only there:

```ts
const sequence = snapshot?.master.sequences.find(
  ({ id }) => id === deliverable?.sequenceId,
);
const clip = sequence?.clips.find(({ id }) => id === selectedClipId);
const activeLayers = snapshot?.master.layers.filter(
  ({ sequence: owner }) =>
    owner === undefined || owner === deliverable?.sequenceId,
) ?? [];
```

Use `deliverable.id` for diagnostic render and `deliverable.sequenceId` for
arrangement. Replace all three unrestricted `snapshot.master.layers` reads in
the arrangement defaulting and role-option code with `activeLayers`. When finding
the inspected layer for diagnostic rendering, search `activeLayers` and prefer a
layer owned by `deliverable.sequenceId`. Assets remain project-global and can
still appear as arrangement choices.

Reset role assignments when the active deliverable changes so IDs from the old
sequence cannot be submitted:

```ts
useEffect(() => {
  setAssignments({});
}, [deliverable?.id]);
```

- [ ] **Step 5: Target Restyle at the active deliverable**

- `RestylePlan.tsx`

Replace primary ID with:

```ts
const deliverable = snapshot === null
  ? undefined
  : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
const deliverableId = deliverable?.id;
const deliverableName = deliverable?.name ?? "Episode";
```

Reset local state that belongs to the previous deliverable:

```ts
useEffect(() => {
  setDraft(null);
  setConfirmation(null);
  setCoverageMode("full");
  setStartFrame(0);
  setEndFrame(300);
}, [deliverableId]);
```

- [ ] **Step 6: Route all UI switches through centralized activation**

In `PublishPanel.tsx`, replace its ad hoc fallback and direct setter:

```ts
const deliverable = snapshot === null
  ? undefined
  : resolveActiveDeliverable(snapshot.master, selectedId);
```

Synchronize deliverable-local editor state when selection changes:

```ts
const metadataDeliverableId = useRef(deliverable?.id);

useEffect(() => {
  if (metadataDeliverableId.current === deliverable?.id) return;
  metadataDeliverableId.current = deliverable?.id;
  setMetadata(deliverable?.publish?.metadata ?? null);
  setOtioLosses(null);
}, [deliverable?.id, deliverable?.publish?.metadata]);
```

Add `useRef` to the React import. The ID guard prevents an unrelated same-deliverable
snapshot refresh from discarding an unsaved metadata draft.

On its `<select>`:

```tsx
onChange={(event) => {
  if (snapshot !== null) {
    void activateDeliverable(snapshot.master, event.target.value, setNotice);
  }
}}
```

In `StatusStripPanel.tsx`, retain the existing `primary` variable for derivation, timeline-range source, and the explicitly primary export button. Change only deliverable-card activation:

```ts
const selectedDeliverableId = useSelectionStore(
  (state) => state.selectedDeliverableId,
);
const activeDeliverable = snapshot === null
  ? undefined
  : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
```

```tsx
onClick={() => snapshot === null
  ? undefined
  : void activateDeliverable(snapshot.master, deliverable.id, setNotice)}
```

Resolve the active deliverable for card state and mark each button:

```tsx
data-active={deliverable.id === activeDeliverable?.id}
aria-pressed={deliverable.id === activeDeliverable?.id}
```

Add a clear focus-equivalent active style in `packages/app/src/renderer/styles.css`:

```css
.deliverable-card > button[data-active="true"] {
  background: rgb(69 147 255 / 12%);
  box-shadow: inset 0 0 0 1px rgb(69 147 255 / 55%);
}
```

In `ProposalPanel.tsx`, make evidence navigation async and activate before applying evidence-specific selections:

```ts
async function jumpToEvidence(evidence: EvidenceRef): Promise<void> {
  if (evidence.deliverableId !== undefined && snapshot !== null) {
    try {
      await activateDeliverable(
        snapshot.master,
        evidence.deliverableId,
        setNotice,
      );
    } catch (error: unknown) {
      setNotice(`Evidence target is unavailable: ${errorMessage(error)}`);
      return;
    }
  }
  if (evidence.sourceRange !== undefined) setPlayhead(evidence.sourceRange.start);
  if (evidence.wordRange !== undefined) {
    selectWord(evidence.wordRange.from);
    setWordRange({
      fromWord: evidence.wordRange.from,
      toWord: evidence.wordRange.to,
    });
  }
  if (evidence.annotationId !== undefined) {
    selectAnnotation(evidence.annotationId);
  }
}
```

Change evidence button handlers to `onClick={() => void jumpToEvidence(evidence)}`.

- [ ] **Step 7: Restrict Inspector selection to the active sequence**

In `InspectorPanel.tsx`, resolve the active deliverable. Search for clips only in its sequence and layers only when global or active:

```ts
const deliverable = snapshot === null
  ? undefined
  : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
const sequence = snapshot?.master.sequences.find(
  ({ id }) => id === deliverable?.sequenceId,
);
const clip = sequence?.clips.find(({ id }) => id === selectedClipId);
const layer = snapshot?.master.layers.find(({ id, sequence: owner }) =>
  id === selectedLayerId &&
  (owner === undefined || owner === sequence?.id));
```

This is defensive in addition to activation clearing selection.

- [ ] **Step 8: Run tests, typecheck, and a primary-reference audit**

Run:

```bash
pnpm vitest run packages/app/src/renderer/active-deliverable.test.ts packages/app/src/renderer/panels/active-deliverable-panels.test.ts packages/app/src/renderer/panels/PublishPanel.test.ts packages/app/src/renderer/panels/StatusStripPanel.test.ts
pnpm --filter @guyditor/app typecheck
rg -n "settings\\.primaryDeliverable|selectDeliverable" packages/app/src/renderer
```

Expected: tests and typecheck PASS. The `rg` output contains primary fallback in `active-deliverable.ts` and intentional primary-source/export logic in `StatusStripPanel.tsx`; no panel has a direct `selectDeliverable` call.

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/renderer/panels/GraphicsPanel.tsx packages/app/src/renderer/panels/BrollPanel.tsx packages/app/src/renderer/panels/PipInspector.tsx packages/app/src/renderer/panels/KeyInspector.tsx packages/app/src/renderer/panels/RestylePlan.tsx packages/app/src/renderer/panels/PublishPanel.tsx packages/app/src/renderer/panels/StatusStripPanel.tsx packages/app/src/renderer/panels/ProposalPanel.tsx packages/app/src/renderer/panels/InspectorPanel.tsx packages/app/src/renderer/styles.css packages/app/src/renderer/panels/PublishPanel.test.ts packages/app/src/renderer/panels/StatusStripPanel.test.ts
git commit -m "fix(renderer): target edits at active distribution"
```

### Task 8: Hydration, refresh preservation, project copy, and Electron acceptance

**Files:**
- Modify: `packages/app/src/renderer/App.tsx`
- Modify: `packages/app/e2e/helpers/workspace-project.ts`
- Create: `packages/app/e2e/active-deliverable.spec.ts`

- [ ] **Step 1: Add the visibly distinct short fixture**

Extend `WorkspaceProjectOptions`:

```ts
derivedShort?: boolean;
```

Before `createProject`, when it is true, add:

```ts
model.sequences.push({
  id: "seq_bbbbbbbbbb",
  name: "Portrait short sequence",
  clips: [{
    id: "clp_cccccccccc",
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: 24, fps: "24/1" },
      out: { frames: 36, fps: "24/1" },
    },
  }],
});
model.layers.push({
  id: "lyr_cccccccccc",
  kind: "video",
  name: "Portrait short video",
  order: 0,
  enabled: true,
  locked: false,
  sequence: "seq_bbbbbbbbbb",
});
model.captions.push({
  ...structuredClone(model.captions[0]!),
  id: "cts_bbbbbbbbbb",
  name: "Portrait short captions",
  sourceLayerIds: ["lyr_cccccccccc"],
});
model.deliverables.push({
  id: "dlv_bbbbbbbbbb",
  kind: "short",
  name: "Portrait short",
  profile: "youtube-shorts@1.0.0",
  sequenceId: "seq_bbbbbbbbbb",
  captionsTrackId: "cts_bbbbbbbbbb",
  status: "draft",
  dependencies: [],
});
```

- [ ] **Step 2: Write the packaged Electron regression test**

Create `packages/app/e2e/active-deliverable.spec.ts` with two launches and cleanup. The test must:

```ts
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { launchApp } from "./helpers/launch-app.js";
import { createWorkspaceProject } from "./helpers/workspace-project.js";

test("one project-portable active short drives every phase and edit target", async () => {
  const template = await createWorkspaceProject({
    transcript: true,
    derivedShort: true,
  });
  const first = await launchApp({ projectTemplate: template });
  let second: Awaited<ReturnType<typeof launchApp>> | null = null;
  const copyRoot = await mkdtemp(join(tmpdir(), "guyditor-active-copy-"));
  try {
    const protectedPaths = [
      "episode.guyditor.yaml",
      "history/HEAD",
      "history/transactions.jsonl",
    ];
    const before = await Promise.all(protectedPaths.map((path) =>
      readFile(join(first.projectPath!, path), "utf8"),
    ));

    await first.page.getByTestId("phase-tab-publish").click();
    await first.page.getByTestId("deliverable-dlv_bbbbbbbbbb").click();
    await expect(first.page.getByTestId("deliverable-dlv_bbbbbbbbbb"))
      .toHaveAttribute("aria-pressed", "true");
    await expect(first.page.getByLabel("Deliverable"))
      .toHaveValue("dlv_bbbbbbbbbb");

    const afterSwitch = await Promise.all(protectedPaths.map((path) =>
      readFile(join(first.projectPath!, path), "utf8"),
    ));
    expect(afterSwitch).toEqual(before);
    await expect.poll(() =>
      readFile(join(first.projectPath!, "workspace.guyditor.yaml"), "utf8"))
      .toContain("activeDeliverableId: dlv_bbbbbbbbbb");

    await first.page.getByTestId("phase-tab-cut").click();
    await expect(first.page.getByTestId("preview-surface"))
      .toHaveAttribute("data-aspect", "portrait");
    await expect(first.page.getByTestId("timeline-clip-clp_cccccccccc"))
      .toBeVisible();
    await expect(first.page.getByTestId("timeline-clip-clp_aaaaaaaaaa"))
      .toHaveCount(0);
    await expect(first.page.getByTestId("caption-track-panel"))
      .toContainText("cts_bbbbbbbbbb");

    await first.page.getByTestId("phase-tab-polish").click();
    await first.page.getByTestId("template-lower-third").click();
    await first.page.getByLabel("title *", { exact: true })
      .fill("Short-only title");
    await first.page.getByTestId("graphic-anchor").selectOption("playhead");
    await first.page.getByTestId("graphic-add").click();
    await expect(first.page.getByTestId("graphic-instance-list"))
      .toContainText("Short-only title");
    await expect.poll(() =>
      readFile(join(first.projectPath!, "history/transactions.jsonl"), "utf8"))
      .toContain("timeline:seq_bbbbbbbbbb@0");

    await first.electronApp.close();
    const copiedProject = join(copyRoot, "copied-project");
    await cp(first.projectPath!, copiedProject, { recursive: true });
    second = await launchApp({
      projectPath: copiedProject,
      userDataDirectory: join(copyRoot, "fresh-profile"),
    });

    await expect(second.page.getByTestId("preview-surface"))
      .toHaveAttribute("data-aspect", "portrait");
    await expect(second.page.getByTestId("timeline-clip-clp_cccccccccc"))
      .toBeVisible();
    await expect(second.page.getByTestId("caption-track-panel"))
      .toContainText("cts_bbbbbbbbbb");
  } finally {
    await first.electronApp.close().catch(() => undefined);
    await second?.electronApp.close().catch(() => undefined);
    await rm(template, { recursive: true, force: true });
    await rm(copyRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Build and run the new E2E test to verify RED**

Run:

```bash
pnpm --filter @guyditor/app build
xvfb-run -a pnpm --filter @guyditor/app test:e2e -- active-deliverable.spec.ts
```

Expected: FAIL at fresh hydration because `App` does not load workspace state, and may fail earlier where remaining active state is not wired.

- [ ] **Step 4: Hydrate workspace state only when the project changes**

In `App.tsx`, import:

```ts
import type { LoadedProjectWorkspaceState } from "../shared/ipc.js";
import {
  applyDeliverableSelection,
  resolveActiveDeliverable,
} from "./active-deliverable.js";
import {
  getWorkspaceState,
  setActiveDeliverable,
} from "./ipc.js";
```

Change `hydrate` to return `Promise<string | undefined>`. Capture the previous
project identity, resolve the next active ID, then replace the mirror immediately
before applying its selection:

```ts
const previous = useProjectMirror.getState().snapshot;
const projectChanged = previous?.projectPath !== next.projectPath;
let workspaceWarning: string | undefined;

if (projectChanged) {
  let loaded: LoadedProjectWorkspaceState;
  try {
    loaded = await getWorkspaceState();
  } catch (error: unknown) {
    loaded = {
      state: {
        format: "guyditor.workspace/v1",
        activeDeliverableId: next.master.settings.primaryDeliverable,
      },
      warning: `Could not load workspace selection; using primary deliverable: ${errorMessage(error)}`,
    };
  }
  const active = resolveActiveDeliverable(
    next.master,
    loaded.state.activeDeliverableId,
  );
  useWorkspaceStore.getState().setProjectKey(next.projectPath);
  replaceSnapshot(next);
  applyDeliverableSelection(next.master, active.id);
  workspaceWarning = loaded.warning;
} else {
  const currentId = useSelectionStore.getState().selectedDeliverableId;
  const active = resolveActiveDeliverable(next.master, currentId);
  replaceSnapshot(next);
  if (active.id !== currentId) {
    applyDeliverableSelection(next.master, active.id);
    try {
      await setActiveDeliverable(active.id);
    } catch (error: unknown) {
      workspaceWarning =
        `Active deliverable was removed; using ${active.name}, but workspace autosave failed: ${errorMessage(error)}`;
    }
  }
}
```

At the end of `hydrate`, return `workspaceWarning`.

Do not call `setProjectKey` on same-project revision refreshes; that preserves the live layout/phase. Do not read workspace state on same-project refreshes; that preserves the current live selection.

- [ ] **Step 5: Preserve warnings at each hydration caller**

Subscribe in `App`:

```ts
const selectedDeliverableId = useSelectionStore(
  (state) => state.selectedDeliverableId,
);
```

Make `refreshProject` surface a workspace warning:

```ts
const refreshProject = useCallback(async (successNotice?: string): Promise<void> => {
  const next = await getSnapshot();
  const warning = await hydrate(next);
  if (warning !== undefined) setNotice(warning);
  else if (successNotice !== undefined) setNotice(successNotice);
}, [hydrate]);
```

For revision events, use:

```ts
void refreshProject(`Accepted ${event.revision}`)
  .catch((error: unknown) => setNotice(errorMessage(error)));
```

For initial hydration, set a returned warning only if the effect is still active:

```ts
void getSnapshot().then(async (opened) => {
  if (!active) return;
  const warning = await hydrate(opened);
  if (active && warning !== undefined) setNotice(warning);
}).catch(() => undefined);
```

For open:

```ts
const warning = await hydrate(opened);
setNotice(warning ?? `Opened ${opened.projectPath}`);
```

For create:

```ts
const warning = await hydrate(created);
setNotice(warning ?? `Created ${created.projectPath}`);
```

Remove the two explicit `setPlayhead` calls immediately after `await hydrate(opened)`
and `await hydrate(created)`; centralized selection already performs the reset.

- [ ] **Step 6: Make restyle and keyboard review follow the active context**

Declare this ref beside the existing overview and annotation generation refs:

```ts
const restyleGeneration = useRef(0);
```

In `refreshRestylePlan`, resolve with the selection store:

```ts
const current = useProjectMirror.getState().snapshot;
if (current === null) {
  setRestylePlan(null);
  return;
}
const generation = ++restyleGeneration.current;
const deliverable = resolveActiveDeliverable(
  current.master,
  useSelectionStore.getState().selectedDeliverableId,
);
setRestylePlan(null);
try {
  const nextPlan = await window.guyditor.call<RestylePlan | null>(
    "DeliverableService",
    "restylePlan",
    { deliverableId: deliverable.id },
  );
  if (generation === restyleGeneration.current) {
    setRestylePlan(nextPlan);
  }
} catch {
  if (generation === restyleGeneration.current) {
    setRestylePlan(null);
  }
}
```

This prevents a slow response for the old deliverable from replacing the new
deliverable’s plan.

Refetch on selection change:

```ts
useEffect(() => {
  if (snapshot !== null && selectedDeliverableId !== null) {
    void refreshRestylePlan();
  }
}, [refreshRestylePlan, selectedDeliverableId, snapshot?.projectPath]);
```

For Alt+arrow word navigation, include the active sequence as `scope`:

```ts
const activeDeliverable = snapshot === null
  ? undefined
  : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
void window.guyditor.call<{ frame: { frames: number; fps: string } }>(
  "OperationEngine",
  "resolveNavigation",
  {
    target: { kind: "word", wordId: id },
    ...(activeDeliverable === undefined
      ? {}
      : { scope: activeDeliverable.sequenceId }),
  },
);
```

For annotation keyboard cycling, filter before finding the next item:

```ts
const activeAnnotations = annotations.filter(
  ({ canvasRef }) =>
    canvasRef.sequenceId === activeDeliverable?.sequenceId,
);
```

Use `activeAnnotations` for the selected index, modulo, and next annotation.
Add `selectedDeliverableId` to the keyboard effect dependency list.

- [ ] **Step 7: Rebuild and run the targeted packaged E2E test**

Run:

```bash
pnpm --filter @guyditor/app build
xvfb-run -a pnpm --filter @guyditor/app test:e2e -- active-deliverable.spec.ts
```

Expected: PASS. The test proves immediate cross-phase context, short-targeted graphic placement, canonical byte stability for selection, copied-project portability, and fresh-profile restore.

- [ ] **Step 8: Run focused regression tests**

Run:

```bash
pnpm vitest run packages/app/src/main/project-workspace-state.test.ts packages/app/src/main/service-host.test.ts packages/app/src/main/surfaces.test.ts packages/app/src/renderer/active-deliverable.test.ts packages/app/src/renderer/panels/active-deliverable-panels.test.ts packages/transcript/src/range-operations.test.ts packages/media/src/storage.test.ts packages/media/src/backup.test.ts
pnpm --filter @guyditor/app typecheck
pnpm --filter @guyditor/app lint
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/renderer/App.tsx packages/app/e2e/helpers/workspace-project.ts packages/app/e2e/active-deliverable.spec.ts
git commit -m "feat(app): restore active distribution across sessions"
```

### Task 9: User documentation, traceability, and complete verification

**Files:**
- Modify: `docs/MANUAL.md`
- Modify: `docs/traceability.md`

- [ ] **Step 1: Document the active distribution and project file**

In the Publish table in `docs/MANUAL.md`, change the Deliverables row to state:

```md
| Deliverables | Deliverables/status panel | The long-form master plus any number of shorts, each with status (draft → in-review → approved → stale) and its own profile. Select one here or in Publish to make it the active distribution across Preview, Timeline, Transcript/Captions, Graphics, B-roll, inspectors, Restyle, and Publish. The choice autosaves with the project and survives phase changes and reopen. |
```

In the “Project on disk” reference, add:

```md
`workspace.guyditor.yaml` (portable non-editorial active-distribution state; safe fallback to primary if missing or invalid)
```

Keep `episode.guyditor.yaml` described as the whole canonical edit.

- [ ] **Step 2: Update traceability evidence**

In the FR-802 row in `docs/traceability.md`, add:

```md
`packages/app/e2e/active-deliverable.spec.ts`
```

and state that one project-portable selection drives all long-form/short editing surfaces while primary-origin derivation remains unchanged.

- [ ] **Step 3: Run formatting and source audits**

Run:

```bash
git diff --check
rg -n "settings\\.primaryDeliverable|selectDeliverable" packages/app/src/renderer
rg -n "workspace\\.guyditor\\.yaml" packages/app packages/media docs
```

Expected:

- `git diff --check` exits 0.
- Primary references remain only in the shared fallback and explicit primary-origin Status actions.
- Workspace filename references cover main persistence, storage, backup, tests, and docs.

- [ ] **Step 4: Run package-wide static verification**

Run:

```bash
pnpm -r typecheck
pnpm -r lint
pnpm check:conventions
```

Expected: all commands exit 0.

- [ ] **Step 5: Run the complete unit suite**

Run:

```bash
pnpm vitest run
```

Expected: every unit project test passes with no snapshot or fixture regressions.

- [ ] **Step 6: Run the complete packaged Electron suite**

Run:

```bash
pnpm test:e2e
```

Expected: app build succeeds and every Playwright test passes, including `active-deliverable.spec.ts`.

- [ ] **Step 7: Inspect final branch state**

Run:

```bash
git status --short
git log --oneline --decorate -10
```

Expected: only the documentation changes from this task are uncommitted; implementation is represented by cohesive commits on `fix/selected-deliverable-context`.

- [ ] **Step 8: Commit documentation**

```bash
git add docs/MANUAL.md docs/traceability.md
git commit -m "docs: explain project-portable active distributions"
```

- [ ] **Step 9: Perform the completion review**

Run:

```bash
git status --short
git diff main...HEAD --check
git diff --stat main...HEAD
```

Expected: clean worktree, no whitespace errors, and changes limited to the files named in this plan.

## Requirement-to-task coverage

| Approved requirement | Implemented and proven by |
|---|---|
| One active deliverable across every phase and panel | Tasks 4, 6, 7; panel test and packaged E2E |
| Project-portable autosave with fresh-profile reopen | Tasks 1, 2, 8 |
| Workspace initialization cannot block canonical project creation | Task 1 failure test and Task 2 creation lifecycle |
| No canonical revision/history/undo/render churn on switch | Task 2 integration and Task 8 byte-for-byte E2E assertions |
| Missing/invalid/unsupported/deleted-ID fallback | Task 1 table-driven tests |
| Corrupt bytes preserved until explicit selection | Task 1 read-before/write tests |
| Atomic publication and deterministic rapid writes | Task 1 implementation and concurrency test |
| Backup, restore, storage accounting, and project copy | Tasks 3 and 8 |
| Reset sequence state but retain layout/zoom | Task 4 store test |
| Active Preview, Timeline, Captions, annotations, PiP, keying | Tasks 6 and 7 |
| Active Graphics, B-roll, Restyle, Publish, Status, evidence navigation | Task 7 |
| Transcript removal cannot edit primary while a short is active | Task 5 and Task 6 |
| Derivation remains primary-origin | Task 7 Status regression and final primary-reference audit |
| Full packaged regression gate | Task 9 |
