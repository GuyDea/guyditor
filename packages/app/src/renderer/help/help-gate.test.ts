import { describe, expect, it } from "vitest";

import { helpDragDecision, helpKeyDecision, helpTargetFor } from "./help-gate.js";
import type { ElementLike } from "./help-gate.js";

interface FakeNode {
  id: string;
  parent: string | null;
  attrs: Record<string, string>;
}

function tree(nodes: FakeNode[]): Map<string, ElementLike> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const elements = new Map<string, ElementLike>();
  const wrap = (id: string): ElementLike => {
    const cached = elements.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (node === undefined) throw new Error(`unknown node ${id}`);
    const element: ElementLike = {
      getAttribute: (name) => node.attrs[name] ?? null,
      closest: (selector) => {
        const attribute = /^\[([a-z-]+)\]$/u.exec(selector)?.[1];
        if (attribute === undefined) throw new Error(`unsupported selector ${selector}`);
        let current: FakeNode | undefined = node;
        while (current !== undefined) {
          if (attribute in current.attrs) return wrap(current.id);
          current = current.parent === null ? undefined : byId.get(current.parent);
        }
        return null;
      },
    };
    elements.set(id, element);
    return element;
  };
  for (const node of nodes) wrap(node.id);
  return elements;
}

describe("helpTargetFor", () => {
  const elements = tree([
    { id: "root", parent: null, attrs: {} },
    { id: "panel", parent: "root", attrs: { "data-help": "panel.media" } },
    { id: "summary", parent: "panel", attrs: { "data-help": "section.media.capture-watcher" } },
    { id: "button", parent: "panel", attrs: {} },
    { id: "outside", parent: "root", attrs: {} },
    { id: "allow", parent: "panel", attrs: { "data-help-allow": "" } },
    { id: "allowChild", parent: "allow", attrs: {} },
  ]);
  const get = (id: string): ElementLike => {
    const element = elements.get(id);
    if (element === undefined) throw new Error(id);
    return element;
  };

  it("resolves the innermost help target", () => {
    expect(helpTargetFor(get("summary"))).toEqual({ key: "section.media.capture-watcher" });
    expect(helpTargetFor(get("button"))).toEqual({ key: "panel.media" });
    expect(helpTargetFor(get("outside"))).toBeNull();
    expect(helpTargetFor(null)).toBeNull();
    expect(helpTargetFor(get("allow"))).toBe("allow");
    expect(helpTargetFor(get("allowChild"))).toBe("allow");
  });
});

describe("helpKeyDecision", () => {
  const off = { active: false, popupOpen: false };
  const on = { active: true, popupOpen: false };
  const onWithPopup = { active: true, popupOpen: true };
  const key = (
    name: string,
    extra: { shiftKey?: boolean; ctrlKey?: boolean; repeat?: boolean; inAllowedRegion?: boolean } = {},
  ) => ({
    key: name,
    shiftKey: extra.shiftKey ?? false,
    ctrlKey: extra.ctrlKey ?? false,
    repeat: extra.repeat ?? false,
    inAllowedRegion: extra.inAllowedRegion ?? false,
  });

  it("keys while help mode is off only toggle on Shift+F1", () => {
    expect(helpKeyDecision(key("F1", { shiftKey: true }), off)).toBe("toggle");
    expect(helpKeyDecision(key("Escape"), off)).toBe("allow");
    expect(helpKeyDecision(key("a"), off)).toBe("allow");
  });

  it("does not turn help mode on behind the welcome screen, but still turns it off", () => {
    expect(helpKeyDecision(key("F1", { shiftKey: true }), { ...off, welcomeShown: true })).toBe("block");
    expect(helpKeyDecision(key("F1", { shiftKey: true }), { ...on, welcomeShown: true })).toBe("toggle");
  });

  it("ignores auto-repeat of Shift+F1 so holding it does not flip help mode", () => {
    expect(helpKeyDecision(key("F1", { shiftKey: true, repeat: true }), off)).toBe("block");
    expect(helpKeyDecision(key("F1", { shiftKey: true, repeat: true }), on)).toBe("block");
  });

  it("keys while help mode is on", () => {
    expect(helpKeyDecision(key("F1", { shiftKey: true }), on)).toBe("toggle");
    expect(helpKeyDecision(key("Escape"), onWithPopup)).toBe("close-popup");
    expect(helpKeyDecision(key("Escape"), on)).toBe("exit");
    for (const name of ["a", " ", "Backspace", "z", "ArrowLeft", "Enter", "Tab"]) {
      expect(helpKeyDecision(key(name), on)).toBe("block");
    }
    expect(helpKeyDecision(key("z", { ctrlKey: true }), on)).toBe("block");
    expect(helpKeyDecision(key("Tab", { inAllowedRegion: true }), on)).toBe("allow");
    expect(helpKeyDecision(key("Enter", { inAllowedRegion: true }), on)).toBe("allow");
  });
});

describe("helpDragDecision", () => {
  it("refuses drag and drop only in help mode", () => {
    for (const type of ["dragstart", "dragenter", "dragover", "dragleave", "drop"]) {
      expect(helpDragDecision(type, true)).toBe("refuse");
      expect(helpDragDecision(type, false)).toBe("pass");
    }
  });
});
