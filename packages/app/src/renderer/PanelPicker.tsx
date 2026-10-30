import { useEffect, useRef } from "react";

import { DOCK_PANEL_IDS } from "./state/layout-state.js";
import type { DockPanelId } from "./state/layout-state.js";
import { PANEL_LABELS } from "./state/tool-rail.js";

interface PanelPickerProps {
  placed: readonly DockPanelId[];
  onChoose: (panelId: DockPanelId) => void;
  onCancel: () => void;
}

/** Lists every dock panel; panels already in this phase's layout are shown but not pickable. */
export function PanelPicker({ placed, onChoose, onCancel }: PanelPickerProps): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>("button:not([aria-disabled='true'])")?.focus();
    const dismissOutside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node | null)) onCancel();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [onCancel]);

  return (
    <div
      ref={root}
      className="panel-picker"
      data-testid="panel-picker"
      role="dialog"
      aria-label="Choose a panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <span className="panel-picker-title">Add panel</span>
      <div className="panel-picker-options">
        {DOCK_PANEL_IDS.map((panelId) => {
          const label = PANEL_LABELS[panelId];
          const disabled = placed.includes(panelId);
          return (
            <button
              type="button"
              key={panelId}
              className="panel-picker-option"
              data-testid={`panel-picker-option-${panelId}`}
              aria-disabled={disabled}
              title={disabled ? `${label.name} is already in this layout` : label.name}
              onClick={() => {
                if (!disabled) onChoose(panelId);
              }}
            >
              <span aria-hidden="true">{label.icon}</span>
              {label.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
