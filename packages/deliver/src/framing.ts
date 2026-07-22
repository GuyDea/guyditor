import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveAspectClass } from "../../compositor/src/index.js";
import type {
  FrameTime,
  FramingCrop,
  FramingOverride,
  FramingRect,
  GuyditorProject,
  SidecarRef,
} from "../../core/src/index.js";
import { convertTimeRounding } from "../../core/src/index.js";
import type {
  MlworkerTrackBox,
  SubjectTrackAnalysis,
} from "../../media/src/index.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

import framingSchema from "../../core/schema/sidecars/guyditor-framing-v1.schema.json" with { type: "json" };
import type { PlatformProfile } from "./profile.js";

export interface FramingShot {
  clipId: string;
  source: { start: FrameTime; end: FrameTime };
}

export interface FramingDecision {
  decisionId: string;
  shot: FramingShot;
  mode: "crop" | "recompose";
  crop?: FramingCrop;
  layout?: string;
  subjects: string[];
  confidence: number;
  warnings: string[];
  overriddenBy?: string;
}

export interface FramingSidecar {
  format: "guyditor.framing/v1";
  deliverableId: string;
  profile: string;
  sourceRevision: string;
  aspect: string;
  requiredTrackAssets: string[];
  decisions: FramingDecision[];
}

