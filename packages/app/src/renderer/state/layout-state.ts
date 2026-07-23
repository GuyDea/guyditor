export const LAYOUT_SCHEMA = "layout/v1" as const;
export const LAYOUT_STORAGE_KEY = "guyditor/layout/v1";

export const DOCK_PANEL_IDS = [
  "media",
  "preview",
  "transcript",
  "inspector",
  "agent",
  "timeline",
  "status",
] as const;

export type DockPanelId = typeof DOCK_PANEL_IDS[number];

export const DOCK_REGION_IDS = [
  "left",
  "center-top",
  "center-bottom",
  "right-top",
  "right-bottom",
  "bottom-timeline",
  "bottom-status",
] as const;

export type DockRegionId = typeof DOCK_REGION_IDS[number];

export const SPLITTER_IDS = [
  "left",
  "right",
  "center-horizontal",
  "right-horizontal",
  "timeline",
  "status",
] as const;

export type SplitterId = typeof SPLITTER_IDS[number];

export interface LayoutRegion {
  panelIds: DockPanelId[];
  activePanelId: DockPanelId | null;
}

export interface SplitterPositions {
  left: number;
  right: number;
  "center-horizontal": number;
  "right-horizontal": number;
  timeline: number;
  status: number;
}

export interface WorkspaceLayout {
  schema: typeof LAYOUT_SCHEMA;
  regions: Record<DockRegionId, LayoutRegion>;
  splitters: SplitterPositions;
  collapsed: Record<DockPanelId, boolean>;
}

interface PersistedLayoutDocument {
  schema: typeof LAYOUT_SCHEMA;
  projects: Record<string, WorkspaceLayout>;
}

type LayoutStorage = Pick<Storage, "getItem" | "setItem">;

const SPLITTER_LIMITS: Record<SplitterId, readonly [number, number]> = {
  left: [220, 420],
  right: [280, 520],
  "center-horizontal": [0.25, 0.75],
  "right-horizontal": [0.25, 0.75],
  timeline: [112, 360],
  status: [112, 220],
};

export function splitterRange(splitter: SplitterId): readonly [number, number] {
  return SPLITTER_LIMITS[splitter];
}

function createCollapsedState(): Record<DockPanelId, boolean> {
  return {
    media: false,
    preview: false,
    transcript: false,
    inspector: false,
    agent: false,
    timeline: false,
    status: false,
  };
}

export function createDefaultLayout(): WorkspaceLayout {
  return {
    schema: LAYOUT_SCHEMA,
    regions: {
      left: { panelIds: ["media"], activePanelId: "media" },
      "center-top": { panelIds: ["preview"], activePanelId: "preview" },
      "center-bottom": { panelIds: ["transcript"], activePanelId: "transcript" },
      "right-top": { panelIds: ["agent"], activePanelId: "agent" },
      "right-bottom": { panelIds: ["inspector"], activePanelId: "inspector" },
      "bottom-timeline": { panelIds: ["timeline"], activePanelId: "timeline" },
      "bottom-status": { panelIds: ["status"], activePanelId: "status" },
    },
    splitters: {
      left: 250,
      right: 310,
      "center-horizontal": 0.58,
      "right-horizontal": 0.56,
      timeline: 170,
      status: 132,
    },
    collapsed: createCollapsedState(),
  };
}

export function clampSplitterValue(splitter: SplitterId, value: number): number {
  const [minimum, maximum] = SPLITTER_LIMITS[splitter];
  if (!Number.isFinite(value)) return createDefaultLayout().splitters[splitter];
  return Math.min(maximum, Math.max(minimum, value));
}

function cloneLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return {
    schema: LAYOUT_SCHEMA,
    regions: {
      left: { ...layout.regions.left, panelIds: [...layout.regions.left.panelIds] },
      "center-top": {
        ...layout.regions["center-top"],
        panelIds: [...layout.regions["center-top"].panelIds],
      },
      "center-bottom": {
        ...layout.regions["center-bottom"],
        panelIds: [...layout.regions["center-bottom"].panelIds],
      },
      "right-top": {
        ...layout.regions["right-top"],
        panelIds: [...layout.regions["right-top"].panelIds],
      },
      "right-bottom": {
        ...layout.regions["right-bottom"],
        panelIds: [...layout.regions["right-bottom"].panelIds],
      },
      "bottom-timeline": {
        ...layout.regions["bottom-timeline"],
        panelIds: [...layout.regions["bottom-timeline"].panelIds],
      },
      "bottom-status": {
        ...layout.regions["bottom-status"],
        panelIds: [...layout.regions["bottom-status"].panelIds],
      },
    },
    splitters: { ...layout.splitters },
    collapsed: { ...layout.collapsed },
  };
}

function activeAfterRemoval(region: LayoutRegion, removed: DockPanelId): DockPanelId | null {
  const remaining = region.panelIds.filter((panelId) => panelId !== removed);
  if (remaining.length === 0) return null;
  return region.activePanelId === removed
    ? remaining[0] ?? null
    : region.activePanelId;
}

