import { useContext } from "react";
import type { PropsWithChildren } from "react";
import { createPortal } from "react-dom";

import { PanelActionsSlot } from "../DockWorkspace.js";
import { useWorkspaceStore } from "../state/view-state.js";
import type { PanelId } from "../state/view-state.js";

interface PanelProps extends PropsWithChildren {
  id: PanelId;
  title: string;
  eyebrow: string;
  className?: string;
  actions?: React.ReactNode;
}

/**
 * Body of a docked panel. The dock group's tab strip is the panel's only header, so
 * `actions` are portalled into the group header rather than drawn here.
 */
export function Panel({
  id,
  title,
  eyebrow,
  className = "",
  actions,
  children,
}: PanelProps): React.JSX.Element {
  const slot = useContext(PanelActionsSlot);
  const flashing = useWorkspaceStore((state) => state.flashingPanel === id);
  const clearPanelFlash = useWorkspaceStore((state) => state.clearPanelFlash);
  const focusPanel = useWorkspaceStore((state) => state.focusPanel);
  const actionBar = actions === undefined ? null : (
    <div className="panel-actions" data-testid={`${id}-panel-actions`}>{actions}</div>
  );
  return (
    <section
      className={`workspace-panel panel-${id} ${flashing ? "panel-flash" : ""} ${className}`}
      data-testid={`${id}-panel`}
      data-panel={id}
      tabIndex={-1}
      aria-label={title}
      aria-description={eyebrow}
      onFocusCapture={() => focusPanel(id)}
      onAnimationEnd={(event) => {
        if (event.animationName === "panel-border-pulse") clearPanelFlash(id);
      }}
    >
      {slot === undefined ? actionBar : slot === null ? null : createPortal(actionBar, slot)}
      <div className="panel-body" data-testid={`${id}-panel-scroll`}>
        {children}
      </div>
    </section>
  );
}
