import { afterEach, describe, expect, it, vi } from "vitest";

import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import { usePreviewStore, useSelectionStore } from "./state/view-state.js";
import { jumpToWordRange, timelineFrameForSource } from "./workspace-navigation.js";

const ASSET = "ast_aaaaaaaaaa";

/** Clip A shows source 0–24; clip B shows source 120–168 after a 12-frame gap. */
function project() {
  const model = projectFixture();
  model.sequences[0]!.clips[1]!.source = {
    in: { frames: 120, fps: "24/1" },
    out: { frames: 168, fps: "24/1" },
  };
  model.sequences[0]!.clips[1]!.gapBefore = { frames: 12, fps: "24/1" };
  return model;
}

describe("timelineFrameForSource", () => {
  it("maps a source frame inside a clip to its timeline frame", () => {
    expect(timelineFrameForSource(project(), ASSET, { frames: 10, fps: "24/1" }))
      .toEqual({ frames: 10, fps: "24/1" });
    // 24 (clip A) + 12 (gap) + 10 into clip B.
    expect(timelineFrameForSource(project(), ASSET, { frames: 130, fps: "24/1" }))
      .toEqual({ frames: 46, fps: "24/1" });
  });

  it("converts a sample-rate source time to sequence frames", () => {
    expect(timelineFrameForSource(project(), ASSET, { frames: 260_000, fps: "48000/1" }))
      .toEqual({ frames: 46, fps: "24/1" });
  });

  it("returns null when the footage is not on the timeline", () => {
    expect(timelineFrameForSource(project(), ASSET, { frames: 60, fps: "24/1" })).toBeNull();
    // source.out is exclusive.
    expect(timelineFrameForSource(project(), ASSET, { frames: 168, fps: "24/1" })).toBeNull();
    expect(timelineFrameForSource(project(), "ast_bbbbbbbbbb", { frames: 10, fps: "24/1" })).toBeNull();
  });
});

describe("jumpToWordRange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWord(seconds: number) {
    vi.stubGlobal("document", { querySelector: () => null });
    vi.stubGlobal("window", {
      guyditor: {
        call: () => Promise.resolve({ assetId: ASSET, word: { start: { samples: seconds * 48_000, rate: 48_000 } } }),
      },
    });
  }

  it("moves the playhead to the timeline frame when the footage is on the timeline", async () => {
    stubWord(130 / 24);
    usePreviewStore.getState().setPlayhead({ frames: 3, fps: "24/1" });
    const notice = vi.fn();
    await jumpToWordRange(project(), ASSET, "w000001", "w000002", notice);
    expect(usePreviewStore.getState().playhead).toEqual({ frames: 46, fps: "24/1" });
    expect(useSelectionStore.getState().wordRange).toEqual({ fromWord: "w000001", toWord: "w000002" });
    expect(notice).not.toHaveBeenCalled();
  });

  it("selects the words and explains when the footage is not on the timeline", async () => {
    stubWord(60 / 24);
    usePreviewStore.getState().setPlayhead({ frames: 3, fps: "24/1" });
    const notice = vi.fn();
    await jumpToWordRange(project(), ASSET, "w000003", "w000004", notice);
    expect(usePreviewStore.getState().playhead).toEqual({ frames: 3, fps: "24/1" });
    expect(useSelectionStore.getState().wordRange).toEqual({ fromWord: "w000003", toWord: "w000004" });
    expect(notice).toHaveBeenCalledWith("Footage is not on the timeline yet; selected it in the transcript.");
  });
});
