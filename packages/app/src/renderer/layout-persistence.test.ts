import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startLayoutPersistence } from "./layout-persistence.js";
import { placedPanels } from "./state/layout-tree.js";
import { configureLayoutSaver, useWorkspaceStore } from "./state/view-state.js";

type Listener = (event: unknown) => void;

interface Bridge {
  calls: { method: string; params: Record<string, unknown> }[];
  resolveGet: (value: unknown) => void;
  rejectGet: (error: Error) => void;
  emit: (event: unknown) => void;
}

function installBridge(): Bridge {
  const calls: Bridge["calls"] = [];
  const listeners: Listener[] = [];
  let resolveGet: (value: unknown) => void = () => undefined;
  let rejectGet: (error: Error) => void = () => undefined;
  const pending = new Promise<unknown>((resolve, reject) => {
    resolveGet = resolve;
    rejectGet = reject;
  });
  vi.stubGlobal("window", {
    guyditor: {
      call: (_service: string, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return method === "get" ? pending : Promise.resolve(undefined);
      },
      on: (_kind: string, listener: Listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
  });
  return {
    calls,
    resolveGet: (value) => resolveGet(value),
    rejectGet: (error) => rejectGet(error),
    emit: (event) => listeners.forEach((listener) => listener(event)),
  };
}

const helpOnly = { root: { kind: "group", id: "g_h", panelIds: ["help"], activePanelId: "help" } };

function timelineGroupId(): string {
  const root = useWorkspaceStore.getState().layout.root;
  if (root?.kind !== "split") throw new Error("Cut preset root should be a split.");
  const timeline = root.children[1];
  if (timeline?.kind !== "group") throw new Error("Timeline group missing.");
  return timeline.id;
}

describe("layout persistence", () => {
  let stop: () => void = () => undefined;

  beforeEach(() => {
    configureLayoutSaver(() => undefined);
    useWorkspaceStore.getState().hydrateLayouts(null);
  });

  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
  });

  it("hydrates the stored document", async () => {
    const bridge = installBridge();
    stop = startLayoutPersistence();

    bridge.resolveGet({ activePhase: "review", layouts: { review: helpOnly } });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().activePhase).toBe("review"));

    expect(placedPanels(useWorkspaceStore.getState().layout)).toEqual(["help"]);
  });

  it("keeps an early edit and still loads every other stored phase", async () => {
    const bridge = installBridge();
    stop = startLayoutPersistence();

    useWorkspaceStore.getState().closeGroup(timelineGroupId());
    bridge.resolveGet({ activePhase: "cut", layouts: { cut: helpOnly, review: helpOnly } });

    await vi.waitFor(() =>
      expect(placedPanels(useWorkspaceStore.getState().layouts.review)).toEqual(["help"]));
    expect(placedPanels(useWorkspaceStore.getState().layouts.cut)).not.toContain("timeline");
    expect(placedPanels(useWorkspaceStore.getState().layouts.cut)).toContain("preview");
    const update = bridge.calls.find(({ method }) => method === "update");
    expect(Object.keys(update?.params["layouts"] as object)).toEqual(["cut"]);
  });

  it("never sends untouched phases when loading fails", async () => {
    const bridge = installBridge();
    stop = startLayoutPersistence();

    bridge.rejectGet(new Error("EACCES"));
    await Promise.resolve();
    useWorkspaceStore.getState().setPhase("review");

    const updates = bridge.calls.filter(({ method }) => method === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.params["layouts"]).toEqual({});
  });

  it("applies other windows' changes and ignores its own echo", async () => {
    const bridge = installBridge();
    stop = startLayoutPersistence();
    bridge.resolveGet(null);
    await Promise.resolve();
    useWorkspaceStore.getState().setPhase("cut");
    const ownClient = bridge.calls.find(({ method }) => method === "update")!.params["clientId"];

    bridge.emit({ kind: "workspace.layout", clientId: ownClient, document: { layouts: { cut: helpOnly } } });
    expect(placedPanels(useWorkspaceStore.getState().layout)).toContain("preview");

    bridge.emit({ kind: "workspace.layout", clientId: "other", document: { layouts: { cut: helpOnly } } });
    expect(placedPanels(useWorkspaceStore.getState().layout)).toEqual(["help"]);
  });
});
