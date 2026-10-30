import { useMemo, useState } from "react";

import { MANUAL_SOURCE } from "../manual-source.js";
import {
  MarkdownDocument,
  filterManualSections,
  parseManual,
} from "../manual.js";
import { CHECKLIST_STEPS } from "../state/onboarding.js";
import type { OnboardingState } from "../state/onboarding.js";
import { Panel } from "./Panel.js";

interface HelpPanelProps {
  onboarding: OnboardingState;
  onChecklistDismissedChange: (dismissed: boolean) => void;
  onRestartTour: () => void;
  onShowWelcome: () => void;
}

const KEYBOARD_MAP = [
  ["Ctrl/Cmd+Alt+1…5", "Switch workflow phase"],
  ["1…9", "Focus the matching workspace panel"],
  ["Rail ↑ / ↓ / ← / →", "Move between master tool rail entries"],
  ["Rail Enter", "Show the selected panel, adding it to this tab if needed"],
  ["Space", "Play or pause"],
  ["← / →", "Step one frame"],
  ["Shift+← / Shift+→", "Step ten frames"],
  [", / .", "Step while paused"],
  ["Ctrl/Cmd+Z / Ctrl/Cmd+Y", "Undo or redo"],
  ["Home", "Go to frame zero"],
  ["Alt+← / Alt+→", "Move between transcript words"],
  ["A / Shift+A", "Move between annotations"],
] as const;

export function HelpPanel({
  onboarding,
  onChecklistDismissedChange,
  onRestartTour,
  onShowWelcome,
}: HelpPanelProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [pathNote, setPathNote] = useState<string | null>(null);
  const manual = useMemo(() => parseManual(MANUAL_SOURCE), []);
  const visibleManual = useMemo(
    () => filterManualSections(manual, query),
    [manual, query],
  );
  const completed = CHECKLIST_STEPS.filter(({ id }) => onboarding.checklist[id]).length;

  return (
    <Panel
      id="help"
      title="Help & manual"
      eyebrow="A006 · in-app reference"
      className="help-panel"
      actions={(
        <>
          <button type="button" data-testid="help-restart-tour" onClick={onRestartTour}>
            Restart tour
          </button>
          <button type="button" data-testid="help-show-welcome" onClick={onShowWelcome}>
            Show welcome
          </button>
        </>
      )}
    >
      <div className="help-tools">
        <label>
          <span>Search manual</span>
          <input
            type="search"
            value={query}
            placeholder="Panel, action, or feature"
            data-testid="manual-search"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <span className="manual-source-note">Bundled from docs/MANUAL.md</span>
      </div>

      <section className="getting-started" aria-labelledby="getting-started-title">
        <header>
          <div>
            <span className="eyebrow">One complete workflow</span>
            <h3 id="getting-started-title">Getting started</h3>
          </div>
          <strong>{String(completed)}/{String(CHECKLIST_STEPS.length)}</strong>
        </header>
        {onboarding.checklistDismissed ? (
          <button
            type="button"
            data-testid="checklist-show"
            onClick={() => onChecklistDismissedChange(false)}
          >Show checklist</button>
        ) : (
          <>
            <ol>
              {CHECKLIST_STEPS.map(({ id, label }, index) => (
                <li
                  key={id}
                  data-testid={`checklist-${id}`}
                  data-complete={onboarding.checklist[id]}
                >
                  <span aria-hidden="true">
                    {onboarding.checklist[id] ? "✓" : String(index + 1).padStart(2, "0")}
                  </span>
                  <span>{label}</span>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="checklist-dismiss"
              data-testid="checklist-dismiss"
              onClick={() => onChecklistDismissedChange(true)}
            >Dismiss checklist</button>
          </>
        )}
      </section>

      <details className="keyboard-map">
        <summary>Keyboard map</summary>
        <dl>
          {KEYBOARD_MAP.map(([keys, action]) => (
            <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>
          ))}
        </dl>
      </details>

      {pathNote === null ? null : (
        <p className="manual-path-note" role="status" data-testid="manual-path-note">
          Repository document: <code>{pathNote}</code>
          <button type="button" aria-label="Dismiss path note" onClick={() => setPathNote(null)}>×</button>
        </p>
      )}

      {visibleManual.sections.length === 0 ? (
        <p className="manual-empty" data-testid="manual-empty">
          No manual section contains “{query}”.
        </p>
      ) : (
        <MarkdownDocument document={visibleManual} onRepositoryLink={setPathNote} />
      )}
    </Panel>
  );
}
