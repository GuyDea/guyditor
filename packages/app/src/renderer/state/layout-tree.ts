import { DOCK_PANEL_IDS, WORKFLOW_PHASES } from "./layout-state.js";
import type { DockPanelId, WorkflowPhase } from "./layout-state.js";
import { presetLayout } from "./layout-presets.js";

/** `row` lays children side by side; `column` stacks them. */
export type SplitDirection = "row" | "column";

export interface LayoutGroup {
  kind: "group";
  id: string;
  panelIds: DockPanelId[];
  activePanelId: DockPanelId;
}

export interface LayoutSplit {
  kind: "split";
  id: string;
  direction: SplitDirection;
  children: LayoutNode[];
  /** Fractions of the split's extent, one per child, summing to 1. */
  sizes: number[];
}

export type LayoutNode = LayoutGroup | LayoutSplit;

export interface PhaseLayout {
  root: LayoutNode | null;
}

export interface LayoutsDocument {
  activePhase: WorkflowPhase;
  layouts: Record<WorkflowPhase, PhaseLayout>;
}

export const MIN_GROUP_PX = 120;

export function newNodeId(prefix: "g" | "s"): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function groups(node: LayoutNode | null): LayoutGroup[] {
  if (node === null) return [];
  return node.kind === "group" ? [node] : node.children.flatMap(groups);
}

export function groupOf(layout: PhaseLayout, panelId: DockPanelId): LayoutGroup | null {
  return groups(layout.root).find((group) => group.panelIds.includes(panelId)) ?? null;
}

export function findGroup(layout: PhaseLayout, groupId: string): LayoutGroup | null {
  return groups(layout.root).find((group) => group.id === groupId) ?? null;
}

export function firstGroup(layout: PhaseLayout): LayoutGroup | null {
  return groups(layout.root)[0] ?? null;
}

export function placedPanels(layout: PhaseLayout): DockPanelId[] {
  return groups(layout.root).flatMap((group) => group.panelIds);
}

function normalizedSizes(sizes: readonly number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 0 ? sizes.map((size) => size / total) : sizes.map(() => 1 / sizes.length);
}

/** Rebuilds the tree bottom-up; `visit` may replace a group or drop it (null). */
function rewriteGroups(
  node: LayoutNode | null,
  visit: (group: LayoutGroup) => LayoutNode | null,
): LayoutNode | null {
  if (node === null) return null;
  if (node.kind === "group") return visit(node);
  const kept: { child: LayoutNode; size: number }[] = [];
  node.children.forEach((child, index) => {
    const next = rewriteGroups(child, visit);
    if (next !== null) kept.push({ child: next, size: node.sizes[index] ?? 0 });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!.child;
  return {
    ...node,
    children: kept.map(({ child }) => child),
    sizes: normalizedSizes(kept.map(({ size }) => size)),
  };
}

function updateGroup(
  layout: PhaseLayout,
  groupId: string,
  update: (group: LayoutGroup) => LayoutNode | null,
): PhaseLayout {
  return {
    root: rewriteGroups(layout.root, (group) => group.id === groupId ? update(group) : group),
  };
}

function rootGroup(panelId: DockPanelId): PhaseLayout {
  return {
    root: { kind: "group", id: newNodeId("g"), panelIds: [panelId], activePanelId: panelId },
  };
}

export function splitGroup(
  layout: PhaseLayout,
  groupId: string,
  side: "right" | "down",
  panelId: DockPanelId,
): PhaseLayout {
  if (groupOf(layout, panelId) !== null || findGroup(layout, groupId) === null) return layout;
  const direction: SplitDirection = side === "right" ? "row" : "column";
  const added: LayoutGroup = {
    kind: "group",
    id: newNodeId("g"),
    panelIds: [panelId],
    activePanelId: panelId,
  };
  const insert = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") {
      return node.id === groupId
        ? { kind: "split", id: newNodeId("s"), direction, children: [node, added], sizes: [0.5, 0.5] }
        : node;
    }
    const index = node.children.findIndex((child) =>
      child.kind === "group" && child.id === groupId);
    if (index >= 0 && node.direction === direction) {
      const half = node.sizes[index]! / 2;
      return {
        ...node,
        children: [...node.children.slice(0, index + 1), added, ...node.children.slice(index + 1)],
        sizes: [...node.sizes.slice(0, index), half, half, ...node.sizes.slice(index + 1)],
      };
    }
    return { ...node, children: node.children.map(insert) };
  };
  return { root: layout.root === null ? null : insert(layout.root) };
}

function withoutPanel(layout: PhaseLayout, panelId: DockPanelId): PhaseLayout {
  const source = groupOf(layout, panelId);
  if (source === null) return layout;
  return updateGroup(layout, source.id, (group) => {
    const index = group.panelIds.indexOf(panelId);
    const panelIds = group.panelIds.filter((id) => id !== panelId);
    if (panelIds.length === 0) return null;
    const activePanelId = group.activePanelId === panelId
      ? panelIds[index - 1] ?? panelIds[index]!
      : group.activePanelId;
    return { ...group, panelIds, activePanelId };
  });
}

export function moveTab(
  layout: PhaseLayout,
  panelId: DockPanelId,
  targetGroupId: string,
  index?: number,
): PhaseLayout {
  if (findGroup(layout, targetGroupId) === null) return layout;
  const removed = withoutPanel(layout, panelId);
  return updateGroup(removed, targetGroupId, (group) => {
    const at = Math.min(Math.max(0, index ?? group.panelIds.length), group.panelIds.length);
    return {
      ...group,
      panelIds: [...group.panelIds.slice(0, at), panelId, ...group.panelIds.slice(at)],
      activePanelId: panelId,
    };
  });
}

