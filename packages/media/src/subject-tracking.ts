import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  MlworkerTrackBox,
  MlworkerTrackResult,
  MlworkerTrackSample,
} from "./mlworker/types.js";

export interface AnalysisSidecar<Data = unknown> {
  format: "guyditor.analysis/v1";
  kind: string;
  assetId: string;
  sourceHash: string;
  params: Record<string, unknown>;
  toolVersions: Record<string, string>;
  createdAt: string;
  data: Data;
}

export interface SubjectTrackData {
  frameCount: number;
  width: number;
  height: number;
  fps: number;
  sampleEvery: number;
  samples: MlworkerTrackSample[];
}

export interface SubjectTrackAnalysis extends AnalysisSidecar<SubjectTrackData> {
  kind: "subject.track";
}

export interface CreateSubjectTrackAnalysisInput {
  assetId: string;
  sourceHash: string;
  params: Record<string, unknown>;
  toolVersions: Record<string, string>;
  createdAt: string;
  result: MlworkerTrackResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(detail: string): never {
  throw new TypeError(`Invalid guyditor.analysis/v1 subject.track sidecar: ${detail}.`);
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${name} must be finite`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const number = finiteNumber(value, name);
  if (!Number.isSafeInteger(number) || number < 1) invalid(`${name} must be a positive integer`);
  return number;
}

function normalized(value: unknown, name: string, positive = false): number {
  const number = finiteNumber(value, name);
  if (number < 0 || number > 1 || (positive && number === 0)) {
    invalid(`${name} must be ${positive ? "greater than zero and " : ""}within 0..1`);
  }
  return number;
}

const TRACK_KINDS = new Set(["face", "body", "object", "screen-region"]);

function trackBox(value: unknown, path: string): MlworkerTrackBox {
  if (!isRecord(value)) invalid(`${path} must be an object`);
  const kind = value["kind"];
  if (typeof kind !== "string" || !TRACK_KINDS.has(kind)) invalid(`${path}.kind is invalid`);
  const trackId = value["trackId"];
  if (typeof trackId !== "string" || trackId.length === 0) invalid(`${path}.trackId is required`);
  const x = normalized(value["x"], `${path}.x`);
  const y = normalized(value["y"], `${path}.y`);
  const w = normalized(value["w"], `${path}.w`, true);
  const h = normalized(value["h"], `${path}.h`, true);
  if (x + w > 1.000001 || y + h > 1.000001) invalid(`${path} extends outside the frame`);
  return {
    kind: kind as MlworkerTrackBox["kind"],
    trackId,
    x,
    y,
    w,
    h,
    conf: normalized(value["conf"], `${path}.conf`),
  };
}

function trackData(value: unknown): SubjectTrackData {
  if (!isRecord(value)) invalid("data must be an object");
  const frameCount = positiveInteger(value["frameCount"], "data.frameCount");
  const width = positiveInteger(value["width"], "data.width");
  const height = positiveInteger(value["height"], "data.height");
  const fps = finiteNumber(value["fps"], "data.fps");
  if (fps <= 0) invalid("data.fps must be positive");
  const sampleEvery = positiveInteger(value["sampleEvery"], "data.sampleEvery");
  if (!Array.isArray(value["samples"])) invalid("data.samples must be an array");
  let previousFrame = -1;
  const samples = value["samples"].map((sample, index): MlworkerTrackSample => {
    if (!isRecord(sample)) invalid(`data.samples[${String(index)}] must be an object`);
    const frame = finiteNumber(sample["frame"], `data.samples[${String(index)}].frame`);
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frameCount || frame <= previousFrame) {
      invalid(`data.samples[${String(index)}].frame must be monotonic and within the media`);
    }
    previousFrame = frame;
    if (!Array.isArray(sample["boxes"])) invalid(`data.samples[${String(index)}].boxes must be an array`);
    return {
      frame,
      boxes: sample["boxes"].map((box, boxIndex) =>
        trackBox(box, `data.samples[${String(index)}].boxes[${String(boxIndex)}]`)),
    };
  });
  return { frameCount, width, height, fps, sampleEvery, samples };
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    invalid(`${name} must contain string values`);
  }
  return structuredClone(value) as Record<string, string>;
}

export function parseSubjectTrackAnalysis(text: string): SubjectTrackAnalysis {
  let source: unknown;
  try {
    source = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    invalid(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(source)) invalid("root must be an object");
  if (source["format"] !== "guyditor.analysis/v1" || source["kind"] !== "subject.track") {
    invalid("format/kind must identify subject.track");
  }
  const assetId = source["assetId"];
  if (typeof assetId !== "string" || !/^ast_[a-z2-7]{10}$/u.test(assetId)) invalid("assetId is invalid");
  const sourceHash = source["sourceHash"];
  if (typeof sourceHash !== "string" || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(sourceHash)) {
    invalid("sourceHash must be SHA-256");
  }
  if (!isRecord(source["params"])) invalid("params must be an object");
  const createdAt = source["createdAt"];
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) invalid("createdAt is invalid");
  return {
    format: "guyditor.analysis/v1",
    kind: "subject.track",
    assetId,
    sourceHash,
    params: structuredClone(source["params"]),
    toolVersions: stringRecord(source["toolVersions"], "toolVersions"),
    createdAt,
    data: trackData(source["data"]),
  };
}

export function serializeSubjectTrackAnalysis(sidecar: SubjectTrackAnalysis): string {
  const validated = parseSubjectTrackAnalysis(JSON.stringify(sidecar));
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function createSubjectTrackAnalysis(
  input: CreateSubjectTrackAnalysisInput,
): SubjectTrackAnalysis {
  return parseSubjectTrackAnalysis(JSON.stringify({
    format: "guyditor.analysis/v1",
    kind: "subject.track",
    assetId: input.assetId,
    sourceHash: input.sourceHash,
    params: structuredClone(input.params),
    toolVersions: structuredClone(input.toolVersions),
    createdAt: input.createdAt,
    data: {
      frameCount: input.result.frameCount,
      width: input.result.width,
      height: input.result.height,
      fps: input.result.fps,
      sampleEvery: input.result.sampleEvery,
      samples: structuredClone(input.result.samples),
    },
  }));
}

export function subjectTrackSidecarPath(assetId: string): string {
  if (!/^ast_[a-z2-7]{10}$/u.test(assetId)) invalid("assetId is invalid");
  return `sidecars/analysis/${assetId}.subject.track.json`;
}

export async function writeSubjectTrackAnalysis(
  projectRoot: string,
  sidecar: SubjectTrackAnalysis,
): Promise<{ path: string; sha256: string; bytes: number }> {
  const relativePath = subjectTrackSidecarPath(sidecar.assetId);
  const absolutePath = join(projectRoot, relativePath);
  const serialized = serializeSubjectTrackAnalysis(sidecar);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, serialized, "utf8");
  return {
    path: relativePath,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized),
  };
}
