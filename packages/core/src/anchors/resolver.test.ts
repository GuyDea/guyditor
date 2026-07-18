import { describe, expect, it } from "vitest";

import {
  resolveAnchor,
  resolveAnchorRange,
} from "../index.js";
import type {
  AnchorResolution,
  AnchorResolverDependencies,
  GuyditorProject,
  Result,
  WordLookup,
  WordLookupResolution,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const SCOPE = "seq_aaaaaaaaaa";

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function lookup(
  words: Readonly<Record<string, WordLookupResolution | undefined>>,
): WordLookup {
  return {
    resolveWord(_project, wordId) {
      return Promise.resolve({ ok: true, value: words[wordId] });
    },
  };
}

function word(
  overrides: Partial<WordLookupResolution> = {},
): WordLookupResolution {
  return {
    wordId: "w000042",
    assetId: "ast_aaaaaaaaaa",
    start: { samples: 500, rate: 1_000 },
    end: { samples: 750, rate: 1_000 },
    approximate: false,
    context: { wordsBefore: ["before"], wordsAfter: ["after"] },
    ...overrides,
  };
}

async function resolve(
  project: GuyditorProject,
  anchor: string,
  deps: AnchorResolverDependencies = {},
  scope: string | undefined = SCOPE,
): Promise<AnchorResolution> {
  return valueOf(resolveAnchor(project, anchor, scope, deps));
}

describe("resolveAnchor", () => {
  it("defaults scope to the primary long-form deliverable", async () => {
    const project = projectFixture();
    expect(await resolve(project, "timeline:12@24/1", {}, undefined)).toEqual({
      status: "resolved",
      timeline: { frames: 12, fps: "24/1" },
    });
  });

  it("resolves qualified and rate-qualified timeline anchors", async () => {
    const project = projectFixture();
    expect(await resolve(project, "timeline:seq_aaaaaaaaaa@12")).toEqual({
      status: "resolved",
      timeline: { frames: 12, fps: "24/1" },
    });
    expect(await resolve(project, "timeline:25@50/1")).toEqual({
      status: "resolved",
      timeline: { frames: 12, fps: "24/1" },
    });
  });

  it("rounds exact conversion ties toward the earlier frame", async () => {
    expect(await resolve(projectFixture(), "timeline:1@48/1")).toEqual({
      status: "resolved",
      timeline: { frames: 0, fps: "24/1" },
    });
  });

  it("orphans timeline positions only when they exceed the duration", async () => {
    const project = projectFixture();
    expect(await resolve(project, "timeline:48@24/1")).toMatchObject({
      status: "resolved",
      timeline: { frames: 48 },
    });
    expect(await resolve(project, "timeline:49@24/1")).toEqual({
      status: "orphaned",
      reason: "beyond-timeline",
    });
  });

  it("resolves clip anchors from the current in-point and follows sequence reorders", async () => {
    const project = projectFixture();
    expect(await resolve(project, "clip:clp_bbbbbbbbbb@6")).toEqual({
      status: "resolved",
      timeline: { frames: 30, fps: "24/1" },
      source: {
        assetId: "ast_aaaaaaaaaa",
        time: { frames: 30, fps: "24/1" },
      },
    });

    project.sequences[0]!.clips.reverse();
    expect(await resolve(project, "clip:clp_bbbbbbbbbb@6")).toMatchObject({
      status: "resolved",
      timeline: { frames: 6, fps: "24/1" },
      source: { time: { frames: 30, fps: "24/1" } },
    });
  });

  it("uses offset-out-of-range for clip-relative positions outside [in,out)", async () => {
    const project = projectFixture();
    expect(await resolve(project, "clip:clp_aaaaaaaaaa@24")).toEqual({
      status: "orphaned",
      reason: "offset-out-of-range",
    });
    expect(await resolve(project, "clip:clp_aaaaaaaaaa@0-1")).toEqual({
      status: "orphaned",
      reason: "offset-out-of-range",
    });
    expect(await resolve(project, "clip:clp_zzzzzzzzzz@0")).toEqual({
      status: "orphaned",
      reason: "clip-deleted",
    });
  });

  it("checks a clip offset in source time, then applies it in timeline frames", async () => {
    const project = projectFixture();
    project.settings.timeline.fps = "24/1";
    project.assets[0]!.probe.fps = "48/1";
    project.sequences[0]!.clips[0]!.source = {
      in: { frames: 10, fps: "48/1" },
      out: { frames: 30, fps: "48/1" },
    };
    project.sequences[0]!.clips = [project.sequences[0]!.clips[0]!];

    expect(await resolve(project, "clip:clp_aaaaaaaaaa@2+3")).toEqual({
      status: "resolved",
      timeline: { frames: 4, fps: "24/1" },
      source: {
        assetId: "ast_aaaaaaaaaa",
        time: { frames: 12, fps: "48/1" },
      },
    });
  });

  it("resolves word edges and carries approximate/source metadata", async () => {
    const project = projectFixture();
    const deps = { wordLookup: lookup({
      w000042: word({ approximate: true }),
    }) };
    expect(await resolve(project, "word:w000042#end", deps)).toEqual({
      status: "resolved",
      timeline: { frames: 18, fps: "24/1" },
      approximate: true,
      source: {
        assetId: "ast_aaaaaaaaaa",
        time: { frames: 18, fps: "24/1" },
      },
    });
  });

  it("uses the earliest derived clip when footage is duplicated", async () => {
    const project = projectFixture();
    project.sequences[0]!.clips[1]!.source = {
      in: { frames: 0, fps: "24/1" },
      out: { frames: 24, fps: "24/1" },
    };
    const deps = { wordLookup: lookup({ w000042: word() }) };
    expect(await resolve(project, "word:w000042", deps)).toMatchObject({
      status: "resolved",
      timeline: { frames: 12 },
    });

    project.sequences[0]!.clips.reverse();
    expect(await resolve(project, "word:w000042", deps)).toMatchObject({
      status: "resolved",
      timeline: { frames: 12 },
    });
  });

  it("reports word-deleted and word-not-in-edit without guessing", async () => {
    const project = projectFixture();
    expect(await resolve(project, "word:w000042", {
      wordLookup: lookup({}),
    })).toEqual({ status: "orphaned", reason: "word-deleted" });
    expect(await resolve(project, "word:w000042", {
      wordLookup: lookup({
        w000042: word({ assetId: "ast_bbbbbbbbbb" }),
      }),
    })).toEqual({ status: "orphaned", reason: "word-not-in-edit" });
  });

  it("resolves beats at depth one and maps nested failures to beat-orphaned", async () => {
    const project = projectFixture();
    project.beats.push({
      id: "beat_aaaaaaaaaa",
      name: "hook",
      anchor: "timeline:12@24/1",
    });
    expect(await resolve(project, "beat:beat_aaaaaaaaaa+2")).toEqual({
      status: "resolved",
      timeline: { frames: 14, fps: "24/1" },
    });
    expect(await resolve(project, "beat:beat_bbbbbbbbbb")).toEqual({
      status: "orphaned",
      reason: "beat-orphaned",
    });
    project.beats[0]!.anchor = "beat:beat_aaaaaaaaaa";
    expect(await resolve(project, "beat:beat_aaaaaaaaaa")).toEqual({
      status: "orphaned",
      reason: "beat-orphaned",
    });
  });

  it("uses a registered annotation callback and otherwise reports ann-orphaned", async () => {
    const project = projectFixture();
    expect(await resolve(project, "ann:ann_aaaaaaaaaa")).toEqual({
      status: "orphaned",
      reason: "ann-orphaned",
    });
    expect(await resolve(project, "ann:ann_aaaaaaaaaa", {
      annotationResolver: {
        resolveAnnotation(_project, annotationId, sequenceId) {
          expect(annotationId).toBe("ann_aaaaaaaaaa");
          expect(sequenceId).toBe(SCOPE);
          return Promise.resolve({
            ok: true,
            value: {
              status: "resolved",
              timeline: { frames: 9, fps: "24/1" },
            },
          });
        },
      },
    })).toEqual({
      status: "resolved",
      timeline: { frames: 9, fps: "24/1" },
    });
  });

  it("applies offsets without clamping and orphans either boundary overflow", async () => {
    const project = projectFixture();
    const deps = { wordLookup: lookup({ w000042: word() }) };
    expect(await resolve(project, ["word:w000042", "-13"].join(""), deps)).toEqual({
      status: "orphaned",
      reason: "beyond-timeline",
    });
    expect(await resolve(project, "word:w000042+37", deps)).toEqual({
      status: "orphaned",
      reason: "beyond-timeline",
    });
  });

  it("validates AnchorRange end strictly after start at resolution time", async () => {
    const project = projectFixture();
    expect(await valueOf(resolveAnchorRange(project, {
      start: "timeline:1@24/1",
      end: "timeline:2@24/1",
    }, SCOPE, {}))).toMatchObject({
      start: { timeline: { frames: 1 } },
      end: { timeline: { frames: 2 } },
    });
    await expect(resolveAnchorRange(project, {
      start: "timeline:2@24/1",
      end: "timeline:2@24/1",
    }, SCOPE, {})).resolves.toMatchObject({
      ok: false,
      error: { code: "E_ANCHOR_RANGE" },
    });
  });
});