export function addTab(
  layout: PhaseLayout,
  groupId: string | null,
  panelId: DockPanelId,
): PhaseLayout {
  const target = (groupId === null ? null : findGroup(layout, groupId)) ?? firstGroup(layout);
  if (target === null) return rootGroup(panelId);
  if (target.panelIds.includes(panelId)) return activateTab(layout, panelId);
  return moveTab(layout, panelId, target.id);
}

export function activateTab(layout: PhaseLayout, panelId: DockPanelId): PhaseLayout {
  const group = groupOf(layout, panelId);
  if (group === null || group.activePanelId === panelId) return layout;
  return updateGroup(layout, group.id, (found) => ({ ...found, activePanelId: panelId }));
}

export function closeTab(layout: PhaseLayout, panelId: DockPanelId): PhaseLayout {
  return withoutPanel(layout, panelId);
}

export function closeGroup(layout: PhaseLayout, groupId: string): PhaseLayout {
  return updateGroup(layout, groupId, () => null);
}

export function resizeSplit(
  layout: PhaseLayout,
  splitId: string,
  dividerIndex: number,
  delta: number,
  containerPx: number,
): PhaseLayout {
  const resize = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") return node;
    if (node.id !== splitId) return { ...node, children: node.children.map(resize) };
    const before = node.sizes[dividerIndex];
    const after = node.sizes[dividerIndex + 1];
    if (before === undefined || after === undefined || containerPx <= 0) return node;
    const pair = before + after;
    const minimum = MIN_GROUP_PX / containerPx;
    if (pair < minimum * 2) return node;
    const next = Math.min(pair - minimum, Math.max(minimum, before + delta / containerPx));
    const sizes = [...node.sizes];
    sizes[dividerIndex] = next;
    sizes[dividerIndex + 1] = pair - next;
    return { ...node, sizes };
  };
  return { root: layout.root === null ? null : resize(layout.root) };
}

export function revealInLayout(
  layout: PhaseLayout,
  panelId: DockPanelId,
  focusedGroupId: string | null,
): { layout: PhaseLayout; added: boolean } {
  if (groupOf(layout, panelId) !== null) {
    return { layout: activateTab(layout, panelId), added: false };
  }
  return { layout: addTab(layout, focusedGroupId, panelId), added: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDockPanelId(value: unknown): value is DockPanelId {
  return typeof value === "string" && (DOCK_PANEL_IDS as readonly string[]).includes(value);
}

class InvalidLayout extends Error {}

function normalizeNode(value: unknown, seen: Set<DockPanelId>): LayoutNode | null {
  if (!isRecord(value)) throw new InvalidLayout();
  const id = typeof value["id"] === "string" && value["id"].length > 0 ? value["id"] : null;
  if (value["kind"] === "group") {
    if (!Array.isArray(value["panelIds"])) throw new InvalidLayout();
    const panelIds = value["panelIds"].filter((panelId): panelId is DockPanelId => {
      if (!isDockPanelId(panelId) || seen.has(panelId)) return false;
      seen.add(panelId);
      return true;
    });
    if (panelIds.length === 0) return null;
    const active = value["activePanelId"];
    return {
      kind: "group",
      id: id ?? newNodeId("g"),
      panelIds,
      activePanelId: isDockPanelId(active) && panelIds.includes(active) ? active : panelIds[0]!,
    };
  }
  if (value["kind"] === "split") {
    const direction = value["direction"];
    const children = value["children"];
    if ((direction !== "row" && direction !== "column") || !Array.isArray(children)) {
      throw new InvalidLayout();
    }
    const rawSizes = value["sizes"];
    const sizes = Array.isArray(rawSizes) && rawSizes.length === children.length &&
      rawSizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)
      ? rawSizes as number[]
      : children.map(() => 1);
    const kept: { child: LayoutNode; size: number }[] = [];
    children.forEach((child, index) => {
      const next = normalizeNode(child, seen);
      if (next !== null) kept.push({ child: next, size: sizes[index]! });
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!.child;
    return {
      kind: "split",
      id: id ?? newNodeId("s"),
      direction,
      children: kept.map(({ child }) => child),
      sizes: normalizedSizes(kept.map(({ size }) => size)),
    };
  }
  throw new InvalidLayout();
}

export function normalizeLayout(value: unknown): PhaseLayout | null {
  if (!isRecord(value) || !("root" in value)) return null;
  if (value["root"] === null) return { root: null };
  try {
    return { root: normalizeNode(value["root"], new Set()) };
  } catch (error: unknown) {
    if (error instanceof InvalidLayout) return null;
    throw error;
  }
}

function isWorkflowPhase(value: unknown): value is WorkflowPhase {
  return typeof value === "string" && (WORKFLOW_PHASES as readonly string[]).includes(value);
}

export function normalizeLayoutsDocument(value: unknown): LayoutsDocument {
  const stored = isRecord(value) ? value : {};
  const layouts = isRecord(stored["layouts"]) ? stored["layouts"] : {};
  return {
    activePhase: isWorkflowPhase(stored["activePhase"]) ? stored["activePhase"] : "cut",
    layouts: Object.fromEntries(WORKFLOW_PHASES.map((phase) => [
      phase,
      normalizeLayout(layouts[phase]) ?? presetLayout(phase),
    ])) as Record<WorkflowPhase, PhaseLayout>,
  };
}
