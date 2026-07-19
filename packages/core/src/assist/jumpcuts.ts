import type {
  Asset,
  Clip,
  ContinuityWarning,
  GuyditorProject,
  OperationInput,
} from "../index.js";

export interface JumpCutConcealmentConfig {
  zoomLevels: number[];
  minPunchDurationFrames: { frames: number; fps: string };
  anchor: "face-track" | "center";
  maxSourceGapSec: number;
  preferAngleSwitch: boolean;
  smoothCutPresetId: string;
}

export interface FaceTrackAvailability {
  usable: boolean;
  framingStatic: boolean;
}

export interface JumpCutOperationReason {
  operationIndex: number;
  boundary: { beforeClip: string; afterClip: string };
  text: string;
  evidence: string;
}

export interface JumpCutDecline {
  boundary: { beforeClip?: string; afterClip?: string };
  reason: string;
}

export type JumpCutConcealmentPlan =
  | {
      kind: "proposal";
      operations: OperationInput[];
      reasons: JumpCutOperationReason[];
      declined: JumpCutDecline[];
      angleSwitching: "available" | "not-applicable";
      reviewRequired: true;
      directApply: false;
      report: string;
    }
  | {
      kind: "no-proposal";
      declined: JumpCutDecline[];
      angleSwitching: "not-applicable";
      report: string;
    };

export interface PlanJumpCutConcealmentInput {
  project: GuyditorProject;
  sequenceId: string;
  warnings: readonly ContinuityWarning[];
  config: JumpCutConcealmentConfig;
  faceTracks: Readonly<Record<string, FaceTrackAvailability>>;
}

export const DEFAULT_JUMP_CUT_CONCEALMENT_CONFIG: JumpCutConcealmentConfig = {
  zoomLevels: [1, 1.12, 1.25],
  minPunchDurationFrames: { frames: 1, fps: "1/1" },
  anchor: "face-track",
  maxSourceGapSec: 10,
  preferAngleSwitch: true,
  smoothCutPresetId: "pre_smoothcut2",
};

interface RationalParts {
  numerator: number;
  denominator: number;
}

function rationalParts(value: string): RationalParts | undefined {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(value);
  if (match === null) return undefined;
  return { numerator: Number(match[1]), denominator: Number(match[2]) };
}

function frameSeconds(frames: number, fps: string): number | undefined {
  const parts = rationalParts(fps);
  return parts === undefined ? undefined : frames * parts.denominator / parts.numerator;
}

export function validateJumpCutConcealmentConfig(
  config: JumpCutConcealmentConfig,
): string[] {
  const issues: string[] = [];
  if (config.zoomLevels.length === 0 || config.zoomLevels[0] !== 1) {
    issues.push("zoomLevels must begin with 1.0");
  }
  if (config.zoomLevels.some((level, index) =>
    !Number.isFinite(level) || level < 1 || (index > 0 && level <= config.zoomLevels[index - 1]!),
  )) {
    issues.push("zoomLevels must be finite, ascending values of at least 1.0");
  }
  if (
    !Number.isSafeInteger(config.minPunchDurationFrames.frames) ||
    config.minPunchDurationFrames.frames < 1 ||
    rationalParts(config.minPunchDurationFrames.fps) === undefined
  ) {
    issues.push("minPunchDurationFrames must use positive integer frames and rational fps");
  }
  if (!Number.isFinite(config.maxSourceGapSec) || config.maxSourceGapSec < 0) {
    issues.push("maxSourceGapSec must be a non-negative finite number");
  }
  if (config.smoothCutPresetId.trim() === "") {
    issues.push("smoothCutPresetId must not be empty");
  }
  return issues;
}

function synchronizedReference(asset: Asset): string | undefined {
  return asset.sync?.referenceAssetId;
}

function synchronizedAlternates(project: GuyditorProject, assetId: string): Asset[] {
  const source = project.assets.find(({ id }) => id === assetId);
  const reference = source === undefined ? undefined : synchronizedReference(source);
  const groupReference = reference ?? assetId;
  return project.assets.filter((candidate) => {
    if (candidate.id === assetId || candidate.kind !== "video") return false;
    const candidateReference = synchronizedReference(candidate);
    return candidate.id === groupReference || candidateReference === groupReference;
  });
}

function hasManualTransform(clip: Clip): boolean {
  return clip.effects?.some(({ kind }) => kind === "transform") ?? false;
}

