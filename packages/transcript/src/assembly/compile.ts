import {
  convertTimeRounding, failure, makeGuyditorError, success,
  type Annotation, type FrameTime, type OperationInput, type Rational, type Result,
} from "../../../core/src/index.js";
import type { SampleTime, TranscriptWord } from "../types.js";
import type { AssemblyPlan, CandidateSegment, CompiledCut } from "./types.js";

export interface CompileContext {
  sequenceId: string;
  layerId: string;
  fps: Rational;
  existingClips: { in: FrameTime; out: FrameTime; gapBefore?: FrameTime | null }[];
  words: Map<string, TranscriptWord & { assetId: string }>;
  segments: CandidateSegment[];
  assetDurations: Map<string, FrameTime>;
  /** Default 120. */
  leadPadMs?: number;
  /** Default 200. */
  tailPadMs?: number;
}

const DEFAULT_LEAD_PAD_MS = 120;
const DEFAULT_TAIL_PAD_MS = 200;

function outOfRange(message: string): Result<never> {
  return failure(makeGuyditorError("E_ASSEMBLY_CUT_OUT_OF_RANGE", message, { retry: "none" }));
}

function toFrames(samples: number, rate: number, fps: Rational): Result<FrameTime> {
  const rounded = convertTimeRounding({ frames: samples, fps: `${String(rate)}/1` }, fps);
  return rounded.ok ? success(rounded.value.time) : rounded;
}

/** Samples at `rate` converted to `reference`'s rate (rounded). */
function atRate(time: SampleTime, rate: number): number {
  return Math.round((time.samples * rate) / time.rate);
}

function neighbourBounds(
  assetId: string, first: TranscriptWord, last: TranscriptWord,
  ctx: CompileContext,
): { prevEnd: number | null; nextStart: number | null } {
  const rate = first.start.rate;
  let prevEnd: number | null = null;
  let nextStart: number | null = null;
  for (const seg of ctx.segments) {
    if (seg.assetId !== assetId) continue;
    const from = ctx.words.get(seg.fromWord);
    const to = ctx.words.get(seg.toWord);
    if (!from || !to) continue;
    const segStart = atRate(from.start, rate);
    const segEnd = atRate(to.end, rate);
    if (segEnd <= atRate(first.start, rate) && segStart < atRate(first.start, rate)) {
      prevEnd = prevEnd === null ? segEnd : Math.max(prevEnd, segEnd);
    } else if (segStart >= atRate(last.end, rate) && segEnd > atRate(last.end, rate)) {
      nextStart = nextStart === null ? segStart : Math.min(nextStart, segStart);
    }
  }
  // Inside a segment the nearest active words bound the padding too (whichever is tighter).
  const firstStart = atRate(first.start, rate);
  const lastEnd = atRate(last.end, rate);
  for (const word of ctx.words.values()) {
    if (word.assetId !== assetId || word.state !== "active") continue;
    const start = atRate(word.start, rate);
    const end = atRate(word.end, rate);
    if (end <= firstStart && start < firstStart) {
      prevEnd = prevEnd === null ? end : Math.max(prevEnd, end);
    } else if (start >= lastEnd && end > lastEnd) {
      nextStart = nextStart === null ? start : Math.min(nextStart, start);
    }
  }
  return { prevEnd, nextStart };
}

export function compileAssemblyPlan(
  plan: AssemblyPlan, context: CompileContext,
): Result<{ operations: OperationInput[]; cuts: CompiledCut[] }> {
  const leadMs = context.leadPadMs ?? DEFAULT_LEAD_PAD_MS;
  const tailMs = context.tailPadMs ?? DEFAULT_TAIL_PAD_MS;
  let cursor = context.existingClips.reduce(
    (sum, clip) => sum + (clip.gapBefore?.frames ?? 0) + (clip.out.frames - clip.in.frames), 0,
  );
  const operations: OperationInput[] = [];
  const cuts: CompiledCut[] = [];

  for (const [i, cut] of plan.cuts.entries()) {
    const first = context.words.get(cut.fromWord);
    const last = context.words.get(cut.toWord);
    const duration = context.assetDurations.get(cut.assetId);
    if (!first || !last || !duration) {
      return outOfRange(`Cut ${String(i)} references an unknown word or asset.`);
    }
    const rate = first.start.rate;
    const { prevEnd, nextStart } = neighbourBounds(cut.assetId, first, last, context);
    const firstStart = atRate(first.start, rate);
    const lastEnd = atRate(last.end, rate);
    const lead = Math.round((leadMs * rate) / 1000);
    const tail = Math.round((tailMs * rate) / 1000);
    const inSamples = Math.max(0, prevEnd ?? 0, firstStart - lead);
    const outSamples = Math.min(nextStart ?? Infinity, lastEnd + tail);

    const inFrames = toFrames(inSamples, rate, context.fps);
    if (!inFrames.ok) return inFrames;
    const outFrames = toFrames(outSamples, rate, context.fps);
    if (!outFrames.ok) return outFrames;
    const durationFrames = convertTimeRounding(duration, context.fps);
    if (!durationFrames.ok) return durationFrames;
    const limit = durationFrames.value.time.frames;
    const wordEnd = toFrames(lastEnd, rate, context.fps);
    if (!wordEnd.ok) return wordEnd;
    if (wordEnd.value.frames > limit) {
      return outOfRange(`Cut ${String(i)} ends beyond asset ${cut.assetId} duration.`);
    }
    const inF = inFrames.value.frames;
    const outF = Math.min(outFrames.value.frames, limit);
    if (inF >= outF) return outOfRange(`Cut ${String(i)} has no positive length after padding.`);

    const index = context.existingClips.length + i;
    const inTime: FrameTime = { frames: inF, fps: context.fps };
    const outTime: FrameTime = { frames: outF, fps: context.fps };
    operations.push({
      op: "clip.insert",
      params: {
        sequenceId: context.sequenceId, index, layerId: context.layerId, evidence: cut.reason,
        source: { assetId: cut.assetId, in: inTime, out: outTime },
      },
    });
    cuts.push({
      index, assetId: cut.assetId, in: inTime, out: outTime,
      timelineStart: { frames: cursor, fps: context.fps },
      extent: { frames: outF - inF, fps: context.fps },
      reason: cut.reason,
      flags: plan.flags.filter((flag) => flag.cutIndex === i),
    });
    cursor += outF - inF;
  }
  return success({ operations, cuts });
}

export function reviewMarkerAnnotations(
  cuts: CompiledCut[],
  input: {
    sequenceId: string; deliverableId: string; aspect: string; authorId: string; now: string;
    idFactory: (prefix: "ann") => string;
  },
): Annotation[] {
  return cuts.filter((cut) => cut.flags.length > 0).map((cut) => ({
    id: input.idFactory("ann"),
    shape: "range",
    body: cut.flags.map((flag) => `${flag.kind}: ${flag.note}`).join(" | "),
    geometry: null,
    anchor: { kind: "timeline", sequenceId: input.sequenceId, frame: cut.timelineStart },
    extent: cut.extent,
    canvasRef: { sequenceId: input.sequenceId, deliverableId: input.deliverableId, aspect: input.aspect },
    state: "open",
    blocking: false,
    author: { kind: "agent", id: input.authorId },
    createdAt: input.now,
    history: [],
  }));
}
