import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WorkspaceLayoutService } from "./workspace-layout-service.js";

async function userDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "guyditor-layout-"));
}

describe("WorkspaceLayoutService", () => {
  it("returns null before anything is saved", async () => {
    const service = new WorkspaceLayoutService({ userDirectory: await userDirectory() });

    expect(await service.get()).toBeNull();
  });

  it("round-trips a document across service instances", async () => {
    const directory = await userDirectory();
    const document = {
      activePhase: "polish",
      layouts: { cut: { root: null }, polish: { root: { kind: "group", id: "g_1", panelIds: ["preview"], activePanelId: "preview" } } },
    };

    await new WorkspaceLayoutService({ userDirectory: directory }).save(document);

    expect(await new WorkspaceLayoutService({ userDirectory: directory }).get()).toEqual(document);
  });

  it("keeps the latest of concurrent saves", async () => {
    const directory = await userDirectory();
    const service = new WorkspaceLayoutService({ userDirectory: directory });

    await Promise.all([
      service.save({ activePhase: "cut" }),
      service.save({ activePhase: "review" }),
    ]);

    expect(await service.get()).toEqual({ activePhase: "review" });
  });

  it("stores an invalid layout untouched; normalization belongs to the renderer", async () => {
    const service = new WorkspaceLayoutService({ userDirectory: await userDirectory() });
    const document = { activePhase: "cut", layouts: { cut: 42 } };

    await service.save(document);

    expect(await service.get()).toEqual(document);
  });

  it("exposes get and save on its IPC surface", async () => {
    const service = new WorkspaceLayoutService({ userDirectory: await userDirectory() });
    const surface = service.surface();

    await surface.save({ document: { activePhase: "ingest" } });

    expect(await surface.get()).toEqual({ activePhase: "ingest" });
  });
});
