import type {
  CriticAdapter,
  CritiqueFinding,
  CritiqueRequest,
  CritiqueResult,
} from "./types.js";
import type { CostEstimate } from "../cost-meter.js";
import type { DataClass } from "../audit-types.js";

export interface StubCriticAdapterOptions {
  onCritique?: () => void;
}

function finiteRangeNumber(
  range: Record<string, unknown>,
  key: string,
  minimum = 0,
): number {
  const value = range[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`Critic subject.range.${key} must be a finite number >= ${String(minimum)}.`);
  }
  return value;
}

function loudnessValues(range: Record<string, unknown>): number[] {
  const value = range.loudnessLufs;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) =>
    typeof item !== "number" || !Number.isFinite(item))) {
    throw new TypeError("Critic subject.range.loudnessLufs must be a non-empty finite-number array.");
  }
  return value as number[];
}

function variance(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
}

function severity(value: number, major: number, minor: number): CritiqueFinding["severity"] {
  if (value >= major) return "major";
  if (value >= minor) return "minor";
  return "note";
}

/** Deterministic measurable-signal critic used for tests and local dogfood. */
export class StubCriticAdapter implements CriticAdapter {
  public readonly id = "adp_4444444444";
  public readonly kind = "critic" as const;
  public readonly provider = "guyditor-stub";
  public readonly accepts: { dataClasses: DataClass[]; maxVideoSeconds: number } = {
    dataClasses: ["metadata", "prompt", "video"],
    maxVideoSeconds: 120,
  };
  readonly #onCritique: (() => void) | undefined;

  public constructor(options: StubCriticAdapterOptions = {}) {
    this.#onCritique = options.onCritique;
  }

  public estimate(request: CritiqueRequest): CostEstimate {
    const seconds = finiteRangeNumber(request.subject.range, "durationSeconds", 0.001);
    return {
      adapterId: this.id,
      currency: "USD",
      amount: 0,
      units: { seconds },
      confidence: "quote",
    };
  }

  public async critique(request: CritiqueRequest): Promise<CritiqueResult> {
    this.#onCritique?.();
    if (!/^crt_[a-z2-7]{10}$/u.test(request.critiqueId)) {
      throw new TypeError(`Invalid critiqueId ${request.critiqueId}.`);
    }
    const durationSeconds = finiteRangeNumber(request.subject.range, "durationSeconds", 0.001);
    const cutCount = finiteRangeNumber(request.subject.range, "cutCount");
    const silenceSeconds = finiteRangeNumber(request.subject.range, "silenceSeconds");
    if (silenceSeconds > durationSeconds) {
      throw new RangeError("Critic silenceSeconds cannot exceed durationSeconds.");
    }
    const cutDensity = cutCount / durationSeconds;
    const silenceRatio = silenceSeconds / durationSeconds;
    const loudnessVariance = variance(loudnessValues(request.subject.range));
    const range = structuredClone(request.subject.range);
    return {
      critiqueId: request.critiqueId,
      adapterId: this.id,
      model: "stub-critic-v1",
      findings: [
        {
          id: "cut-density",
          severity: severity(cutDensity, 0.6, 0.4),
          range,
          observation: `Measured cut density is ${cutDensity.toFixed(3)} cuts/second (${String(cutCount)} cuts over ${durationSeconds.toFixed(3)} seconds).`,
          suggestion: "Review whether each cut preserves enough time to understand the promise.",
        },
        {
          id: "silence-ratio",
          severity: severity(silenceRatio, 0.3, 0.2),
          range,
          observation: `Measured silence ratio is ${(silenceRatio * 100).toFixed(1)}%.`,
          suggestion: "Check whether long pauses are intentional or reduce momentum.",
        },
        {
          id: "loudness-stability",
          severity: severity(loudnessVariance, 12, 5),
          range,
          observation: `Measured loudness variance is ${loudnessVariance.toFixed(3)} LUFS².`,
          suggestion: "Review level changes for intelligibility before applying loudness processing.",
        },
      ],
      rawCostUnits: { seconds: durationSeconds },
    };
  }
}
