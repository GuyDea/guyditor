import type {
  DuckingConfig,
  SampleTime,
} from "../../core/src/index.js";

export interface SpeechInterval {
  start: SampleTime;
  end: SampleTime;
}

export interface ResolvedDuckingOverride {
  at: SampleTime;
  gainDb: number;
}

export interface DuckingEnvelopePoint {
  at: SampleTime;
  gainDb: number;
}

export interface CompileDuckingEnvelopeInput {
  config: DuckingConfig;
  speech: readonly SpeechInterval[];
  overrides: readonly ResolvedDuckingOverride[];
  duration: SampleTime;
}

export function compileDuckingEnvelope(
  input: CompileDuckingEnvelopeInput,
): DuckingEnvelopePoint[] {
  const rate = input.duration.rate;
  if (!Number.isSafeInteger(input.duration.samples) || input.duration.samples < 0) {
    throw new TypeError("Ducking duration must be a non-negative exact sample count.");
  }
  for (const interval of input.speech) {
    if (interval.start.rate !== rate || interval.end.rate !== rate) {
      throw new TypeError("Ducking speech intervals must use the output sample rate.");
    }
    if (interval.start.samples < 0 || interval.end.samples <= interval.start.samples) {
      throw new TypeError("Ducking speech intervals must be positive half-open ranges.");
    }
  }
  for (const override of input.overrides) {
    if (override.at.rate !== rate) {
      throw new TypeError("Ducking overrides must use the output sample rate.");
    }
  }

  const attack = millisecondsToSamples(input.config.attackMs, rate);
  const release = millisecondsToSamples(input.config.releaseMs, rate);
  const hold = millisecondsToSamples(input.config.holdMs, rate);
  const minGap = millisecondsToSamples(input.config.minGapMs, rate);
  const speech = input.config.enabled && input.config.mode === "auto"
    ? mergeSpeech(input.speech, minGap, input.duration.samples)
    : [];
  const curves = speech.map(({ start, end }) => ({
    rampStart: Math.max(0, start - attack),
    duckStart: start,
    duckEnd: Math.min(input.duration.samples, end + hold),
    rampEnd: Math.min(input.duration.samples, end + hold + release),
    gainDb: input.config.duckDb,
  }));
  const overrides = input.config.enabled
    ? [...input.overrides]
        .filter(({ at }) => at.samples >= 0 && at.samples <= input.duration.samples)
        .sort((left, right) => left.at.samples - right.at.samples || left.gainDb - right.gainDb)
    : [];
  const candidateTimes = new Set<number>([0, input.duration.samples]);
  for (const curve of curves) {
    candidateTimes.add(curve.rampStart);
    candidateTimes.add(curve.duckStart);
    candidateTimes.add(curve.duckEnd);
    candidateTimes.add(curve.rampEnd);
  }
  const protectedTimes = new Set<number>();
  for (const override of overrides) {
    const before = Math.max(0, override.at.samples - release);
    const after = Math.min(input.duration.samples, override.at.samples + release);
    candidateTimes.add(before);
    candidateTimes.add(override.at.samples);
    candidateTimes.add(after);
    protectedTimes.add(before);
    protectedTimes.add(override.at.samples);
    protectedTimes.add(after);
  }

  const breakpoints = [...candidateTimes].sort((left, right) => left - right);
  for (let index = 0; index < breakpoints.length - 1; index += 1) {
    const start = breakpoints[index]!;
    const end = breakpoints[index + 1]!;
    if (end <= start) continue;
    for (let leftIndex = 0; leftIndex < curves.length; leftIndex += 1) {
      const left = curves[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < curves.length; rightIndex += 1) {
        const right = curves[rightIndex]!;
        const startDifference = curveGain(left, start) - curveGain(right, start);
        const endDifference = curveGain(left, end) - curveGain(right, end);
        if (startDifference === 0 || endDifference === 0 || startDifference * endDifference >= 0) {
          continue;
        }
        const position = startDifference / (startDifference - endDifference);
        const crossing = nearestEarlier(start + (end - start) * position);
        if (crossing > start && crossing < end) candidateTimes.add(crossing);
      }
    }
  }

  const points = [...candidateTimes]
    .sort((left, right) => left - right)
    .map((samples) => ({
      at: { samples, rate },
      gainDb: normalizedDb(gainAt(samples, curves, overrides, release)),
    }));
  return simplify(points, protectedTimes);
}

