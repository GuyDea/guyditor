import {
  validateTakeComparison,
} from "../../core/src/index.js";
import type {
  TakeCandidate,
  TakeComparison,
  TakeRecord,
} from "../../core/src/index.js";
import type {
  TakeDeliveryMetrics,
  TakeTechnicalMetrics,
} from "../../media/src/index.js";
import type { TakeTranscriptCandidate } from "../../transcript/src/index.js";
import type { ResolvedSkill, SkillRule } from "./skills/index.js";

export interface TakePreferenceWeights {
  pace: number;
  silence: number;
  fillers: number;
  loudnessStability: number;
  technical: number;
  markers: number;
}

export interface TakePreferenceRubric {
  id: string;
  version: string;
  preferredPace: { min: number; max: number };
  weights: TakePreferenceWeights;
  ruleRefs: string[];
}

export interface TakeComparisonCandidateInput {
  take: TakeRecord;
  transcript: TakeTranscriptCandidate & { similarityToLead: number };
  delivery: TakeDeliveryMetrics;
  technical: TakeTechnicalMetrics;
}

export interface TakeComparisonInput {
  comparisonId: string;
  createdAt: string;
  slot: TakeComparison["slot"];
  candidates: TakeComparisonCandidateInput[];
  rubric: TakePreferenceRubric;
}

function strength(rule: SkillRule): number {
  return rule.strength === "must" ? 5 : rule.strength === "prefer" ? 3 : 2;
}

function paceRange(skills: readonly ResolvedSkill[]): { min: number; max: number } {
  for (const text of skills.flatMap(({ manifest, body }) => [
    manifest.summary,
    ...manifest.rules.map(({ text: ruleText }) => ruleText),
    body,
  ])) {
    const match = /\b([6-9][0-9]|1[0-9]{2}|2[0-4][0-9])\s*[-–]\s*([6-9][0-9]|1[0-9]{2}|2[0-4][0-9])\s*(?:wpm|words per minute)\b/iu.exec(text);
    if (match !== null && Number(match[1]) < Number(match[2])) {
      return { min: Number(match[1]), max: Number(match[2]) };
    }
  }
  return { min: 130, max: 175 };
}