export function assignPanel(
  layout: WorkspaceLayout,
  panelId: DockPanelId,
  targetRegionId: DockRegionId,
  targetIndex?: number,
): WorkspaceLayout {
  const next = cloneLayout(layout);
  for (const regionId of DOCK_REGION_IDS) {
    const region = next.regions[regionId];
    const activePanelId = activeAfterRemoval(region, panelId);
    region.panelIds = region.panelIds.filter((candidate) => candidate !== panelId);
    region.activePanelId = activePanelId;
  }
  const target = next.regions[targetRegionId];
  const insertionIndex = Math.min(
    target.panelIds.length,
    Math.max(0, targetIndex ?? target.panelIds.length),
  );
  target.panelIds.splice(insertionIndex, 0, panelId);
  target.activePanelId = panelId;
  return next;
}

export function reorderPanel(
  layout: WorkspaceLayout,
  regionId: DockRegionId,
  panelId: DockPanelId,
  targetIndex: number,
): WorkspaceLayout {
  if (!layout.regions[regionId].panelIds.includes(panelId)) return cloneLayout(layout);
  return assignPanel(layout, panelId, regionId, targetIndex);
}

export function activatePanel(
  layout: WorkspaceLayout,
  regionId: DockRegionId,
  panelId: DockPanelId,
): WorkspaceLayout {
  const next = cloneLayout(layout);
  if (next.regions[regionId].panelIds.includes(panelId)) {
    next.regions[regionId].activePanelId = panelId;
  }
  return next;
}

export function setCollapsed(
  layout: WorkspaceLayout,
  panelId: DockPanelId,
  collapsed: boolean,
): WorkspaceLayout {
  const next = cloneLayout(layout);
  next.collapsed[panelId] = collapsed;
  return next;
}

export function setSplitter(
  layout: WorkspaceLayout,
  splitter: SplitterId,
  value: number,
): WorkspaceLayout {
  const next = cloneLayout(layout);
  next.splitters[splitter] = clampSplitterValue(splitter, value);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDockPanelId(value: unknown): value is DockPanelId {
  return typeof value === "string" &&
    (DOCK_PANEL_IDS as readonly string[]).includes(value);
}

function isRegion(value: unknown): value is LayoutRegion {
  if (!isRecord(value) || !Array.isArray(value.panelIds)) return false;
  if (!value.panelIds.every(isDockPanelId)) return false;
  return value.activePanelId === null ||
    isDockPanelId(value.activePanelId) && value.panelIds.includes(value.activePanelId);
}

function isWorkspaceLayout(value: unknown): value is WorkspaceLayout {
  if (!isRecord(value) || value.schema !== LAYOUT_SCHEMA) return false;
  if (!isRecord(value.regions) || !isRecord(value.splitters) || !isRecord(value.collapsed)) {
    return false;
  }
  const regions = value.regions;
  const splitters = value.splitters;
  const collapsed = value.collapsed;
  if (!DOCK_REGION_IDS.every((regionId) => isRegion(regions[regionId]))) return false;
  const panels = DOCK_REGION_IDS.flatMap((regionId) => {
    const region = regions[regionId];
    return isRegion(region) ? region.panelIds : [];
  });
  if (panels.length !== DOCK_PANEL_IDS.length ||
    new Set(panels).size !== DOCK_PANEL_IDS.length ||
    !DOCK_PANEL_IDS.every((panelId) => panels.includes(panelId))) {
    return false;
  }
  if (!SPLITTER_IDS.every((splitter) =>
    typeof splitters[splitter] === "number" &&
    Number.isFinite(splitters[splitter]))) {
    return false;
  }
  return DOCK_PANEL_IDS.every((panelId) => typeof collapsed[panelId] === "boolean");
}

export function parseLayout(value: unknown): WorkspaceLayout {
  if (!isWorkspaceLayout(value)) return createDefaultLayout();
  const next = cloneLayout(value);
  for (const splitter of SPLITTER_IDS) {
    next.splitters[splitter] = clampSplitterValue(splitter, next.splitters[splitter]);
  }
  return next;
}

function parseDocument(serialized: string | null): PersistedLayoutDocument | null {
  if (serialized === null) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value) || value.schema !== LAYOUT_SCHEMA || !isRecord(value.projects)) {
      return null;
    }
    const projects: Record<string, WorkspaceLayout> = {};
    for (const [projectKey, projectLayout] of Object.entries(value.projects)) {
      if (isWorkspaceLayout(projectLayout)) projects[projectKey] = parseLayout(projectLayout);
    }
    return { schema: LAYOUT_SCHEMA, projects };
  } catch {
    return null;
  }
}

export function loadProjectLayout(
  projectKey: string,
  storage: LayoutStorage,
): WorkspaceLayout {
  const document = parseDocument(storage.getItem(LAYOUT_STORAGE_KEY));
  return parseLayout(document?.projects[projectKey]);
}

export function saveProjectLayout(
  projectKey: string,
  layout: WorkspaceLayout,
  storage: LayoutStorage,
): void {
  const current = parseDocument(storage.getItem(LAYOUT_STORAGE_KEY));
  const document: PersistedLayoutDocument = {
    schema: LAYOUT_SCHEMA,
    projects: {
      ...(current?.projects ?? {}),
      [projectKey]: parseLayout(layout),
    },
  };
  storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(document));
}
