import { convertTimeRounding } from "../../../core/src/index.js";
import type { FrameTime, GuyditorProject, Proposal, Rational } from "../../../core/src/index.js";
import type {
  AssemblyPlan,
  AssemblySession,
  CompiledCut,
  CompileContext,
  SourceSampleRange,
  TranscriptSidecar,
} from "../../../transcript/src/index.js";

const REASON_LIMIT = 280;
// Deliverables carry no aspect field; the master is the 16:9 long-form cut.
export const MASTER_ASPECT = "16:9";

export interface AssemblyTarget {
  sequenceId: string;
  deliverableId: string;
  layerId: string;
  fps: Rational;
  aspect: string;
}

function fail(detail: string): Error {
  return new Error(`E_ASSEMBLY_PROJECT: ${detail}`);
}

export function assemblyTarget(project: GuyditorProject): AssemblyTarget {
  const deliverableId = project.settings.primaryDeliverable;
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  if (deliverable === undefined) throw fail("the primary deliverable does not exist");
  const layer = project.layers
    .filter(({ kind, sequence }) => kind === "video" && sequence === deliverable.sequenceId)
    .sort((a, b) => a.order - b.order)[0];
  if (layer === undefined) throw fail("the master sequence has no video layer for A-roll");
  return {
    sequenceId: deliverable.sequenceId,
    deliverableId,
    layerId: layer.id,
    fps: project.settings.timeline.fps,
    aspect: MASTER_ASPECT,
  };
}

function atFps(time: { frames: number; fps: Rational }, fps: Rational): FrameTime {
  const converted = convertTimeRounding(time, fps);
  if (!converted.ok) throw fail(converted.error.message);
  return converted.value.time;
}

export function compileContext(
  project: GuyditorProject,
  session: AssemblySession,
  sidecars: readonly TranscriptSidecar[],
): CompileContext {
  const target = assemblyTarget(project);
  const { fps } = target;
  const sequence = project.sequences.find(({ id }) => id === target.sequenceId);
  if (sequence === undefined) throw fail("the master sequence does not exist");
  const words: CompileContext["words"] = new Map();
  for (const sidecar of sidecars.filter(({ assetId }) => session.inputs.assetIds.includes(assetId))) {
    for (const [id, word] of Object.entries(sidecar.words)) words.set(id, { ...word, assetId: sidecar.assetId });
  }
  const assetDurations: CompileContext["assetDurations"] = new Map();
  for (const assetId of session.inputs.assetIds) {
    const duration = project.assets.find(({ id }) => id === assetId)?.probe.duration;
    if (duration === undefined) continue;
    const raw = "samples" in duration
      ? { frames: duration.samples, fps: `${String(duration.rate)}/1` as Rational }
      : duration;
    assetDurations.set(assetId, atFps(raw, fps));
  }
  return {
    sequenceId: target.sequenceId,
    layerId: target.layerId,
    fps,
    existingClips: sequence.clips.map((clip) => ({
      in: { frames: 0, fps },
      out: atFps({ frames: clip.source.out.frames - clip.source.in.frames, fps: clip.source.in.fps }, fps),
      gapBefore: clip.gapBefore === undefined ? null : atFps(clip.gapBefore, fps),
    })),
    words,
    segments: session.evidence?.segments ?? [],
    assetDurations,
  };
}

/** The plan summary, cut at 280 characters with a trailing ellipsis when longer. */
export function proposalReason(plan: AssemblyPlan): string {
  const chars = [...plan.summary];
  return chars.length <= REASON_LIMIT ? plan.summary : `${chars.slice(0, REASON_LIMIT - 1).join("")}…`;
}

/** Source ranges the assembly kept, at each asset's transcript sample rate. */
export function keptRanges(
  cuts: readonly CompiledCut[],
  sidecars: readonly TranscriptSidecar[],
): SourceSampleRange[] {
  return cuts.flatMap((cut) => {
    const rate = sidecars.find(({ assetId }) => assetId === cut.assetId)?.audio.rate;
    if (rate === undefined) return [];
    const [num, den] = cut.in.fps.split("/").map(Number) as [number, number];
    const samples = (frames: number) => Math.round((frames * den * rate) / num);
    return [{
      assetId: cut.assetId,
      start: { samples: samples(cut.in.frames), rate },
      end: { samples: samples(cut.out.frames), rate },
    }];
  });
}

/** Cut start frames recomputed from the accepted sequence (gaps plus lengths of the clips before each cut). */
export function rederiveStarts(
  project: GuyditorProject,
  sequenceId: string,
  cuts: readonly CompiledCut[],
): CompiledCut[] {
  const sequence = project.sequences.find(({ id }) => id === sequenceId);
  if (sequence === undefined) return [...cuts];
  return cuts.map((cut) => {
    const { fps } = cut.timelineStart;
    if (cut.index >= sequence.clips.length) return cut;
    let frames = 0;
    for (const clip of sequence.clips.slice(0, cut.index)) {
      frames += (clip.gapBefore === undefined ? 0 : atFps(clip.gapBefore, fps).frames)
        + atFps({ frames: clip.source.out.frames - clip.source.in.frames, fps: clip.source.in.fps }, fps).frames;
    }
    return { ...cut, timelineStart: { frames, fps } };
  });
}

/**
 * An assembly proposal may be rebased over unrelated revisions only while the spot its clips go
 * to is untouched: the sequence still has exactly as many clips as the first insert index.
 */
export function isRebaseSafeAssemblyProposal(
  proposal: Pick<Proposal, "operations" | "reason">,
  project: GuyditorProject,
): boolean {
  if (proposal.operations.length === 0 || !proposal.operations.every(({ op }) => op === "clip.insert")) {
    return false;
  }
  if (!proposal.reason.sources.some(({ kind, ref }) => kind === "instruction" && /^asb_/u.test(ref))) return false;
  const indexes = proposal.operations.map(({ params }) => params["index"]);
  const sequenceIds = new Set(proposal.operations.map(({ params }) => params["sequenceId"]));
  if (sequenceIds.size !== 1 || indexes.some((index) => typeof index !== "number")) return false;
  const sequence = project.sequences.find(({ id }) => id === [...sequenceIds][0]);
  return sequence !== undefined && sequence.clips.length === Math.min(...(indexes as number[]));
}
