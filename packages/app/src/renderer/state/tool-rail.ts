import {
  activatePanel,
  assignPanel,
  DOCK_REGION_IDS,
  setRailCollapsed,
  WORKFLOW_PHASES,
} from "./layout-state.js";
import type {
  DockPanelId,
  DockRegionId,
  WorkflowPhase,
  WorkspaceLayout,
} from "./layout-state.js";

export type ToolRailGroupId = WorkflowPhase | "system";
export type ToolRailPanelState =
  | "expanded-here"
  | "collapsed"
  | "in-another-tab-only";

export interface ToolRailGroup {
  id: ToolRailGroupId;
  label: string;
  panelIds: readonly DockPanelId[];
}

export const TOOL_RAIL_GROUPS: readonly ToolRailGroup[] = [
  { id: "ingest", label: "Ingest", panelIds: ["media", "broll"] },
  { id: "cut", label: "Cut", panelIds: ["transcript", "timeline"] },
  { id: "polish", label: "Polish", panelIds: ["preview", "graphics", "skills"] },
  { id: "review", label: "Review", panelIds: ["agent"] },
  { id: "publish", label: "Publish", panelIds: ["status", "publish"] },
  { id: "system", label: "System", panelIds: ["help", "storage", "inspector"] },
] as const;

export const PANEL_HOME_REGIONS: Record<DockPanelId, DockRegionId> = {
  media: "left",
  preview: "center-top",
  transcript: "center-bottom",
  inspector: "right-bottom",
  agent: "right-top",
  timeline: "bottom-timeline",
  status: "bottom-status",
  graphics: "left",
  publish: "center-top",
  skills: "center-bottom",
  broll: "left",
  storage: "center-top",
  help: "right-bottom",
};

export const PANEL_LABELS: Record<DockPanelId, { icon: string; name: string }> = {
  media: { icon: "M", name: "Media" },
  preview: { icon: "P", name: "Preview" },
  transcript: { icon: "T", name: "Transcript" },
  inspector: { icon: "I", name: "Inspector" },
  agent: { icon: "A", name: "Agent" },
  timeline: { icon: "L", name: "Timeline" },
  status: { icon: "S", name: "Status" },
  graphics: { icon: "G", name: "Graphics" },
  publish: { icon: "U", name: "Publish" },
  skills: { icon: "K", name: "Skills" },
  broll: { icon: "B", name: "B-roll" },
  storage: { icon: "D", name: "Storage" },
  help: { icon: "?", name: "Help" },
};

export function panelRegion(
  layout: WorkspaceLayout,
  panelId: DockPanelId,
): DockRegionId | null {
  return DOCK_REGION_IDS.find((regionId) =>
    layout.regions[regionId].panelIds.includes(panelId)) ?? null;
}

export function toolRailPanelState(
  layouts: Record<WorkflowPhase, WorkspaceLayout>,
  activePhase: WorkflowPhase,
  panelId: DockPanelId,
): ToolRailPanelState {
  const current = layouts[activePhase];
  if (panelRegion(current, panelId) !== null) {
    return current.railCollapsed[panelId] ? "collapsed" : "expanded-here";
  }
  return WORKFLOW_PHASES.some((phase) =>
    phase !== activePhase && panelRegion(layouts[phase], panelId) !== null)
    ? "in-another-tab-only"
    : "collapsed";
}

export function togglePanelFromRail(
  layout: WorkspaceLayout,
  panelId: DockPanelId,
): { layout: WorkspaceLayout; expanded: boolean } {
  const assignedRegion = panelRegion(layout, panelId);
  if (assignedRegion !== null && !layout.railCollapsed[panelId]) {
    return {
      layout: setRailCollapsed(layout, panelId, true),
      expanded: false,
    };
  }
  const targetRegion = assignedRegion ?? PANEL_HOME_REGIONS[panelId];
  const assigned = assignedRegion === null
    ? assignPanel(layout, panelId, targetRegion)
    : layout;
  return {
    layout: activatePanel(
      setRailCollapsed(assigned, panelId, false),
      targetRegion,
      panelId,
    ),
    expanded: true,
  };
}
