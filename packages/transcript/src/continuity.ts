import {
  absoluteSeconds,
  compareRational,
  convertTimeRounding,
  subRational,
} from "../../core/src/index.js";
import type {
  Clip,
  ContinuityGuard,
  ContinuityWarning,
  GuyditorProject,
  OperationInput,
  TimeValue,
} from "../../core/src/index.js";

import type { TranscriptSidecar } from "./types.js";
import type { SourceSampleRange } from "./fillers/types.js";

export interface ContinuityPeaksTier {
  samplesPerPeak: number;
  data: number[];
}

export interface ContinuityPeaks {
  format: "guyditor.peaks/v1";
  assetId: string;
  sourceHash: string;
  sampleRate: number;
  tiers: ContinuityPeaksTier[];
}

export interface TranscriptContinuityOptions {
  sidecars: readonly TranscriptSidecar[];
  loadPeaks?: (
    assetId: string,
  ) => ContinuityPeaks | undefined | Promise<ContinuityPeaks | undefined>;
}

interface BoundaryEdge {
  clipId?: string;
  assetId: string;
  time: TimeValue;
}

interface CutBoundary {
  sequenceId?: string;
  before?: BoundaryEdge;
  after?: BoundaryEdge;
}

function boundarySurface(boundary: CutBoundary): ContinuityWarning["boundary"] {
  return {
    ...(boundary.before?.clipId === undefined ? {} : { beforeClip: boundary.before.clipId }),
    ...(boundary.after?.clipId === undefined ? {} : { afterClip: boundary.after.clipId }),
  };
}

function edgeKey(edge: BoundaryEdge | undefined): string {
  if (edge === undefined) return "-";
  return `${edge.assetId}:${JSON.stringify(edge.time)}`;
}

function boundaryKey(boundary: CutBoundary): string {
  return `${boundary.sequenceId ?? "source"}:${edgeKey(boundary.before)}>${edgeKey(boundary.after)}`;
}

function projectBoundaries(project: GuyditorProject): CutBoundary[] {
  return project.sequences.flatMap((sequence) => {
    const clips = sequence.clips;
    if (clips.length === 0) return [];
    return [
      {
        sequenceId: sequence.id,
        after: {
          clipId: clips[0]!.id,
          assetId: clips[0]!.asset,
          time: clips[0]!.source.in,
        },
      },
      ...clips.slice(1).map((clip, index) => {
        const previous = clips[index]!;
        return {
          sequenceId: sequence.id,
          before: {
            clipId: previous.id,
            assetId: previous.asset,
            time: previous.source.out,
          },
          after: {
            clipId: clip.id,
            assetId: clip.asset,
            time: clip.source.in,
          },
        };
      }),
      {
        sequenceId: sequence.id,
        before: {
          clipId: clips.at(-1)!.id,
          assetId: clips.at(-1)!.asset,
          time: clips.at(-1)!.source.out,
        },
      },
    ];
  });
}

function movedBoundaries(before: GuyditorProject, after: GuyditorProject): CutBoundary[] {
  const existing = new Map<string, number>();
  for (const boundary of projectBoundaries(before)) {
    const key = boundaryKey(boundary);
    existing.set(key, (existing.get(key) ?? 0) + 1);
  }
  return projectBoundaries(after).filter((boundary) => {
    const key = boundaryKey(boundary);
    const count = existing.get(key) ?? 0;
    if (count === 0) return true;
    existing.set(key, count - 1);
    return false;
  });
}

function roundNearestTowardEarlier(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n <= denominator ? quotient : quotient + 1n;
}

function toSamples(value: TimeValue, rate: number): number | undefined {
  if ("samples" in value) {
    const converted = roundNearestTowardEarlier(
      BigInt(value.samples) * BigInt(rate),
      BigInt(value.rate),
    );
    return converted >= 0n && converted <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(converted)
      : undefined;
  }
  const converted = convertTimeRounding(value, `${String(rate)}/1`);
  return converted.ok ? converted.value.time.frames : undefined;
}

function formatMilliseconds(samples: number, rate: number): string {
  const numerator = BigInt(samples) * 1_000n;
  if (numerator % BigInt(rate) === 0n) return `${String(numerator / BigInt(rate))} ms`;
  return `${(samples * 1_000 / rate).toFixed(1)} ms`;
}

