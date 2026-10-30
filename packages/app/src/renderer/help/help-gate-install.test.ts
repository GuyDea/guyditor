import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installHelpGate } from "./help-gate.js";
import type { ElementLike } from "./help-gate.js";
import { useHelpMode } from "./help-mode.js";

function fakeElement(attrs: Record<string, string>): ElementLike {
  const element: ElementLike = {
    getAttribute: (name) => attrs[name] ?? null,
    closest: (selector) => {
      const name = /^\[([a-z-]+)\]$/u.exec(selector)?.[1] ?? "";
      return name in attrs ? element : null;
    },
  };
  return element;
}

function fire(
  win: EventTarget,
  type: string,
  init: { target?: ElementLike; key?: string; shiftKey?: boolean; pointerId?: number } = {},
): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), {
    key: init.key ?? "",
    shiftKey: init.shiftKey ?? false,
    ctrlKey: false,
    repeat: false,
    pointerId: init.pointerId ?? 1,
  });
  if (init.target !== undefined) Object.defineProperty(event, "target", { value: init.target });
  win.dispatchEvent(event);
  return event;
}

describe("installHelpGate", () => {
  const dataset: Record<string, string | undefined> = {};
  let welcomeShown: boolean;
  let win: EventTarget & {
    document: {
      documentElement: { dataset: Record<string, string | undefined> };
      querySelector: (selector: string) => object | null;
    };
  };
  let uninstall: () => void;
  let lateCalls: string[];

  beforeEach(() => {
    delete dataset.helpMode;
    useHelpMode.setState({ active: false, openKey: null, manualRequest: null });
    welcomeShown = false;
    const querySelector = (selector: string): object | null =>
      welcomeShown && selector === ".welcome-surface" ? {} : null;
    win = Object.assign(new EventTarget(), { document: { documentElement: { dataset }, querySelector } });
    uninstall = installHelpGate(win as unknown as Window);
    lateCalls = [];
    // Registered after the gate, on the same target and phase, like the guided tour's listener.
    for (const type of ["keydown", "click", "pointerup", "pointercancel", "dragenter"]) {
      win.addEventListener(type, () => lateCalls.push(type), true);
    }
  });
  afterEach(() => uninstall());

  it("passes everything through while help mode is off", () => {
    for (const type of ["click", "pointerup", "dragenter"]) {
      expect(fire(win, type, { target: fakeElement({ "data-help": "panel.media" }) }).defaultPrevented).toBe(false);
    }
    expect(fire(win, "keydown", { key: "a" }).defaultPrevented).toBe(false);
    expect(lateCalls).toEqual(["click", "pointerup", "dragenter", "keydown"]);
    expect(useHelpMode.getState().openKey).toBeNull();
  });

  it("toggles on Shift+F1 and swallows it", () => {
    const event = fire(win, "keydown", { key: "F1", shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(useHelpMode.getState().active).toBe(true);
    expect(dataset.helpMode).toBe("on");
    expect(lateCalls).toEqual([]);
    fire(win, "keydown", { key: "F1", shiftKey: true });
    expect(useHelpMode.getState().active).toBe(false);
    expect(dataset.helpMode).toBeUndefined();
  });

  it("opens the popup for a clicked target and swallows the click", () => {
    useHelpMode.setState({ active: true });
    const event = fire(win, "click", { target: fakeElement({ "data-help": "panel.media" }) });
    expect(event.defaultPrevented).toBe(true);
    expect(useHelpMode.getState().openKey).toBe("panel.media");
    expect(lateCalls).toEqual([]);
  });

  it("swallows pointerup and drag events so inputs cannot commit edits", () => {
    useHelpMode.setState({ active: true });
    const slider = fakeElement({ "data-help": "panel.key-inspector" });
    for (const type of ["pointerup", "pointercancel", "touchstart", "touchend", "dragenter", "dragleave"]) {
      expect(fire(win, type, { target: slider }).defaultPrevented).toBe(true);
    }
    expect(lateCalls).toEqual([]);
    expect(useHelpMode.getState().openKey).toBeNull();
  });

  it("releases a pointer pressed before help mode turned on, once", () => {
    const slider = fakeElement({ "data-help": "panel.key-inspector" });
    fire(win, "pointerdown", { target: slider, pointerId: 7 });
    fire(win, "pointerdown", { target: slider, pointerId: 8 });
    useHelpMode.setState({ active: true });
    lateCalls = [];
    expect(fire(win, "pointerup", { target: slider, pointerId: 7 }).defaultPrevented).toBe(false);
    expect(fire(win, "pointercancel", { target: slider, pointerId: 8 }).defaultPrevented).toBe(false);
    expect(lateCalls).toEqual(["pointerup", "pointercancel"]);
    // Each pointer is released only once, and pointers pressed in help mode stay swallowed.
    expect(fire(win, "pointerup", { target: slider, pointerId: 7 }).defaultPrevented).toBe(true);
    fire(win, "pointerdown", { target: slider, pointerId: 9 });
    expect(fire(win, "pointerup", { target: slider, pointerId: 9 }).defaultPrevented).toBe(true);
    expect(lateCalls).toEqual(["pointerup", "pointercancel"]);
  });

  it("forgets a pointer released while help mode was still off", () => {
    const slider = fakeElement({ "data-help": "panel.key-inspector" });
    fire(win, "pointerdown", { target: slider, pointerId: 3 });
    fire(win, "pointerup", { target: slider, pointerId: 3 });
    useHelpMode.setState({ active: true });
    expect(fire(win, "pointerup", { target: slider, pointerId: 3 }).defaultPrevented).toBe(true);
  });

  it("lets Enter activate an allowed control natively but hides it from later listeners", () => {
    useHelpMode.setState({ active: true, openKey: "panel.media" });
    const close = fakeElement({ "data-help-allow": "" });
    const event = fire(win, "keydown", { key: "Enter", target: close });
    expect(event.defaultPrevented).toBe(false);
    expect(lateCalls).toEqual([]);
    // With help mode off, Enter still reaches everyone.
    useHelpMode.setState({ active: false, openKey: null });
    fire(win, "keydown", { key: "Enter", target: close });
    expect(lateCalls).toEqual(["keydown"]);
  });

  it("ignores Shift+F1 while the welcome screen covers the toggle", () => {
    welcomeShown = true;
    fire(win, "keydown", { key: "F1", shiftKey: true });
    expect(useHelpMode.getState().active).toBe(false);
    expect(dataset.helpMode).toBeUndefined();
    welcomeShown = false;
    fire(win, "keydown", { key: "F1", shiftKey: true });
    expect(useHelpMode.getState().active).toBe(true);
  });

  it("lets only data-help-allow targets through", () => {
    useHelpMode.setState({ active: true });
    const allowed = fakeElement({ "data-help-allow": "" });
    expect(fire(win, "click", { target: allowed }).defaultPrevented).toBe(false);
    expect(fire(win, "pointerup", { target: allowed }).defaultPrevented).toBe(false);
    expect(fire(win, "click", { target: fakeElement({}) }).defaultPrevented).toBe(true);
    expect(useHelpMode.getState().openKey).toBeNull();
    expect(lateCalls).toEqual(["click", "pointerup"]);
  });

  it("closes the popup on Escape, then exits help mode", () => {
    useHelpMode.setState({ active: true, openKey: "panel.media" });
    expect(fire(win, "keydown", { key: "Escape" }).defaultPrevented).toBe(true);
    expect(useHelpMode.getState()).toMatchObject({ active: true, openKey: null });
    expect(fire(win, "keydown", { key: "Escape" }).defaultPrevented).toBe(true);
    expect(useHelpMode.getState().active).toBe(false);
    expect(dataset.helpMode).toBeUndefined();
  });

  it("blocks keys in help mode and clears the attribute and listeners on uninstall", () => {
    useHelpMode.setState({ active: true });
    expect(dataset.helpMode).toBe("on");
    expect(fire(win, "keydown", { key: "a" }).defaultPrevented).toBe(true);
    uninstall();
    expect(dataset.helpMode).toBeUndefined();
    expect(fire(win, "keydown", { key: "a" }).defaultPrevented).toBe(false);
    useHelpMode.setState({ active: false });
    useHelpMode.setState({ active: true });
    expect(dataset.helpMode).toBeUndefined();
  });
});
