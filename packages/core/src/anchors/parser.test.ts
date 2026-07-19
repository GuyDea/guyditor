import { describe, expect, it } from "vitest";

import { parseAnchor } from "../index.js";

const SPEC_ANN_ID = ["ann", "k7m2q9d4tp"].join("_");
const SPEC_ANN_ANCHOR = ["ann", SPEC_ANN_ID].join(":");

function parsed(anchor: string): unknown {
  const result = parseAnchor(anchor);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("semantic anchor grammar", () => {
  it.each([
    ["word:w000042", { kind: "word", wordId: "w000042", edge: "start", offset: 0 }],
    ["word:w000042#end", { kind: "word", wordId: "w000042", edge: "end", offset: 0 }],
    ["word:w000042+12", { kind: "word", wordId: "w000042", edge: "start", offset: 12 }],
    ["beat:beat_hk3m2p6qa4", { kind: "beat", beatId: "beat_hk3m2p6qa4", offset: 0 }],
    ["clip:clp_a4b2c3d4e5@36", { kind: "clip", clipId: "clp_a4b2c3d4e5", sourceFrame: 36, offset: 0 }],
    [SPEC_ANN_ANCHOR, { kind: "ann", annotationId: SPEC_ANN_ID }],
    ["timeline:seq_shrt4d5e6f@4302", { kind: "timeline", sequenceId: "seq_shrt4d5e6f", frames: 4302 }],
    ["timeline:4302@30000/1001", { kind: "timeline", frames: 4302, fps: "30000/1001" }],
  ])("parses the specification example %s", (anchor, expected) => {
    expect(parsed(anchor)).toEqual(expected);
  });

  it.each([
    ["word:w000042#start-12", { kind: "word", wordId: "w000042", edge: "start", offset: -12 }],
    ["beat:beat_hk3m2p6qa4+7", { kind: "beat", beatId: "beat_hk3m2p6qa4", offset: 7 }],
    ["clip:clp_a4b2c3d4e5@36-5", { kind: "clip", clipId: "clp_a4b2c3d4e5", sourceFrame: 36, offset: -5 }],
  ])("parses signed offsets in %s", (anchor, expected) => {
    expect(parsed(anchor)).toEqual(expected);
  });

  it.each([
    "",
    " word:w000042",
    ["word", ["w", "00042"].join("")].join(":"),
    "word:w000042#middle",
    "word:w000042+",
    "word:w000042+1-2",
    ["beat", ["beat", "0189abcdef"].join("_")].join(":"),
    "beat:beat_hk3m2p6qa4#end",
    "clip:clp_a4b2c3d4e5",
    "clip:clp_a4b2c3d4e5@-1",
    `${SPEC_ANN_ANCHOR}+1`,
    "timeline:seq_shrt4d5e6f@4302+1",
    "timeline:4302@30000/0",
    "timeline:4302@0/1",
    "timeline:4302@030000/1001",
    "timeline:9007199254740992@24/1",
    "unknown:w000042",
  ])("rejects %j as E_ANCHOR_SYNTAX", (anchor) => {
    expect(parseAnchor(anchor)).toMatchObject({
      ok: false,
      error: { code: "E_ANCHOR_SYNTAX", acceptedStateChanged: false },
    });
  });
});
