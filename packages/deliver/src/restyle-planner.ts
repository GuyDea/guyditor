import { createHash } from "node:crypto";

import {
  deriveTimeline,
  failure,
  integerRangesOverlap,
  makeGuyditorError,
  success,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  RestyleAdapterConstraints,
  RestyleBoundaryKind,
  RestyleFrameRange,
  RestylePlan,
  RestyleSeamDefault,
  RestyleSeamPolicy,
  RestyleSeamTreatment,
  Result,
} from "../../core/src/index.js";

export const DEFAULT_RESTYLE_INTERSTITIAL_TEMPLATE_ID = "tpl_d2e3f4g5h6";
export const DEFAULT_RESTYLE_INTERSTITIAL_SECONDS = 1;

export interface RestyleWordBoundary {
  id: string;
  startFrame: number;
  endFrame: number;
}

export interface RestylePlanningSignals {
  words: RestyleWordBoundary[];
  beats: Array<{ id: string; frame: number }>;
  vadSilences: RestyleFrameRange[];
  lowMotionFrames: number[];
}

export interface CreateRestylePlanRequest {
  project: GuyditorProject;
  deliverableId: string;
  coverage: "full" | RestyleFrameRange[];
  adapterId: string;
  model: string;
  constraints: RestyleAdapterConstraints;
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  providerSettings: Record<string, unknown>;
  createdAt: string;
  signals: RestylePlanningSignals;
  seamPolicy?: RestyleSeamPolicy;
}

interface BoundaryCandidate {
  frame: number;
  kind: Exclude<RestyleBoundaryKind, "range-edge" | "hard-cap">;
  priority: number;
  evidence: string[];
}

function plannerFailure(message: string, affected: readonly string[] = []) {
  return failure(makeGuyditorError("E_RESTYLE_CONSTRAINT", message, { affected }));
}

function fpsValue(fps: string): number | undefined {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(fps);
  if (match === null) return undefined;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  const value = numerator / denominator;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function normalizeRanges(
  requested: "full" | RestyleFrameRange[],
  durationFrames: number,
): RestyleFrameRange[] | undefined {
  const source = requested === "full"
    ? [{ startFrame: 0, endFrame: durationFrames }]
    : requested;
  const sorted = source.map((range) => ({
    startFrame: Math.max(0, range.startFrame),
    endFrame: Math.min(durationFrames, range.endFrame),
  })).filter(({ startFrame, endFrame }) =>
    Number.isSafeInteger(startFrame) && Number.isSafeInteger(endFrame) && endFrame > startFrame)
    .sort((left, right) =>
      left.startFrame - right.startFrame || left.endFrame - right.endFrame);
  if (sorted.length === 0) return undefined;
  const normalized: RestyleFrameRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (previous !== undefined && range.startFrame <= previous.endFrame) {
      previous.endFrame = Math.max(previous.endFrame, range.endFrame);
    } else {
      normalized.push(range);
    }
  }
  return normalized;
}

function candidateBoundaries(
  signals: RestylePlanningSignals,
  searchStart: number,
  ideal: number,
): BoundaryCandidate[] {
  const candidates: BoundaryCandidate[] = [];
  for (const silence of signals.vadSilences) {
    const lowMotion = signals.lowMotionFrames
      .filter((frame) => frame >= silence.startFrame && frame <= silence.endFrame)
      .filter((frame) => frame >= searchStart && frame <= ideal)
      .sort((left, right) => Math.abs(ideal - left) - Math.abs(ideal - right) || left - right)[0];
    const midpoint = Math.round((silence.startFrame + silence.endFrame) / 2);
    const frame = lowMotion ?? midpoint;
    if (frame >= searchStart && frame <= ideal) {
      candidates.push({
        frame,
        kind: "vad-silence",
        priority: lowMotion === undefined ? 1 : 0,
        evidence: [
          `vad:${String(silence.startFrame)}-${String(silence.endFrame)}`,
          ...(lowMotion === undefined ? [] : [`low-motion:${String(lowMotion)}`]),
        ],
      });
    }
  }
  for (const beat of signals.beats) {
    if (beat.frame >= searchStart && beat.frame <= ideal) {
      candidates.push({
        frame: beat.frame,
        kind: "beat",
        priority: 2,
        evidence: [`beat:${beat.id}`],
      });
    }
  }
  const words = [...signals.words].sort((left, right) =>
    left.startFrame - right.startFrame || left.id.localeCompare(right.id));
  for (let index = 0; index < words.length - 1; index += 1) {
    const left = words[index]!;
    const right = words[index + 1]!;
    if (right.startFrame <= left.endFrame) continue;
    const frame = Math.round((left.endFrame + right.startFrame) / 2);
    if (frame >= searchStart && frame <= ideal) {
      candidates.push({
        frame,
        kind: "word-gap",
        priority: 3,
        evidence: [`word-gap:${left.id}-${right.id}`],
      });
    }
  }
  for (const frame of signals.lowMotionFrames) {
    if (frame >= searchStart && frame <= ideal) {
      candidates.push({
        frame,
        kind: "low-motion",
        priority: 4,
        evidence: [`low-motion:${String(frame)}`],
      });
    }
  }
  return candidates;
}

