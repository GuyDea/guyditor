import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import {
  PROJECT_WORKSPACE_FILE,
  ProjectWorkspaceStateStore,
} from "./project-workspace-state.js";

const PRIMARY_DELIVERABLE_ID = "dlv_aaaaaaaaaa";
const SHORT_DELIVERABLE_ID = "dlv_bbbbbbbbbb";
const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "guyditor-workspace-state-"));
  roots.push(value);
  return value;
}

function projectWithShort() {
  const project = projectFixture();
  project.deliverables.push({
    id: SHORT_DELIVERABLE_ID,
    kind: "short",
    name: "Portrait short",
    profile: "youtube-shorts@1.0.0",
    sequenceId: "seq_bbbbbbbbbb",
    status: "draft",
  });
  return project;
}

function expectedState(activeDeliverableId = PRIMARY_DELIVERABLE_ID) {
  return {
    format: "guyditor.workspace/v1" as const,
    activeDeliverableId,
  };
}

function serialized(activeDeliverableId: string): string {
  return [
    "format: guyditor.workspace/v1",
    `activeDeliverableId: ${activeDeliverableId}`,
    "",
  ].join("\n");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ProjectWorkspaceStateStore", () => {
  it("falls back silently when the optional workspace document is missing", async () => {
    const path = await root();

    const loaded = await new ProjectWorkspaceStateStore(path).load(projectWithShort());

    expect(loaded).toEqual({ state: expectedState() });
  });

  it("does not block canonical project creation when initialization IO fails", async () => {
    const unavailable = join(await root(), "missing-parent");
    const store = new ProjectWorkspaceStateStore(unavailable);
    const project = projectWithShort();

    await expect(store.initialize(project)).resolves.toEqual(expectedState());
    await expect(store.load(project)).resolves.toEqual({
      state: expectedState(),
      warning: expect.stringContaining(
        "Could not initialize workspace selection",
      ),
    });
    await expect(store.load(project)).resolves.toEqual({
      state: expectedState(),
    });
  });

  it.each([
    {
      label: "invalid YAML",
      bytes: "format: [\n",
      detail: "Workspace selection is invalid",
    },
    {
      label: "an unsupported format",
      bytes: [
        "format: guyditor.workspace/v2",
        `activeDeliverableId: ${SHORT_DELIVERABLE_ID}`,
        "",
      ].join("\n"),
      detail: "Unsupported workspace format",
    },
    {
      label: "an unknown field",
      bytes: [
        "format: guyditor.workspace/v1",
        `activeDeliverableId: ${SHORT_DELIVERABLE_ID}`,
        "extra: true",
        "",
      ].join("\n"),
      detail: "only format and activeDeliverableId",
    },
    {
      label: "a malformed deliverable ID",
      bytes: [
        "format: guyditor.workspace/v1",
        "activeDeliverableId: master",
        "",
      ].join("\n"),
      detail: "malformed",
    },
    {
      label: "a well-formed deleted deliverable ID",
      bytes: [
        "format: guyditor.workspace/v1",
        "activeDeliverableId: dlv_cccccccccc",
        "",
      ].join("\n"),
      detail: "no longer exists",
    },
  ])(
    "preserves original bytes and returns a warned primary fallback for $label",
    async ({ bytes, detail }) => {
      const path = await root();
      const document = join(path, PROJECT_WORKSPACE_FILE);
      await writeFile(document, bytes, "utf8");

      const loaded = await new ProjectWorkspaceStateStore(path).load(
        projectWithShort(),
      );

      expect(loaded.state).toEqual(expectedState());
      expect(loaded.warning).toContain(detail);
      expect(loaded.warning).toContain(
        `using primary deliverable ${PRIMARY_DELIVERABLE_ID}`,
      );
      await expect(readFile(document, "utf8")).resolves.toBe(bytes);
    },
  );

  it("throws the project invariant error when the primary fallback is invalid", async () => {
    const path = await root();
    const project = projectWithShort();
    project.settings.primaryDeliverable = "dlv_cccccccccc";

    await expect(new ProjectWorkspaceStateStore(path).load(project)).rejects
      .toMatchObject({
        code: "E_PROJECT_INVARIANT",
        affected: ["dlv_cccccccccc"],
      });
  });

  it("publishes a known deliverable ID with exact deterministic bytes", async () => {
    const path = await root();
    const store = new ProjectWorkspaceStateStore(path);

    await expect(
      store.setActiveDeliverable(projectWithShort(), SHORT_DELIVERABLE_ID),
    ).resolves.toEqual(expectedState(SHORT_DELIVERABLE_ID));

    await expect(
      readFile(join(path, PROJECT_WORKSPACE_FILE), "utf8"),
    ).resolves.toBe(serialized(SHORT_DELIVERABLE_ID));
    await expect(readdir(path)).resolves.toEqual([PROJECT_WORKSPACE_FILE]);
  });

  it("rejects an unknown ID without replacing existing bytes or leaving temp files", async () => {
    const path = await root();
    const document = join(path, PROJECT_WORKSPACE_FILE);
    const original = serialized(PRIMARY_DELIVERABLE_ID);
    await writeFile(document, original, "utf8");
    const store = new ProjectWorkspaceStateStore(path);

    await expect(
      store.setActiveDeliverable(projectWithShort(), "dlv_cccccccccc"),
    ).rejects.toMatchObject({
      code: "E_WORKSPACE_DELIVERABLE_NOT_FOUND",
      affected: ["dlv_cccccccccc"],
    });

    await expect(readFile(document, "utf8")).resolves.toBe(original);
    await expect(readdir(path)).resolves.toEqual([PROJECT_WORKSPACE_FILE]);
  });

  it("replaces preserved corrupt bytes on the next explicit valid selection", async () => {
    const path = await root();
    const document = join(path, PROJECT_WORKSPACE_FILE);
    const store = new ProjectWorkspaceStateStore(path);
    const project = projectWithShort();
    const corrupt = "not: [valid\n";
    await writeFile(document, corrupt, "utf8");

    await expect(store.load(project)).resolves.toMatchObject({
      state: expectedState(),
      warning: expect.any(String),
    });
    await expect(readFile(document, "utf8")).resolves.toBe(corrupt);

    await store.setActiveDeliverable(project, SHORT_DELIVERABLE_ID);

    await expect(readFile(document, "utf8")).resolves.toBe(
      serialized(SHORT_DELIVERABLE_ID),
    );
  });

  it("serializes rapid set calls in request order so the last request wins", async () => {
    const path = await root();
    const store = new ProjectWorkspaceStateStore(path);
    const project = projectWithShort();

    await Promise.all([
      store.setActiveDeliverable(project, PRIMARY_DELIVERABLE_ID),
      store.setActiveDeliverable(project, SHORT_DELIVERABLE_ID),
      store.setActiveDeliverable(project, PRIMARY_DELIVERABLE_ID),
      store.setActiveDeliverable(project, SHORT_DELIVERABLE_ID),
    ]);

    await expect(store.load(project)).resolves.toEqual({
      state: expectedState(SHORT_DELIVERABLE_ID),
    });
    await expect(
      readFile(join(path, PROJECT_WORKSPACE_FILE), "utf8"),
    ).resolves.toBe(serialized(SHORT_DELIVERABLE_ID));
  });

  it("waits for an outstanding write before loading", async () => {
    const path = await root();
    const store = new ProjectWorkspaceStateStore(path);
    const project = projectWithShort();

    const publication = store.setActiveDeliverable(project, SHORT_DELIVERABLE_ID);

    await expect(store.load(project)).resolves.toEqual({
      state: expectedState(SHORT_DELIVERABLE_ID),
    });
    await expect(publication).resolves.toEqual(
      expectedState(SHORT_DELIVERABLE_ID),
    );
  });

  it("allows a later write after a publication failure", async () => {
    const projectRoot = join(await root(), "missing-parent");
    const store = new ProjectWorkspaceStateStore(projectRoot);
    const project = projectWithShort();

    await expect(
      store.setActiveDeliverable(project, SHORT_DELIVERABLE_ID),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(projectRoot);
    await expect(
      store.setActiveDeliverable(project, PRIMARY_DELIVERABLE_ID),
    ).resolves.toEqual(expectedState());
    await expect(
      readFile(join(projectRoot, PROJECT_WORKSPACE_FILE), "utf8"),
    ).resolves.toBe(serialized(PRIMARY_DELIVERABLE_ID));
  });
});
