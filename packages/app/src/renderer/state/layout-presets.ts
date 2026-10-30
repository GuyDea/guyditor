import { WORKFLOW_PHASES } from "./layout-state.js";
import type { DockPanelId, WorkflowPhase } from "./layout-state.js";
import { newNodeId } from "./layout-tree.js";
import type {
  LayoutGroup,
  LayoutNode,
  LayoutsDocument,
  PhaseLayout,
  SplitDirection,
} from "./layout-tree.js";

function tabs(...panelIds: [DockPanelId, ...DockPanelId[]]): LayoutGroup {
  return { kind: "group", id: newNodeId("g"), panelIds, activePanelId: panelIds[0] };
}

function split(direction: SplitDirection, sizes: number[], ...children: LayoutNode[]): LayoutNode {
  return { kind: "split", id: newNodeId("s"), direction, children, sizes };
}

const PRESETS: Record<WorkflowPhase, () => LayoutNode> = {
  ingest: () => split("column", [0.82, 0.18],
    split("row", [0.2, 0.6, 0.2], tabs("media"), tabs("storage"), tabs("assemble")),
    tabs("status")),
  cut: () => split("column", [0.82, 0.18],
    split("row", [0.8, 0.2],
      split("column", [0.58, 0.42], tabs("preview"), tabs("transcript")),
      tabs("agent", "assemble")),
    tabs("timeline")),
  polish: () => split("row", [0.19, 0.61, 0.2],
    tabs("graphics"),
    split("column", [0.62, 0.38], tabs("preview"), tabs("transcript")),
    split("column", [0.52, 0.48], tabs("agent"), tabs("inspector"))),
  review: () => split("row", [0.18, 0.6, 0.22], tabs("media"), tabs("preview"), tabs("agent")),
  publish: () => split("column", [0.78, 0.22], tabs("publish"), tabs("status")),
};

/** A fresh copy (new node ids) of the phase's shipped layout. */
export function presetLayout(phase: WorkflowPhase): PhaseLayout {
  return { root: PRESETS[phase]() };
}

export function presetLayouts(activePhase: WorkflowPhase = "cut"): LayoutsDocument {
  return {
    activePhase,
    layouts: Object.fromEntries(
      WORKFLOW_PHASES.map((phase) => [phase, presetLayout(phase)]),
    ) as Record<WorkflowPhase, PhaseLayout>,
  };
}