function chooseBoundary(
  signals: RestylePlanningSignals,
  chunkStart: number,
  ideal: number,
  snapWindowFrames: number,
): BoundaryCandidate {
  const searchStart = Math.max(chunkStart + 1, ideal - snapWindowFrames);
  const candidates = candidateBoundaries(signals, searchStart, ideal)
    .filter(({ frame }) => frame > chunkStart)
    .sort((left, right) =>
      left.priority - right.priority ||
      Math.abs(ideal - left.frame) - Math.abs(ideal - right.frame) ||
      left.frame - right.frame || left.kind.localeCompare(right.kind));
  return candidates[0] ?? {
    frame: ideal,
    kind: "hard-cap",
    priority: Number.MAX_SAFE_INTEGER,
    evidence: [`hard-cap:${String(ideal)}`],
  };
}

function semanticAnchor(
  sequenceId: string,
  frame: number,
  signals: RestylePlanningSignals,
  maximumDistance: number,
): string {
  const wordCandidates = signals.words.flatMap((word) => [
    { anchor: `word:${word.id}#start`, frame: word.startFrame },
    { anchor: `word:${word.id}#end`, frame: word.endFrame },
  ]).sort((left, right) =>
    Math.abs(left.frame - frame) - Math.abs(right.frame - frame) ||
    left.frame - right.frame || left.anchor.localeCompare(right.anchor));
  const word = wordCandidates[0];
  if (word !== undefined && Math.abs(word.frame - frame) <= maximumDistance) {
    return word.anchor;
  }
  const beat = [...signals.beats].sort((left, right) =>
    Math.abs(left.frame - frame) - Math.abs(right.frame - frame) ||
    left.frame - right.frame || left.id.localeCompare(right.id))[0];
  return beat !== undefined && Math.abs(beat.frame - frame) <= maximumDistance
    ? `beat:${beat.id}`
    : `timeline:${sequenceId}@${String(frame)}`;
}

