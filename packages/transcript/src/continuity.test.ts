import { describe, expect, it } from "vitest";

import { OperationEngine } from "../../core/src/index.js";
import type {
  GuyditorProject,
  IdPrefix,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";

import {
  createTranscriptContinuityGuard,
} from "./continuity.js";
import type { ContinuityPeaks } from "./continuity.js";
import type { TranscriptSidecar } from "./types.js";

function project(): GuyditorProject {
  const model = projectFixture();
  model.assets[0]!.probe.duration = { frames: 120, fps: "24/1" };
  model.sequences[0]!.clips = [{
    id: "clp_aaaaaaaaaa",
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: 0, fps: "24/1" },
      out: { frames: 120, fps: "24/1" },
    },
  }];
  return model;
}

function transcript(): TranscriptSidecar {
  return {
    schema: "guyditor.transcript/v1",
    assetId: "ast_aaaaaaaaaa",
    audio: { rate: 48_000, channels: 1, streamIndex: 0 },
    language: "en",
    languageProbability: 1,
    provenance: {
      engine: { name: "test", version: "1", model: "fixture" },
      alignment: null,
      createdAt: "2026-07-19T00:00:00Z",
      jobId: "job_aaaaaaaaaa",
    },
    speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker" }],
    segments: [{
      id: "seg_aaaaaaaaaa",
      speaker: "spk_aaaaaaaaaa",
      language: "en",
      start: { samples: 0, rate: 48_000 },
      end: { samples: 240_000, rate: 48_000 },
      words: ["w000001"],
    }],
    words: {
      w000001: {
        text: "hello",
        punctBefore: "",
        punctAfter: "",
        start: { samples: 48_000, rate: 48_000 },
        end: { samples: 96_000, rate: 48_000 },
        confidence: 1,
        alignment: "ctc",
        state: "active",
        origin: "asr",
      },
    },
  };
}

function ids() {
  let clip = 0;
  return (prefix: IdPrefix): string => {
    if (prefix === "clp") {
      clip += 1;
      return clip === 1 ? "clp_bbbbbbbbbb" : "clp_cccccccccc";
    }
    if (prefix === "fx") return "fx_bbbbbbbbbb";
    return "txn_bbbbbbbbbb";
  };
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function context() {
  return { baseRevision: "rev_00001", origin: "ui" as const, dryRun: true };
}

describe("transcript audio continuity guards", () => {
  it("warns with word and measured-margin evidence for a cut inside a word", async () => {
    const engine = new OperationEngine(project(), {
      idFactory: ids(),
      continuityGuard: createTranscriptContinuityGuard({ sidecars: [transcript()] }),
    });

    const result = await valueOf(engine.execute([{
      op: "clip.split",
      params: { clipId: "clp_aaaaaaaaaa", at: 36 },
    }], context()));

    expect(result.applied[0]!.warnings).toContainEqual(expect.objectContaining({
      code: "clipped-phoneme-risk",
      severity: "warning",
      evidence: expect.stringMatching(/hello.*500 ms/u),
    }));
  });

  it("stays quiet when a cut is in transcript silence and peaks are unavailable", async () => {
    const sidecar = transcript();
    sidecar.segments[0]!.words.push("w000002");
    sidecar.words["w000002"] = {
      text: "tail",
      punctBefore: "",
      punctAfter: "",
      start: { samples: 216_000, rate: 48_000 },
      end: { samples: 240_000, rate: 48_000 },
      confidence: 1,
      alignment: "ctc",
      state: "active",
      origin: "asr",
    };
    const engine = new OperationEngine(project(), {
      idFactory: ids(),
      continuityGuard: createTranscriptContinuityGuard({
        sidecars: [sidecar],
        loadPeaks: async () => undefined,
      }),
    });

    const result = await valueOf(engine.execute([{
      op: "clip.split",
      params: { clipId: "clp_aaaaaaaaaa", at: 72 },
    }], context()));

    expect(result.applied[0]!.warnings).toEqual([]);
  });

  it("uses peaks to report click level and an ambience envelope jump", async () => {
    const data = Array.from({ length: 500 }, (_value, index) => {
      const bucket = Math.floor(index / 2);
      return bucket < 150 ? (index % 2 === 0 ? -4 : 4) : (index % 2 === 0 ? -110 : 110);
    });
    const peaks: ContinuityPeaks = {
      format: "guyditor.peaks/v1",
      assetId: "ast_aaaaaaaaaa",
      sourceHash: "a".repeat(64),
      sampleRate: 48_000,
      tiers: [{ samplesPerPeak: 960, data }],
    };
    const engine = new OperationEngine(project(), {
      idFactory: ids(),
      continuityGuard: createTranscriptContinuityGuard({
        sidecars: [transcript()],
        loadPeaks: async () => peaks,
      }),
    });

    const result = await valueOf(engine.execute([{
      op: "clip.split",
      params: { clipId: "clp_aaaaaaaaaa", at: 72 },
    }], context()));
    const warnings = result.applied[0]!.warnings;

    expect(warnings).toContainEqual(expect.objectContaining({
      code: "click-risk",
      evidence: expect.stringMatching(/dBFS.*peaks/u),
      suggestion: expect.stringContaining("3 ms micro-fade"),
    }));
    expect(warnings).toContainEqual(expect.objectContaining({
      code: "ambience-jump",
      evidence: expect.stringMatching(/300 ms.*dB/u),
      suggestion: expect.stringContaining("80 ms audio crossfade"),
    }));
    expect(warnings.every((warning) => warning.autoFix === undefined)).toBe(true);
  });
});
