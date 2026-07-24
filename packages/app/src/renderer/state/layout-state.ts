export const LAYOUT_SCHEMA = "layout/v2" as const;
export const LAYOUT_STORAGE_KEY = "guyditor/layout/v2";
export const LEGACY_LAYOUT_SCHEMA = "layout/v1" as const;
export const LEGACY_LAYOUT_STORAGE_KEY = "guyditor/layout/v1";

export const WORKFLOW_PHASES = [
  "ingest",
  "cut",
  "polish",
  "review",
  "publish",
] as const;

export type WorkflowPhase = typeof WORKFLOW_PHASES[number];

export const DOCK_PANEL_IDS = [
  "media",
  "preview",
  "transcript",
  "inspector",
  "agent",
  "timeline",
  "status",
  "graphics",
  "publish",
  "skills",
  "broll",
  "storage",
  "help",
] as const;

export type DockPanelId = typeof DOCK_PANEL_IDS[number];

const PRE_ONBOARDING_DOCK_PANEL_IDS = [
  "media",
  "preview",
  "transcript",
  "inspector",
  "agent",
  "timeline",
  "status",
  "graphics",
  "publish",
  "skills",
  "broll",
  "storage",
] as const;

type PreOnboardingDockPanelId = typeof PRE_ONBOARDING_DOCK_PANEL_IDS[number];

const LEGACY_DOCK_PANEL_IDS = [
  "media",
  "preview",
  "transcript",
  "inspector",
  "agent",
  "timeline",
  "status",
] as const;

type LegacyDockPanelId = typeof LEGACY_DOCK_PANEL_IDS[number];

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
  railCollapsed: Record<DockPanelId, boolean>;
}

export interface WorkflowLayouts {
  schema: typeof LAYOUT_SCHEMA;
  activePhase: WorkflowPhase;
  layouts: Record<WorkflowPhase, WorkspaceLayout>;
}

interface PersistedLayoutDocument {
  schema: typeof LAYOUT_SCHEMA;
  projects: Record<string, WorkflowLayouts>;
}

interface CollapsedWorkspaceLayout {
  schema: typeof LAYOUT_SCHEMA;
  regions: Record<DockRegionId, LayoutRegion>;
  splitters: SplitterPositions;
  collapsed: Record<DockPanelId, boolean>;
}

interface PreOnboardingLayoutRegion {
  panelIds: PreOnboardingDockPanelId[];
  activePanelId: PreOnboardingDockPanelId | null;
}

interface PreOnboardingWorkspaceLayout {
  schema: typeof LAYOUT_SCHEMA;
  regions: Record<DockRegionId, PreOnboardingLayoutRegion>;
  splitters: SplitterPositions;
  collapsed: Record<PreOnboardingDockPanelId, boolean>;
}

interface LegacyLayoutRegion {
  panelIds: LegacyDockPanelId[];
  activePanelId: LegacyDockPanelId | null;
}

interface LegacyWorkspaceLayout {
  schema: typeof LEGACY_LAYOUT_SCHEMA;
  regions: Record<DockRegionId, LegacyLayoutRegion>;
  splitters: SplitterPositions;
  collapsed: Record<LegacyDockPanelId, boolean>;
}

