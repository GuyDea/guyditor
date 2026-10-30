import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { WorkspaceLayoutService } from "./workspace-layout-service.js";

async function userDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "guyditor-layout-"));
}

const cutLayout = { root: { kind: "group", id: "g_1", panelIds: ["preview"], activePanelId: "preview" } };
const reviewLayout = { root: null };

describe("WorkspaceLayoutService", () => {
  it("returns null before anything is saved", async () => {
    const service = new WorkspaceLayoutService({ userDirectory: await userDirectory() });

    expect(await service.get()).toBeNull();
  });

  it("merges per-phase updates and persists them across instances", async () => {
    const directory = await userDirectory();
    const service = new WorkspaceLayoutService({ userDirectory: directory });

    await service.update({ clientId: "a", activePhase: "cut", layouts: { cut: cutLayout } });
    await service.update({ clientId: "a", activePhase: "review", layouts: { review: reviewLayout } });

    expect(await new WorkspaceLayoutService({ userDirectory: directory }).get()).toEqual({
      activePhase: "review",
      layouts: { cut: cutLayout, review: reviewLayout },
    });
  });

  it("keeps both phases when two windows update concurrently", async () => {
    const service = new WorkspaceLayoutService({ userDirectory: await userDirectory() });

    await Promise.all([
      service.update({ clientId: "a", activePhase: "cut", layouts: { cut: cutLayout } }),
      service.update({ clientId: "b", activePhase: "review", layouts: { review: reviewLayout } }),
    ]);

    expect(await service.get()).toMatchObject({ layouts: { cut: cutLayout, review: reviewLayout } });
  });

  it("does not let a window's phase switch revert layouts it did not send", async () => {
    const service = new WorkspaceLayoutService({ userDirectory: await userDirectory() });
    await service.update({ clientId: "a", activePhase: "cut", layouts: { cut: cutLayout } });

    await service.update({ clientId: "b", activePhase: "publish", layouts: {} });

    expect(await service.get()).toEqual({ activePhase: "publish", layouts: { cut: cutLayout } });
  });

  it("announces the merged document with the sending client", async () => {
    const onChange = vi.fn();
    const service = new WorkspaceLayoutService({ userDirectory: await userDirectory(), onChange });

    await service.update({ clientId: "a", activePhase: "cut", layouts: { cut: cutLayout } });

    expect(onChange).toHaveBeenCalledWith(
      { activePhase: "cut", layouts: { cut: cutLayout } },
      "a",
    );
  });

  it("replaces a corrupt stored value instead of merging into it", async () => {
    const directory = await userDirectory();
    const service = new WorkspaceLayoutService({ userDirectory: directory });
    await service.update({ clientId: "a", activePhase: "cut", layouts: { cut: cutLayout } });

    const { replaceSettingsKey } = await import("./settings.js");
    await replaceSettingsKey(directory, "workspace", 42);
    await service.update({ clientId: "a", activePhase: "cut", layouts: { cut: cutLayout } });

    expect(await service.get()).toEqual({ activePhase: "cut", layouts: { cut: cutLayout } });
  });

  it("exposes get and update on its IPC surface", async () => {
    const service = new WorkspaceLayoutService({ userDirectory: await userDirectory() });
    const surface = service.surface();

    await surface.update({ clientId: "a", activePhase: "ingest", layouts: {} });

    expect(await surface.get()).toEqual({ activePhase: "ingest", layouts: {} });
  });
});
