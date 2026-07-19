import { describe, expect, it } from "vitest";

import type { ContinuityWarning, GuyditorProject } from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";
import {
  DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG,
  findJumpCutWarnings,
  planJumpCutConcealment,
} from "./jumpcuts.js";

function jumpCut(beforeClip: string, afterClip: string): ContinuityWarning {
  return {
    code: "jump-cut",
    severity: "info",
    boundary: { beforeClip, afterClip },
    evidence: `same-source discontinuity ${beforeClip}/${afterClip}`,
  };
}

function scriptedProject(): GuyditorProject {
  const project = projectFixture();
  project.assets[0]!.probe.height = 2160;
  project.assets[0]!.probe.width = 3840;
  project.assets[0]!.video = {
    codec: "h264",
    width: 3840,
    height: 2160,
    fps: "24/1",
    pixFmt: "yuv420p",
    hasAlpha: false,
    rotation: 0,
  };
  project.presets.push({
    id: "pre_smoothcut2",
    name: "smooth-cut",
    kind: "transition",
    version: 1,
    path: "presets/pre_smoothcut2@1.yaml",
    sha256: "b".repeat(64),
  });
  const clipIds = [
    "clp_aaaaaaaaaa",
    "clp_bbbbbbbbbb",
    "clp_cccccccccc",
    "clp_dddddddddd",
  ];
  project.sequences[0]!.clips = [0, 1, 2, 3].map((index) => ({
    id: clipIds[index]!,
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: index * 48, fps: "24/1" },
      out: { frames: index * 48 + 36, fps: "24/1" },
    },
  }));
  return project;
}

describe("jump-cut concealment planning", () => {
  it("surfaces qualifying same-source discontinuities from the continuity guard rule", () => {
    const warnings = findJumpCutWarnings(scriptedProject(), "seq_aaaaaaaaaa");
    expect(warnings.map(({ boundary }) => boundary)).toEqual([
      { beforeClip: "clp_aaaaaaaaaa", afterClip: "clp_bbbbbbbbbb" },
      { beforeClip: "clp_bbbbbbbbbb", afterClip: "clp_cccccccccc" },
      { beforeClip: "clp_cccccccccc", afterClip: "clp_dddddddddd" },
    ]);
  });

  it("alternates adjacent feasible punch levels across a scripted same-source run", () => {
    const project = scriptedProject();
    const result = planJumpCutConcealment({
      project,
      sequenceId: "seq_aaaaaaaaaa",
      warnings: [
        jumpCut("clp_aaaaaaaaaa", "clp_bbbbbbbbbb"),
        jumpCut("clp_bbbbbbbbbb", "clp_cccccccccc"),
        jumpCut("clp_cccccccccc", "clp_dddddddddd"),
      ],
      config: DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG,
      faceTracks: { ast_aaaaaaaaaa: { usable: true, framingStatic: true } },
    });

    expect(result.kind).toBe("proposal");
    if (result.kind !== "proposal") throw new Error("expected proposal");
    expect(result.operations.map(({ op, params }) => ({ op, params }))).toEqual([
      {
        op: "clip.punchin.set",
        params: { clipId: "clp_bbbbbbbbbb", level: 1.12, anchor: "face-track" },
      },
      {
        op: "clip.punchin.set",
        params: { clipId: "clp_cccccccccc", level: 1.25, anchor: "face-track" },
      },
      {
        op: "clip.punchin.set",
        params: { clipId: "clp_dddddddddd", level: 1.12, anchor: "face-track" },
      },
    ]);
    expect(result.reasons).toHaveLength(3);
    expect(result.reasons.every(({ text, evidence }) =>
      text.includes("jump-cut density") && evidence.includes("same-source discontinuity"),
    )).toBe(true);
    expect(result.reviewRequired).toBe(true);
    expect(result.directApply).toBe(false);
  });

  it("prefers a synchronized alternate and otherwise reports angle switching N/A", () => {
    const project = scriptedProject();
    project.assets.push({
      ...structuredClone(project.assets[0]!),
      id: "ast_bbbbbbbbbb",
      path: "media/b.mov",
      sha256: "b".repeat(64),
      sync: {
        referenceAssetId: "ast_aaaaaaaaaa",
        method: "manual",
        offset: { samples: 0, rate: 48_000 },
        evidence: { clap: true },
        decidedBy: "creator",
        decidedAt: "2026-07-19T10:00:00Z",
      },
    });
    project.sequences[0]!.clips[1]!.effects = [{
      id: "fx_aaaaaaaaaa",
      kind: "transform",
      params: { scale: 1.05 },
    }];

    const withAlternate = planJumpCutConcealment({
      project,
      sequenceId: "seq_aaaaaaaaaa",
      warnings: [jumpCut("clp_aaaaaaaaaa", "clp_bbbbbbbbbb")],
      config: DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG,
      faceTracks: {},
    });
    expect(withAlternate).toMatchObject({
      kind: "proposal",
      angleSwitching: "available",
      operations: [{
        op: "clip.source.switch",
        params: {
          clipId: "clp_bbbbbbbbbb",
          assetId: "ast_bbbbbbbbbb",
          synchronizedTo: "ast_aaaaaaaaaa",
        },
      }],
    });

    project.assets.pop();
    const withoutAlternate = planJumpCutConcealment({
      project,
      sequenceId: "seq_aaaaaaaaaa",
      warnings: [jumpCut("clp_aaaaaaaaaa", "clp_bbbbbbbbbb")],
      config: DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG,
      faceTracks: {},
    });
    expect(withoutAlternate).toMatchObject({
      kind: "proposal",
      angleSwitching: "not-applicable",
      operations: [{
        op: "transition.set",
        params: {
          boundary: {
            beforeClipId: "clp_aaaaaaaaaa",
            afterClipId: "clp_bbbbbbbbbb",
          },
          kind: "preset",
          presetId: "pre_smoothcut2",
          duration: { frames: 3, fps: "24/1" },
        },
      }],
    });
  });

  it("returns a report without operations when no flagged boundaries are in scope", () => {
    expect(planJumpCutConcealment({
      project: scriptedProject(),
      sequenceId: "seq_aaaaaaaaaa",
      warnings: [],
      config: DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG,
      faceTracks: {},
    })).toEqual({
      kind: "no-proposal",
      angleSwitching: "not-applicable",
      declined: [],
      report: "No jump-cut boundaries were flagged in the requested scope.",
    });
  });
});