export interface DeriveFramingInput {
  project: GuyditorProject;
  deliverableId: string;
  profile: PlatformProfile;
  tracking: Readonly<Record<string, SubjectTrackAnalysis | undefined>>;
  sceneBoundaries: Readonly<Record<string, readonly number[] | undefined>>;
  previous?: FramingSidecar;
  enqueueTrack?: (assetId: string) => void;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateFraming = ajv.compile<FramingSidecar>(framingSchema);

function schemaErrors(errors: readonly ErrorObject[] | null | undefined): string {
  return errors?.map((error) =>
    `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? error.keyword}`)
    .join("; ") ?? "unknown schema error";
}

function validateSidecar(value: unknown): FramingSidecar {
  if (!validateFraming(value)) {
    throw new TypeError(`Invalid guyditor.framing/v1 sidecar: ${schemaErrors(validateFraming.errors)}.`);
  }
  for (const decision of value.decisions) {
    for (const keyframe of decision.crop?.keyframes ?? []) {
      if (keyframe.rect.x + keyframe.rect.w > 1.000001 || keyframe.rect.y + keyframe.rect.h > 1.000001) {
        throw new TypeError(`Invalid guyditor.framing/v1 sidecar: ${decision.decisionId} crop leaves the source frame.`);
      }
    }
  }
  return structuredClone(value);
}

export function parseFramingSidecar(text: string): FramingSidecar {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new TypeError(
      `Invalid guyditor.framing/v1 JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return validateSidecar(value);
}

export function serializeFramingSidecar(sidecar: FramingSidecar): string {
  return `${JSON.stringify(validateSidecar(sidecar), null, 2)}\n`;
}

export function framingSidecarPath(deliverableId: string): string {
  if (!/^dlv_[a-z2-7]{10}$/u.test(deliverableId)) {
    throw new TypeError(`Invalid framing deliverable ID ${deliverableId}.`);
  }
  return `sidecars/framing/${deliverableId}.framing.json`;
}

function sourceFrames(value: FrameTime, fps: string): number {
  const converted = convertTimeRounding(value, fps);
  if (!converted.ok) throw converted.error;
  return converted.value.time.frames;
}

function shots(input: DeriveFramingInput): FramingShot[] {
  const deliverable = input.project.deliverables.find(({ id }) => id === input.deliverableId);
  const sequence = deliverable === undefined
    ? undefined
    : input.project.sequences.find(({ id }) => id === deliverable.sequenceId);
  if (deliverable === undefined || deliverable.kind !== "short" || sequence === undefined) {
    throw new TypeError(`Short deliverable ${input.deliverableId} is unavailable.`);
  }
  return sequence.clips.flatMap((clip): FramingShot[] => {
    const fps = clip.source.in.fps;
    const start = sourceFrames(clip.source.in, fps);
    const end = sourceFrames(clip.source.out, fps);
    const cuts = [...new Set(input.sceneBoundaries[clip.asset] ?? [])]
      .filter((frame) => Number.isSafeInteger(frame) && frame > start && frame < end)
      .sort((left, right) => left - right);
    const boundaries = [start, ...cuts, end];
    return boundaries.slice(0, -1).map((shotStart, index) => ({
      clipId: clip.id,
      source: {
        start: { frames: shotStart, fps },
        end: { frames: boundaries[index + 1]!, fps },
      },
    }));
  });
}

function sourceAssetId(project: GuyditorProject, shot: FramingShot): string {
  const clip = project.sequences.flatMap(({ clips }) => clips)
    .find(({ id }) => id === shot.clipId);
  if (clip === undefined) throw new TypeError(`Framing shot clip ${shot.clipId} is unavailable.`);
  return clip.asset;
}

interface SelectedTracking {
  samples: Array<{ frame: number; boxes: MlworkerTrackBox[] }>;
  subjects: string[];
  confidence: number;
}

function selectedTracking(
  sidecar: SubjectTrackAnalysis | undefined,
  shot: FramingShot,
  screenEnabled: boolean,
): SelectedTracking {
  if (sidecar === undefined) return { samples: [], subjects: [], confidence: 0 };
  const start = sourceFrames(shot.source.start, shot.source.start.fps);
  const end = sourceFrames(shot.source.end, shot.source.start.fps);
  const inShot = sidecar.data.samples.filter(({ frame }) => frame >= start && frame < end);
  const byTrack = new Map<string, MlworkerTrackBox[]>();
  for (const sample of inShot) {
    for (const box of sample.boxes) {
      if (box.kind !== "face" && box.kind !== "body" && !(screenEnabled && box.kind === "screen-region")) {
        continue;
      }
      const boxes = byTrack.get(box.trackId) ?? [];
      boxes.push(box);
      byTrack.set(box.trackId, boxes);
    }
  }
  const subjects = [...byTrack]
    .filter(([, boxes]) => boxes.reduce((sum, box) => sum + box.conf, 0) / boxes.length >= 0.5)
    .map(([trackId]) => trackId)
    .sort();
  const selected = new Set(subjects);
  const samples = inShot.map((sample) => ({
    frame: sample.frame,
    boxes: sample.boxes.filter(({ trackId }) => selected.has(trackId)),
  })).filter(({ boxes }) => boxes.length > 0);
  const boxes = samples.flatMap((sample) => sample.boxes);
  const confidence = boxes.length === 0
    ? 0
    : boxes.reduce((sum, box) => sum + box.conf, 0) / boxes.length;
  return { samples, subjects, confidence };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function envelope(boxes: readonly MlworkerTrackBox[]): FramingRect {
  const left = Math.min(...boxes.map(({ x }) => x));
  const top = Math.min(...boxes.map(({ y }) => y));
  const right = Math.max(...boxes.map(({ x, w }) => x + w));
  const bottom = Math.max(...boxes.map(({ y, h }) => y + h));
  const width = right - left;
  const height = bottom - top;
  return {
    x: clamp(left - width * 0.15, 0, 1),
    y: clamp(top - height * 0.15, 0, 1),
    w: Math.min(1, width * 1.30),
    h: Math.min(1, height * 1.30),
  };
}

function cropForEnvelope(
  subject: FramingRect,
  sourceAspect: number,
  profile: PlatformProfile,
): { rect: FramingRect; impossible: boolean } {
  const action = profile.safeAreas.action;
  const actionWidth = 1 - action.left - action.right;
  const actionHeight = 1 - action.top - action.bottom;
  const normalizedAspect = (profile.video.resolution.width / profile.video.resolution.height) / sourceAspect;
  const requiredWidth = subject.w / actionWidth;
  const requiredHeight = subject.h / actionHeight;
  let height = Math.max(requiredHeight, requiredWidth / normalizedAspect);
  let width = height * normalizedAspect;
  const impossible = width > 1 || height > 1;
  if (height > 1) {
    height = 1;
    width = normalizedAspect;
  }
  if (width > 1) {
    width = 1;
    height = 1 / normalizedAspect;
  }
  const subjectCenterX = subject.x + subject.w / 2;
  const subjectCenterY = subject.y + subject.h / 2;
  const safeCenterX = action.left + actionWidth / 2;
  const safeCenterY = action.top + actionHeight / 2;
  return {
    rect: {
      x: clamp(subjectCenterX - safeCenterX * width, 0, 1 - width),
      y: clamp(subjectCenterY - safeCenterY * height, 0, 1 - height),
      w: width,
      h: height,
    },
    impossible,
  };
}

function smooth(
  points: Array<{ frame: number; rect: FramingRect }>,
  fps: number,
): Array<{ frame: number; rect: FramingRect }> {
  const radius = Math.max(0, Math.round(fps * 0.25));
  return points.map((point) => {
    const window = points.filter(({ frame }) => Math.abs(frame - point.frame) <= radius);
    const average = (key: keyof FramingRect) =>
      window.reduce((sum, candidate) => sum + candidate.rect[key], 0) / window.length;
    return {
      frame: point.frame,
      rect: { x: average("x"), y: average("y"), w: average("w"), h: average("h") },
    };
  });
}

function movement(left: FramingRect, right: FramingRect): number {
  return Math.max(
    Math.abs((left.x + left.w / 2) - (right.x + right.w / 2)),
    Math.abs((left.y + left.h / 2) - (right.y + right.h / 2)),
    Math.abs(left.w - right.w),
    Math.abs(left.h - right.h),
  );
}

function framesPerSecond(value: string): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(value);
  if (match === null) return Number.NaN;
  return Number(match[1]) / Number(match[2]);
}

function collapse(
  points: Array<{ frame: number; rect: FramingRect }>,
): Array<{ frame: number; rect: FramingRect }> {
  if (points.length <= 2) return points;
  const kept = [points[0]!];
  for (const point of points.slice(1, -1)) {
    if (movement(kept.at(-1)!.rect, point.rect) >= 0.01) kept.push(point);
  }
  const last = points.at(-1)!;
  if (kept.at(-1)!.frame !== last.frame) kept.push(last);
  return kept;
}

function cropDecision(
  shot: FramingShot,
  tracking: SelectedTracking,
  asset: GuyditorProject["assets"][number],
  profile: PlatformProfile,
): Pick<FramingDecision, "crop" | "warnings"> {
  const warnings: string[] = [];
  const sourceAspect = (asset.video?.width ?? asset.probe.width ?? 16) /
    (asset.video?.height ?? asset.probe.height ?? 9);
  const fps = framesPerSecond(shot.source.start.fps);
  const points = tracking.samples.map((sample) => {
    let boxes = sample.boxes;
    let framed = cropForEnvelope(envelope(boxes), sourceAspect, profile);
    if (framed.impossible) {
      const faces = boxes.filter(({ kind }) => kind === "face");
      if (faces.length > 0) {
        boxes = faces;
        framed = cropForEnvelope(envelope(boxes), sourceAspect, profile);
      }
      if (!warnings.includes("All tracked subjects cannot fit inside the action-safe area; faces are preferred.")) {
        warnings.push("All tracked subjects cannot fit inside the action-safe area; faces are preferred.");
      }
    }
    return { frame: sample.frame, rect: framed.rect };
  });
  if (points.length === 0) {
    warnings.push("No qualifying face/body track was available; using a centered vertical crop.");
    const ratio = (profile.video.resolution.width / profile.video.resolution.height) / sourceAspect;
    points.push({
      frame: shot.source.start.frames,
      rect: { x: (1 - ratio) / 2, y: 0, w: ratio, h: 1 },
    });
  }
  const keyframes = collapse(smooth(points, Number.isFinite(fps) && fps > 0 ? fps : 30))
    .map(({ frame, rect }) => ({ at: { frames: frame, fps: shot.source.start.fps }, rect }));
  return { crop: { keyframes }, warnings };
}

function overrideFor(
  overrides: readonly FramingOverride[],
  decisionId: string,
): FramingOverride | undefined {
  return overrides.find((override) => override.decisionId === decisionId);
}

export function deriveFramingSidecar(input: DeriveFramingInput): FramingSidecar {
  const deliverable = input.project.deliverables.find(({ id }) => id === input.deliverableId);
  if (deliverable === undefined || deliverable.kind !== "short") {
    throw new TypeError(`Short deliverable ${input.deliverableId} is unavailable.`);
  }
  const layers = input.project.layers.filter(({ sequence, enabled }) =>
    sequence === deliverable.sequenceId && enabled);
  const independentlyMovable = layers.filter(({ kind }) =>
    kind === "video" || kind === "image" || kind === "animation");
  const screenEnabled = layers.some(({ name }) => /screen|diagram|slide/ui.test(name));
  const requiredTrackAssets = new Set<string>();
  const decisions = shots(input).map((shot, index): FramingDecision => {
    const decisionId = `fd_${String(index + 1).padStart(4, "0")}`;
    const assetId = sourceAssetId(input.project, shot);
    const asset = input.project.assets.find(({ id }) => id === assetId);
    if (asset === undefined) throw new TypeError(`Framing asset ${assetId} is unavailable.`);
    const availableTracking = input.tracking[assetId];
    const sidecar = availableTracking?.sourceHash.replace(/^sha256:/u, "") === asset.sha256
      ? availableTracking
      : undefined;
    if (sidecar === undefined) {
      requiredTrackAssets.add(assetId);
      input.enqueueTrack?.(assetId);
    }
    const selected = selectedTracking(sidecar, shot, screenEnabled);
    const automated: FramingDecision = independentlyMovable.length >= 2
      ? {
          decisionId,
          shot,
          mode: "recompose",
          layout: `${input.profile.id}:${resolveAspectClass(input.profile.video.aspect)}`,
          subjects: selected.subjects,
          confidence: selected.confidence,
          warnings: sidecar === undefined ? ["Subject tracking is missing or stale; refresh analysis before approval."] : [],
        }
      : {
          decisionId,
          shot,
          mode: "crop",
          ...cropDecision(shot, selected, asset, input.profile),
          subjects: selected.subjects,
          confidence: selected.confidence,
        };
    const override = overrideFor(deliverable.framingOverrides ?? [], decisionId);
    if (override === undefined) return automated;
    const previous = input.previous?.decisions.find((decision) =>
      decision.decisionId === decisionId && JSON.stringify(decision.shot) === JSON.stringify(shot));
    return {
      ...(previous === undefined ? automated : structuredClone(previous)),
      overriddenBy: override.id,
    };
  });
  return validateSidecar({
    format: "guyditor.framing/v1",
    deliverableId: input.deliverableId,
    profile: `${input.profile.id}@${input.profile.version}`,
    sourceRevision: input.project.revision,
    aspect: input.profile.video.aspect,
    requiredTrackAssets: [...requiredTrackAssets].sort(),
    decisions,
  });
}

export function framingSidecarReference(
  sidecar: FramingSidecar,
  inputs: SidecarRef["inputs"],
): SidecarRef {
  const bytes = serializeFramingSidecar(sidecar);
  return {
    name: `framing-${sidecar.deliverableId}`,
    path: framingSidecarPath(sidecar.deliverableId),
    schema: "guyditor.framing/v1",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    generatedBy: { tool: "@guyditor/deliver", version: "0.0.0" },
    inputs: structuredClone(inputs),
  };
}

export async function writeFramingSidecar(
  projectRoot: string,
  sidecar: FramingSidecar,
  inputs: SidecarRef["inputs"],
): Promise<SidecarRef> {
  const reference = framingSidecarReference(sidecar, inputs);
  const absolutePath = join(projectRoot, reference.path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, serializeFramingSidecar(sidecar), "utf8");
  return reference;
}
