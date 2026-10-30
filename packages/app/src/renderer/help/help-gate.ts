import { useHelpMode } from "./help-mode.js";

/** The slice of `Element` the gate needs, so tests can use plain fakes. */
export interface ElementLike {
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
}

/**
 * Resolves what a click in help mode means: `"allow"` for the help chrome itself
 * (toggle, banner, popup), `{ key }` for the innermost `[data-help]` element, or
 * `null` for anything else (swallowed, nothing to explain).
 */
export function helpTargetFor(target: ElementLike | null): { key: string } | "allow" | null {
  if (target === null) return null;
  if (target.closest("[data-help-allow]") !== null) return "allow";
  const owner = target.closest("[data-help]");
  const key = owner?.getAttribute("data-help") ?? null;
  return key === null ? null : { key };
}

const POINTER_EVENTS = [
  "pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click", "dblclick", "auxclick",
  "contextmenu", "touchstart", "touchend",
] as const;
const DRAG_EVENTS = ["dragstart", "dragenter", "dragover", "dragleave", "drop"] as const;
// Non-passive so touchstart can be cancelled (browsers default window-level touch listeners to passive).
const LISTENER_OPTIONS = { capture: true, passive: false } as const;

export type HelpKeyDecision = "toggle" | "close-popup" | "exit" | "allow" | "block";

/**
 * `welcomeShown`: the welcome screen covers the title bar, so help mode must not turn on
 * behind it (the toggle and banner would be hidden). Turning it off still works.
 */
export function helpKeyDecision(
  event: { key: string; shiftKey: boolean; inAllowedRegion: boolean; ctrlKey?: boolean; repeat?: boolean },
  state: { active: boolean; popupOpen: boolean; welcomeShown?: boolean },
): HelpKeyDecision {
  if (event.key === "F1" && event.shiftKey) {
    if (event.repeat === true) return "block";
    return !state.active && state.welcomeShown === true ? "block" : "toggle";
  }
  if (!state.active) return "allow";
  if (event.key === "Escape") return state.popupOpen ? "close-popup" : "exit";
  if (event.inAllowedRegion && (event.key === "Tab" || event.key === "Enter")) return "allow";
  return "block";
}

export function helpDragDecision(type: string, active: boolean): "refuse" | "pass" {
  if (!active) return "pass";
  return DRAG_EVENTS.some((name) => name === type) ? "refuse" : "pass";
}


function asElementLike(target: EventTarget | null): ElementLike | null {
  if (target === null) return null;
  const candidate = target as Partial<ElementLike>;
  return typeof candidate.closest === "function" && typeof candidate.getAttribute === "function"
    ? (target as unknown as ElementLike)
    : null;
}

// stopImmediatePropagation also silences other window capture listeners (e.g. the guided
// tour's keydown handler), which stopPropagation alone would not.
function swallow(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * Installs the one help-mode gate: capture-phase listeners on `window` that run before
 * React and the app's own window listeners, so nothing reacts while help mode is on.
 * Returns the uninstall function.
 */
export function installHelpGate(target: Window): () => void {
  const root = target.document.documentElement;
  const syncAttribute = (active: boolean): void => {
    if (active) root.dataset.helpMode = "on";
    else delete root.dataset.helpMode;
  };

  // Pointers pressed while help mode was off: their release must still reach the app, or a
  // drag started before Shift+F1 (a slider, a dock splitter) would stay captured.
  const pressedWhileOff = new Set<number>();

  const onKeyDown = (event: Event): void => {
    const keyEvent = event as KeyboardEvent;
    const state = useHelpMode.getState();
    const decision = helpKeyDecision(
      {
        key: keyEvent.key,
        shiftKey: keyEvent.shiftKey,
        ctrlKey: keyEvent.ctrlKey,
        repeat: keyEvent.repeat,
        inAllowedRegion: helpTargetFor(asElementLike(keyEvent.target)) === "allow",
      },
      {
        active: state.active,
        popupOpen: state.openKey !== null,
        welcomeShown: target.document.querySelector(".welcome-surface") !== null,
      },
    );
    if (decision === "allow") {
      // Tab/Enter on the help chrome: keep the native default (focus move, button activation)
      // but hide the key from later window listeners such as the guided tour's Enter handler.
      if (state.active) keyEvent.stopImmediatePropagation();
      return;
    }
    if (decision === "toggle") state.toggle();
    else if (decision === "close-popup") state.close();
    else if (decision === "exit") state.exit();
    swallow(keyEvent);
  };

  const onPointer = (event: Event): void => {
    const state = useHelpMode.getState();
    const { pointerId } = event as PointerEvent;
    if (event.type === "pointerdown" && !state.active) pressedWhileOff.add(pointerId);
    if (event.type === "pointerup" || event.type === "pointercancel") {
      if (pressedWhileOff.delete(pointerId) && state.active) return;
    }
    if (!state.active) return;
    const hit = helpTargetFor(asElementLike(event.target));
    if (hit === "allow") return;
    swallow(event);
    if (event.type === "click" && hit !== null) state.open(hit.key);
  };

  const onDrag = (event: Event): void => {
    if (helpDragDecision(event.type, useHelpMode.getState().active) === "pass") return;
    swallow(event);
    if (event.type === "dragover") {
      const transfer = (event as DragEvent).dataTransfer;
      if (transfer !== null) transfer.dropEffect = "none";
    }
  };

  target.addEventListener("keydown", onKeyDown, LISTENER_OPTIONS);
  for (const type of POINTER_EVENTS) target.addEventListener(type, onPointer, LISTENER_OPTIONS);
  for (const type of DRAG_EVENTS) target.addEventListener(type, onDrag, LISTENER_OPTIONS);
  syncAttribute(useHelpMode.getState().active);
  const unsubscribe = useHelpMode.subscribe((state) => syncAttribute(state.active));

  return () => {
    unsubscribe();
    target.removeEventListener("keydown", onKeyDown, LISTENER_OPTIONS);
    for (const type of POINTER_EVENTS) target.removeEventListener(type, onPointer, LISTENER_OPTIONS);
    for (const type of DRAG_EVENTS) target.removeEventListener(type, onDrag, LISTENER_OPTIONS);
    syncAttribute(false);
  };
}