function smoothCutOperation(
  beforeClipId: string,
  afterClipId: string,
  fps: string,
  presetId: string,
): OperationInput {
  return {
    op: "transition.set",
    params: {
      boundary: { beforeClipId, afterClipId },
      kind: "preset",
      presetId,
      duration: { frames: 3, fps },
    },
  };
}

export function findJumpCutWarnings(
  project: GuyditorProject,
  sequenceId: string,
): ContinuityWarning[] {
  const sequence = project.sequences.find(({ id }) => id === sequenceId);
  if (sequence === undefined) return [];
  return sequence.clips.slice(1).flatMap((after, index) => {
    const before = sequence.clips[index]!;
    if (before.asset !== after.asset ||
        (before.punchIn?.level ?? 1) !== (after.punchIn?.level ?? 1)) return [];
    const gap = frameSeconds(after.source.in.frames - before.source.out.frames, after.source.in.fps);
    const oneFrame = frameSeconds(1, before.source.out.fps);
    if (gap === undefined || oneFrame === undefined || gap < oneFrame || gap > 10) return [];
    return [{
      code: "jump-cut" as const,
      severity: "info" as const,
      boundary: { beforeClip: before.id, afterClip: after.id },
      evidence: `Adjacent clips skip ${String(gap)} s of the same source with an unchanged punch-in level.`,
      suggestion: "Consider a restrained punch-in change, synchronized angle, or smooth-cut preset.",
    }];
  });
}

function declineReason(
  before: Clip,
  after: Clip,
  project: GuyditorProject,
  config: JumpCutConcealmentConfig,
  faceTrack: FaceTrackAvailability | undefined,
): string | undefined {
  const source = project.assets.find(({ id }) => id === after.asset);
  const sourceHeight = source?.video?.height ?? source?.probe.height;
  const zMax = sourceHeight === undefined ? 1 : sourceHeight / project.settings.timeline.height;
  if ((config.zoomLevels[1] ?? Number.POSITIVE_INFINITY) > zMax) {
    return `source resolution permits only ${zMax.toFixed(3)}x zoom`;
  }
  const duration = frameSeconds(after.source.out.frames - after.source.in.frames, after.source.in.fps);
  const minimum = frameSeconds(
    config.minPunchDurationFrames.frames,
    config.minPunchDurationFrames.fps,
  );
  if (duration === undefined || minimum === undefined || duration < minimum) {
    return "segment is shorter than the configured minimum punch duration";
  }
  if (hasManualTransform(after)) return "clip already carries a manual clip.transform.set";
  if (
    config.anchor === "face-track" &&
    faceTrack?.usable !== true &&
    faceTrack?.framingStatic !== true
  ) {
    return "no usable face track exists and framing is not known to be static";
  }
  if (before.asset !== after.asset) return "boundary is not a same-source jump cut";
  const sourceGap = frameSeconds(
    after.source.in.frames - before.source.out.frames,
    after.source.in.fps,
  );
  if (sourceGap === undefined || sourceGap < 0 || sourceGap > config.maxSourceGapSec) {
    return "source discontinuity is outside the configured jump-cut gap";
  }
  return undefined;
}

function nextAdjacentLevel(
  feasible: readonly number[],
  current: number,
  direction: 1 | -1,
): { level: number; direction: 1 | -1 } {
  let index = feasible.findIndex((level) => level === current);
  if (index === -1) {
    index = feasible.reduce((best, level, candidate) =>
      Math.abs(level - current) < Math.abs(feasible[best]! - current) ? candidate : best, 0);
  }
  let nextDirection = direction;
  if (index === feasible.length - 1) nextDirection = -1;
  else if (index === 0) nextDirection = 1;
  return { level: feasible[index + nextDirection]!, direction: nextDirection };
}

