import { createHash } from "node:crypto";

import type { SidecarRef } from "../project/index.js";
import type { TakeCandidate, TakeComparison } from "./types.js";

const IDS = {
  comparison: /^tkc_[a-z2-7]{10}$/u,
  take: /^tak_[a-z2-7]{10}$/u,
  asset: /^ast_[a-z2-7]{10}$/u,
  beat: /^beat_[a-z2-7]{10}$/u,
  skill: /^skl_[a-z2-7]{10}$/u,
  word: /^w[0-9]{6}$/u,
};
const RATIONAL = /^(?:0|[1-9][0-9]*)\/[1-9][0-9]*$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

function invalid(detail: string): never {
  throw new TypeError(`Invalid TakeComparison: ${detail}.`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) invalid(`${path} has unsupported fields ${extra.join(", ")}`);
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid(`${path} must be non-empty`);
  return value;
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(`${path} must be a string array`);
  }
  return [...value] as string[];
}

function finite(value: unknown, path: string, minimum?: number, maximum?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) ||
      minimum !== undefined && value < minimum || maximum !== undefined && value > maximum) {
    invalid(`${path} must be a finite number${minimum === undefined ? "" : ` >= ${String(minimum)}`}`);
  }
  return value;
}

function sourceTime(value: unknown, path: string): { frames: number; fps: string } {
  const source = record(value, path);
  exact(source, ["frames", "fps"], path);
  if (!Number.isSafeInteger(source["frames"]) || Number(source["frames"]) < 0 ||
      typeof source["fps"] !== "string" || !RATIONAL.test(source["fps"])) {
    invalid(`${path} must use non-negative integer frames and rational fps`);
  }
  return { frames: Number(source["frames"]), fps: source["fps"] };
}

