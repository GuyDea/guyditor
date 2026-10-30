import { describe, expect, it } from "vitest";

import { DOCK_PANEL_IDS } from "./layout-state.js";
import { presetLayouts } from "./layout-presets.js";
import { PANEL_LABELS, TOOL_RAIL_GROUPS, toolRailPanelState } from "./tool-rail.js";

describe("master tool rail state", () => {
  it("maps every registered panel to exactly one group", () => {
    const grouped = TOOL_RAIL_GROUPS.flatMap(({ panelIds }) => panelIds);

    expect(grouped).toHaveLength(DOCK_PANEL_IDS.length);
    expect(new Set(grouped).size).toBe(DOCK_PANEL_IDS.length);
    expect([...grouped].sort()).toEqual([...DOCK_PANEL_IDS].sort());
  });

  it("registers the Assemble panel", () => {
    expect(PANEL_LABELS.assemble.name).toBe("Assemble");
  });

  it("derives here, other-phase, and absent states", () => {
    const { layouts } = presetLayouts();

    expect(toolRailPanelState(layouts, "cut", "preview")).toBe("here");
    expect(toolRailPanelState(layouts, "cut", "media")).toBe("other-phase");
    expect(toolRailPanelState(layouts, "cut", "help")).toBe("absent");
  });
});
