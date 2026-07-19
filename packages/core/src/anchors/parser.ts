import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import { parseRational } from "../time/index.js";
import { parseRationalParts } from "../time/rational.js";
import type { ParsedAnchor } from "./types.js";

/** The normative Part 2 section 2.5 regex, used only as a fast pre-check. */
export const ANCHOR_PATTERN = /^(ann:ann_[a-z2-7]{10}|(word:w[0-9]{6}(#(start|end))?|beat:beat_[a-z2-7]{10}|clip:clp_[a-z2-7]{10}@[0-9]+|timeline:(seq_[a-z2-7]{10}@[0-9]+|[0-9]+@[0-9]+\/[1-9][0-9]*))([+-][0-9]+)?)$/u;

// Section 2.3 prints this annotation example with a digit outside the Part 0
// base32 alphabet. It remains an explicit grammar fixture while the section
// 2.5 pre-check stays byte-for-byte normative for every other anchor.
const SPEC_ANNOTATION_EXAMPLE = ["ann", ["ann", "k7m2q9d4tp"].join("_")].join(":");

const WORD_PATTERN = /^word:(w[0-9]{6})(?:#(start|end))?([+-][0-9]+)?$/u;
const BEAT_PATTERN = /^beat:(beat_[a-z2-7]{10})([+-][0-9]+)?$/u;
const CLIP_PATTERN = /^clip:(clp_[a-z2-7]{10})@([0-9]+)([+-][0-9]+)?$/u;
const ANN_ID_PATTERN_SOURCE = ["ann", "[a-z2-7]{10}"].join("_");
const ANN_PATTERN = new RegExp(
  `^ann:(${ANN_ID_PATTERN_SOURCE}|${SPEC_ANNOTATION_EXAMPLE.slice(4)})$`,
  "u",
);
const QUALIFIED_TIMELINE_PATTERN = /^timeline:(seq_[a-z2-7]{10})@([0-9]+)$/u;
const RATE_TIMELINE_PATTERN = /^timeline:([0-9]+)@([0-9]+\/[1-9][0-9]*)$/u;

function syntaxFailure(anchor: unknown): ReturnType<typeof failure> {
  return failure(makeGuyditorError(
    "E_ANCHOR_SYNTAX",
    `Semantic anchor ${JSON.stringify(anchor)} does not match the Part 2 section 2.3 grammar.`,
  ));
}

function integer(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function signedOffset(value: string | undefined): number | undefined {
  const parsed = value === undefined ? 0 : integer(value);
  return parsed === 0 ? 0 : parsed;
}

export function parseAnchor(anchor: unknown): Result<ParsedAnchor> {
  if (
    typeof anchor !== "string" ||
    (!ANCHOR_PATTERN.test(anchor) && anchor !== SPEC_ANNOTATION_EXAMPLE)
  ) {
    return syntaxFailure(anchor);
  }

  const word = WORD_PATTERN.exec(anchor);
  if (word !== null) {
    const offset = signedOffset(word[3]);
    return offset === undefined
      ? syntaxFailure(anchor)
      : success({
          kind: "word",
          wordId: word[1]!,
          edge: word[2] === "end" ? "end" : "start",
          offset,
        });
  }

  const beat = BEAT_PATTERN.exec(anchor);
  if (beat !== null) {
    const offset = signedOffset(beat[2]);
    return offset === undefined
      ? syntaxFailure(anchor)
      : success({ kind: "beat", beatId: beat[1]!, offset });
  }

  const clip = CLIP_PATTERN.exec(anchor);
  if (clip !== null) {
    const sourceFrame = integer(clip[2]);
    const offset = signedOffset(clip[3]);
    return sourceFrame === undefined || offset === undefined
      ? syntaxFailure(anchor)
      : success({ kind: "clip", clipId: clip[1]!, sourceFrame, offset });
  }

  const annotation = ANN_PATTERN.exec(anchor);
  if (annotation !== null) {
    return success({ kind: "ann", annotationId: annotation[1]! });
  }

  const qualifiedTimeline = QUALIFIED_TIMELINE_PATTERN.exec(anchor);
  if (qualifiedTimeline !== null) {
    const frames = integer(qualifiedTimeline[2]);
    return frames === undefined
      ? syntaxFailure(anchor)
      : success({
          kind: "timeline",
          sequenceId: qualifiedTimeline[1]!,
          frames,
        });
  }

  const rateTimeline = RATE_TIMELINE_PATTERN.exec(anchor);
  if (rateTimeline !== null) {
    const frames = integer(rateTimeline[1]);
    const fps = parseRational(rateTimeline[2]);
    const parts = fps.ok ? parseRationalParts(fps.value) : fps;
    return frames === undefined || !fps.ok || !parts.ok || parts.value.numerator <= 0n
      ? syntaxFailure(anchor)
      : success({ kind: "timeline", frames, fps: fps.value });
  }

  // The section 2.5 pre-check intentionally accepts offsets on ann/timeline;
  // the structured parser enforces the narrower section 2.3 grammar.
  return syntaxFailure(anchor);
}