function candidate(value: unknown, path: string): TakeCandidate {
  const source = record(value, path);
  exact(source, [
    "takeId", "assetId", "sourceRange", "transcriptText", "scriptMatch", "delivery",
    "technical", "preference", "markers",
  ], path);
  if (typeof source["takeId"] !== "string" || !IDS.take.test(source["takeId"]) ||
      typeof source["assetId"] !== "string" || !IDS.asset.test(source["assetId"])) {
    invalid(`${path} takeId or assetId is malformed`);
  }
  const range = record(source["sourceRange"], `${path}.sourceRange`);
  exact(range, ["in", "out"], `${path}.sourceRange`);
  const rangeIn = sourceTime(range["in"], `${path}.sourceRange.in`);
  const rangeOut = sourceTime(range["out"], `${path}.sourceRange.out`);
  if (rangeIn.fps !== rangeOut.fps || rangeIn.frames >= rangeOut.frames) {
    invalid(`${path}.sourceRange must be an increasing range at one fps`);
  }
  const deliverySource = record(source["delivery"], `${path}.delivery`);
  exact(deliverySource, [
    "wordsPerMinute", "fillerCount", "pauseRatio", "energyVariance", "restartCount",
  ], `${path}.delivery`);
  const delivery = {
    wordsPerMinute: finite(deliverySource["wordsPerMinute"], `${path}.delivery.wordsPerMinute`, 0),
    fillerCount: finite(deliverySource["fillerCount"], `${path}.delivery.fillerCount`, 0),
    pauseRatio: finite(deliverySource["pauseRatio"], `${path}.delivery.pauseRatio`, 0, 1),
    energyVariance: finite(deliverySource["energyVariance"], `${path}.delivery.energyVariance`, 0),
    restartCount: finite(deliverySource["restartCount"], `${path}.delivery.restartCount`, 0),
  };
  const technicalSource = record(source["technical"], `${path}.technical`);
  exact(technicalSource, [
    "audioClippingPct", "noiseFloorDb", "focusScore", "exposureScore", "framingScore",
  ], `${path}.technical`);
  const technical = {
    audioClippingPct: finite(technicalSource["audioClippingPct"], `${path}.technical.audioClippingPct`, 0),
    noiseFloorDb: finite(technicalSource["noiseFloorDb"], `${path}.technical.noiseFloorDb`),
    ...(technicalSource["focusScore"] === undefined ? {} : {
      focusScore: finite(technicalSource["focusScore"], `${path}.technical.focusScore`, 0),
    }),
    ...(technicalSource["exposureScore"] === undefined ? {} : {
      exposureScore: finite(technicalSource["exposureScore"], `${path}.technical.exposureScore`, 0),
    }),
    ...(technicalSource["framingScore"] === undefined ? {} : {
      framingScore: finite(technicalSource["framingScore"], `${path}.technical.framingScore`, 0),
    }),
  };
  const preferenceSource = record(source["preference"], `${path}.preference`);
  exact(preferenceSource, ["score", "rubricId", "rubricVersion"], `${path}.preference`);
  if (typeof preferenceSource["rubricId"] !== "string" || !IDS.skill.test(preferenceSource["rubricId"]) ||
      typeof preferenceSource["rubricVersion"] !== "string" || !SEMVER.test(preferenceSource["rubricVersion"])) {
    invalid(`${path}.preference must cite a versioned skill rubric`);
  }
  const markersSource = record(source["markers"], `${path}.markers`);
  exact(markersSource, ["qualityFlags", "notes"], `${path}.markers`);
  const scriptSource = source["scriptMatch"] === undefined
    ? undefined
    : record(source["scriptMatch"], `${path}.scriptMatch`);
  if (scriptSource !== undefined) exact(scriptSource, ["score", "deviations"], `${path}.scriptMatch`);
  return {
    takeId: source["takeId"],
    assetId: source["assetId"],
    sourceRange: { in: rangeIn, out: rangeOut },
    transcriptText: typeof source["transcriptText"] === "string" ? source["transcriptText"] : invalid(`${path}.transcriptText must be a string`),
    ...(scriptSource === undefined ? {} : {
      scriptMatch: {
        score: finite(scriptSource["score"], `${path}.scriptMatch.score`, 0, 1),
        deviations: strings(scriptSource["deviations"], `${path}.scriptMatch.deviations`),
      },
    }),
    delivery,
    technical,
    preference: {
      score: finite(preferenceSource["score"], `${path}.preference.score`, 0, 1),
      rubricId: preferenceSource["rubricId"],
      rubricVersion: preferenceSource["rubricVersion"],
    },
    markers: {
      qualityFlags: strings(markersSource["qualityFlags"], `${path}.markers.qualityFlags`),
      notes: strings(markersSource["notes"], `${path}.markers.notes`),
    },
  };
}