interface SampleInterval {
  start: number;
  end: number;
}

interface GainCurve {
  rampStart: number;
  duckStart: number;
  duckEnd: number;
  rampEnd: number;
  gainDb: number;
}

function nearestEarlier(value: number): number {
  return Math.ceil(value - 0.5);
}

function millisecondsToSamples(milliseconds: number, rate: number): number {
  return Math.max(0, nearestEarlier(milliseconds * rate / 1_000));
}

function mergeSpeech(
  intervals: readonly SpeechInterval[],
  minGap: number,
  duration: number,
): SampleInterval[] {
  const sorted = intervals
    .map(({ start, end }) => ({
      start: Math.min(duration, start.samples),
      end: Math.min(duration, end.samples),
    }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SampleInterval[] = [];
  for (const interval of sorted) {
    const prior = merged.at(-1);
    if (prior === undefined || interval.start - prior.end >= minGap) {
      merged.push({ ...interval });
    } else {
      prior.end = Math.max(prior.end, interval.end);
    }
  }
  return merged;
}

function curveGain(curve: GainCurve, sample: number): number {
  if (sample < curve.rampStart || sample > curve.rampEnd) return 0;
  if (sample < curve.duckStart) {
    const length = curve.duckStart - curve.rampStart;
    return length === 0 ? curve.gainDb : curve.gainDb * (sample - curve.rampStart) / length;
  }
  if (sample <= curve.duckEnd) return curve.gainDb;
  const length = curve.rampEnd - curve.duckEnd;
  return length === 0 ? 0 : curve.gainDb * (curve.rampEnd - sample) / length;
}

function manualGain(
  sample: number,
  overrides: readonly ResolvedDuckingOverride[],
  release: number,
): number | undefined {
  let winner: ResolvedDuckingOverride | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const override of overrides) {
    const candidateDistance = Math.abs(sample - override.at.samples);
    if (
      candidateDistance <= release &&
      (candidateDistance < distance ||
        (candidateDistance === distance && override.at.samples < (winner?.at.samples ?? Number.POSITIVE_INFINITY)))
    ) {
      winner = override;
      distance = candidateDistance;
    }
  }
  return winner?.gainDb;
}

function gainAt(
  sample: number,
  curves: readonly GainCurve[],
  overrides: readonly ResolvedDuckingOverride[],
  release: number,
): number {
  const manual = manualGain(sample, overrides, release);
  if (manual !== undefined) return manual;
  return curves.reduce((gain, curve) => Math.min(gain, curveGain(curve, sample)), 0);
}

function normalizedDb(value: number): number {
  if (Math.abs(value) < 1e-12) return 0;
  return Number(value.toFixed(12));
}

function simplify(
  points: readonly DuckingEnvelopePoint[],
  protectedTimes: ReadonlySet<number>,
): DuckingEnvelopePoint[] {
  const simplified: DuckingEnvelopePoint[] = [];
  for (const point of points) {
    simplified.push(point);
    while (simplified.length >= 3) {
      const left = simplified.at(-3)!;
      const middle = simplified.at(-2)!;
      const right = simplified.at(-1)!;
      if (protectedTimes.has(middle.at.samples)) break;
      const leftSpan = middle.at.samples - left.at.samples;
      const rightSpan = right.at.samples - middle.at.samples;
      const leftDelta = middle.gainDb - left.gainDb;
      const rightDelta = right.gainDb - middle.gainDb;
      if (Math.abs(leftDelta * rightSpan - rightDelta * leftSpan) > 1e-9) break;
      simplified.splice(-2, 1);
    }
  }
  return simplified;
}
