import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { useJobsStore } from "./state/jobs.js";
import {
  PANEL_LABELS,
  TOOL_RAIL_GROUPS,
  toolRailPanelState,
} from "./state/tool-rail.js";
import { useWorkspaceStore } from "./state/view-state.js";
import { panelBadgeCounts } from "./workflow-phases.js";
import { revealPanel } from "./workspace-navigation.js";

const STATE_LABELS = {
  here: "In this tab",
  "other-phase": "In another tab",
  absent: "Not placed",
} as const;

export function MasterToolRail(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const layouts = useWorkspaceStore((state) => state.layouts);
  const activePhase = useWorkspaceStore((state) => state.activePhase);
  const overview = useJobsStore((state) => state.overview);
  const badges = panelBadgeCounts(overview);
  const entryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  let entryIndex = 0;

  const moveFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    let target: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      target = (index + 1) % entryRefs.current.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      target = (index - 1 + entryRefs.current.length) % entryRefs.current.length;
    } else if (event.key === "Home") {
      target = 0;
    } else if (event.key === "End") {
      target = entryRefs.current.length - 1;
    }
    if (target === null) return;
    event.preventDefault();
    entryRefs.current[target]?.focus();
  };

  return (
    <aside
      className="master-tool-rail"
      data-testid="master-tool-rail"
      data-expanded={expanded}
      aria-label="Master tool rail"
    >
      <button
        type="button"
        className="tool-rail-expand"
        data-testid="tool-rail-toggle"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} tool rail labels`}
        title={`${expanded ? "Collapse" : "Expand"} tool rail labels`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span aria-hidden="true">{expanded ? "‹" : "›"}</span>
        <span className="tool-rail-name">Tools</span>
      </button>
      <nav aria-label="Workspace panels">
        {TOOL_RAIL_GROUPS.map((group) => (
          <section className="tool-rail-group" key={group.id}>
            <h2 title={group.label}>
              <span aria-hidden="true">{group.label.slice(0, 1)}</span>
              <span className="tool-rail-name">{group.label}</span>
            </h2>
            {group.panelIds.map((panelId) => {
              const index = entryIndex++;
              const label = PANEL_LABELS[panelId];
              const state = toolRailPanelState(layouts, activePhase, panelId);
              const badge = badges[panelId];
              return (
                <button
                  type="button"
                  className="tool-rail-entry"
                  key={panelId}
                  ref={(element) => {
                    entryRefs.current[index] = element;
                  }}
                  data-testid={`tool-rail-entry-${panelId}`}
                  data-state={state}
                  aria-pressed={state === "here"}
                  aria-label={`${label.name}: ${STATE_LABELS[state]}${
                    badge > 0 ? `, ${String(badge)} need attention` : ""
                  }`}
                  title={`${label.name} · ${STATE_LABELS[state]}${
                    badge > 0 ? ` · ${String(badge)} need attention` : ""
                  }`}
                  onClick={() => revealPanel(panelId)}
                  onKeyDown={(event) => moveFocus(event, index)}
                >
                  <span className="tool-rail-icon" aria-hidden="true">{label.icon}</span>
                  <span className="tool-rail-name">{label.name}</span>
                  <span
                    className="tool-rail-state"
                    data-state={state}
                    aria-hidden="true"
                  />
                  {badge > 0 ? (
                    <span
                      className="tool-rail-badge"
                      data-testid={`tool-rail-badge-${panelId}`}
                    >
                      <span className="tool-rail-badge-count">{String(badge)}</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </section>
        ))}
      </nav>
    </aside>
  );
}