export function validateTakeComparison(value: unknown): TakeComparison {
  const source = record(value, "comparison");
  exact(source, ["id", "slot", "candidates", "recommendation", "selectedTakeId", "createdAt"], "comparison");
  if (typeof source["id"] !== "string" || !IDS.comparison.test(source["id"])) {
    invalid("id is malformed");
  }
  const slotSource = record(source["slot"], "comparison.slot");
  exact(slotSource, ["beatId", "scriptSection", "wordRange"], "comparison.slot");
  if (slotSource["beatId"] !== undefined &&
      (typeof slotSource["beatId"] !== "string" || !IDS.beat.test(slotSource["beatId"]))) {
    invalid("slot.beatId is malformed");
  }
  const wordRangeSource = slotSource["wordRange"] === undefined
    ? undefined
    : record(slotSource["wordRange"], "comparison.slot.wordRange");
  if (wordRangeSource !== undefined) {
    exact(wordRangeSource, ["fromWord", "toWord"], "comparison.slot.wordRange");
    if (typeof wordRangeSource["fromWord"] !== "string" || !IDS.word.test(wordRangeSource["fromWord"]) ||
        typeof wordRangeSource["toWord"] !== "string" || !IDS.word.test(wordRangeSource["toWord"])) {
      invalid("slot.wordRange is malformed");
    }
  }
  if (!Array.isArray(source["candidates"]) || source["candidates"].length < 2) {
    invalid("candidates must retain at least two takes");
  }
  const candidates = source["candidates"].map((entry, index) =>
    candidate(entry, `comparison.candidates[${String(index)}]`));
  const takeIds = new Set(candidates.map(({ takeId }) => takeId));
  if (takeIds.size !== candidates.length) invalid("candidates contain duplicate take IDs");
  const recommendationSource = source["recommendation"] === undefined
    ? undefined
    : record(source["recommendation"], "comparison.recommendation");
  let recommendation: TakeComparison["recommendation"];
  if (recommendationSource !== undefined) {
    exact(recommendationSource, ["takeId", "reasons", "confidence"], "comparison.recommendation");
    if (typeof recommendationSource["takeId"] !== "string" || !takeIds.has(recommendationSource["takeId"])) {
      invalid("recommendation takeId must name a candidate");
    }
    if (!Array.isArray(recommendationSource["reasons"]) || recommendationSource["reasons"].length === 0) {
      invalid("recommendation requires at least one reason");
    }
    const reasons = recommendationSource["reasons"].map((entry, index) => {
      const reason = record(entry, `comparison.recommendation.reasons[${String(index)}]`);
      exact(reason, ["criterion", "detail", "evidence"], `comparison.recommendation.reasons[${String(index)}]`);
      return {
        criterion: string(reason["criterion"], `comparison.recommendation.reasons[${String(index)}].criterion`),
        detail: string(reason["detail"], `comparison.recommendation.reasons[${String(index)}].detail`),
        evidence: string(reason["evidence"], `comparison.recommendation.reasons[${String(index)}].evidence`),
      };
    });
    const confidence = recommendationSource["confidence"];
    if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
      invalid("recommendation confidence is invalid");
    }
    recommendation = { takeId: recommendationSource["takeId"], reasons, confidence };
  }
  const selectedTakeId = source["selectedTakeId"];
  if (selectedTakeId !== undefined && (typeof selectedTakeId !== "string" || !takeIds.has(selectedTakeId))) {
    invalid("selectedTakeId must name a retained candidate");
  }
  const createdAt = string(source["createdAt"], "comparison.createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) invalid("createdAt must be ISO 8601");
  return structuredClone({
    id: source["id"],
    slot: {
      ...(slotSource["beatId"] === undefined ? {} : { beatId: slotSource["beatId"] as string }),
      ...(slotSource["scriptSection"] === undefined ? {} : {
        scriptSection: string(slotSource["scriptSection"], "comparison.slot.scriptSection"),
      }),
      ...(wordRangeSource === undefined ? {} : {
        wordRange: {
          fromWord: wordRangeSource["fromWord"] as string,
          toWord: wordRangeSource["toWord"] as string,
        },
      }),
    },
    candidates,
    ...(recommendation === undefined ? {} : { recommendation }),
    ...(selectedTakeId === undefined ? {} : { selectedTakeId }),
    createdAt,
  });
}

export function parseTakeComparison(text: string): TakeComparison {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return invalid("expected valid JSON");
  }
  return validateTakeComparison(value);
}

export function serializeTakeComparison(value: unknown): string {
  return `${JSON.stringify(validateTakeComparison(value), null, 2)}\n`;
}

export function takeComparisonSidecarRef(
  value: unknown,
  assetHashes: Readonly<Record<string, string>>,
): SidecarRef {
  const comparison = validateTakeComparison(value);
  const serialized = serializeTakeComparison(comparison);
  const assets = [...new Set(comparison.candidates.map(({ assetId }) => assetId))].sort();
  return {
    name: `take-comparison-${comparison.id}`,
    path: `sidecars/takes/${comparison.id}.json`,
    schema: "guyditor.take-comparison/v1",
    sha256: createHash("sha256").update(serialized).digest("hex"),
    inputs: assets.map((asset) => {
      const sha256 = assetHashes[asset];
      if (sha256 === undefined || !/^[0-9a-f]{64}$/u.test(sha256)) {
        return invalid(`asset ${asset} is missing its source hash`);
      }
      return { asset, sha256 };
    }),
  };
}
