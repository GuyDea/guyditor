import { describe, expect, it } from "vitest";

import { WORKFLOW_PHASES } from "./layout-state.js";
import type { DockPanelId } from "./layout-state.js";
import { presetLayout, presetLayouts } from "./layout-presets.js";
import {
  addTab,
  closeGroup,
  closeTab,
  firstGroup,
  groupOf,
  MIN_GROUP_PX,
  moveTab,
  normalizeLayout,
  normalizeLayoutsDocument,
  placedPanels,
  resizeSplit,
  revealInLayout,
  splitGroup,
} from "./layout-tree.js";
import type { LayoutGroup, LayoutNode, LayoutSplit, PhaseLayout } from "./layout-tree.js";

type Shape = DockPanelId[] | { row: Shape[] } | { column: Shape[] };

function shape(node: LayoutNode | null): Shape | null {
  if (node === null) return null;
  if (node.kind === "group") return [...node.panelIds];
  const children = node.children.map((child) => shape(child) as Shape);
  return node.direction === "row" ? { row: children } : { column: children };
}

function group(panelIds: DockPanelId[], id = `g_${panelIds.join("_")}`): LayoutGroup {
  return { kind: "group", id, panelIds, activePanelId: panelIds[0]! };
}

function split(
  direction: "row" | "column",
  children: LayoutNode[],
  sizes: number[],
  id = "s_test",
): LayoutSplit {
  return { kind: "split", id, direction, children, sizes };
}

function single(panelId: DockPanelId): PhaseLayout {
  return { root: group([panelId]) };
}

function rootSplit(layout: PhaseLayout): LayoutSplit {
  if (layout.root?.kind !== "split") throw new Error("Expected a split root.");
  return layout.root;
}

