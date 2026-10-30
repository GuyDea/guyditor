import { useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import { panelHelpKey } from "./help/help-texts.js";
import {
  DOCK_PANEL_IDS,
  splitterRange,
} from "./state/layout-state.js";
import type {
  DockPanelId,
  DockRegionId,
  SplitterId,
} from "./state/layout-state.js";
import { PANEL_LABELS } from "./state/tool-rail.js";
import { useWorkspaceStore } from "./state/view-state.js";

const PANEL_DRAG_MIME = "application/x-guyditor-panel";

function isDockPanelId(value: string): value is DockPanelId {
  return (DOCK_PANEL_IDS as readonly string[]).includes(value);
}

export function beginPanelDrag(event: DragEvent<HTMLElement>, panelId: DockPanelId): void {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(PANEL_DRAG_MIME, panelId);
  event.dataTransfer.setData("text/plain", panelId);
}

function draggedPanel(event: DragEvent<HTMLElement>): DockPanelId | null {
  const value = event.dataTransfer.getData(PANEL_DRAG_MIME) ||
    event.dataTransfer.getData("text/plain");
  return isDockPanelId(value) ? value : null;
}

interface DockRegionProps {
  regionId: DockRegionId;
  panels: Record<DockPanelId, ReactNode>;
}

function DockRegion({ regionId, panels }: DockRegionProps): React.JSX.Element {
  const region = useWorkspaceStore((state) => state.layout.regions[regionId]);
  const railCollapsed = useWorkspaceStore((state) => state.layout.railCollapsed);
  const assignPanel = useWorkspaceStore((state) => state.assignPanel);
  const activatePanel = useWorkspaceStore((state) => state.activatePanel);
  const togglePanel = useWorkspaceStore((state) => state.togglePanel);
  const [dropActive, setDropActive] = useState(false);
  const expandedPanelIds = region.panelIds.filter((panelId) => !railCollapsed[panelId]);
  const activePanelId = region.activePanelId !== null &&
    expandedPanelIds.includes(region.activePanelId)
    ? region.activePanelId
    : expandedPanelIds[0] ?? null;

  const receiveDrop = (
    event: DragEvent<HTMLElement>,
    targetIndex?: number,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    const panelId = draggedPanel(event);
    if (panelId !== null) assignPanel(panelId, regionId, targetIndex);
  };

  return (
    <section
      className="dock-region"
      data-testid={`dock-region-${regionId}`}
      data-region={regionId}
      data-active-panel={activePanelId ?? ""}
      data-drop-active={dropActive}
      onDragEnter={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropActive(false);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => receiveDrop(event)}
    >
      {region.panelIds.length > 1 ? (
        <div
          className="dock-tabs"
          role="tablist"
          aria-label={`${regionId} panels`}
          data-testid={`dock-tabs-${regionId}`}
        >
          {region.panelIds.map((panelId, index) => {
            const label = PANEL_LABELS[panelId];
            return (
              <button
                type="button"
                role="tab"
                draggable
                aria-selected={activePanelId === panelId}
                className="dock-tab"
                data-collapsed={railCollapsed[panelId]}
                data-testid={`dock-tab-${panelId}`}
                data-help={panelHelpKey(panelId)}
                key={panelId}
                title={label.name}
                onClick={() => {
                  if (railCollapsed[panelId]) togglePanel(panelId);
                  activatePanel(regionId, panelId);
                }}
                onDragStart={(event) => beginPanelDrag(event, panelId)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => receiveDrop(event, index)}
              >
                <span aria-hidden="true">{label.icon}</span>
                {label.name}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="dock-panel-stage">
        {activePanelId === null ? (
          <div className="empty-dock-target">
            <span>Drop a panel here</span>
          </div>
        ) : panels[activePanelId]}
      </div>
    </section>
  );
}

interface SplitterProps {
  splitterId: SplitterId;
  orientation: "vertical" | "horizontal";
}

function Splitter({ splitterId, orientation }: SplitterProps): React.JSX.Element {
  const value = useWorkspaceStore((state) => state.layout.splitters[splitterId]);
  const setSplitter = useWorkspaceStore((state) => state.setSplitter);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startValue: number;
    denominator: number;
  } | null>(null);
  const [minimum, maximum] = splitterRange(splitterId);

  const adjustedValue = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const current = drag.current;
    if (current === null) return value;
    const deltaX = event.clientX - current.startX;
    const deltaY = event.clientY - current.startY;
    if (splitterId === "left") return current.startValue + deltaX;
    if (splitterId === "right") return current.startValue - deltaX;
    if (splitterId === "center-horizontal" || splitterId === "right-horizontal") {
      return current.startValue + deltaY / current.denominator;
    }
    return current.startValue - deltaY;
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    setSplitter(splitterId, adjustedValue(event));
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className={`workspace-splitter splitter-${splitterId}`}
      role="separator"
      tabIndex={0}
      aria-label={`${splitterId.replaceAll("-", " ")} splitter`}
      aria-orientation={orientation}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      data-testid={`splitter-${splitterId}`}
      data-splitter-value={String(value)}
      onDoubleClick={() => {
        const defaults: Record<SplitterId, number> = {
          left: 250,
          right: 310,
          "center-horizontal": 0.58,
          "right-horizontal": 0.56,
          timeline: 170,
          status: 132,
        };
        setSplitter(splitterId, defaults[splitterId]);
      }}
      onKeyDown={(event) => {
        const smallStep = splitterId.includes("horizontal") ? 0.02 : 10;
        const decrease = orientation === "vertical" ? "ArrowLeft" : "ArrowDown";
        const increase = orientation === "vertical" ? "ArrowRight" : "ArrowUp";
        if (event.key === decrease || event.key === increase) {
          event.preventDefault();
          setSplitter(splitterId, value + (event.key === increase ? smallStep : -smallStep));
        } else if (event.key === "Home") {
          event.preventDefault();
          setSplitter(splitterId, minimum);
        } else if (event.key === "End") {
          event.preventDefault();
          setSplitter(splitterId, maximum);
        }
      }}
      onPointerDown={(event) => {
        const parentHeight = event.currentTarget.parentElement?.getBoundingClientRect().height ?? 1;
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startValue: value,
          denominator: Math.max(1, parentHeight),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId) {
          setSplitter(splitterId, adjustedValue(event), false);
        }
      }}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
    >
      <span aria-hidden="true" />
    </div>
  );
}

interface DockWorkspaceProps {
  panels: Record<DockPanelId, ReactNode>;
}

export function DockWorkspace({
  panels,
}: DockWorkspaceProps): React.JSX.Element {
  const layout = useWorkspaceStore((state) => state.layout);
  const activePhase = useWorkspaceStore((state) => state.activePhase);
  const leftCollapsed = layout.regions.left.panelIds.every(
    (panelId) => layout.railCollapsed[panelId],
  );
  const rightCollapsed = [
    ...layout.regions["right-top"].panelIds,
    ...layout.regions["right-bottom"].panelIds,
  ].every((panelId) => layout.railCollapsed[panelId]);
  const timelineCollapsed = layout.regions["bottom-timeline"].panelIds.every(
    (panelId) => layout.railCollapsed[panelId],
  );
  const statusCollapsed = layout.regions["bottom-status"].panelIds.every(
    (panelId) => layout.railCollapsed[panelId],
  );
  const style = {
    "--left-width": `${String(leftCollapsed ? 46 : layout.splitters.left)}px`,
    "--right-width": `${String(rightCollapsed ? 46 : layout.splitters.right)}px`,
    "--panel-left-width": `${String(layout.splitters.left)}px`,
    "--panel-right-width": `${String(layout.splitters.right)}px`,
    "--center-top": `${String(layout.splitters["center-horizontal"])}fr`,
    "--center-bottom": `${String(1 - layout.splitters["center-horizontal"])}fr`,
    "--right-top": `${String(layout.splitters["right-horizontal"])}fr`,
    "--right-bottom": `${String(1 - layout.splitters["right-horizontal"])}fr`,
    "--timeline-height": `${String(timelineCollapsed ? 31 : layout.splitters.timeline)}px`,
    "--status-height": `${String(statusCollapsed ? 31 : layout.splitters.status)}px`,
  } as CSSProperties;

  return (
    <div
      className="workspace-layout"
      id="workspace-layout"
      data-testid="workspace-layout"
      data-phase={activePhase}
      style={style}
    >
      <div className="left-dock-column">
        <DockRegion regionId="left" panels={panels} />
        <div className="utility-panel-stack" data-testid="left-utility-panels" />
      </div>
      <Splitter splitterId="left" orientation="vertical" />
      <div className="center-dock-stack">
        <DockRegion regionId="center-top" panels={panels} />
        <Splitter splitterId="center-horizontal" orientation="horizontal" />
        <DockRegion regionId="center-bottom" panels={panels} />
      </div>
      <Splitter splitterId="right" orientation="vertical" />
      <div className="right-dock-stack">
        <DockRegion regionId="right-top" panels={panels} />
        <Splitter splitterId="right-horizontal" orientation="horizontal" />
        <div className="right-bottom-dock">
          <DockRegion regionId="right-bottom" panels={panels} />
          <div className="utility-panel-stack" data-testid="right-utility-panels" />
        </div>
      </div>
      <Splitter splitterId="timeline" orientation="horizontal" />
      <DockRegion regionId="bottom-timeline" panels={panels} />
      <Splitter splitterId="status" orientation="horizontal" />
      <DockRegion regionId="bottom-status" panels={panels} />
    </div>
  );
}
