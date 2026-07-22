import type { PropsWithChildren } from "react";

import { useWorkspaceStore } from "../state/view-state.js";
import type { PanelId } from "../state/view-state.js";

interface PanelProps extends PropsWithChildren {
  id: PanelId;
  title: string;
  eyebrow: string;
  className?: string;
  actions?: React.ReactNode;
}

export function Panel({
  id,
  title,
  eyebrow,
  className = "",
  actions,
  children,
}: PanelProps): React.JSX.Element {
  const collapsed = useWorkspaceStore((state) => state.collapsed[id]);
  const togglePanel = useWorkspaceStore((state) => state.togglePanel);
  const focusPanel = useWorkspaceStore((state) => state.focusPanel);
  return (
    <section
      className={`workspace-panel panel-${id} ${collapsed ? "is-collapsed" : ""} ${className}`}
      data-testid={`${id}-panel`}
      data-panel={id}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      onFocusCapture={() => focusPanel(id)}
    >
      <header className="panel-bar">
        <div className="panel-title">
          <span className="panel-index">P{String(panelNumber(id))}</span>
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id={`${id}-title`}>{title}</h2>
          </div>
        </div>
        <div className="panel-actions">
          {collapsed ? null : actions}
          <button
            type="button"
            className="icon-button"
            data-testid={`${id}-panel-toggle`}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}
            aria-expanded={!collapsed}
            onClick={() => togglePanel(id)}
          >
            {collapsed ? "+" : "−"}
          </button>
        </div>
      </header>
      {collapsed ? null : <div className="panel-body">{children}</div>}
    </section>
  );
}

function panelNumber(id: PanelId): number {
  return ({ media: 1, preview: 2, transcript: 3, inspector: 4, agent: 5, timeline: 6, status: 7, graphics: 8, publish: 9, skills: 10 })[id];
}
