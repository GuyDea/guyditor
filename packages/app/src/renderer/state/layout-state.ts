/** Per-project layout documents from before the free-form layout; read only by onboarding. */
export const LAYOUT_STORAGE_KEY = "guyditor/layout/v2";
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
  "assemble",
] as const;

export type DockPanelId = typeof DOCK_PANEL_IDS[number];