function stablePlanId(
  request: CreateRestylePlanRequest,
  ranges: RestyleFrameRange[],
  seamPolicy: RestyleSeamPolicy,
): string {
  const identity = JSON.stringify({
    adapterId: request.adapterId,
    constraints: request.constraints,
    coverage: ranges,
    createdAt: request.createdAt,
    deliverableId: request.deliverableId,
    model: request.model,
    prompt: request.prompt,
    providerSettings: request.providerSettings,
    seed: request.seed,
    seamPolicy,
    signals: request.signals,
  });
  return `restyle-plan-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function defaultSeamPolicy(
  request: CreateRestylePlanRequest,
  durationFrames: number,
): RestyleSeamPolicy {
  const deliverable = request.project.deliverables.find(({ id }) => id === request.deliverableId);
  return {
    internal: { kind: "interstitial" },
    rangeEdge: { kind: "punch-in" },
    interstitial: {
      templateId: DEFAULT_RESTYLE_INTERSTITIAL_TEMPLATE_ID,
      params: {
        title: deliverable?.name ?? request.project.project.name,
        body: request.project.project.name,
        accent: "#77E7C4",
        logoSlot: "brand",
      },
      durationFrames,
    },
  };
}

function seamTreatment(
  selected: RestyleSeamDefault,
  policy: RestyleSeamPolicy,
): RestyleSeamTreatment {
  return selected.kind === "interstitial"
    ? {
        kind: "interstitial",
        templateId: policy.interstitial.templateId,
        params: structuredClone(policy.interstitial.params),
        durationFrames: policy.interstitial.durationFrames,
        resumeExact: true,
      }
    : structuredClone(selected);
}

export function createRestylePlan(
  request: CreateRestylePlanRequest,
): Result<RestylePlan> {
  const deliverable = request.project.deliverables.find(({ id }) =>
    id === request.deliverableId);
  if (deliverable === undefined) {
    return plannerFailure(
      `Deliverable ${request.deliverableId} does not exist.`,
      [request.deliverableId],
    );
  }
  const fps = request.project.settings.timeline.fps;
  const numericFps = fpsValue(fps);
  if (numericFps === undefined || request.constraints.maxSegmentSeconds <= 0) {
    return plannerFailure("Restyle duration and timeline fps must be positive.");
  }
  if (
    request.project.settings.timeline.width > request.constraints.maxResolution.width ||
    request.project.settings.timeline.height > request.constraints.maxResolution.height ||
    request.constraints.fpsSupport !== "any" &&
      !request.constraints.fpsSupport.includes(fps)
  ) {
    return plannerFailure(
      `Deliverable ${request.deliverableId} exceeds adapter resolution or fps support.`,
      [request.deliverableId, request.adapterId],
    );
  }
  const timeline = deriveTimeline(request.project, deliverable.sequenceId);
  if (!timeline.ok) return timeline;
  const durationFrames = timeline.value.clips.reduce((maximum, clip) =>
    Math.max(maximum, clip.start.frames + clip.duration.frames), 0);
  const ranges = normalizeRanges(request.coverage, durationFrames);
  if (ranges === undefined) {
    return plannerFailure("Restyle coverage contains no frames.", [request.deliverableId]);
  }
  const maxFrames = Math.floor(request.constraints.maxSegmentSeconds * numericFps);
  if (maxFrames < 1) return plannerFailure("Adapter segment cap is shorter than one frame.");
  const snapWindowFrames = Math.max(1, Math.min(
    Math.round(2 * numericFps),
    Math.round(maxFrames * 0.4),
  ));
  const nominalSecondFrames = Math.max(1, Math.round(
    numericFps * DEFAULT_RESTYLE_INTERSTITIAL_SECONDS,
  ));
  const seamPolicy = structuredClone(
    request.seamPolicy ?? defaultSeamPolicy(request, nominalSecondFrames),
  );
  const interstitialSeconds = seamPolicy.interstitial.durationFrames / numericFps;
  if (
    !Number.isSafeInteger(seamPolicy.interstitial.durationFrames) ||
    interstitialSeconds < 0.5 || interstitialSeconds > 2 ||
    seamPolicy.interstitial.templateId.trim() === ""
  ) {
    return plannerFailure(
      "Interstitial seam duration must be an integer frame count between 0.5 and 2 seconds, with a template ID.",
      [request.deliverableId],
    );
  }
  const planId = stablePlanId(request, ranges, seamPolicy);
  const chunks: RestylePlan["chunks"] = [];
  for (const range of ranges) {
    let cursor = range.startFrame;
    while (cursor < range.endFrame) {
      const ideal = Math.min(cursor + maxFrames, range.endFrame);
      const boundary = ideal === range.endFrame
        ? {
            frame: range.endFrame,
            kind: "range-edge" as const,
            priority: -1,
            evidence: [] as string[],
          }
        : chooseBoundary(request.signals, cursor, ideal, snapWindowFrames);
      const endFrame = boundary.frame <= cursor ? ideal : boundary.frame;
      const durationSeconds = rounded((endFrame - cursor) / numericFps);
      const estimatedCostUsd = rounded(durationSeconds * request.constraints.costPerSecond);
      chunks.push({
        id: `restyle-chunk-${String(chunks.length + 1).padStart(3, "0")}`,
        index: chunks.length,
        sourceRange: { startFrame: cursor, endFrame },
        semanticAnchors: {
          start: semanticAnchor(
            deliverable.sequenceId,
            cursor,
            request.signals,
            Math.round(numericFps),
          ),
          end: semanticAnchor(
            deliverable.sequenceId,
            endFrame,
            request.signals,
            Math.round(numericFps),
          ),
          boundaryKind: boundary.kind,
          ...(boundary.evidence.length === 0 ? {} : { evidence: boundary.evidence }),
        },
        durationSeconds,
        estimatedCostUsd,
        status: "planned",
      });
      cursor = endFrame;
    }
  }
  const sequence = request.project.sequences.find(({ id }) => id === deliverable.sequenceId)!;
  const clipById = new Map(sequence.clips.map((clip) => [clip.id, clip] as const));
  const sourceAssetIds = new Set<string>();
  for (const clip of timeline.value.clips) {
    const clipRange = {
      startFrame: clip.start.frames,
      endFrame: clip.start.frames + clip.duration.frames,
    };
    if (ranges.some((range) => integerRangesOverlap(
      { start: range.startFrame, end: range.endFrame },
      { start: clipRange.startFrame, end: clipRange.endFrame },
    ))) {
      const assetId = clipById.get(clip.clipId)?.asset;
      if (assetId !== undefined) sourceAssetIds.add(assetId);
    }
  }
  const sourceAssets = [...sourceAssetIds].sort().map((assetId) => {
    const asset = request.project.assets.find(({ id }) => id === assetId)!;
    return { assetId, sha256: asset.sha256 };
  });
  const amount = rounded(chunks.reduce((sum, chunk) => sum + chunk.estimatedCostUsd, 0));
  const seams: RestylePlan["seams"] = [];
  for (const range of ranges) {
    const rangeChunks = chunks.filter((chunk) =>
      chunk.sourceRange.startFrame >= range.startFrame &&
      chunk.sourceRange.endFrame <= range.endFrame);
    if (range.startFrame > 0 && rangeChunks[0] !== undefined) {
      seams.push({
        id: "",
        frame: range.startFrame,
        boundary: "untouched-to-restyled",
        afterChunkId: rangeChunks[0].id,
        treatment: seamTreatment(seamPolicy.rangeEdge, seamPolicy),
        status: "planned",
      });
    }
    for (let index = 1; index < rangeChunks.length; index += 1) {
      const before = rangeChunks[index - 1]!;
      const after = rangeChunks[index]!;
      seams.push({
        id: "",
        frame: after.sourceRange.startFrame,
        boundary: "internal",
        beforeChunkId: before.id,
        afterChunkId: after.id,
        treatment: seamTreatment(seamPolicy.internal, seamPolicy),
        status: "planned",
      });
    }
    if (range.endFrame < durationFrames && rangeChunks.at(-1) !== undefined) {
      seams.push({
        id: "",
        frame: range.endFrame,
        boundary: "restyled-to-untouched",
        beforeChunkId: rangeChunks.at(-1)!.id,
        treatment: seamTreatment(seamPolicy.rangeEdge, seamPolicy),
        status: "planned",
      });
    }
  }
  seams.sort((left, right) => left.frame - right.frame || left.boundary.localeCompare(right.boundary));
  seams.forEach((seam, index) => {
    seam.id = `restyle-seam-${String(index + 1).padStart(3, "0")}`;
  });
  return success({
    schema: "guyditor.restyle/v1",
    id: planId,
    deliverableId: deliverable.id,
    sequenceId: deliverable.sequenceId,
    sourceAssets,
    adapterId: request.adapterId,
    model: request.model,
    createdAt: request.createdAt,
    coverage: {
      mode: request.coverage === "full" ? "full" : "ranges",
      ranges,
    },
    constraints: structuredClone(request.constraints),
    settings: {
      prompt: request.prompt,
      ...(request.negativePrompt === undefined
        ? {}
        : { negativePrompt: request.negativePrompt }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      providerSettings: structuredClone(request.providerSettings),
    },
    chunks,
    seams,
    estimatedCost: { currency: "USD", amount },
  });
}