function wordWarnings(
  boundary: CutBoundary,
  sidecars: readonly TranscriptSidecar[],
): ContinuityWarning[] {
  const warnings: ContinuityWarning[] = [];
  const seen = new Set<string>();
  for (const edge of [boundary.before, boundary.after]) {
    if (edge === undefined) continue;
    const sidecar = sidecars.find(({ assetId }) => assetId === edge.assetId);
    if (sidecar === undefined) continue;
    const cut = toSamples(edge.time, sidecar.audio.rate);
    if (cut === undefined) continue;
    for (const [wordId, word] of Object.entries(sidecar.words)) {
      if (word.state !== "active") continue;
      const start = toSamples(word.start, sidecar.audio.rate);
      const end = toSamples(word.end, sidecar.audio.rate);
      if (start === undefined || end === undefined) continue;
      const key = `${edge.assetId}:${String(cut)}:${wordId}`;
      if (seen.has(key)) continue;
      let evidence: string | undefined;
      if (cut > start && cut < end) {
        evidence = `Cut lies inside “${word.text}” (${wordId}), ${formatMilliseconds(
          cut - start,
          sidecar.audio.rate,
        )} after its start and ${formatMilliseconds(end - cut, sidecar.audio.rate)} before its end.`;
      } else if (
        cut >= end && BigInt(cut - end) * 1_000n <= 40n * BigInt(sidecar.audio.rate)
      ) {
        evidence = `Cut is ${formatMilliseconds(
          cut - end,
          sidecar.audio.rate,
        )} after “${word.text}” (${wordId}) ended.`;
      } else if (
        cut <= start && BigInt(start - cut) * 1_000n <= 40n * BigInt(sidecar.audio.rate)
      ) {
        evidence = `Cut is ${formatMilliseconds(
          start - cut,
          sidecar.audio.rate,
        )} before “${word.text}” (${wordId}) starts.`;
      }
      if (evidence === undefined) continue;
      seen.add(key);
      warnings.push({
        code: "clipped-phoneme-risk",
        severity: "warning",
        boundary: boundarySurface(boundary),
        evidence,
        suggestion: "Move the cut farther into silence or audition a short audio crossfade.",
      });
    }
  }
  return warnings;
}

function fineTier(peaks: ContinuityPeaks): ContinuityPeaksTier | undefined {
  return peaks.tiers.slice().sort((left, right) => left.samplesPerPeak - right.samplesPerPeak)[0];
}

function magnitudeAt(peaks: ContinuityPeaks, source: TimeValue): number | undefined {
  const tier = fineTier(peaks);
  const sample = toSamples(source, peaks.sampleRate);
  if (tier === undefined || sample === undefined) return undefined;
  const bucket = Math.floor(sample / tier.samplesPerPeak);
  const low = tier.data[bucket * 2];
  const high = tier.data[bucket * 2 + 1];
  return low === undefined || high === undefined
    ? undefined
    : Math.max(Math.abs(low), Math.abs(high)) / 127;
}

function meanMagnitude(
  peaks: ContinuityPeaks,
  source: TimeValue,
  direction: "before" | "after",
): number | undefined {
  const tier = fineTier(peaks);
  const sample = toSamples(source, peaks.sampleRate);
  if (tier === undefined || sample === undefined) return undefined;
  const windowSamples = Math.floor(peaks.sampleRate * 300 / 1_000);
  const first = Math.max(0, Math.floor(
    (direction === "before" ? sample - windowSamples : sample) / tier.samplesPerPeak,
  ));
  const last = Math.max(first, Math.ceil(
    (direction === "before" ? sample : sample + windowSamples) / tier.samplesPerPeak,
  ));
  const magnitudes: number[] = [];
  for (let bucket = first; bucket < last; bucket += 1) {
    const low = tier.data[bucket * 2];
    const high = tier.data[bucket * 2 + 1];
    if (low !== undefined && high !== undefined) {
      magnitudes.push(Math.max(Math.abs(low), Math.abs(high)) / 127);
    }
  }
  return magnitudes.length === 0
    ? undefined
    : magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length;
}

function amplitudeDb(amplitude: number): number {
  return amplitude <= 0 ? -120 : 20 * Math.log10(amplitude);
}

async function peaksWarnings(
  boundary: CutBoundary,
  load: TranscriptContinuityOptions["loadPeaks"],
  cache: Map<string, ContinuityPeaks | undefined>,
): Promise<ContinuityWarning[]> {
  if (load === undefined || boundary.before === undefined || boundary.after === undefined) return [];
  const get = async (assetId: string): Promise<ContinuityPeaks | undefined> => {
    if (!cache.has(assetId)) cache.set(assetId, await load(assetId));
    return cache.get(assetId);
  };
  const beforePeaks = await get(boundary.before.assetId);
  const afterPeaks = await get(boundary.after.assetId);
  if (beforePeaks === undefined || afterPeaks === undefined) return [];
  const beforeCut = magnitudeAt(beforePeaks, boundary.before.time);
  const afterCut = magnitudeAt(afterPeaks, boundary.after.time);
  const warnings: ContinuityWarning[] = [];
  const cutLevel = Math.max(beforeCut ?? 0, afterCut ?? 0);
  const cutDb = amplitudeDb(cutLevel);
  if (cutDb > -30) {
    warnings.push({
      code: "click-risk",
      severity: "warning",
      boundary: boundarySurface(boundary),
      evidence: `Peak envelope is ${cutDb.toFixed(1)} dBFS at the cut from the finest available peaks tier; zero-crossing samples are unavailable.`,
      suggestion: "Apply a 3 ms micro-fade or refine the cut against decoded PCM.",
    });
  }
  const beforeMean = meanMagnitude(beforePeaks, boundary.before.time, "before");
  const afterMean = meanMagnitude(afterPeaks, boundary.after.time, "after");
  if (beforeMean !== undefined && afterMean !== undefined) {
    const beforeDb = amplitudeDb(beforeMean);
    const afterDb = amplitudeDb(afterMean);
    const delta = Math.abs(afterDb - beforeDb);
    if (delta > 4) {
      warnings.push({
        code: "ambience-jump",
        severity: "warning",
        boundary: boundarySurface(boundary),
        evidence: `The 300 ms peaks envelopes differ by ${delta.toFixed(1)} dB (${beforeDb.toFixed(1)} to ${afterDb.toFixed(1)} dBFS).`,
        suggestion: "Audition an 80 ms audio crossfade or patch the joint with matching room tone.",
      });
    }
  }
  return warnings;
}

