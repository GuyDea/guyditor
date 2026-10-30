import { useHelpMode } from "./help-mode.js";

export function HelpModeBanner(): React.JSX.Element | null {
  const active = useHelpMode((state) => state.active);
  if (!active) return null;
  return (
    <div className="help-mode-banner" role="status" data-testid="help-mode-banner" data-help-allow="">
      Help mode: click a panel or section to see what it does. Esc closes a popup; Esc again leaves help mode.
    </div>
  );
}
