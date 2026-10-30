import { useHelpMode } from "./help-mode.js";
import "./help-mode.css";

export function HelpModeToggle(): React.JSX.Element {
  const active = useHelpMode((state) => state.active);
  const toggle = useHelpMode((state) => state.toggle);
  return (
    <button
      type="button"
      className={active ? "help-mode-toggle help-mode-toggle-on" : "help-mode-toggle"}
      aria-pressed={active}
      aria-label="Help mode"
      title="Help mode (Shift+F1): click any panel or section to see what it does"
      data-testid="help-mode-toggle"
      data-help-allow=""
      onClick={toggle}
    >{active ? "Help mode" : "ⓘ"}</button>
  );
}
