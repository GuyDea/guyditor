export interface TakeTechnicalMetrics {
  audioClippingPct: number;
  noiseFloorDb: number;
  focusScore?: number;
  exposureScore?: number;
  framingScore?: number;
}

export interface TakeDeliveryMetrics {
  wordsPerMinute: number;
  fillerCount: number;
  pauseRatio: number;
  energyVariance: number;
  restartCount: number;
}

export interface TakeMetricSignals {
  durationSeconds: number;
  wordCount: number;
  fillerCount: number;
  silenceSeconds: number;
  loudnessLufs: number[];
  restartCount: number;
  technical: TakeTechnicalMetrics;
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
}

function nonNegative(value: number, label: string): void {
  finite(value, label);
  if (value < 0) throw new RangeError(`${label} must be non-negative.`);
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

export function deriveTakeMetrics(signals: TakeMetricSignals): {
  delivery: TakeDeliveryMetrics;
  technical: TakeTechnicalMetrics;
} {
  finite(signals.durationSeconds, "Take duration");
  if (signals.durationSeconds <= 0) throw new RangeError("Take duration must be positive.");
  for (const [value, label] of [
    [signals.wordCount, "Take wordCount"],
    [signals.fillerCount, "Take fillerCount"],
    [signals.silenceSeconds, "Take silenceSeconds"],
    [signals.restartCount, "Take restartCount"],
    [signals.technical.audioClippingPct, "Take audioClippingPct"],
  ] as const) nonNegative(value, label);
  finite(signals.technical.noiseFloorDb, "Take noiseFloorDb");
  for (const [value, label] of [
    [signals.technical.focusScore, "Take focusScore"],
    [signals.technical.exposureScore, "Take exposureScore"],
    [signals.technical.framingScore, "Take framingScore"],
  ] as const) {
    if (value !== undefined) nonNegative(value, label);
  }
  if (signals.loudnessLufs.length === 0) {
    throw new TypeError("Take loudness analysis must contain at least one sample.");
  }
  signals.loudnessLufs.forEach((value) => finite(value, "Take loudness sample"));
  const mean = signals.loudnessLufs.reduce((sum, value) => sum + value, 0) /
    signals.loudnessLufs.length;
  const variance = signals.loudnessLufs.reduce((sum, value) =>
    sum + (value - mean) ** 2, 0) / signals.loudnessLufs.length;
  return {
    delivery: {
      wordsPerMinute: rounded(signals.wordCount / signals.durationSeconds * 60),
      fillerCount: signals.fillerCount,
      pauseRatio: rounded(Math.min(1, signals.silenceSeconds / signals.durationSeconds)),
      energyVariance: rounded(variance),
      restartCount: signals.restartCount,
    },
    technical: structuredClone(signals.technical),
  };
}