export function takePreferenceRubric(skills: readonly ResolvedSkill[]): TakePreferenceRubric {
  const relevant = skills.filter(({ manifest }) => manifest.rules.some(({ category }) =>
    category === "pacing" || category === "pauses_fillers" ||
    category === "hooks_retention" || category === "framing_cuts"));
  const primary = relevant[0];
  if (primary === undefined) {
    throw new TypeError("Take comparison requires a pinned delivery or retention skill rubric.");
  }
  const raw: TakePreferenceWeights = {
    pace: 0.1,
    silence: 0.1,
    fillers: 0.1,
    loudnessStability: 0.1,
    technical: 0.1,
    markers: 0.1,
  };
  const rules = relevant.flatMap(({ manifest }) => manifest.rules);
  for (const rule of rules) {
    const weight = strength(rule);
    if (rule.category === "pacing") raw.pace += weight;
    if (rule.category === "pauses_fillers") {
      raw.silence += weight;
      raw.fillers += weight;
    }
    if (rule.category === "hooks_retention") {
      raw.pace += weight;
      raw.silence += weight / 2;
    }
    if (rule.category === "framing_cuts") raw.technical += weight;
    if (/loud|energy|volume/iu.test(rule.text)) raw.loudnessStability += weight;
  }
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  return {
    id: primary.manifest.id,
    version: primary.manifest.version,
    preferredPace: paceRange(relevant),
    weights: Object.fromEntries(Object.entries(raw).map(([key, value]) =>
      [key, value / total])) as unknown as TakePreferenceWeights,
    ruleRefs: rules.map((rule) =>
      `${primary.manifest.id}@${primary.manifest.version}#${rule.id}`),
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

function paceScore(value: number, target: { min: number; max: number }): number {
  if (value >= target.min && value <= target.max) return 1;
  const distance = value < target.min ? target.min - value : value - target.max;
  return clamp(1 - distance / Math.max(20, target.max - target.min));
}

function technicalScore(value: TakeTechnicalMetrics): number {
  const scores = [
    clamp(1 - value.audioClippingPct / 5),
    clamp((-value.noiseFloorDb - 30) / 40),
    ...(value.focusScore === undefined ? [] : [clamp(value.focusScore)]),
    ...(value.exposureScore === undefined ? [] : [clamp(value.exposureScore)]),
    ...(value.framingScore === undefined ? [] : [clamp(value.framingScore)]),
  ];
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function markerScore(take: TakeRecord): number {
  if (take.quality === "good") return 1;
  if (take.quality === "bad" || take.quality === "flubbed") return 0;
  return 0.5;
}

function preferenceScore(input: TakeComparisonCandidateInput, rubric: TakePreferenceRubric): number {
  const components: TakePreferenceWeights = {
    pace: paceScore(input.delivery.wordsPerMinute, rubric.preferredPace),
    silence: clamp(1 - input.delivery.pauseRatio),
    fillers: 1 / (1 + input.delivery.fillerCount),
    loudnessStability: 1 / (1 + input.delivery.energyVariance),
    technical: technicalScore(input.technical),
    markers: markerScore(input.take),
  };
  return rounded((Object.keys(components) as Array<keyof TakePreferenceWeights>)
    .reduce((sum, key) => sum + components[key] * rubric.weights[key], 0));
}

function takeCandidate(
  input: TakeComparisonCandidateInput,
  rubric: TakePreferenceRubric,
): TakeCandidate {
  return {
    takeId: input.take.id,
    assetId: input.take.assetId,
    sourceRange: {
      in: { frames: input.take.range.start, fps: input.take.range.fps },
      out: { frames: input.take.range.end, fps: input.take.range.fps },
    },
    transcriptText: input.transcript.transcriptText,
    scriptMatch: {
      score: input.transcript.similarityToLead,
      deviations: input.transcript.similarityToLead === 1
        ? []
        : [`Transcript similarity ${input.transcript.similarityToLead.toFixed(3)}`],
    },
    delivery: structuredClone(input.delivery),
    technical: structuredClone(input.technical),
    preference: {
      score: preferenceScore(input, rubric),
      rubricId: rubric.id,
      rubricVersion: rubric.version,
    },
    markers: {
      qualityFlags: [input.take.quality],
      notes: [...input.take.notes],
    },
  };
}

export function buildTakeComparison(input: TakeComparisonInput): TakeComparison {
  const candidates = [...input.candidates]
    .sort((left, right) => left.take.id.localeCompare(right.take.id))
    .map((candidateInput) => takeCandidate(candidateInput, input.rubric));
  if (candidates.length < 2) throw new TypeError("Take comparison requires at least two candidates.");
  const ranked = [...candidates].sort((left, right) =>
    right.preference.score - left.preference.score || left.takeId.localeCompare(right.takeId));
  const selected = ranked[0]!;
  const margin = selected.preference.score - ranked[1]!.preference.score;
  const comparison: TakeComparison = {
    id: input.comparisonId,
    slot: structuredClone(input.slot),
    candidates,
    recommendation: {
      takeId: selected.takeId,
      reasons: [
        {
          criterion: "creator_preference",
          detail: `This take best matches the pinned ${input.rubric.id}@${input.rubric.version} rubric.`,
          evidence: `${selected.takeId} preference.score=${selected.preference.score.toFixed(4)}; rules=${input.rubric.ruleRefs.join(",")}`,
        },
        {
          criterion: "delivery",
          detail: "Pace, silence, fillers, loudness stability, and restarts were compared from measured analysis.",
          evidence: `${selected.takeId} wordsPerMinute=${selected.delivery.wordsPerMinute.toFixed(2)}; pauseRatio=${selected.delivery.pauseRatio.toFixed(4)}; fillerCount=${String(selected.delivery.fillerCount)}; energyVariance=${selected.delivery.energyVariance.toFixed(4)}; restartCount=${String(selected.delivery.restartCount)}`,
        },
        {
          criterion: "technical_quality",
          detail: "Probe and QC signals were considered alongside delivery preference.",
          evidence: `${selected.takeId} audioClippingPct=${selected.technical.audioClippingPct.toFixed(4)}; noiseFloorDb=${selected.technical.noiseFloorDb.toFixed(2)}`,
        },
      ],
      confidence: margin >= 0.2 ? "high" : margin >= 0.08 ? "medium" : "low",
    },
    createdAt: input.createdAt,
  };
  return validateTakeComparison(comparison);
}