interface LegacyPersistedLayoutDocument {
  schema: typeof LEGACY_LAYOUT_SCHEMA;
  projects: Record<string, LegacyWorkspaceLayout>;
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

const DEFAULT_SPLITTERS: Record<WorkflowPhase, SplitterPositions> = {
  ingest: {
    left: 330,
    right: 300,
    "center-horizontal": 0.62,
    "right-horizontal": 0.56,
    timeline: 132,
    status: 180,
  },
  cut: {
    left: 250,
    right: 310,
    "center-horizontal": 0.58,
    "right-horizontal": 0.56,
    timeline: 170,
    status: 132,
  },
  polish: {
    left: 320,
    right: 340,
    "center-horizontal": 0.62,
    "right-horizontal": 0.52,
    timeline: 150,
    status: 112,
  },
  review: {
    left: 300,
    right: 380,
    "center-horizontal": 0.64,
    "right-horizontal": 0.62,
    timeline: 130,
    status: 112,
  },
  publish: {
    left: 220,
    right: 280,
    "center-horizontal": 0.68,
    "right-horizontal": 0.56,
    timeline: 112,
    status: 210,
  },
};

const PANEL_PLACEMENTS: Record<
  WorkflowPhase,
  Record<DockRegionId, readonly DockPanelId[]>
> = {
  ingest: {
    left: ["media"],
    "center-top": ["storage"],
    "center-bottom": [],
    "right-top": [],
    "right-bottom": [],
    "bottom-timeline": [],
    "bottom-status": ["status"],
  },
  cut: {
    left: [],
    "center-top": ["preview"],
    "center-bottom": ["transcript"],
    "right-top": ["agent"],
    "right-bottom": [],
    "bottom-timeline": ["timeline"],
    "bottom-status": [],
  },
  polish: {
    left: ["graphics"],
    "center-top": ["preview"],
    "center-bottom": ["transcript"],
    "right-top": ["agent"],
    "right-bottom": ["inspector"],
    "bottom-timeline": [],
    "bottom-status": [],
  },
  review: {
    left: ["media"],
    "center-top": ["preview"],
    "center-bottom": [],
    "right-top": ["agent"],
    "right-bottom": [],
    "bottom-timeline": [],
    "bottom-status": [],
  },
  publish: {
    left: [],
    "center-top": ["publish"],
    "center-bottom": [],
    "right-top": [],
    "right-bottom": [],
    "bottom-timeline": [],
    "bottom-status": ["status"],
  },
};

export function splitterRange(splitter: SplitterId): readonly [number, number] {
  return SPLITTER_LIMITS[splitter];
}

function createRailCollapsedState(): Record<DockPanelId, boolean> {
  return Object.fromEntries(
    DOCK_PANEL_IDS.map((panelId) => [panelId, panelId === "help"]),
  ) as Record<DockPanelId, boolean>;
}

export function createDefaultLayout(phase: WorkflowPhase = "cut"): WorkspaceLayout {
  const placements = PANEL_PLACEMENTS[phase];
  return {
    schema: LAYOUT_SCHEMA,
    regions: Object.fromEntries(DOCK_REGION_IDS.map((regionId) => {
      const panelIds = [...placements[regionId]];
      return [regionId, { panelIds, activePanelId: panelIds[0] ?? null }];
    })) as Record<DockRegionId, LayoutRegion>,
    splitters: { ...DEFAULT_SPLITTERS[phase] },
    railCollapsed: createRailCollapsedState(),
  };
}

export function createDefaultLayouts(activePhase: WorkflowPhase = "cut"): WorkflowLayouts {
  return {
    schema: LAYOUT_SCHEMA,
    activePhase,
    layouts: Object.fromEntries(
      WORKFLOW_PHASES.map((phase) => [phase, createDefaultLayout(phase)]),
    ) as Record<WorkflowPhase, WorkspaceLayout>,
  };
}

export function clampSplitterValue(splitter: SplitterId, value: number): number {
  const [minimum, maximum] = SPLITTER_LIMITS[splitter];
  if (!Number.isFinite(value)) return DEFAULT_SPLITTERS.cut[splitter];
  return Math.min(maximum, Math.max(minimum, value));
}

function cloneLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return {
    schema: LAYOUT_SCHEMA,
    regions: Object.fromEntries(DOCK_REGION_IDS.map((regionId) => [
      regionId,
      {
        ...layout.regions[regionId],
        panelIds: [...layout.regions[regionId].panelIds],
      },
    ])) as Record<DockRegionId, LayoutRegion>,
    splitters: { ...layout.splitters },
    railCollapsed: { ...layout.railCollapsed },
  };
}