describe("splitGroup", () => {
  it("splits a lone group right into an even row", () => {
    const next = splitGroup(single("preview"), "g_preview", "right", "agent");

    expect(shape(next.root)).toEqual({ row: [["preview"], ["agent"]] });
    expect(rootSplit(next).sizes).toEqual([0.5, 0.5]);
  });

  it("splits down into a column", () => {
    const next = splitGroup(single("preview"), "g_preview", "down", "timeline");

    expect(shape(next.root)).toEqual({ column: [["preview"], ["timeline"]] });
  });

  it("inserts a sibling when the parent already runs in the split direction", () => {
    const layout = {
      root: split("row", [group(["media"]), group(["preview"])], [0.5, 0.5]),
    };

    const next = splitGroup(layout, "g_preview", "right", "agent");

    expect(shape(next.root)).toEqual({ row: [["media"], ["preview"], ["agent"]] });
    expect(rootSplit(next).sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it("refuses to place a panel that is already in the layout", () => {
    const layout = {
      root: split("row", [group(["media"]), group(["preview"])], [0.5, 0.5]),
    };

    const next = splitGroup(layout, "g_preview", "down", "media");

    expect(shape(next.root)).toEqual(shape(layout.root));
  });
});

describe("addTab and moveTab", () => {
  it("moves a panel placed elsewhere instead of duplicating it", () => {
    const layout = {
      root: split("row", [group(["media"]), group(["preview", "agent"])], [0.5, 0.5]),
    };

    const next = addTab(layout, "g_media", "agent");

    expect(shape(next.root)).toEqual({ row: [["media", "agent"], ["preview"]] });
    expect(groupOf(next, "agent")?.activePanelId).toBe("agent");
  });

  it("closes the source group when its last tab moves away", () => {
    const layout = {
      root: split("row", [group(["media"]), group(["preview"])], [0.3, 0.7]),
    };

    const next = moveTab(layout, "media", "g_preview", 0);

    expect(shape(next.root)).toEqual(["media", "preview"]);
    expect(placedPanels(next)).toEqual(["media", "preview"]);
  });

  it("keeps a lone tab dropped back onto its own tab strip", () => {
    const layout = {
      root: split("column", [group(["preview"]), group(["timeline"])], [0.8, 0.2]),
    };

    const next = moveTab(layout, "timeline", "g_timeline", 0);

    expect(shape(next.root)).toEqual({ column: [["preview"], ["timeline"]] });
  });

  it("reorders tabs within one group", () => {
    const layout = { root: group(["agent", "assemble", "inspector"], "g_right") };

    const next = moveTab(layout, "inspector", "g_right", 0);

    expect(shape(next.root)).toEqual(["inspector", "agent", "assemble"]);
    expect(firstGroup(next)?.activePanelId).toBe("inspector");
  });

  it("falls back to the first group for an unknown target", () => {
    const next = addTab(single("preview"), "g_gone", "agent");

    expect(shape(next.root)).toEqual(["preview", "agent"]);
  });

  it("creates a root group in an empty layout", () => {
    expect(shape(addTab({ root: null }, null, "agent").root)).toEqual(["agent"]);
  });
});

describe("closeGroup and closeTab", () => {
  it("lets siblings absorb the freed space proportionally", () => {
    const layout = {
      root: split(
        "row",
        [group(["media"]), group(["preview"]), group(["agent"])],
        [0.2, 0.6, 0.2],
      ),
    };

    const next = closeGroup(layout, "g_preview");

    expect(shape(next.root)).toEqual({ row: [["media"], ["agent"]] });
    expect(rootSplit(next).sizes).toEqual([0.5, 0.5]);
  });

  it("collapses a split left with one child", () => {
    const layout = {
      root: split("column", [
        split("row", [group(["preview"]), group(["agent"])], [0.5, 0.5], "s_inner"),
        group(["timeline"]),
      ], [0.8, 0.2]),
    };

    const next = closeGroup(layout, "g_agent");

    expect(shape(next.root)).toEqual({ column: [["preview"], ["timeline"]] });
    expect(rootSplit(next).sizes).toEqual([0.8, 0.2]);
  });

  it("empties the workspace when the only group closes", () => {
    expect(closeGroup(single("preview"), "g_preview").root).toBeNull();
  });

  it("activates the neighbouring tab when the active tab closes", () => {
    const layout = { root: group(["agent", "assemble"]) };

    const next = closeTab(layout, "agent");

    expect(shape(next.root)).toEqual(["assemble"]);
    expect(firstGroup(next)?.activePanelId).toBe("assemble");
  });
});

describe("resizeSplit", () => {
  it("never shrinks a child below the minimum group size", () => {
    const layout = {
      root: split("row", [group(["media"]), group(["preview"])], [0.5, 0.5]),
    };

    const next = resizeSplit(layout, "s_test", 0, -900, 1000);
    const sizes = rootSplit(next).sizes;

    expect(MIN_GROUP_PX).toBe(120);
    expect(sizes[0]).toBeCloseTo(0.12);
    expect(sizes[0]! + sizes[1]!).toBeCloseTo(1);
  });

  it("moves the divider by the given pixels", () => {
    const layout = {
      root: split("row", [group(["media"]), group(["preview"])], [0.5, 0.5]),
    };

    const sizes = rootSplit(resizeSplit(layout, "s_test", 0, 100, 1000)).sizes;

    expect(sizes[0]).toBeCloseTo(0.6);
    expect(sizes[1]).toBeCloseTo(0.4);
  });
});

describe("revealInLayout", () => {
  it("activates a panel that is already placed", () => {
    const layout = { root: group(["agent", "assemble"]) };

    const result = revealInLayout(layout, "assemble", null);

    expect(result.added).toBe(false);
    expect(firstGroup(result.layout)?.activePanelId).toBe("assemble");
  });

  it("adds to the first group when the focused group no longer exists", () => {
    const layout = {
      root: split("row", [group(["media"]), group(["preview"])], [0.5, 0.5]),
    };

    const result = revealInLayout(layout, "inspector", "g_closed");

    expect(result.added).toBe(true);
    expect(shape(result.layout.root)).toEqual({ row: [["media", "inspector"], ["preview"]] });
  });

  it("adds to the focused group", () => {
    const layout = {
      root: split("row", [group(["media"]), group(["preview"])], [0.5, 0.5]),
    };

    const result = revealInLayout(layout, "inspector", "g_preview");

    expect(groupOf(result.layout, "inspector")?.id).toBe("g_preview");
  });

  it("becomes the root group of an empty workspace", () => {
    const result = revealInLayout({ root: null }, "help", null);

    expect(shape(result.layout.root)).toEqual(["help"]);
  });
});

describe("normalizeLayout", () => {
  it("drops duplicate and unknown panels, empty groups and one-child splits", () => {
    const stored = {
      root: {
        kind: "split",
        id: "s_a",
        direction: "row",
        sizes: [2, 1, 1],
        children: [
          { kind: "group", id: "g_a", panelIds: ["preview", "bogus"], activePanelId: "bogus" },
          { kind: "group", id: "g_b", panelIds: ["preview"], activePanelId: "preview" },
          { kind: "group", id: "g_c", panelIds: ["agent"], activePanelId: "agent" },
        ],
      },
    };

    const layout = normalizeLayout(stored);

    expect(shape(layout?.root ?? null)).toEqual({ row: [["preview"], ["agent"]] });
    expect(firstGroup(layout!)?.activePanelId).toBe("preview");
    const sizes = rootSplit(layout!).sizes;
    expect(sizes[0]! + sizes[1]!).toBeCloseTo(1);
    expect(sizes[0]).toBeCloseTo(2 / 3);
  });

  it("accepts an empty workspace", () => {
    expect(normalizeLayout({ root: null })).toEqual({ root: null });
  });

  it("rejects a pathologically deep tree instead of overflowing the stack", () => {
    let node: unknown = { kind: "group", id: "g_leaf", panelIds: ["preview"], activePanelId: "preview" };
    for (let depth = 0; depth < 20_000; depth += 1) {
      node = { kind: "split", id: `s_${String(depth)}`, direction: "row", sizes: [1], children: [node] };
    }

    expect(normalizeLayout({ root: node })).toBeNull();
  });

  it("rejects values that are not layouts", () => {
    expect(normalizeLayout(42)).toBeNull();
    expect(normalizeLayout({ root: { kind: "window" } })).toBeNull();
  });
});

describe("normalizeLayoutsDocument", () => {
  it("falls back to the preset only for the phase whose stored layout is invalid", () => {
    const polish = { root: group(["graphics", "preview"]) };

    const document = normalizeLayoutsDocument({
      activePhase: "polish",
      layouts: { cut: 42, polish },
    });

    expect(document.activePhase).toBe("polish");
    expect(shape(document.layouts.cut.root)).toEqual(shape(presetLayout("cut").root));
    expect(shape(document.layouts.polish.root)).toEqual(["graphics", "preview"]);
  });

  it("defaults the active phase to cut", () => {
    expect(normalizeLayoutsDocument({ activePhase: "nope" }).activePhase).toBe("cut");
    expect(normalizeLayoutsDocument(null).activePhase).toBe("cut");
  });
});

describe("presets", () => {
  it.each(WORKFLOW_PHASES)("%s preset is already normalized and unique", (phase) => {
    const preset = presetLayout(phase);
    const panels = placedPanels(preset);

    expect(shape(normalizeLayout(preset)?.root ?? null)).toEqual(shape(preset.root));
    expect(new Set(panels).size).toBe(panels.length);
    expect(panels.length).toBeGreaterThan(0);
  });

  it("matches the agreed Cut arrangement", () => {
    expect(shape(presetLayout("cut").root)).toEqual({
      column: [
        { row: [{ column: [["preview"], ["transcript"]] }, ["agent", "assemble"]] },
        ["timeline"],
      ],
    });
  });

  it("returns every phase from presetLayouts", () => {
    const document = presetLayouts("review");

    expect(document.activePhase).toBe("review");
    expect(Object.keys(document.layouts).sort()).toEqual([...WORKFLOW_PHASES].sort());
  });
});
