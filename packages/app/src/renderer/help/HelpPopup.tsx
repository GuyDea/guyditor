import { useEffect, useRef } from "react";

import { InlineMarkdown } from "../manual.js";
import { revealPanel } from "../workspace-navigation.js";
import { useHelpMode } from "./help-mode.js";
import { helpEntries } from "./help-source.js";
import type { HelpEntry } from "./help-texts.js";
import "./help-mode.css";

const NO_LINKS = (): void => undefined;

export interface HelpPopupViewProps {
  entry: HelpEntry | undefined;
  helpKey: string;
  /** Parse error of docs/HELP.md, shown instead of the entry when the file is malformed. */
  error?: string;
  onClose: () => void;
  onOpenManual: (heading: string) => void;
}

function Markdown({ source }: { source: string }): React.JSX.Element {
  return <InlineMarkdown source={source} onRepositoryLink={NO_LINKS} />;
}

export function HelpPopupView({
  entry,
  helpKey,
  error,
  onClose,
  onOpenManual,
}: HelpPopupViewProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [helpKey]);

  const closeButton = (
    <button type="button" ref={closeRef} data-testid="help-popup-close" onClick={onClose}>Close</button>
  );

  return (
    <div
      className="help-popup-backdrop"
      data-testid="help-popup-backdrop"
      data-help-allow=""
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="help-popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-popup-title"
        data-testid="help-popup"
        data-help-allow=""
      >
        {error !== undefined ? (
          <>
            <h2 id="help-popup-title" data-testid="help-popup-title">Help text unavailable</h2>
            <p className="help-popup-error" role="alert" data-testid="help-popup-error">{error}</p>
            <p className="help-popup-where">Requested: <code>{helpKey}</code></p>
            <div className="help-popup-actions">{closeButton}</div>
          </>
        ) : entry === undefined ? (
          <>
            <h2 id="help-popup-title" data-testid="help-popup-title">No help text yet</h2>
            <p>This part of the app has no help entry yet.</p>
            <p className="help-popup-where">Key: <code>{helpKey}</code></p>
            <div className="help-popup-actions">{closeButton}</div>
          </>
        ) : (
          <>
            <h2 id="help-popup-title" data-testid="help-popup-title">{entry.title}</h2>
            <p className="help-popup-where">{entry.where}</p>
            <h3>What it's good for</h3>
            <p data-testid="help-popup-good"><Markdown source={entry.goodFor} /></p>
            <h3>How to use it</h3>
            <ol data-testid="help-popup-how">
              {entry.howTo.map((step) => (
                <li key={step}><Markdown source={step} /></li>
              ))}
            </ol>
            <div className="help-popup-actions">
              {entry.manual === undefined ? null : (
                <button
                  type="button"
                  data-testid="help-popup-manual"
                  onClick={() => onOpenManual(entry.manual ?? "")}
                >Open in manual</button>
              )}
              {closeButton}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function HelpPopup(): React.JSX.Element | null {
  const openKey = useHelpMode((state) => state.openKey);
  if (openKey === null) return null;
  const { entries, error } = helpEntries();
  return (
    <HelpPopupView
      entry={entries.get(openKey)}
      helpKey={openKey}
      {...(error === undefined ? {} : { error })}
      onClose={() => useHelpMode.getState().close()}
      onOpenManual={(heading) => {
        const state = useHelpMode.getState();
        state.requestManual(heading);
        state.close();
        revealPanel("help");
      }}
    />
  );
}