export function planJumpCutConcealment(
  input: PlanJumpCutConcealmentInput,
): JumpCutConcealmentPlan {
  const configIssues = validateJumpCutConcealmentConfig(input.config);
  if (configIssues.length > 0) {
    return {
      kind: "no-proposal",
      angleSwitching: "not-applicable",
      declined: [{ boundary: {}, reason: configIssues.join("; ") }],
      report: `Invalid jump-cut concealment policy: ${configIssues.join("; ")}.`,
    };
  }
  const sequence = input.project.sequences.find(({ id }) => id === input.sequenceId);
  const warnings = input.warnings.filter(({ code, boundary }) =>
    code === "jump-cut" && boundary.beforeClip !== undefined && boundary.afterClip !== undefined,
  );
  if (sequence === undefined) {
    return {
      kind: "no-proposal",
      angleSwitching: "not-applicable",
      declined: [{ boundary: {}, reason: `sequence ${input.sequenceId} does not exist` }],
      report: `Sequence ${input.sequenceId} does not exist.`,
    };
  }
  if (warnings.length === 0) {
    return {
      kind: "no-proposal",
      angleSwitching: "not-applicable",
      declined: [],
      report: "No jump-cut boundaries were flagged in the requested scope.",
    };
  }

  const byId = new Map(sequence.clips.map((clip) => [clip.id, clip] as const));
  const operations: OperationInput[] = [];
  const reasons: JumpCutOperationReason[] = [];
  const declined: JumpCutDecline[] = [];
  let direction: 1 | -1 = 1;
  let priorAfterId: string | undefined;
  let runLevel = 1;
  let angleAvailable = false;

  for (const warning of warnings) {
    const beforeId = warning.boundary.beforeClip!;
    const afterId = warning.boundary.afterClip!;
    const before = byId.get(beforeId);
    const after = byId.get(afterId);
    if (before === undefined || after === undefined) {
      declined.push({
        boundary: warning.boundary,
        reason: "warning references a clip outside the requested sequence",
      });
      continue;
    }
    if (priorAfterId !== before.id) {
      direction = 1;
      runLevel = before.punchIn?.level ?? 1;
    }
    priorAfterId = after.id;
    const source = input.project.assets.find(({ id }) => id === after.asset);
    const sourceHeight = source?.video?.height ?? source?.probe.height ?? 0;
    const zMax = sourceHeight / input.project.settings.timeline.height;
    const feasible = input.config.zoomLevels.filter((level) => level <= zMax);
    const reason = declineReason(
      before,
      after,
      input.project,
      input.config,
      input.faceTracks[after.asset],
    );
    let operation: OperationInput;
    let operationText: string;
    if (reason === undefined) {
      const adjacent = nextAdjacentLevel(
        feasible,
        runLevel,
        direction,
      );
      direction = adjacent.direction;
      runLevel = adjacent.level;
      operation = {
        op: "clip.punchin.set",
        params: {
          clipId: after.id,
          level: adjacent.level,
          anchor: input.config.anchor === "face-track" &&
            input.faceTracks[after.asset]?.usable === true
            ? "face-track"
            : { x: 0.5, y: 0.5 },
        },
      };
      operationText = `Conceal jump-cut density by alternating ${after.id} to ${String(adjacent.level)}x.`;
    } else {
      declined.push({ boundary: warning.boundary, reason });
      const alternates = synchronizedAlternates(input.project, after.asset);
      if (input.config.preferAngleSwitch && alternates.length > 0) {
        angleAvailable = true;
        const alternate = alternates[operations.length % alternates.length]!;
        operation = {
          op: "clip.source.switch",
          params: {
            clipId: after.id,
            assetId: alternate.id,
            synchronizedTo: after.asset,
          },
        };
        operationText = `Conceal jump-cut density by switching ${after.id} to synchronized angle ${alternate.id}; punch-in declined because ${reason}.`;
      } else {
        const smoothCut = input.project.presets.find(({ id, kind }) =>
          id === input.config.smoothCutPresetId && kind === "transition");
        if (smoothCut === undefined) {
          declined.push({
            boundary: warning.boundary,
            reason: `smooth-cut preset ${input.config.smoothCutPresetId} is not pinned in the project`,
          });
          continue;
        }
        operation = smoothCutOperation(
          before.id,
          after.id,
          input.project.settings.timeline.fps,
          input.config.smoothCutPresetId,
        );
        operationText = `Conceal jump-cut density with ${input.config.smoothCutPresetId}; punch-in declined because ${reason}.`;
      }
    }
    const operationIndex = operations.push(operation) - 1;
    reasons.push({
      operationIndex,
      boundary: { beforeClip: before.id, afterClip: after.id },
      text: operationText,
      evidence: warning.evidence,
    });
  }

  if (operations.length === 0) {
    return {
      kind: "no-proposal",
      angleSwitching: "not-applicable",
      declined,
      report: `Every flagged boundary was declined: ${declined.map(({ reason }) => reason).join("; ")}.`,
    };
  }
  return {
    kind: "proposal",
    operations,
    reasons,
    declined,
    angleSwitching: angleAvailable ? "available" : "not-applicable",
    reviewRequired: true,
    directApply: false,
    report: `Prepared ${String(operations.length)} review-gated concealment operations from ${String(warnings.length)} jump-cut warnings.`,
  };
}
