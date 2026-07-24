import { describe, expect, it } from "vitest";

import {
  createDefaultLayouts,
  DOCK_PANEL_IDS,
  LAYOUT_STORAGE_KEY,
  loadProjectLayouts,
} from "./layout-state.js";
import {
  PANEL_HOME_REGIONS,
  TOOL_RAIL_GROUPS,
  toolRailPanelState,
  togglePanelFromRail,
} from "./tool-rail.js";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("master tool rail state", () => {
  it("maps every registered panel to exactly one group and one home region", () => {
    const grouped = TOOL_RAIL_GROUPS.flatMap(({ panelIds }) => panelIds);

    expect(grouped).toHaveLength(DOCK_PANEL_IDS.length);
    expect(new Set(grouped).size).toBe(DOCK_PANEL_IDS.length);
    expect([...grouped].sort()).toEqual([...DOCK_PANEL_IDS].sort());
    expect(Object.keys(PANEL_HOME_REGIONS).sort()).toEqual([...DOCK_PANEL_IDS].sort());
  });

  it("derives expanded-here, collapsed, and in-another-tab-only states", () => {
    const layouts = createDefaultLayouts();

    expect(toolRailPanelState(layouts.layouts, "cut", "preview")).toBe("expanded-here");
    expect(toolRailPanelState(layouts.layouts, "cut", "help")).toBe("collapsed");
    expect(toolRailPanelState(layouts.layouts, "cut", "media"))
      .toBe("in-another-tab-only");
  });

  it("collapses an expanded panel without losing its assigned region", () => {
    const layouts = createDefaultLayouts();
    const current = layouts.layouts.cut;

    const { layout: next, expanded } = togglePanelFromRail(current, "preview");

    expect(next.railCollapsed.preview).toBe(true);
    expect(next.regions["center-top"].panelIds).toContain("preview");
    expect(expanded).toBe(false);
  });

  it("expands an absent panel in its home region and makes it active", () => {
    const layouts = createDefaultLayouts();
    const current = layouts.layouts.cut;

    const { layout: next, expanded } = togglePanelFromRail(current, "media");

    expect(next.railCollapsed.media).toBe(false);
    expect(next.regions.left.panelIds).toContain("media");
    expect(next.regions.left.activePanelId).toBe("media");
    expect(expanded).toBe(true);
  });

  it("migrates layout/v2 collapsed flags to railCollapsed without data loss", () => {
    const previous = structuredClone(createDefaultLayouts()) as unknown as {
      activePhase: string;
      layouts: Record<string, {
        collapsed?: Record<string, boolean>;
        railCollapsed?: Record<string, boolean>;
        regions: Record<string, { activePanelId: string | null; panelIds: string[] }>;
        schema: string;
        splitters: Record<string, number>;
      }>;
      schema: string;
    };
    for (const layout of Object.values(previous.layouts)) {
      layout.collapsed = { ...layout.railCollapsed };
      delete layout.railCollapsed;
    }
    previous.layouts.cut!.collapsed!.preview = true;
    previous.layouts.cut!.splitters.left = 377;
    const expectedRegions = Object.fromEntries(Object.entries(previous.layouts).map(
      ([phase, layout]) => [phase, structuredClone(layout.regions)],
    ));
    const expectedCollapsed = Object.fromEntries(Object.entries(previous.layouts).map(
      ([phase, layout]) => [phase, structuredClone(layout.collapsed)],
    ));
    const expectedSplitters = Object.fromEntries(Object.entries(previous.layouts).map(
      ([phase, layout]) => [phase, structuredClone(layout.splitters)],
    ));
    const storage = memoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        schema: "layout/v2",
        projects: { "/project": previous },
      }),
    });

    const migrated = loadProjectLayouts("/project", storage);

    for (const [phase, layout] of Object.entries(migrated.layouts)) {
      expect(layout.regions).toEqual(expectedRegions[phase]);
      expect(layout.railCollapsed).toEqual(expectedCollapsed[phase]);
      expect(layout.splitters).toEqual(expectedSplitters[phase]);
      expect("collapsed" in layout).toBe(false);
    }
    expect(migrated.layouts.cut.railCollapsed.preview).toBe(true);
    expect(migrated.layouts.cut.splitters.left).toBe(377);
  });
});
