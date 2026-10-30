import { WORKFLOW_PHASES } from "./layout-state.js";
import type { DockPanelId, WorkflowPhase } from "./layout-state.js";
import { groupOf } from "./layout-tree.js";
import type { PhaseLayout } from "./layout-tree.js";

export type ToolRailGroupId = WorkflowPhase | "system";
export type ToolRailPanelState = "here" | "other-phase" | "absent";

export interface ToolRailGroup {
  id: ToolRailGroupId;
  label: string;
  panelIds: readonly DockPanelId[];
}

export const TOOL_RAIL_GROUPS: readonly ToolRailGroup[] = [
  { id: "ingest", label: "Ingest", panelIds: ["media", "broll"] },
  { id: "cut", label: "Cut", panelIds: ["transcript", "assemble", "timeline"] },
  { id: "polish", label: "Polish", panelIds: ["preview", "graphics", "skills"] },
  { id: "review", label: "Review", panelIds: ["agent"] },
  { id: "publish", label: "Publish", panelIds: ["status", "publish"] },
  { id: "system", label: "System", panelIds: ["help", "storage", "inspector"] },
] as const;

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
  assemble: { icon: "A", name: "Assemble" },
};

export function toolRailPanelState(
  layouts: Record<WorkflowPhase, PhaseLayout>,
  activePhase: WorkflowPhase,
  panelId: DockPanelId,
): ToolRailPanelState {
  if (groupOf(layouts[activePhase], panelId) !== null) return "here";
  return WORKFLOW_PHASES.some((phase) =>
    phase !== activePhase && groupOf(layouts[phase], panelId) !== null)
    ? "other-phase"
    : "absent";
}
