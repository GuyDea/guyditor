import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeDirect,
  redoLast,
  undoLast,
} from "./ipc.js";
import { useUndoStore } from "./state/undo.js";

const GRAPHIC_ADD = {
  op: "graphic.add",
  params: {
    templateId: "tpl_a2c3d4e5f6",
    sequenceId: "seq_bbbbbbbbbb",
    anchor: "timeline:seq_bbbbbbbbbb@0",
    duration: "intrinsic",
    params: { title: "Short title" },
  },
};
const GRAPHIC_REMOVE = {
  op: "graphic.remove",
  params: { graphicId: "gfx_bbbbbbbbbb" },
};

function result(
  txnId: string,
  revision: string,
  inverse: Array<{ op: string; params: Record<string, unknown> }>,
) {
  return { txnId, revision, inverse };
}

beforeEach(() => {
  useUndoStore.getState().clear();
});

afterEach(() => {
  useUndoStore.getState().clear();
  vi.unstubAllGlobals();
});

describe("renderer operation divergence", () => {
  it("forwards and replays a direct edit's divergence through undo and redo", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(result(
        "txn_aaaaaaaaaa",
        "rev_00002",
        [GRAPHIC_REMOVE],
      ))
      .mockResolvedValueOnce(result(
        "txn_bbbbbbbbbb",
        "rev_00003",
        [GRAPHIC_ADD],
      ))
      .mockResolvedValueOnce(result(
        "txn_cccccccccc",
        "rev_00004",
        [GRAPHIC_REMOVE],
      ));
    vi.stubGlobal("window", { guyditor: { call } });

    await executeDirect([GRAPHIC_ADD], "Add short graphic", "graphics");
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      intent: "direct",
      divergence: "graphics",
    });
    expect(useUndoStore.getState().undo[0]).toMatchObject({
      divergence: "graphics",
    });

    await undoLast();
    expect(call.mock.calls[1]?.[2]).toMatchObject({
      intent: "undo",
      undoOf: "txn_aaaaaaaaaa",
      divergence: "graphics",
    });

    await redoLast();
    expect(call.mock.calls[2]?.[2]).toMatchObject({
      intent: "redo",
      undoOf: "txn_aaaaaaaaaa",
      divergence: "graphics",
    });
    expect(useUndoStore.getState().undo[0]).toMatchObject({
      divergence: "graphics",
    });
  });

  it("omits divergence for a long-form direct edit", async () => {
    const call = vi.fn().mockResolvedValue(result(
      "txn_aaaaaaaaaa",
      "rev_00002",
      [GRAPHIC_REMOVE],
    ));
    vi.stubGlobal("window", { guyditor: { call } });

    await executeDirect([GRAPHIC_ADD], "Add long-form graphic");

    expect(call.mock.calls[0]?.[2]).not.toHaveProperty("divergence");
    expect(useUndoStore.getState().undo[0]).not.toHaveProperty("divergence");
  });
});