function cloneLayouts(layouts: WorkflowLayouts): WorkflowLayouts {
  return {
    schema: LAYOUT_SCHEMA,
    activePhase: layouts.activePhase,
    layouts: Object.fromEntries(WORKFLOW_PHASES.map((phase) => [
      phase,
      cloneLayout(layouts.layouts[phase]),
    ])) as Record<WorkflowPhase, WorkspaceLayout>,
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

export function setRailCollapsed(
  layout: WorkspaceLayout,
  panelId: DockPanelId,
  collapsed: boolean,
): WorkspaceLayout {
  const next = cloneLayout(layout);
  next.railCollapsed[panelId] = collapsed;
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

function isWorkflowPhase(value: unknown): value is WorkflowPhase {
  return typeof value === "string" &&
    (WORKFLOW_PHASES as readonly string[]).includes(value);
}

function isDockPanelId(value: unknown): value is DockPanelId {
  return typeof value === "string" &&
    (DOCK_PANEL_IDS as readonly string[]).includes(value);
}

function isPreOnboardingDockPanelId(value: unknown): value is PreOnboardingDockPanelId {
  return typeof value === "string" &&
    (PRE_ONBOARDING_DOCK_PANEL_IDS as readonly string[]).includes(value);
}

function isLegacyDockPanelId(value: unknown): value is LegacyDockPanelId {
  return typeof value === "string" &&
    (LEGACY_DOCK_PANEL_IDS as readonly string[]).includes(value);
}

function isRegion(value: unknown): value is LayoutRegion {
  if (!isRecord(value) || !Array.isArray(value.panelIds)) return false;
  if (!value.panelIds.every(isDockPanelId)) return false;
  return value.activePanelId === null ||
    isDockPanelId(value.activePanelId) && value.panelIds.includes(value.activePanelId);
}

function isPreOnboardingRegion(value: unknown): value is PreOnboardingLayoutRegion {
  if (!isRecord(value) || !Array.isArray(value.panelIds)) return false;
  if (!value.panelIds.every(isPreOnboardingDockPanelId)) return false;
  return value.activePanelId === null ||
    isPreOnboardingDockPanelId(value.activePanelId) &&
      value.panelIds.includes(value.activePanelId);
}

function isLegacyRegion(value: unknown): value is LegacyLayoutRegion {
  if (!isRecord(value) || !Array.isArray(value.panelIds)) return false;
  if (!value.panelIds.every(isLegacyDockPanelId)) return false;
  return value.activePanelId === null ||
    isLegacyDockPanelId(value.activePanelId) && value.panelIds.includes(value.activePanelId);
}

function hasValidSplitters(value: Record<string, unknown>): boolean {
  return SPLITTER_IDS.every((splitter) =>
    typeof value[splitter] === "number" && Number.isFinite(value[splitter]));
}

function isWorkspaceLayout(value: unknown): value is WorkspaceLayout {
  if (!isRecord(value) || value.schema !== LAYOUT_SCHEMA) return false;
  if (!isRecord(value.regions) || !isRecord(value.splitters) ||
    !isRecord(value.railCollapsed)) {
    return false;
  }
  const regions = value.regions;
  const splitters = value.splitters;
  const railCollapsed = value.railCollapsed;
  if (!DOCK_REGION_IDS.every((regionId) => isRegion(regions[regionId]))) return false;
  const panels = DOCK_REGION_IDS.flatMap((regionId) => {
    const region = regions[regionId];
    return isRegion(region) ? region.panelIds : [];
  });
  if (new Set(panels).size !== panels.length) return false;
  if (!hasValidSplitters(splitters)) return false;
  return DOCK_PANEL_IDS.every(
    (panelId) => typeof railCollapsed[panelId] === "boolean",
  );
}

function isCollapsedWorkspaceLayout(
  value: unknown,
): value is CollapsedWorkspaceLayout {
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
  if (new Set(panels).size !== panels.length) return false;
  if (!hasValidSplitters(splitters)) return false;
  return DOCK_PANEL_IDS.every((panelId) => typeof collapsed[panelId] === "boolean");
}

function isPreOnboardingWorkspaceLayout(
  value: unknown,
): value is PreOnboardingWorkspaceLayout {
  if (!isRecord(value) || value.schema !== LAYOUT_SCHEMA) return false;
  if (!isRecord(value.regions) || !isRecord(value.splitters) || !isRecord(value.collapsed)) {
    return false;
  }
  const regions = value.regions;
  const splitters = value.splitters;
  const collapsed = value.collapsed;
  if (!DOCK_REGION_IDS.every((regionId) => isPreOnboardingRegion(regions[regionId]))) {
    return false;
  }
  const panels = DOCK_REGION_IDS.flatMap((regionId) => {
    const region = regions[regionId];
    return isPreOnboardingRegion(region) ? region.panelIds : [];
  });
  if (panels.length !== PRE_ONBOARDING_DOCK_PANEL_IDS.length ||
    new Set(panels).size !== PRE_ONBOARDING_DOCK_PANEL_IDS.length ||
    !PRE_ONBOARDING_DOCK_PANEL_IDS.every((panelId) => panels.includes(panelId))) {
    return false;
  }
  if (!hasValidSplitters(splitters)) return false;
  return PRE_ONBOARDING_DOCK_PANEL_IDS.every(
    (panelId) => typeof collapsed[panelId] === "boolean",
  );
}

function isLegacyWorkspaceLayout(value: unknown): value is LegacyWorkspaceLayout {
  if (!isRecord(value) || value.schema !== LEGACY_LAYOUT_SCHEMA) return false;
  if (!isRecord(value.regions) || !isRecord(value.splitters) || !isRecord(value.collapsed)) {
    return false;
  }
  const regions = value.regions;
  const splitters = value.splitters;
  const collapsed = value.collapsed;
  if (!DOCK_REGION_IDS.every((regionId) => isLegacyRegion(regions[regionId]))) {
    return false;
  }
  const panels = DOCK_REGION_IDS.flatMap((regionId) => {
    const region = regions[regionId];
    return isLegacyRegion(region) ? region.panelIds : [];
  });
  if (panels.length !== LEGACY_DOCK_PANEL_IDS.length ||
    new Set(panels).size !== LEGACY_DOCK_PANEL_IDS.length ||
    !LEGACY_DOCK_PANEL_IDS.every((panelId) => panels.includes(panelId))) {
    return false;
  }
  if (!hasValidSplitters(splitters)) return false;
  return LEGACY_DOCK_PANEL_IDS.every(
    (panelId) => typeof collapsed[panelId] === "boolean",
  );
}

export function parseLayout(
  value: unknown,
  fallbackPhase: WorkflowPhase = "cut",
): WorkspaceLayout {
  if (isPreOnboardingWorkspaceLayout(value)) {
    return migratePreOnboardingLayout(value, fallbackPhase);
  }
  if (isCollapsedWorkspaceLayout(value)) {
    return migrateCollapsedLayout(value);
  }
  if (!isWorkspaceLayout(value)) return createDefaultLayout(fallbackPhase);
  const next = cloneLayout(value);
  for (const splitter of SPLITTER_IDS) {
    next.splitters[splitter] = clampSplitterValue(splitter, next.splitters[splitter]);
  }
  return next;
}

function parseWorkflowLayouts(value: unknown): WorkflowLayouts | null {
  if (!isRecord(value) || value.schema !== LAYOUT_SCHEMA ||
    !isWorkflowPhase(value.activePhase) || !isRecord(value.layouts)) {
    return null;
  }
  const layouts = value.layouts;
  if (!WORKFLOW_PHASES.every((phase) =>
    isWorkspaceLayout(layouts[phase]) ||
    isCollapsedWorkspaceLayout(layouts[phase]) ||
    isPreOnboardingWorkspaceLayout(layouts[phase]))) {
    return null;
  }
  return {
    schema: LAYOUT_SCHEMA,
    activePhase: value.activePhase,
    layouts: Object.fromEntries(WORKFLOW_PHASES.map((phase) => [
      phase,
      parseLayout(layouts[phase], phase),
    ])) as Record<WorkflowPhase, WorkspaceLayout>,
  };
}

function migrateCollapsedLayout(
  previous: CollapsedWorkspaceLayout,
): WorkspaceLayout {
  const splitters = { ...previous.splitters };
  for (const splitter of SPLITTER_IDS) {
    splitters[splitter] = clampSplitterValue(splitter, splitters[splitter]);
  }
  return {
    schema: LAYOUT_SCHEMA,
    regions: Object.fromEntries(DOCK_REGION_IDS.map((regionId) => [
      regionId,
      {
        panelIds: [...previous.regions[regionId].panelIds],
        activePanelId: previous.regions[regionId].activePanelId,
      },
    ])) as Record<DockRegionId, LayoutRegion>,
    splitters,
    railCollapsed: { ...previous.collapsed },
  };
}

function migratePreOnboardingLayout(
  previous: PreOnboardingWorkspaceLayout,
  phase: WorkflowPhase,
): WorkspaceLayout {
  const migrated = createDefaultLayout(phase);
  for (const regionId of DOCK_REGION_IDS) {
    migrated.regions[regionId] = {
      panelIds: [
        ...previous.regions[regionId].panelIds,
        ...(regionId === "right-bottom" ? ["help" as const] : []),
      ],
      activePanelId: previous.regions[regionId].activePanelId,
    };
  }
  for (const splitter of SPLITTER_IDS) {
    migrated.splitters[splitter] = clampSplitterValue(splitter, previous.splitters[splitter]);
  }
  for (const panelId of PRE_ONBOARDING_DOCK_PANEL_IDS) {
    migrated.railCollapsed[panelId] = previous.collapsed[panelId];
  }
  migrated.railCollapsed.help = true;
  return migrated;
}

function parseDocument(serialized: string | null): PersistedLayoutDocument | null {
  if (serialized === null) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value) || value.schema !== LAYOUT_SCHEMA || !isRecord(value.projects)) {
      return null;
    }
    const projects: Record<string, WorkflowLayouts> = {};
    for (const [projectKey, projectLayouts] of Object.entries(value.projects)) {
      const parsed = parseWorkflowLayouts(projectLayouts);
      if (parsed !== null) projects[projectKey] = parsed;
    }
    return { schema: LAYOUT_SCHEMA, projects };
  } catch {
    return null;
  }
}

