import type {
  AnchorName,
  AvoidRegion,
  OperationInput,
  PipConfig,
  PlacementConstraints,
  SemanticAnchor,
} from "../../core/src/index.js";

import type { NormalizedRect } from "./placement.js";
import { solvePlacement } from "./placement.js";

export interface CaptionLayoutProvider {
  getCaptionBoxes(
    sequenceId: string,
    frameRange: { from: number; to: number },
    aspectClass: "16:9" | "9:16" | "1:1" | "4:5",
  ): AvoidRegion[];
}

export interface OverlapWarning {
  severity: "none" | "soft" | "hard";
  softOverlapFraction: number;
  regionIds: string[];
}

function intersectionArea(a: NormalizedRect, b: NormalizedRect): number {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

function activeAt(region: AvoidRegion, frame: number): boolean {
  return region.frames === undefined || (frame >= region.frames.from && frame <= region.frames.to);
}

export function overlapWarningForRect(
  rect: NormalizedRect,
  regions: readonly AvoidRegion[],
  frame: number,
): OverlapWarning {
  let hard = false;
  let softArea = 0;
  const ids: string[] = [];
  for (const region of regions) {
    if (!activeAt(region, frame)) continue;
    const area = intersectionArea(rect, region.rect);
    if (area <= 0) continue;
    ids.push(region.id);
    if (region.hardness === "hard") hard = true;
    else softArea += area;
  }
  return {
    severity: hard ? "hard" : softArea > 0 ? "soft" : "none",
    softOverlapFraction: Math.min(1, softArea / (rect.w * rect.h)),
    regionIds: ids,
  };
}

export function overlapWarning(
  placement: PlacementConstraints,
  regions: readonly AvoidRegion[],
  compW: number,
  compH: number,
  frame: number,
): OverlapWarning {
  return overlapWarningForRect(solvePlacement(placement, compW, compH), regions, frame);
}

export interface AvoidRelocation {
  frame: number;
  anchor: AnchorName;
  reason: "hard-overlap" | "soft-overlap" | "return";
  regionIds: string[];
  score: number;
}

export interface AvoidancePlan {
  status: "proposal";
  operations: OperationInput[];
  relocations: AvoidRelocation[];
  summaries: string[];
  unavailableSources: AvoidRegion["source"][];
}

export interface AvoidanceRequest {
  layerId: string;
  pip: PipConfig;
  regions: readonly AvoidRegion[];
  compW: number;
  compH: number;
  fromFrame: number;
  toFrame: number;
  semanticAnchorAtFrame?: (frame: number) => SemanticAnchor;
  idFactory?: (frame: number, index: number) => string;
}

function placementAtAnchor(base: PlacementConstraints, anchor: AnchorName): PlacementConstraints {
  return { ...structuredClone(base), anchor };
}

function distance(a: NormalizedRect, b: NormalizedRect): number {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  return Math.hypot(ax - bx, ay - by) / Math.SQRT2;
}

function stableKeyframeId(index: number): string {
  return `kfr_${String.fromCharCode(97 + index % 26).repeat(10)}`;
}

export function planCollisionAvoidance(request: AvoidanceRequest): AvoidancePlan {
  const config = request.pip.avoid;
  if (config === undefined || !config.enabled) {
    return { status: "proposal", operations: [], relocations: [], summaries: [], unavailableSources: [] };
  }
  const supported = new Set<AvoidRegion["source"]>(["caption", "marked", "safe_area"]);
  const unavailableSources = config.sources.filter((source) => !supported.has(source));
  const regions = request.regions.filter(({ source }) => config.sources.includes(source));
  const fallback = config.fallbackAnchors.length === 0
    ? [request.pip.placement.base.anchor]
    : config.fallbackAnchors;
  const authoredAnchor = request.pip.placement.base.anchor;
  let currentAnchor = authoredAnchor;
  let currentRect = solvePlacement(request.pip.placement.base, request.compW, request.compH);
  let lastRelocation = Number.NEGATIVE_INFINITY;
  let softRun = 0;
  const relocations: AvoidRelocation[] = [];

  for (let frame = request.fromFrame; frame <= request.toFrame; frame += 1) {
    const currentWarning = overlapWarningForRect(currentRect, regions, frame);
    softRun = currentWarning.softOverlapFraction > config.softOverlapMax ? softRun + 1 : 0;
    const hardRequired = currentWarning.severity === "hard";
    const softRequired = softRun >= 12;
    const canMove = hardRequired || frame - lastRelocation >= config.holdFrames;
    let reason: AvoidRelocation["reason"] | undefined = hardRequired
      ? "hard-overlap"
      : softRequired ? "soft-overlap" : undefined;
    if (
      reason === undefined && currentAnchor !== authoredAnchor && canMove &&
      overlapWarningForRect(
        solvePlacement(request.pip.placement.base, request.compW, request.compH),
        regions,
        frame,
      ).severity === "none"
    ) reason = "return";
    if (reason === undefined || !canMove) continue;

    const candidateAnchors = reason === "return" ? [authoredAnchor] : fallback;
    const candidates = candidateAnchors.flatMap((anchor, fallbackIndex) => {
      if (anchor === currentAnchor) return [];
      const placement = placementAtAnchor(request.pip.placement.base, anchor);
      const rect = solvePlacement(placement, request.compW, request.compH);
      let softTotal = 0;
      for (
        let lookahead = frame;
        lookahead <= Math.min(request.toFrame, frame + config.holdFrames);
        lookahead += 1
      ) {
        const warning = overlapWarningForRect(rect, regions, lookahead);
        if (warning.severity === "hard") return [];
        softTotal = Math.max(softTotal, warning.softOverlapFraction);
      }
      return [{
        anchor,
        rect,
        score: softTotal + 0.4 * distance(currentRect, rect) + 0.2 * fallbackIndex,
      }];
    });
    candidates.sort((a, b) => a.score - b.score || a.anchor.localeCompare(b.anchor));
    const selected = candidates[0];
    if (selected === undefined) continue;
    relocations.push({
      frame,
      anchor: selected.anchor,
      reason,
      regionIds: currentWarning.regionIds,
      score: selected.score,
    });
    currentAnchor = selected.anchor;
    currentRect = selected.rect;
    lastRelocation = frame;
    softRun = 0;
  }

  const semanticAnchorAtFrame = request.semanticAnchorAtFrame ??
    ((frame: number): SemanticAnchor => `timeline:seq_aaaaaaaaaa@${String(frame)}`);
  const operations = relocations.map((relocation, index): OperationInput => ({
    op: "pip.keyframe.add",
    params: {
      layerId: request.layerId,
      keyframe: {
        id: request.idFactory?.(relocation.frame, index) ?? stableKeyframeId(index),
        at: semanticAnchorAtFrame(relocation.frame),
        placement: placementAtAnchor(request.pip.placement.base, relocation.anchor),
        transition: structuredClone(config.moveTransition),
      },
    },
  }));
  const summaries = relocations.map((relocation) =>
    relocation.reason === "return"
      ? `Return presenter to ${relocation.anchor} at ${semanticAnchorAtFrame(relocation.frame)}`
      : `Move presenter to ${relocation.anchor} at ${semanticAnchorAtFrame(relocation.frame)} to avoid ${
        relocation.regionIds.length === 0 ? "region" : "caption overlap"
      }`);
  return { status: "proposal", operations, relocations, summaries, unavailableSources };
}