function findClip(project: GuyditorProject, clipId: string | undefined): Clip | undefined {
  if (clipId === undefined) return undefined;
  return project.sequences.flatMap(({ clips }) => clips).find(({ id }) => id === clipId);
}

function jumpCutWarning(
  boundary: CutBoundary,
  project: GuyditorProject,
): ContinuityWarning | undefined {
  if (
    boundary.before === undefined || boundary.after === undefined ||
    boundary.before.assetId !== boundary.after.assetId
  ) return undefined;
  const afterSeconds = absoluteSeconds(boundary.after.time);
  const beforeSeconds = absoluteSeconds(boundary.before.time);
  if (!afterSeconds.ok || !beforeSeconds.ok) return undefined;
  const skipped = subRational(
    afterSeconds.value,
    beforeSeconds.value,
  );
  if (!skipped.ok) return undefined;
  const frame = absoluteSeconds(
    "frames" in boundary.before.time
      ? { frames: 1, fps: boundary.before.time.fps }
      : { frames: 1, fps: project.settings.timeline.fps },
  );
  if (!frame.ok) return undefined;
  const positive = compareRational(skipped.value, "0/1");
  const atLeastFrame = compareRational(skipped.value, frame.value);
  const atMostTen = compareRational(skipped.value, "10/1");
  if (
    !positive.ok || !atLeastFrame.ok || !atMostTen.ok ||
    positive.value !== 1 || atLeastFrame.value === -1 || atMostTen.value === 1
  ) return undefined;
  const beforeClip = findClip(project, boundary.before.clipId);
  const afterClip = findClip(project, boundary.after.clipId);
  if ((beforeClip?.punchIn?.level ?? 1) !== (afterClip?.punchIn?.level ?? 1)) return undefined;
  return {
    code: "jump-cut",
    severity: "info",
    boundary: boundarySurface(boundary),
    evidence: `Adjacent clips skip ${skipped.value} s of the same source with an unchanged punch-in level.`,
    suggestion: "Consider a restrained punch-in change or cutaway if the visual jump is distracting.",
  };
}

async function assessBoundaries(
  boundaries: readonly CutBoundary[],
  project: GuyditorProject,
  options: TranscriptContinuityOptions,
): Promise<ContinuityWarning[]> {
  const warnings: ContinuityWarning[] = [];
  const cache = new Map<string, ContinuityPeaks | undefined>();
  for (const boundary of boundaries) {
    warnings.push(...wordWarnings(boundary, options.sidecars));
    warnings.push(...await peaksWarnings(boundary, options.loadPeaks, cache));
    const jump = jumpCutWarning(boundary, project);
    if (jump !== undefined) warnings.push(jump);
  }
  return [...new Map(warnings.map((warning) => [
    `${warning.code}:${warning.boundary.beforeClip ?? "-"}:${warning.boundary.afterClip ?? "-"}:${warning.evidence}`,
    warning,
  ])).values()];
}

export function createTranscriptContinuityGuard(
  options: TranscriptContinuityOptions,
): ContinuityGuard {
  return ({ before, after }) => assessBoundaries(movedBoundaries(before, after), after, options);
}

export function assessSourceRangeContinuity(
  project: GuyditorProject,
  sourceRange: SourceSampleRange,
  options: TranscriptContinuityOptions,
): Promise<ContinuityWarning[]> {
  const boundary: CutBoundary = {
    before: {
      assetId: sourceRange.assetId,
      time: sourceRange.start,
    },
    after: {
      assetId: sourceRange.assetId,
      time: sourceRange.end,
    },
  };
  return assessBoundaries([boundary], project, options);
}

export function continuityEvidenceOperation(
  warning: ContinuityWarning,
): OperationInput | undefined {
  return warning.autoFix;
}