function parseLegacyDocument(
  serialized: string | null,
): LegacyPersistedLayoutDocument | null {
  if (serialized === null) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value) || value.schema !== LEGACY_LAYOUT_SCHEMA ||
      !isRecord(value.projects)) {
      return null;
    }
    const projects: Record<string, LegacyWorkspaceLayout> = {};
    for (const [projectKey, projectLayout] of Object.entries(value.projects)) {
      if (isLegacyWorkspaceLayout(projectLayout)) projects[projectKey] = projectLayout;
    }
    return { schema: LEGACY_LAYOUT_SCHEMA, projects };
  } catch {
    return null;
  }
}

function migrateLegacyLayout(legacy: LegacyWorkspaceLayout): WorkspaceLayout {
  const migrated = createDefaultLayout("cut");
  const legacyPanels = new Set<string>(LEGACY_DOCK_PANEL_IDS);
  for (const regionId of DOCK_REGION_IDS) {
    const utilityPanels = migrated.regions[regionId].panelIds.filter(
      (panelId) => !legacyPanels.has(panelId),
    );
    migrated.regions[regionId] = {
      panelIds: [...legacy.regions[regionId].panelIds, ...utilityPanels],
      activePanelId: legacy.regions[regionId].activePanelId,
    };
  }
  for (const splitter of SPLITTER_IDS) {
    migrated.splitters[splitter] = clampSplitterValue(splitter, legacy.splitters[splitter]);
  }
  for (const panelId of LEGACY_DOCK_PANEL_IDS) {
    migrated.railCollapsed[panelId] = legacy.collapsed[panelId];
  }
  return migrated;
}

export function loadProjectLayouts(
  projectKey: string,
  storage: LayoutStorage,
): WorkflowLayouts {
  const document = parseDocument(storage.getItem(LAYOUT_STORAGE_KEY));
  const persisted = document?.projects[projectKey];
  if (persisted !== undefined) return cloneLayouts(persisted);

  const legacyDocument = parseLegacyDocument(storage.getItem(LEGACY_LAYOUT_STORAGE_KEY));
  const legacy = legacyDocument?.projects[projectKey];
  if (legacy === undefined) return createDefaultLayouts();
  const migrated = createDefaultLayouts();
  migrated.layouts.cut = migrateLegacyLayout(legacy);
  return migrated;
}

export function saveProjectLayouts(
  projectKey: string,
  layouts: WorkflowLayouts,
  storage: LayoutStorage,
): void {
  const current = parseDocument(storage.getItem(LAYOUT_STORAGE_KEY));
  const parsed = parseWorkflowLayouts(layouts) ?? createDefaultLayouts();
  const document: PersistedLayoutDocument = {
    schema: LAYOUT_SCHEMA,
    projects: {
      ...(current?.projects ?? {}),
      [projectKey]: parsed,
    },
  };
  storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(document));
}
