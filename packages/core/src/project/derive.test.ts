import { describe, expect, it } from "vitest";

import { deriveTimeline } from "../index.js";
import type { GuyditorProject, Result, TimelineDerivation } from "../index.js";
import { projectFixture } from "./test-fixtures.js";

function valueOf<T>(result: Result<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function derive(project: GuyditorProject): TimelineDerivation {
  return valueOf(deriveTimeline(project, "seq_aaaaaaaaaa"));
}

describe("deriveTimeline", () => {
  it("derives gap, overlap, and incoming-transition boundaries", () => {
    const project = projectFixture();
    project.sequences[0]!.clips = [
      {
        id: "clp_aaaaaaaaaa",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 0, fps: "24/1" },
          out: { frames: 24, fps: "24/1" },
        },
      },
      {
        id: "clp_bbbbbbbbbb",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 24, fps: "24/1" },
          out: { frames: 48, fps: "24/1" },
        },
        gapBefore: { frames: 12, fps: "24/1" },
      },
      {
        id: "clp_cccccccccc",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 48, fps: "24/1" },
          out: { frames: 72, fps: "24/1" },
        },
        overlapPrevious: { frames: 6, fps: "24/1" },
        transitionAfter: {
          id: "trn_aaaaaaaaaa",
          preset: "built-in-cut",
          duration: { frames: 4, fps: "24/1" },
        },
      },
      {
        id: "clp_dddddddddd",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 72, fps: "24/1" },
          out: { frames: 96, fps: "24/1" },
        },
      },
    ];

    expect(derive(project)).toEqual({
      clips: [
        { clipId: "clp_aaaaaaaaaa", start: { frames: 0, fps: "24/1" }, duration: { frames: 24, fps: "24/1" } },
        { clipId: "clp_bbbbbbbbbb", start: { frames: 36, fps: "24/1" }, duration: { frames: 24, fps: "24/1" } },
        { clipId: "clp_cccccccccc", start: { frames: 54, fps: "24/1" }, duration: { frames: 24, fps: "24/1" } },
        { clipId: "clp_dddddddddd", start: { frames: 74, fps: "24/1" }, duration: { frames: 24, fps: "24/1" } },
      ],
      duration: "49/12",
    });
  });

  it("applies speed 5/4 and freeze hold in effect order", () => {
    const project = projectFixture();
    const clip = project.sequences[0]!.clips[0]!;
    clip.source.out = { frames: 30, fps: "24/1" };
    clip.effects = [
      { id: "fx_aaaaaaaaaa", kind: "speed", params: { rate: "5/4" } },
      {
        id: "fx_bbbbbbbbbb",
        kind: "freeze",
        params: { hold: { frames: 12, fps: "24/1" } },
      },
    ];
    project.sequences[0]!.clips = [clip];

    expect(derive(project)).toEqual({
      clips: [
        {
          clipId: clip.id,
          start: { frames: 0, fps: "24/1" },
          duration: { frames: 36, fps: "24/1" },
        },
      ],
      duration: "3/2",
    });
  });

  it("rounds only reported positions while exact fractions chain forward", () => {
    const project = projectFixture();
    project.settings.timeline.fps = "24/1";
    project.assets[0]!.probe.fps = "30/1";
    project.assets[0]!.probe.duration = { frames: 300, fps: "30/1" };
    project.sequences[0]!.clips = [
      {
        id: "clp_aaaaaaaaaa",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 0, fps: "30/1" },
          out: { frames: 1, fps: "30/1" },
        },
      },
      {
        id: "clp_bbbbbbbbbb",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 1, fps: "30/1" },
          out: { frames: 2, fps: "30/1" },
        },
      },
      {
        id: "clp_cccccccccc",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 2, fps: "30/1" },
          out: { frames: 3, fps: "30/1" },
        },
      },
    ];

    expect(derive(project)).toEqual({
      clips: [
        { clipId: "clp_aaaaaaaaaa", start: { frames: 0, fps: "24/1" }, duration: { frames: 1, fps: "24/1" } },
        { clipId: "clp_bbbbbbbbbb", start: { frames: 1, fps: "24/1" }, duration: { frames: 1, fps: "24/1" } },
        { clipId: "clp_cccccccccc", start: { frames: 2, fps: "24/1" }, duration: { frames: 1, fps: "24/1" } },
      ],
      duration: "1/10",
    });
  });

  it.each([
    {
      name: "incoming transition plus overlap",
      mutate(project: GuyditorProject): void {
        project.sequences[0]!.clips[0]!.transitionAfter = {
          id: "trn_aaaaaaaaaa",
          preset: "built-in-cut",
          duration: { frames: 1, fps: "24/1" },
        };
        project.sequences[0]!.clips[1]!.overlapPrevious = { frames: 1, fps: "24/1" };
      },
    },
    {
      name: "gap plus overlap",
      mutate(project: GuyditorProject): void {
        project.sequences[0]!.clips[1]!.gapBefore = { frames: 1, fps: "24/1" };
        project.sequences[0]!.clips[1]!.overlapPrevious = { frames: 1, fps: "24/1" };
      },
    },
    {
      name: "negative accumulated time",
      mutate(project: GuyditorProject): void {
        project.sequences[0]!.clips[0]!.source.out.frames = 1;
        project.sequences[0]!.clips[1]!.overlapPrevious = { frames: 2, fps: "24/1" };
      },
    },
  ])("rejects $name as E_TIMELINE_BOUNDARY", ({ mutate }) => {
    const project = projectFixture();
    mutate(project);

    expect(deriveTimeline(project, "seq_aaaaaaaaaa")).toMatchObject({
      ok: false,
      error: {
        code: "E_TIMELINE_BOUNDARY",
        acceptedStateChanged: false,
      },
    });
  });
});
