import { createContext, Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import { PanelPicker } from "./PanelPicker.js";
import { DOCK_PANEL_IDS } from "./state/layout-state.js";
import type { DockPanelId } from "./state/layout-state.js";
import { placedPanels } from "./state/layout-tree.js";
import type { LayoutGroup, LayoutNode, LayoutSplit } from "./state/layout-tree.js";
import { PANEL_LABELS } from "./state/tool-rail.js";
import { useWorkspaceStore } from "./state/view-state.js";

const PANEL_DRAG_MIME = "application/x-guyditor-panel";

/**
 * Where a panel portals its header actions. `undefined` means the panel is rendered
 * outside a dock group (tests, server render) and draws them inline instead.
 */
export const PanelActionsSlot = createContext<HTMLElement | null | undefined>(undefined);

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

type Panels = Record<DockPanelId, ReactNode>;

function usePlacedPanels(): DockPanelId[] {
  const layout = useWorkspaceStore((state) => state.layout);
  return placedPanels(layout);
}

function GroupMenu({ group, onClose }: { group: LayoutGroup; onClose: () => void }): React.JSX.Element {
  const openPicker = useWorkspaceStore((state) => state.openPicker);
  const closeGroup = useWorkspaceStore((state) => state.closeGroup);
  const item = (testId: string, label: string, run: () => void): React.JSX.Element => (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={() => {
        onClose();
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="dock-group-menu" role="menu" data-testid="group-menu-list">
      {item("group-menu-split-right", "Split right", () =>
        openPicker({ mode: "split", groupId: group.id, side: "right" }))}
      {item("group-menu-split-down", "Split down", () =>
        openPicker({ mode: "split", groupId: group.id, side: "down" }))}
      {item("group-menu-add-tab", "Add tab…", () =>
        openPicker({ mode: "add-tab", groupId: group.id }))}
      {item("group-menu-close", "Close panel", () => closeGroup(group.id))}
    </div>
  );
}

function DockGroup({ group, panels }: { group: LayoutGroup; panels: Panels }): React.JSX.Element {
  const activateTab = useWorkspaceStore((state) => state.activateTab);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const closeGroup = useWorkspaceStore((state) => state.closeGroup);
  const moveTab = useWorkspaceStore((state) => state.moveTab);
  const focusPanel = useWorkspaceStore((state) => state.focusPanel);
  const openPicker = useWorkspaceStore((state) => state.openPicker);
  const picker = useWorkspaceStore((state) => state.picker);
  const cancelPicker = useWorkspaceStore((state) => state.cancelPicker);
  const choosePanel = useWorkspaceStore((state) => state.choosePanel);
  const placed = usePlacedPanels();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const controls = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const dismissOutside = (event: PointerEvent): void => {
      if (!controls.current?.contains(event.target as Node | null)) setMenuOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [menuOpen]);
  const label = PANEL_LABELS[group.activePanelId].name;

  const receiveDrop = (event: DragEvent<HTMLElement>, index?: number): void => {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    const panelId = draggedPanel(event);
    if (panelId !== null) moveTab(panelId, group.id, index);
  };

  const section = (
    <section
      className="dock-group"
      data-testid="dock-group"
      data-group-id={group.id}
      data-active-panel={group.activePanelId}
      onPointerDownCapture={() => focusPanel(group.activePanelId)}
    >
      <header className="dock-group-header">
        <div
          className="dock-tabs"
          role="tablist"
          aria-label="Panels in this group"
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
          {group.panelIds.map((panelId, index) => {
            const tab = PANEL_LABELS[panelId];
            return (
              <div className="dock-tab-slot" key={panelId}>
                <button
                  type="button"
                  role="tab"
                  draggable
                  id={`${panelId}-title`}
                  aria-selected={group.activePanelId === panelId}
                  className="dock-tab"
                  data-testid={`dock-tab-${panelId}`}
                  title={tab.name}
                  onClick={() => activateTab(panelId)}
                  onDragStart={(event) => beginPanelDrag(event, panelId)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => receiveDrop(event, index)}
                >
                  <span aria-hidden="true">{tab.icon}</span>
                  {tab.name}
                </button>
                <button
                  type="button"
                  className="dock-tab-close"
                  data-testid={`dock-tab-close-${panelId}`}
                  aria-label={`Close ${tab.name}`}
                  title={`Close ${tab.name}`}
                  onClick={() => closeTab(panelId)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <div className="panel-actions" data-testid="group-actions" ref={setSlot} />
        <div className="dock-group-controls" ref={controls}>
          <button
            type="button"
            className="icon-button"
            data-testid="group-split-right"
            aria-label={`Split ${label} right`}
            title="Split right"
            onClick={() => openPicker({ mode: "split", groupId: group.id, side: "right" })}
          >
            ◫
          </button>
          <button
            type="button"
            className="icon-button"
            data-testid="group-split-down"
            aria-label={`Split ${label} down`}
            title="Split down"
            onClick={() => openPicker({ mode: "split", groupId: group.id, side: "down" })}
          >
            ⊟
          </button>
          <button
            type="button"
            className="icon-button"
            data-testid="group-menu"
            aria-label={`${label} panel options`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More"
            onClick={() => setMenuOpen((open) => !open)}
          >
            ⋯
          </button>
          <button
            type="button"
            className="icon-button"
            data-testid="group-close"
            aria-label={`Close ${label} panel`}
            title="Close panel"
            onClick={() => closeGroup(group.id)}
          >
            ✕
          </button>
          {menuOpen ? <GroupMenu group={group} onClose={() => setMenuOpen(false)} /> : null}
        </div>
      </header>
      <div className="dock-panel-stage">
        <PanelActionsSlot.Provider value={slot}>
          {panels[group.activePanelId]}
        </PanelActionsSlot.Provider>
        {picker?.mode === "add-tab" && picker.groupId === group.id ? (
          <div className="panel-picker-overlay">
            <PanelPicker placed={placed} onChoose={choosePanel} onCancel={cancelPicker} />
          </div>
        ) : null}
      </div>
    </section>
  );

  // The host wrapper is always rendered so opening a split never remounts the panel.
  const pendingSide = picker?.mode === "split" && picker.groupId === group.id ? picker.side : null;
  return (
    <div
      className="dock-group-host"
      data-direction={pendingSide === "down" ? "column" : "row"}
    >
      {section}
      {pendingSide === null ? null : (
        <div className="pending-split" data-testid="pending-split">
          <PanelPicker placed={placed} onChoose={choosePanel} onCancel={cancelPicker} />
        </div>
      )}
    </div>
  );
}

function SplitDivider({ split, index }: { split: LayoutSplit; index: number }): React.JSX.Element {
  const resizeSplit = useWorkspaceStore((state) => state.resizeSplit);
  const drag = useRef<{ pointerId: number; last: number; extent: number } | null>(null);
  const row = split.direction === "row";
  const extentOf = (element: HTMLElement): number => {
    const box = element.parentElement?.getBoundingClientRect();
    return Math.max(1, (row ? box?.width : box?.height) ?? 1);
  };
  const position = (event: ReactPointerEvent<HTMLElement>): number =>
    row ? event.clientX : event.clientY;

  const finish = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    resizeSplit(split.id, index, position(event) - current.last, current.extent, true);
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className="split-divider"
      role="separator"
      tabIndex={0}
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label={row ? "Resize panels horizontally" : "Resize panels vertically"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((split.sizes[index] ?? 0) * 100)}
      data-testid="split-divider"
      data-split-id={split.id}
      onKeyDown={(event) => {
        const decrease = row ? "ArrowLeft" : "ArrowUp";
        const increase = row ? "ArrowRight" : "ArrowDown";
        if (event.key !== decrease && event.key !== increase) return;
        event.preventDefault();
        const extent = extentOf(event.currentTarget);
        resizeSplit(split.id, index, (event.key === increase ? 0.02 : -0.02) * extent, extent);
      }}
      onPointerDown={(event) => {
        drag.current = {
          pointerId: event.pointerId,
          last: position(event),
          extent: extentOf(event.currentTarget),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        const next = position(event);
        resizeSplit(split.id, index, next - current.last, current.extent, false);
        current.last = next;
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <span aria-hidden="true" />
    </div>
  );
}

function DockNode({ node, panels }: { node: LayoutNode; panels: Panels }): React.JSX.Element {
  if (node.kind === "group") return <DockGroup group={node} panels={panels} />;
  return (
    <div className="dock-split" data-testid="dock-split" data-direction={node.direction}>
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 ? <SplitDivider split={node} index={index - 1} /> : null}
          <div
            className="dock-split-child"
            style={{ flex: `${String(node.sizes[index] ?? 0)} 1 0px` } as CSSProperties}
          >
            <DockNode node={child} panels={panels} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

interface DockWorkspaceProps {
  panels: Panels;
}

export function DockWorkspace({ panels }: DockWorkspaceProps): React.JSX.Element {
  const layout = useWorkspaceStore((state) => state.layout);
  const activePhase = useWorkspaceStore((state) => state.activePhase);
  const picker = useWorkspaceStore((state) => state.picker);
  const openPicker = useWorkspaceStore((state) => state.openPicker);
  const cancelPicker = useWorkspaceStore((state) => state.cancelPicker);
  const choosePanel = useWorkspaceStore((state) => state.choosePanel);
  const openRootPicker = useCallback(() => openPicker({ mode: "root" }), [openPicker]);

  return (
    <div
      className="workspace-layout"
      id="workspace-layout"
      data-testid="workspace-layout"
      data-phase={activePhase}
    >
      {layout.root === null ? (
        <div className="workspace-empty">
          {picker?.mode === "root" ? (
            <PanelPicker placed={[]} onChoose={choosePanel} onCancel={cancelPicker} />
          ) : (
            <button
              type="button"
              className="primary-action"
              data-testid="workspace-add-panel"
              onClick={openRootPicker}
            >
              Add panel
            </button>
          )}
        </div>
      ) : (
        <DockNode node={layout.root} panels={panels} />
      )}
    </div>
  );
}
